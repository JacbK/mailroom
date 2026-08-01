import { MailroomError } from '../errors.js';
import type { MessageView } from '../types.js';
import { buildRawMessage, parseDraft, type ComposeContentType } from './compose.js';
import { mapLimit } from './concurrency.js';
import type { OperationConnections } from './connections.js';
import { parseQualifiedId, qualifyId } from './ids.js';
import {
  draftResult,
  prepareOutgoing,
  sentResult,
  type OutgoingMessageInput,
} from './outgoing.js';
import { attachmentsOf, toMessageView } from './parser.js';

const HARD_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

export class GmailDrafts {
  public constructor(private readonly connections: OperationConnections) {}

  public async listDrafts(input: {
    account: string;
    maxResults?: number;
    nextPageToken?: string;
  }): Promise<{
    account_alias: string;
    account_email: string;
    drafts: Array<{ draft_id: string; message: MessageView }>;
    next_page_token: string | null;
  }> {
    const maxResults = input.maxResults ?? 20;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new MailroomError('INVALID_INPUT', 'max_results must be 1-100.', 'Use a smaller page.');
    }
    const { account, gateway } = await this.connections.get(input.account);
    const page = await gateway.listDrafts(maxResults, input.nextPageToken);
    const drafts = await mapLimit(page.drafts, 5, async (draft) => {
      if (!draft.id) throw new Error('Gmail draft is missing its ID.');
      const full = await gateway.getDraft(draft.id, 'full');
      if (!full.message) throw new Error('Gmail draft is missing its message.');
      return {
        draft_id: qualifyId(account.alias, draft.id),
        message: toMessageView(full.message, account),
      };
    });
    return {
      account_alias: account.alias,
      account_email: account.email,
      drafts,
      next_page_token: page.nextPageToken ?? null,
    };
  }

  public async createDraft(input: OutgoingMessageInput): Promise<{
    account_alias: string;
    account_email: string;
    draft_id: string;
    message_id: string;
    thread_id: string;
  }> {
    const { account, gateway } = await this.connections.get(input.account);
    const prepared = await prepareOutgoing(account, gateway, input);
    return draftResult(account, await gateway.createDraft(prepared.raw, prepared.threadId));
  }

  public async updateDraft(input: {
    draftId: string;
    to?: string | null;
    subject?: string | null;
    body?: string | null;
    htmlBody?: string | null;
    bodyFile?: string;
    contentType?: ComposeContentType;
    cc?: string | null;
    bcc?: string | null;
  }): Promise<{
    account_alias: string;
    account_email: string;
    draft_id: string;
    message_id: string;
    thread_id: string;
  }> {
    const { alias, gmailId } = parseQualifiedId(input.draftId);
    const { account, gateway } = await this.connections.get(alias);
    const existing = await gateway.getDraft(gmailId, 'raw');
    if (!existing.message?.raw) throw new Error('Gmail draft is missing its raw content.');
    const parsed = await parseDraft(existing.message.raw);
    if (parsed.hasAttachments) {
      throw new MailroomError(
        'INVALID_INPUT',
        'Drafts with attachments cannot be edited in place.',
        'Create a replacement draft or edit it in Gmail.',
      );
    }
    const bodyChanged = input.body !== undefined
      || input.htmlBody !== undefined
      || input.bodyFile !== undefined
      || input.contentType !== undefined;
    const raw = await buildRawMessage({
      from: account.email,
      to: input.to ?? parsed.to,
      subject: input.subject ?? parsed.subject,
      ...(bodyChanged
        ? {
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
          }
        : { body: parsed.text, htmlBody: parsed.html }),
      ...(input.bodyFile ? { bodyFile: input.bodyFile } : {}),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      cc: input.cc ?? parsed.cc,
      bcc: input.bcc ?? parsed.bcc,
    });
    return draftResult(
      account,
      await gateway.updateDraft(gmailId, raw, existing.message.threadId ?? undefined),
    );
  }

  public async sendDraft(draftId: string): Promise<{
    account_alias: string;
    account_email: string;
    message_id: string;
    thread_id: string;
  }> {
    const { alias, gmailId } = parseQualifiedId(draftId);
    const { account, gateway } = await this.connections.get(alias);
    return sentResult(account, await gateway.sendDraft(gmailId));
  }

  public async sendEmail(input: OutgoingMessageInput): Promise<{
    account_alias: string;
    account_email: string;
    message_id: string;
    thread_id: string;
  }> {
    const { account, gateway } = await this.connections.get(input.account);
    const prepared = await prepareOutgoing(account, gateway, input);
    return sentResult(account, await gateway.sendMessage(prepared.raw, prepared.threadId));
  }

  public async forwardEmails(input: {
    messageIds: string[];
    to: string;
    cc?: string;
    bcc?: string;
    note?: string;
  }): Promise<Array<{
    source_message_id: string;
    sent_message_id: string;
    thread_id: string;
    account_alias: string;
  }>> {
    this.assertQualifiedIdBatch(input.messageIds, 50);
    return await this.connections.run(async () => await mapLimit(
      input.messageIds,
      2,
      async (qualifiedMessageId) => {
        const { alias, gmailId } = parseQualifiedId(qualifiedMessageId);
        const { account, gateway } = await this.connections.get(alias);
        const source = await gateway.getMessage(gmailId, 'full');
        const view = toMessageView(source, account);
        const attachmentMetadata = attachmentsOf(source);
        const declaredAttachmentBytes = attachmentMetadata.reduce(
          (sum, attachment) => sum + attachment.size,
          0,
        );
        if (declaredAttachmentBytes > HARD_ATTACHMENT_LIMIT) {
          throw new MailroomError(
            'ATTACHMENT_TOO_LARGE',
            `Forwarded attachments total ${declaredAttachmentBytes} bytes, above the 25 MiB limit.`,
            'Forward fewer attachments manually in Gmail.',
          );
        }
        const attachments = await mapLimit(attachmentMetadata, 3, async (attachment) => {
          const raw = await gateway.getAttachment(gmailId, attachment.id);
          return {
            filename: attachment.filename,
            content: Buffer.from(raw.data ?? '', 'base64url'),
            contentType: attachment.mimeType,
          };
        });
        const forwarded = [
          input.note?.trim(),
          '---------- Forwarded message ----------',
          `From: ${view.from}`,
          `Date: ${view.date ?? ''}`,
          `Subject: ${view.subject}`,
          `To: ${view.to.join(', ')}`,
          '',
          view.body_text,
        ].filter((line) => line !== undefined).join('\n');
        const raw = await buildRawMessage({
          from: account.email,
          to: input.to,
          subject: /^fwd:/i.test(view.subject) ? view.subject : `Fwd: ${view.subject}`,
          body: forwarded,
          ...(input.cc !== undefined ? { cc: input.cc } : {}),
          ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
          attachments,
        });
        const result = sentResult(account, await gateway.sendMessage(raw));
        return {
          source_message_id: qualifiedMessageId,
          sent_message_id: result.message_id,
          thread_id: result.thread_id,
          account_alias: alias,
        };
      },
    ));
  }

  private assertQualifiedIdBatch(ids: string[], max: number): void {
    if (ids.length < 1 || ids.length > max) {
      throw new MailroomError('INVALID_INPUT', `Expected 1-${max} account-qualified IDs.`, 'Use a smaller batch.');
    }
    for (const id of new Set(ids)) parseQualifiedId(id);
  }
}

export type { ComposeContentType, OutgoingMessageInput };
