import { createHash, randomUUID } from 'node:crypto';
import type { gmail_v1 } from '@googleapis/gmail';
import { SwitchboardError, toSwitchboardError } from '../errors.js';
import { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, MessageView, SearchPage, SearchResult } from '../types.js';
import { GmailClientFactory } from './client-factory.js';
import { buildRawMessage, parseDraft, type ComposeContentType } from './compose.js';
import { GoogleGmailGateway, type GmailGateway } from './gateway.js';
import { parseQualifiedId, qualifyId } from './ids.js';
import { attachmentsOf, headerOf, toMessageView, toSearchResult, toThreadMessageView } from './parser.js';

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const CURSOR_CAPACITY = 100;
const HARD_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_LIMIT = 1024 * 1024;
const SEARCH_DEADLINE_MS = 45_000;
const MIN_PAGE_FETCH_BUDGET = 12;
const MAX_PAGE_FETCH_BUDGET = 40;
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

interface ConnectedGateway {
  account: AccountConfig;
  gateway: GmailGateway;
}

type GatewayProvider = (alias: string) => Promise<ConnectedGateway>;

interface AccountPageState {
  pageToken?: string;
  exhausted: boolean;
  buffer: SearchResult[];
}

interface CursorState {
  lastUsedAt: number;
  query: string;
  aliases: string[];
  labelIds: Map<string, string[]>;
  accounts: Map<string, AccountPageState>;
  seen: Set<string>;
}

export interface SearchInput {
  query?: string | undefined;
  accounts?: string[] | undefined;
  after?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  labelIds?: string[] | undefined;
}

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

function defaultProvider(factory: GmailClientFactory): GatewayProvider {
  return async (alias) => {
    const connection = await factory.connect(alias);
    return { account: connection.account, gateway: new GoogleGmailGateway(connection.gmail) };
  };
}

function dateFilter(value: string | undefined, name: 'after' | 'before'): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new SwitchboardError(
      'INVALID_INPUT',
      `${name} must be a real date in YYYY-MM-DD format.`,
      `Use a value such as ${name === 'after' ? '2026-01-01' : '2026-12-31'}.`,
    );
  }
  return `${name}:${value.replaceAll('-', '/')}`;
}

function compareResults(a: SearchResult, b: SearchResult): number {
  const aTime = a.date ? Date.parse(a.date) : 0;
  const bTime = b.date ? Date.parse(b.date) : 0;
  return bTime - aTime || a.message_id.localeCompare(b.message_id);
}

const SYSTEM_LABEL_IDS = new Set([
  'CHAT', 'DRAFT', 'IMPORTANT', 'INBOX', 'SENT', 'SPAM', 'STARRED', 'TRASH', 'UNREAD',
  'CATEGORY_FORUMS', 'CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES',
]);

function labelIdsForAlias(labelIds: string[] | undefined, alias: string): string[] {
  if (!labelIds) return [];
  const result: string[] = [];
  for (const labelId of labelIds) {
    if (SYSTEM_LABEL_IDS.has(labelId)) result.push(labelId);
    else if (labelId.includes(':')) {
      const parsed = parseQualifiedId(labelId);
      if (parsed.alias === alias) result.push(parsed.gmailId);
    } else {
      throw new SwitchboardError(
        'AMBIGUOUS_ID',
        `User label ID "${labelId}" is missing its account alias.`,
        'Use the qualified label ID returned by `gmail_list_labels`.',
      );
    }
  }
  return [...new Set(result)];
}

