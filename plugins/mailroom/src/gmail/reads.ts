import { createHash } from 'node:crypto';
import { MailroomError, toMailroomError } from '../errors.js';
import type { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, MessageView } from '../types.js';
import { mapLimit } from './concurrency.js';
import type { OperationConnections } from './connections.js';
import { parseQualifiedId, qualifyId } from './ids.js';
import { attachmentsOf, toMessageView, toThreadMessageView } from './parser.js';

const HARD_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_LIMIT = 1024 * 1024;
const BLOCKED_ATTACHMENT_TYPES = new Set([
  'application/java-archive',
  'application/vnd.apple.installer+xml',
  'application/x-7z-compressed',
  'application/x-apple-diskimage',
  'application/x-bat',
  'application/x-executable',
  'application/x-msdownload',
  'application/x-rar-compressed',
  'application/x-sh',
  'application/zip',
]);
const BLOCKED_ATTACHMENT_EXTENSIONS = /\.(?:app|bat|bin|cmd|com|dmg|exe|iso|jar|js|msi|pkg|ps1|rar|sh|tar|zip)$/i;

export class GmailReads {
  public constructor(
    private readonly config: ConfigStore,
    private readonly connections: OperationConnections,
  ) {}

  public async accounts(): Promise<Array<AccountConfig & {
    status: 'connected' | 'needs_auth' | 'error';
  }>> {
    const accounts = await this.config.list();
    return await mapLimit(accounts, 3, async (account) => {
      try {
        const { gateway } = await this.connections.get(account.alias);
        const profile = await gateway.profile();
        const connected = profile.emailAddress?.toLowerCase() === account.email.toLowerCase();
        return { ...account, status: connected ? 'connected' as const : 'needs_auth' as const };
      } catch (error) {
        const safe = toMailroomError(error);
        return {
          ...account,
          status: safe.code === 'AUTH_REQUIRED' ? 'needs_auth' as const : 'error' as const,
        };
      }
    });
  }

  public async profiles(aliases?: string[]): Promise<Array<{
    account_alias: string;
    account_email: string;
    messages_total: number;
    threads_total: number;
    history_id: string | null;
  }>> {
    const selected = await this.selectedAccounts(aliases);
    return await mapLimit(selected, 3, async (account) => {
      const { gateway } = await this.connections.get(account.alias);
      const profile = await gateway.profile();
      return {
        account_alias: account.alias,
        account_email: account.email,
        messages_total: profile.messagesTotal ?? 0,
        threads_total: profile.threadsTotal ?? 0,
        history_id: profile.historyId ?? null,
      };
    });
  }

  public async readEmail(qualifiedMessageId: string, includeRawMime = false): Promise<MessageView & {
    raw_mime?: string;
  }> {
    return await this.connections.run(async () => {
      const view = await this.getMessage(qualifiedMessageId);
      if (!includeRawMime) return view;
      const { alias, gmailId } = parseQualifiedId(qualifiedMessageId);
      const { gateway } = await this.connections.get(alias);
      const raw = await gateway.getMessage(gmailId, 'raw');
      return {
        ...view,
        raw_mime: Buffer.from(raw.raw ?? '', 'base64url').toString('utf8'),
      };
    });
  }

  public async batchReadEmail(messageIds: string[]): Promise<Array<{
    message_id: string;
    email?: MessageView;
    error?: ReturnType<MailroomError['toJSON']>;
  }>> {
    if (messageIds.length < 1 || messageIds.length > 100) {
      throw new MailroomError('INVALID_INPUT', 'message_ids must contain 1-100 IDs.', 'Use a smaller batch.');
    }
    return await this.connections.run(async () => await mapLimit(messageIds, 5, async (messageId) => {
      try {
        return { message_id: messageId, email: await this.getMessage(messageId) };
      } catch (error) {
        return { message_id: messageId, error: toMailroomError(error).toJSON() };
      }
    }));
  }

