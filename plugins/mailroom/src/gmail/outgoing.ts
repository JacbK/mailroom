import type { gmail_v1 } from '@googleapis/gmail';
import { MailroomError } from '../errors.js';
import type { AccountConfig } from '../types.js';
import { buildRawMessage, type ComposeContentType } from './compose.js';
import type { GmailGateway } from './gateway.js';
import { parseQualifiedId, qualifyId } from './ids.js';
import { headerOf } from './parser.js';

export interface OutgoingMessageInput {
  account: string;
  to: string;
  subject: string;
  body?: string | null;
  htmlBody?: string | null;
  bodyFile?: string;
  contentType?: ComposeContentType;
  cc?: string | null;
  bcc?: string | null;
  attachmentFiles?: string[];
  replyMessageId?: string | null;
}

export async function prepareOutgoing(
  account: AccountConfig,
  gateway: GmailGateway,
  input: OutgoingMessageInput,
): Promise<{ raw: string; threadId?: string }> {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (input.replyMessageId) {
    const parsed = parseQualifiedId(input.replyMessageId);
    if (parsed.alias !== account.alias) {
      throw new MailroomError(
        'INVALID_INPUT',
        'A reply must be sent from the account that owns the source message.',
        `Use account "${parsed.alias}".`,
      );
    }
    const source = await gateway.getMessage(parsed.gmailId, 'full');
    threadId = source.threadId ?? undefined;
    inReplyTo = headerOf(source, 'Message-ID') || undefined;
    const prior = headerOf(source, 'References').split(/\s+/).filter(Boolean);
    references = [...prior, ...(inReplyTo ? [inReplyTo] : [])];
  }
  const raw = await buildRawMessage({
    from: account.email,
    to: input.to,
    subject: input.subject,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
    ...(input.bodyFile ? { bodyFile: input.bodyFile } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(input.cc !== undefined ? { cc: input.cc } : {}),
    ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
    ...(input.attachmentFiles !== undefined ? { attachmentFiles: input.attachmentFiles } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references?.length ? { references } : {}),
  });
  return { raw, ...(threadId ? { threadId } : {}) };
}

export function draftResult(account: AccountConfig, draft: gmail_v1.Schema$Draft): {
  account_alias: string;
  account_email: string;
  draft_id: string;
  message_id: string;
  thread_id: string;
} {
  if (!draft.id || !draft.message?.id || !draft.message.threadId) {
    throw new Error('Gmail returned an incomplete draft.');
  }
  return {
    account_alias: account.alias,
    account_email: account.email,
    draft_id: qualifyId(account.alias, draft.id),
    message_id: qualifyId(account.alias, draft.message.id),
    thread_id: qualifyId(account.alias, draft.message.threadId),
  };
}

export function sentResult(account: AccountConfig, message: gmail_v1.Schema$Message): {
  account_alias: string;
  account_email: string;
  message_id: string;
  thread_id: string;
} {
  if (!message.id || !message.threadId) throw new Error('Gmail returned an incomplete sent message.');
  return {
    account_alias: account.alias,
    account_email: account.email,
    message_id: qualifyId(account.alias, message.id),
    thread_id: qualifyId(account.alias, message.threadId),
  };
}