async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < values.length) {
      const current = index;
      index += 1;
      const value = values[current];
      if (value !== undefined) results[current] = await work(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export class GmailService {
  private readonly cursors = new Map<string, CursorState>();
  private readonly activeCursors = new Set<string>();

  public constructor(
    private readonly config = new ConfigStore(),
    factory = new GmailClientFactory(config),
    private readonly provideGateway: GatewayProvider = defaultProvider(factory),
  ) {}

  public async accounts(): Promise<Array<AccountConfig & {
    status: 'connected' | 'needs_auth' | 'error';
  }>> {
    const accounts = await this.config.list();
    return await mapLimit(accounts, 3, async (account) => {
      try {
        const { gateway } = await this.provideGateway(account.alias);
        const profile = await gateway.profile();
        const connected = profile.emailAddress?.toLowerCase() === account.email.toLowerCase();
        return { ...account, status: connected ? 'connected' as const : 'needs_auth' as const };
      } catch (error) {
        const safe = toSwitchboardError(error);
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
      const { gateway } = await this.provideGateway(account.alias);
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

  public async searchEmailIds(input: SearchInput): Promise<{
    message_ids: string[];
    thread_ids: string[];
    next_cursor: string | null;
    result_count: number;
    searched_accounts: AccountConfig[];
    partial: boolean;
    partial_reason: string | null;
  }> {
    const page = await this.search(input);
    return {
      message_ids: page.results.map((item) => item.message_id),
      thread_ids: [...new Set(page.results.map((item) => item.thread_id))],
      next_cursor: page.next_cursor,
      result_count: page.result_count,
      searched_accounts: page.searched_accounts,
      partial: page.partial,
      partial_reason: page.partial_reason,
    };
  }

  public async readEmail(qualifiedMessageId: string, includeRawMime = false): Promise<MessageView & {
    raw_mime?: string;
  }> {
    const view = await this.getMessage(qualifiedMessageId);
    if (!includeRawMime) return view;
    const { alias, gmailId } = parseQualifiedId(qualifiedMessageId);
    const { gateway } = await this.provideGateway(alias);
    const raw = await gateway.getMessage(gmailId, 'raw');
    const rawBase64Url = raw.raw ?? '';
    return {
      ...view,
      raw_mime: Buffer.from(rawBase64Url, 'base64url').toString('utf8'),
    };
  }

  public async batchReadEmail(messageIds: string[]): Promise<Array<{
    message_id: string;
    email?: MessageView;
    error?: ReturnType<SwitchboardError['toJSON']>;
  }>> {
    if (messageIds.length < 1 || messageIds.length > 100) {
      throw new SwitchboardError('INVALID_INPUT', 'message_ids must contain 1-100 IDs.', 'Use a smaller batch.');
    }
    return await mapLimit(messageIds, 5, async (messageId) => {
      try {
        return { message_id: messageId, email: await this.getMessage(messageId) };
      } catch (error) {
        return { message_id: messageId, error: toSwitchboardError(error).toJSON() };
      }
    });
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
    const maxMessages = input.maxMessages ?? 20;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
      throw new SwitchboardError('INVALID_INPUT', 'max_messages must be 1-100.', 'Use a smaller thread window.');
    }
    let qualifiedThreadId = input.id;
    if ((input.idType ?? 'message') === 'message') {
      const { alias, gmailId } = parseQualifiedId(input.id);
      const { gateway } = await this.provideGateway(alias);
      const message = await gateway.getMessage(gmailId, 'metadata');
      if (!message.threadId) throw new Error('Gmail message is missing its thread ID.');
      qualifiedThreadId = qualifyId(alias, message.threadId);
    }
    return await this.getThread(qualifiedThreadId, maxMessages);
  }

  public async batchReadEmailThreads(input: {
    ids: string[];
    idType?: 'message' | 'thread';
    maxMessages?: number;
  }): Promise<Array<{
    id: string;
    thread?: Awaited<ReturnType<GmailService['readEmailThread']>>;
    error?: ReturnType<SwitchboardError['toJSON']>;
  }>> {
    if (input.ids.length < 1 || input.ids.length > 50) {
      throw new SwitchboardError('INVALID_INPUT', 'ids must contain 1-50 values.', 'Use a smaller batch.');
    }
    const results = await mapLimit([...new Set(input.ids)], 4, async (id) => {
      try {
        const thread = await this.readEmailThread({
          id,
          ...(input.idType ? { idType: input.idType } : {}),
          ...(input.maxMessages ? { maxMessages: input.maxMessages } : {}),
        });
        return { id, thread };
      } catch (error) {
        return { id, error: toSwitchboardError(error).toJSON() };
      }
    });
    const seen = new Set<string>();
    return results.filter((item) => {
      if (!item.thread) return true;
      if (seen.has(item.thread.thread_id)) return false;
      seen.add(item.thread.thread_id);
      return true;
    });
  }

  public async search(input: SearchInput): Promise<SearchPage> {
    const cursor = input.cursor;
    if (cursor && this.activeCursors.has(cursor)) {
      throw new SwitchboardError(
        'CURSOR_IN_USE',
        'This search cursor is already being used by another request.',
        'Wait for the current page to finish, then reuse the cursor sequentially.',
      );
    }
    if (cursor) this.activeCursors.add(cursor);
    try {
      return await this.searchUnlocked(input);
    } finally {
      if (cursor) this.activeCursors.delete(cursor);
    }
  }

  private async searchUnlocked(input: SearchInput): Promise<SearchPage> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        'limit must be an integer from 1 through 50.',
        'Use a smaller page and follow next_cursor when more results are needed.',
      );
    }
    this.pruneExpiredCursors();

    const cursorId = input.cursor ?? randomUUID();
    let state: CursorState;
    if (input.cursor) {
      const existing = this.cursors.get(cursorId);
      if (!existing) {
        throw new SwitchboardError(
          'CURSOR_EXPIRED',
          'This search cursor expired or belongs to a previous server session.',
          'Repeat the original search without a cursor.',
        );
      }
      state = existing;
      state.lastUsedAt = Date.now();
      this.cursors.delete(cursorId);
      this.cursors.set(cursorId, state);
    } else {
      const configured = await this.config.list();
      if (configured.length === 0) {
        throw new SwitchboardError(
          'AUTH_REQUIRED',
          'No Gmail accounts are configured.',
          'Run `./setup` to add at least one account.',
        );
      }
      const requestedAliases = input.accounts?.length
        ? [...new Set(input.accounts)]
        : configured.map((account) => account.alias);
      for (const alias of requestedAliases) {
        if (!configured.some((account) => account.alias === alias)) {
          throw new SwitchboardError(
            'ACCOUNT_NOT_FOUND',
            `No Gmail account is configured with alias "${alias}".`,
            `Available aliases: ${configured.map((account) => account.alias).join(', ')}.`,
          );
        }
      }
      const userLabelAliases = new Set((input.labelIds ?? []).flatMap((labelId) => {
        if (SYSTEM_LABEL_IDS.has(labelId)) return [];
        if (!labelId.includes(':')) {
          throw new SwitchboardError(
            'AMBIGUOUS_ID',
            `User label ID "${labelId}" is missing its account alias.`,
            'Use the qualified label ID returned by `gmail_list_labels`.',
          );
        }
        return [parseQualifiedId(labelId).alias];
      }));
      const aliases = userLabelAliases.size > 0
        ? requestedAliases.filter((alias) => userLabelAliases.has(alias))
        : requestedAliases;
      if (aliases.length === 0) {
        throw new SwitchboardError(
          'INVALID_INPUT',
          'The selected user labels do not belong to the selected accounts.',
          'Search the account alias included in the qualified label ID.',
        );
      }
      const parts = [input.query?.trim(), dateFilter(input.after, 'after'), dateFilter(input.before, 'before')]
        .filter((part): part is string => Boolean(part));
      state = {
        lastUsedAt: Date.now(),
        query: parts.join(' '),
        aliases,
        labelIds: new Map(aliases.map((alias) => [alias, labelIdsForAlias(input.labelIds, alias)])),
        accounts: new Map(aliases.map((alias) => [alias, { exhausted: false, buffer: [] }])),
        seen: new Set(),
      };
      this.enforceCursorCapacity();
      this.cursors.set(cursorId, state);
    }

    const results: SearchResult[] = [];
    const signal = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    const pageBudget = {
      remaining: Math.min(
        MAX_PAGE_FETCH_BUDGET,
        Math.max(MIN_PAGE_FETCH_BUDGET, state.aliases.length * 2),
      ),
    };
    let partialReason: string | null = null;
    while (results.length < limit) {
      try {
        await this.fillAccountHeads(
          state,
          Math.min(Math.max(limit, 10), 25),
          signal,
          pageBudget,
        );
      } catch (error) {
        if (!(error instanceof SwitchboardError) || error.code !== 'TIMEOUT') throw error;
        partialReason = error.message;
        break;
      }
      const missingHead = [...state.accounts.values()].some(
        (item) => item.buffer.length === 0 && !item.exhausted,
      );
      if (missingHead && pageBudget.remaining === 0) {
        partialReason = 'The per-call Gmail page limit was reached before chronological order could be proven.';
        break;
      }
      const candidates = state.aliases
        .map((alias) => ({ alias, result: state.accounts.get(alias)?.buffer[0] }))
        .filter((item): item is { alias: string; result: SearchResult } => item.result !== undefined)
        .sort((a, b) => compareResults(a.result, b.result));
      const newest = candidates[0];
      if (!newest) {
        if ([...state.accounts.values()].some((item) => !item.exhausted)) {
          partialReason = 'The per-call Gmail page limit was reached before another result was found.';
        }
        break;
      }
      state.accounts.get(newest.alias)?.buffer.shift();
      results.push(newest.result);
    }

    const hasMore = [...state.accounts.values()].some(
      (item) => item.buffer.length > 0 || !item.exhausted,
    );
    if (!hasMore && cursorId) this.cursors.delete(cursorId);
    const accountConfigs = await Promise.all(state.aliases.map(async (alias) => await this.config.get(alias)));
    return {
      results,
      next_cursor: hasMore ? cursorId : null,
      result_count: results.length,
      searched_accounts: accountConfigs,
      partial: partialReason !== null,
      partial_reason: partialReason,
    };
  }

  public async getMessage(qualifiedMessageId: string): Promise<MessageView> {
    const { alias, gmailId } = parseQualifiedId(qualifiedMessageId);
    const { account, gateway } = await this.provideGateway(alias);
    try {
      return toMessageView(await gateway.getMessage(gmailId, 'full'), account);
    } catch (error) {
      throw toSwitchboardError(error);
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
    const { account, gateway } = await this.provideGateway(alias);
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
      throw toSwitchboardError(error);
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
      throw new SwitchboardError(
        'INVALID_INPUT',
        `max_bytes must be between 1 and ${HARD_ATTACHMENT_LIMIT}.`,
        'Use the default unless a known safe attachment requires a larger limit.',
      );
    }
    const { account, gateway } = await this.provideGateway(alias);
    const message = await gateway.getMessage(gmailId, 'full');
    if (!input.attachmentId && !input.filename) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        'attachment_id or filename is required.',
        'Reuse an attachment value returned by the parent message.',
      );
    }
    const matches = attachmentsOf(message).filter((item) => (
      input.attachmentId ? item.id === input.attachmentId : item.filename === input.filename
    ));
    if (!input.attachmentId && matches.length > 1) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        `More than one attachment is named ${input.filename}.`,
        'Use the exact attachment_id instead.',
      );
    }
    const metadata = matches[0];
    if (!metadata) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        'The requested attachment does not belong to this message.',
        'Reuse the attachment ID returned by `gmail_read_email`.',
      );
    }
    if (BLOCKED_ATTACHMENT_TYPES.has(metadata.mimeType.toLowerCase())
      || BLOCKED_ATTACHMENT_EXTENSIONS.test(metadata.filename)) {
      throw new SwitchboardError(
        'ATTACHMENT_BLOCKED',
        `Blocked potentially executable or archived attachment: ${metadata.filename}.`,
        'Open the message in Gmail and inspect the attachment manually if you trust the sender.',
      );
    }
    if (metadata.size > maxBytes) {
      throw new SwitchboardError(
        'ATTACHMENT_TOO_LARGE',
        `Attachment is ${metadata.size} bytes, above the ${maxBytes}-byte limit.`,
        `Raise max_bytes up to ${HARD_ATTACHMENT_LIMIT} only if the file is expected and trusted.`,
      );
    }
    const body = await gateway.getAttachment(gmailId, metadata.id);
    const data = Buffer.from(body.data ?? '', 'base64url');
    if (data.byteLength > maxBytes) {
      throw new SwitchboardError(
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

  public async listLabels(aliases?: string[]): Promise<Array<{
    account_alias: string;
    account_email: string;
    labels: Array<{
      id: string;
      name: string;
      type: string;
      messages_total: number;
      messages_unread: number;
      threads_total: number;
      threads_unread: number;
    }>;
  }>> {
    const accounts = await this.selectedAccounts(aliases);
    return await mapLimit(accounts, 3, async (account) => {
      const { gateway } = await this.provideGateway(account.alias);
      const labels = await gateway.listLabels();
      return {
        account_alias: account.alias,
        account_email: account.email,
        labels: labels.filter((label) => label.id && label.name).map((label) => ({
          id: qualifyId(account.alias, label.id ?? ''),
          name: label.name ?? '',
          type: label.type ?? '',
          messages_total: label.messagesTotal ?? 0,
          messages_unread: label.messagesUnread ?? 0,
          threads_total: label.threadsTotal ?? 0,
          threads_unread: label.threadsUnread ?? 0,
        })),
      };
    });
  }

  public async createLabel(input: {
    account: string;
    name: string;
    labelListVisibility?: 'labelShow' | 'labelShowIfUnread' | 'labelHide';
    messageListVisibility?: 'show' | 'hide';
  }): Promise<{
    account_alias: string;
    account_email: string;
    id: string;
    name: string;
    created: boolean;
  }> {
    const { account, gateway } = await this.provideGateway(input.account);
    const existing = (await gateway.listLabels()).find((label) => label.name === input.name);
    const label = existing ?? await gateway.createLabel({
      name: input.name,
      ...(input.labelListVisibility ? { labelListVisibility: input.labelListVisibility } : {}),
      ...(input.messageListVisibility ? { messageListVisibility: input.messageListVisibility } : {}),
    });
    if (!label.id || !label.name) throw new Error('Gmail returned an incomplete label.');
    return {
      account_alias: account.alias,
      account_email: account.email,
      id: qualifyId(account.alias, label.id),
      name: label.name,
      created: existing === undefined,
    };
  }

  public async applyLabelsToEmails(input: {
    messageIds: string[];
    addLabelNames?: string[];
    removeLabelNames?: string[];
    createMissingLabels?: boolean;
  }): Promise<{
    modified: number;
    accounts: Array<{
      alias: string;
      modified: number;
      error?: ReturnType<SwitchboardError['toJSON']>;
    }>;
  }> {
    const groups = this.groupQualifiedIds(input.messageIds, 1_000);
    const accounts: Array<{
      alias: string;
      modified: number;
      error?: ReturnType<SwitchboardError['toJSON']>;
    }> = [];
    let modified = 0;
    for (const [alias, ids] of groups) {
      try {
        const { gateway } = await this.provideGateway(alias);
        const labels = await gateway.listLabels();
        const resolveNames = async (names: string[] | undefined): Promise<string[]> => {
          const idsForNames: string[] = [];
          for (const name of names ?? []) {
            let label = labels.find((item) => item.name === name);
            if (!label && input.createMissingLabels) {
              label = await gateway.createLabel({ name });
              labels.push(label);
            }
            if (!label?.id) {
              throw new SwitchboardError(
                'INVALID_INPUT',
                `No label named "${name}" exists in ${alias}.`,
                'Create the label first or set create_missing_labels.',
              );
            }
            idsForNames.push(label.id);
          }
          return idsForNames;
        };
        const add = await resolveNames(input.addLabelNames);
        const remove = await resolveNames(input.removeLabelNames);
        await gateway.batchModify(ids, add, remove);
        modified += ids.length;
        accounts.push({ alias, modified: ids.length });
      } catch (error) {
        accounts.push({ alias, modified: 0, error: toSwitchboardError(error).toJSON() });
      }
    }
    return { modified, accounts };
  }

  public async bulkLabelMatchingEmails(input: {
    account: string;
    query: string;
    labelName: string;
    createLabelIfMissing?: boolean;
    archive?: boolean;
  }): Promise<{ account_alias: string; label_name: string; modified: number; archived: boolean }> {
    const { gateway } = await this.provideGateway(input.account);
    const labels = await gateway.listLabels();
    let label = labels.find((item) => item.name === input.labelName);
    if (!label && input.createLabelIfMissing) label = await gateway.createLabel({ name: input.labelName });
    if (!label?.id) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        `No label named "${input.labelName}" exists in ${input.account}.`,
        'Create the label first or set create_label_if_missing.',
      );
    }
    let pageToken: string | undefined;
    const messageIds = new Set<string>();
    do {
      const page = await gateway.listMessages(input.query, 500, pageToken);
      for (const message of page.messages) if (message.id) messageIds.add(message.id);
      pageToken = page.nextPageToken;
      if (messageIds.size >= 100_000 && pageToken) {
        throw new SwitchboardError(
          'INVALID_INPUT',
          'The bulk label operation exceeded 100,000 messages.',
          'Narrow the Gmail query and retry.',
        );
      }
    } while (pageToken);
    const ids = [...messageIds];
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      await gateway.batchModify(ids.slice(offset, offset + 1_000), [label.id], input.archive ? ['INBOX'] : []);
    }
    return {
      account_alias: input.account,
      label_name: input.labelName,
      modified: ids.length,
      archived: input.archive ?? false,
    };
  }

  public async batchModifyEmail(input: {
    messageIds: string[];
    addLabels?: string[];
    removeLabels?: string[];
  }): Promise<{
    modified: number;
    accounts: Array<{
      alias: string;
      modified: number;
      error?: ReturnType<SwitchboardError['toJSON']>;
    }>;
  }> {
    const groups = this.groupQualifiedIds(input.messageIds, 1_000);
    const operations = [...groups].map(([alias, ids]) => ({
      alias,
      ids,
      add: this.labelsForAccount(input.addLabels, alias),
      remove: this.labelsForAccount(input.removeLabels, alias),
    }));
    for (const operation of operations) {
      if (operation.add.length === 0 && operation.remove.length === 0) {
        throw new SwitchboardError(
          'INVALID_INPUT',
          'At least one label must be added or removed for each target account.',
          'Use qualified user-label IDs, system label IDs, or a purpose-built archive tool.',
        );
      }
    }
    const accounts: Array<{
      alias: string;
      modified: number;
      error?: ReturnType<SwitchboardError['toJSON']>;
    }> = [];
    let modified = 0;
    for (const { alias, ids, add, remove } of operations) {
      try {
        const { gateway } = await this.provideGateway(alias);
        await gateway.batchModify(ids, add, remove);
        modified += ids.length;
        accounts.push({ alias, modified: ids.length });
      } catch (error) {
        accounts.push({ alias, modified: 0, error: toSwitchboardError(error).toJSON() });
      }
    }
    return { modified, accounts };
  }

  public async archiveEmails(messageIds: string[]): Promise<{
    archived: number;
    accounts: Array<{
      alias: string;
      archived: number;
      error?: ReturnType<SwitchboardError['toJSON']>;
    }>;
  }> {
    const result = await this.batchModifyEmail({ messageIds, removeLabels: ['INBOX'] });
    return {
      archived: result.modified,
      accounts: result.accounts.map((account) => ({
        alias: account.alias,
        archived: account.modified,
        ...(account.error ? { error: account.error } : {}),
      })),
    };
  }

  public async deleteEmails(messageIds: string[]): Promise<{
    trashed: number;
    accounts: Array<{
      alias: string;
      trashed: number;
      failures: Array<{ message_id: string; error: ReturnType<SwitchboardError['toJSON']> }>;
    }>;
  }> {
    const groups = this.groupQualifiedIds(messageIds, 1_000);
    const accounts: Array<{
      alias: string;
      trashed: number;
      failures: Array<{ message_id: string; error: ReturnType<SwitchboardError['toJSON']> }>;
    }> = [];
    let trashed = 0;
    for (const [alias, ids] of groups) {
      const { gateway } = await this.provideGateway(alias);
      const outcomes = await mapLimit(ids, 5, async (id) => {
        try {
          await gateway.trashMessage(id);
          return { id, ok: true as const };
        } catch (error) {
          return { id, ok: false as const, error: toSwitchboardError(error).toJSON() };
        }
      });
      const accountTrashed = outcomes.filter((outcome) => outcome.ok).length;
      trashed += accountTrashed;
      accounts.push({
        alias,
        trashed: accountTrashed,
        failures: outcomes.flatMap((outcome) => outcome.ok ? [] : [{
          message_id: qualifyId(alias, outcome.id),
          error: outcome.error,
        }]),
      });
    }
    return { trashed, accounts };
  }

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
      throw new SwitchboardError('INVALID_INPUT', 'max_results must be 1-100.', 'Use a smaller page.');
    }
    const { account, gateway } = await this.provideGateway(input.account);
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
    const { account, gateway } = await this.provideGateway(input.account);
    const prepared = await this.prepareOutgoing(account, gateway, input);
    const draft = await gateway.createDraft(prepared.raw, prepared.threadId);
    return this.draftResult(account, draft);
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
    const { account, gateway } = await this.provideGateway(alias);
    const existing = await gateway.getDraft(gmailId, 'raw');
    if (!existing.message?.raw) throw new Error('Gmail draft is missing its raw content.');
    const parsed = await parseDraft(existing.message.raw);
    if (parsed.hasAttachments) {
      throw new SwitchboardError(
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
    const draft = await gateway.updateDraft(gmailId, raw, existing.message.threadId ?? undefined);
    return this.draftResult(account, draft);
  }

  public async sendDraft(draftId: string): Promise<{
    account_alias: string;
    account_email: string;
    message_id: string;
    thread_id: string;
  }> {
    const { alias, gmailId } = parseQualifiedId(draftId);
    const { account, gateway } = await this.provideGateway(alias);
    const message = await gateway.sendDraft(gmailId);
    return this.sentResult(account, message);
  }

  public async sendEmail(input: OutgoingMessageInput): Promise<{
    account_alias: string;
    account_email: string;
    message_id: string;
    thread_id: string;
  }> {
    const { account, gateway } = await this.provideGateway(input.account);
    const prepared = await this.prepareOutgoing(account, gateway, input);
    const message = await gateway.sendMessage(prepared.raw, prepared.threadId);
    return this.sentResult(account, message);
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
    this.groupQualifiedIds(input.messageIds, 50);
    return await mapLimit(input.messageIds, 2, async (qualifiedMessageId) => {
      const { alias, gmailId } = parseQualifiedId(qualifiedMessageId);
      const { account, gateway } = await this.provideGateway(alias);
      const source = await gateway.getMessage(gmailId, 'full');
      const view = toMessageView(source, account);
      const attachmentMetadata = attachmentsOf(source);
      const declaredAttachmentBytes = attachmentMetadata.reduce((sum, attachment) => sum + attachment.size, 0);
      if (declaredAttachmentBytes > HARD_ATTACHMENT_LIMIT) {
        throw new SwitchboardError(
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
      const sent = await gateway.sendMessage(raw);
      const result = this.sentResult(account, sent);
      return {
        source_message_id: qualifiedMessageId,
        sent_message_id: result.message_id,
        thread_id: result.thread_id,
        account_alias: alias,
      };
    });
  }

  private async selectedAccounts(aliases?: string[]): Promise<AccountConfig[]> {
    const configured = await this.config.list();
    if (!aliases?.length) return configured;
    const unique = [...new Set(aliases)];
    for (const alias of unique) {
      if (!configured.some((account) => account.alias === alias)) {
        throw new SwitchboardError(
          'ACCOUNT_NOT_FOUND',
          `No Gmail account is configured with alias "${alias}".`,
          `Available aliases: ${configured.map((account) => account.alias).join(', ')}.`,
        );
      }
    }
    return unique.map((alias) => configured.find((account) => account.alias === alias) as AccountConfig);
  }

  private groupQualifiedIds(ids: string[], max: number): Map<string, string[]> {
    if (ids.length < 1 || ids.length > max) {
      throw new SwitchboardError('INVALID_INPUT', `Expected 1-${max} account-qualified IDs.`, 'Use a smaller batch.');
    }
    const groups = new Map<string, string[]>();
    for (const value of [...new Set(ids)]) {
      const { alias, gmailId } = parseQualifiedId(value);
      groups.set(alias, [...(groups.get(alias) ?? []), gmailId]);
    }
    return groups;
  }

  private labelsForAccount(labels: string[] | undefined, alias: string): string[] {
    return [...new Set((labels ?? []).flatMap((label) => {
      if (SYSTEM_LABEL_IDS.has(label)) return [label];
      if (!label.includes(':')) {
        throw new SwitchboardError(
          'AMBIGUOUS_ID',
          `User label ID "${label}" is missing its account alias.`,
          'Use the qualified label ID returned by `gmail_list_labels`.',
        );
      }
      const parsed = parseQualifiedId(label);
      return parsed.alias === alias ? [parsed.gmailId] : [];
    }))];
  }

  private async prepareOutgoing(
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
        throw new SwitchboardError(
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

  private draftResult(account: AccountConfig, draft: gmail_v1.Schema$Draft): {
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

  private sentResult(account: AccountConfig, message: gmail_v1.Schema$Message): {
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

  private async fillAccountHeads(
    state: CursorState,
    pageSize: number,
    signal: AbortSignal,
    pageBudget: { remaining: number },
  ): Promise<void> {
    let active = state.aliases.filter((alias) => {
      const item = state.accounts.get(alias);
      return item !== undefined && item.buffer.length === 0 && !item.exhausted;
    });
    while (active.length > 0 && pageBudget.remaining > 0) {
      if (signal.aborted) {
        throw new SwitchboardError(
          'TIMEOUT',
          'Gmail search reached its 45-second deadline.',
          'Continue with next_cursor, or narrow the accounts, query, or date range.',
        );
      }
      const scheduled = active.slice(0, pageBudget.remaining);
      pageBudget.remaining -= scheduled.length;
      await mapLimit(scheduled, 3, async (alias) => {
        const pageState = state.accounts.get(alias);
        if (!pageState) return;
        const { account, gateway } = await this.provideGateway(alias);
        try {
          const page = await gateway.listMessages(
            state.query,
            pageSize,
            pageState.pageToken,
            signal,
            state.labelIds.get(alias),
          );
          const detailed = await mapLimit(page.messages, 5, async (message) => {
            if (!message.id) return null;
            return toSearchResult(await gateway.getMessage(message.id, 'metadata', signal), account);
          });
          for (const item of detailed.filter((value): value is SearchResult => value !== null).sort(compareResults)) {
            if (!state.seen.has(item.message_id)) {
              state.seen.add(item.message_id);
              pageState.buffer.push(item);
            }
          }
          if (page.nextPageToken) pageState.pageToken = page.nextPageToken;
          else delete pageState.pageToken;
          pageState.exhausted = !page.nextPageToken;
        } catch (error) {
          if (signal.aborted) {
            throw new SwitchboardError(
              'TIMEOUT',
              'Gmail search reached its 45-second deadline.',
              'Continue with next_cursor, or narrow the accounts, query, or date range.',
              { cause: error },
            );
          }
          throw toSwitchboardError(error);
        }
      });
      active = state.aliases.filter((alias) => {
        const item = state.accounts.get(alias);
        return item !== undefined && item.buffer.length === 0 && !item.exhausted;
      });
    }
  }

  private pruneExpiredCursors(): void {
    const now = Date.now();
    for (const [key, value] of this.cursors) {
      if (now - value.lastUsedAt > CURSOR_TTL_MS) this.cursors.delete(key);
    }
  }

  private enforceCursorCapacity(): void {
    while (this.cursors.size >= CURSOR_CAPACITY) {
      const oldest = this.cursors.keys().next().value;
      if (!oldest) break;
      this.cursors.delete(oldest);
    }
  }
}