  public async readEmailThread(input: {
    id: string;
    idType?: 'message' | 'thread';
    maxMessages?: number;
  }): Promise<{
    account_alias: string;
    account_email: string;
    thread_id: string;
    messages: MessageView[];
    truncated: boolean;
  }> {
    return await this.connections.run(async () => {
      const maxMessages = input.maxMessages ?? 20;
      if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
        throw new MailroomError('INVALID_INPUT', 'max_messages must be 1-100.', 'Use a smaller thread window.');
      }
      let qualifiedThreadId = input.id;
      if ((input.idType ?? 'message') === 'message') {
        const { alias, gmailId } = parseQualifiedId(input.id);
        const { gateway } = await this.connections.get(alias);
        const message = await gateway.getMessage(gmailId, 'metadata');
        if (!message.threadId) throw new Error('Gmail message is missing its thread ID.');
        qualifiedThreadId = qualifyId(alias, message.threadId);
      }
      return await this.getThread(qualifiedThreadId, maxMessages);
    });
  }

  public async batchReadEmailThreads(input: {
    ids: string[];
    idType?: 'message' | 'thread';
    maxMessages?: number;
  }): Promise<Array<{
    id: string;
    thread?: Awaited<ReturnType<GmailReads['readEmailThread']>>;
    error?: ReturnType<MailroomError['toJSON']>;
  }>> {
    if (input.ids.length < 1 || input.ids.length > 50) {
      throw new MailroomError('INVALID_INPUT', 'ids must contain 1-50 values.', 'Use a smaller batch.');
    }
    return await this.connections.run(async () => {
      const results = await mapLimit([...new Set(input.ids)], 4, async (id) => {
        try {
          const thread = await this.readEmailThread({
            id,
            ...(input.idType ? { idType: input.idType } : {}),
            ...(input.maxMessages ? { maxMessages: input.maxMessages } : {}),
          });
          return { id, thread };
        } catch (error) {
          return { id, error: toMailroomError(error).toJSON() };
        }
      });
      const seen = new Set<string>();
      return results.filter((item) => {
        if (!item.thread) return true;
        if (seen.has(item.thread.thread_id)) return false;
        seen.add(item.thread.thread_id);
        return true;
      });
    });
  }

  public async getMessage(qualifiedMessageId: string): Promise<MessageView> {
    const { alias, gmailId } = parseQualifiedId(qualifiedMessageId);
    const { account, gateway } = await this.connections.get(alias);
    try {
      return toMessageView(await gateway.getMessage(gmailId, 'full'), account);
    } catch (error) {
      throw toMailroomError(error);
    }
  }

  public async getThread(qualifiedThreadId: string, maxMessages = 100): Promise<{
    account_alias: string;
    account_email: string;
    thread_id: string;
    messages: MessageView[];
    truncated: boolean;
  }> {
    const { alias, gmailId } = parseQualifiedId(qualifiedThreadId);
    const { account, gateway } = await this.connections.get(alias);
    try {
      const thread = await gateway.getThread(gmailId);
      const all = [...(thread.messages ?? [])].sort(
        (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
      );
      const messages = all.slice(-maxMessages).map((message) => toThreadMessageView(message, account));
      return {
        account_alias: account.alias,
        account_email: account.email,
        thread_id: qualifiedThreadId,
        messages,
        truncated: all.length > messages.length,
      };
    } catch (error) {
      throw toMailroomError(error);
    }
  }

  public async getAttachment(input: {
    messageId: string;
    attachmentId?: string;
    filename?: string;
    maxBytes?: number;
  }): Promise<{
    account_alias: string;
    account_email: string;
    message_id: string;
    attachment_id: string;
    filename: string;
    mime_type: string;
    size: number;
    sha256: string;
    base64_data: string;
  }> {
    const { alias, gmailId } = parseQualifiedId(input.messageId);
    const maxBytes = input.maxBytes ?? DEFAULT_ATTACHMENT_LIMIT;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_ATTACHMENT_LIMIT) {
      throw new MailroomError(
        'INVALID_INPUT',
        `max_bytes must be between 1 and ${HARD_ATTACHMENT_LIMIT}.`,
        'Use the default unless a known safe attachment requires a larger limit.',
      );
    }
    const { account, gateway } = await this.connections.get(alias);
    const message = await gateway.getMessage(gmailId, 'full');
    if (!input.attachmentId && !input.filename) {
      throw new MailroomError(
        'INVALID_INPUT',
        'attachment_id or filename is required.',
        'Reuse an attachment value returned by the parent message.',
      );
    }
    const matches = attachmentsOf(message).filter((item) => (
      input.attachmentId ? item.id === input.attachmentId : item.filename === input.filename
    ));
    if (!input.attachmentId && matches.length > 1) {
      throw new MailroomError(
        'INVALID_INPUT',
        `More than one attachment is named ${input.filename}.`,
        'Use the exact attachment_id instead.',
      );
    }
    const metadata = matches[0];
    if (!metadata) {
      throw new MailroomError(
        'INVALID_INPUT',
        'The requested attachment does not belong to this message.',
        'Reuse the attachment ID returned by `gmail_read_email`.',
      );
    }
    if (BLOCKED_ATTACHMENT_TYPES.has(metadata.mimeType.toLowerCase())
      || BLOCKED_ATTACHMENT_EXTENSIONS.test(metadata.filename)) {
      throw new MailroomError(
        'ATTACHMENT_BLOCKED',
        `Blocked potentially executable or archived attachment: ${metadata.filename}.`,
        'Open the message in Gmail and inspect the attachment manually if you trust the sender.',
      );
    }
    if (metadata.size > maxBytes) {
      throw new MailroomError(
        'ATTACHMENT_TOO_LARGE',
        `Attachment is ${metadata.size} bytes, above the ${maxBytes}-byte limit.`,
        `Raise max_bytes up to ${HARD_ATTACHMENT_LIMIT} only if the file is expected and trusted.`,
      );
    }
    const body = await gateway.getAttachment(gmailId, metadata.id);
    const data = Buffer.from(body.data ?? '', 'base64url');
    if (data.byteLength > maxBytes) {
      throw new MailroomError(
        'ATTACHMENT_TOO_LARGE',
        `Downloaded attachment is ${data.byteLength} bytes, above the ${maxBytes}-byte limit.`,
        'Request a larger explicit max_bytes value only if the file is expected and trusted.',
      );
    }
    return {
      account_alias: account.alias,
      account_email: account.email,
      message_id: input.messageId,
      attachment_id: metadata.id,
      filename: metadata.filename,
      mime_type: metadata.mimeType,
      size: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      base64_data: data.toString('base64'),
    };
  }

  private async selectedAccounts(aliases?: string[]): Promise<AccountConfig[]> {
    const configured = await this.config.list();
    if (!aliases?.length) return configured;
    const unique = [...new Set(aliases)];
    for (const alias of unique) {
      if (!configured.some((account) => account.alias === alias)) {
        throw new MailroomError(
          'ACCOUNT_NOT_FOUND',
          `No Gmail account is configured with alias "${alias}".`,
          `Available aliases: ${configured.map((account) => account.alias).join(', ')}.`,
        );
      }
    }
    return unique.map((alias) => configured.find((account) => account.alias === alias) as AccountConfig);
  }
}
