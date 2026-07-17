import { createHash, randomUUID } from 'node:crypto';
import { SwitchboardError, toSwitchboardError } from '../errors.js';
import { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, MessageView, SearchPage, SearchResult } from '../types.js';
import { GmailClientFactory } from './client-factory.js';
import { GoogleGmailGateway, type GmailGateway } from './gateway.js';
import { parseQualifiedId } from './ids.js';
import { attachmentsOf, toMessageView, toSearchResult, toThreadMessageView } from './parser.js';

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const CURSOR_CAPACITY = 100;
const HARD_ATTACHMENT_LIMIT = 5 * 1024 * 1024;
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
      const aliases = input.accounts?.length
        ? [...new Set(input.accounts)]
        : configured.map((account) => account.alias);
      for (const alias of aliases) {
        if (!configured.some((account) => account.alias === alias)) {
          throw new SwitchboardError(
            'ACCOUNT_NOT_FOUND',
            `No Gmail account is configured with alias "${alias}".`,
            `Available aliases: ${configured.map((account) => account.alias).join(', ')}.`,
          );
        }
      }
      const parts = [input.query?.trim(), dateFilter(input.after, 'after'), dateFilter(input.before, 'before')]
        .filter((part): part is string => Boolean(part));
      state = {
        lastUsedAt: Date.now(),
        query: parts.join(' '),
        aliases,
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

  public async getThread(qualifiedThreadId: string): Promise<{
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
      const messages = all.slice(-100).map((message) => toThreadMessageView(message, account));
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
    attachmentId: string;
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
    const metadata = attachmentsOf(message).find((item) => item.id === input.attachmentId);
    if (!metadata) {
      throw new SwitchboardError(
        'INVALID_INPUT',
        'The requested attachment does not belong to this message.',
        'Reuse the attachment ID returned by `gmail_get_message`.',
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
    const body = await gateway.getAttachment(gmailId, input.attachmentId);
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
      attachment_id: input.attachmentId,
      filename: metadata.filename,
      mime_type: metadata.mimeType,
      size: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      base64_data: data.toString('base64'),
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
