import { randomUUID } from 'node:crypto';
import { MailroomError, toMailroomError } from '../errors.js';
import type { ConfigStore } from '../storage/config-store.js';
import type { SearchPage, SearchResult } from '../types.js';
import { mapLimit } from './concurrency.js';
import type { OperationConnections } from './connections.js';
import { parseQualifiedId } from './ids.js';
import { toSearchResult } from './parser.js';

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const CURSOR_CAPACITY = 100;
const SEARCH_DEADLINE_MS = 45_000;
const MIN_PAGE_FETCH_BUDGET = 12;
const MAX_PAGE_FETCH_BUDGET = 40;

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

export const SYSTEM_LABEL_IDS = new Set([
  'CHAT', 'DRAFT', 'IMPORTANT', 'INBOX', 'SENT', 'SPAM', 'STARRED', 'TRASH', 'UNREAD',
  'CATEGORY_FORUMS', 'CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES',
]);

function dateFilter(value: string | undefined, name: 'after' | 'before'): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = match !== null
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  if (!valid) {
    throw new MailroomError(
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

function labelIdsForAlias(labelIds: string[] | undefined, alias: string): string[] {
  if (!labelIds) return [];
  const result: string[] = [];
  for (const labelId of labelIds) {
    if (SYSTEM_LABEL_IDS.has(labelId)) result.push(labelId);
    else if (labelId.includes(':')) {
      const parsed = parseQualifiedId(labelId);
      if (parsed.alias === alias) result.push(parsed.gmailId);
    } else {
      throw new MailroomError(
        'AMBIGUOUS_ID',
        `User label ID "${labelId}" is missing its account alias.`,
        'Use the qualified label ID returned by `gmail_list_labels`.',
      );
    }
  }
  return [...new Set(result)];
}

export class GmailSearch {
  private readonly cursors = new Map<string, CursorState>();
  private readonly activeCursors = new Set<string>();

  public constructor(
    private readonly config: ConfigStore,
    private readonly connections: OperationConnections,
  ) {}

  public async search(input: SearchInput): Promise<SearchPage> {
    return await this.connections.run(async () => {
      const cursor = input.cursor;
      if (cursor && this.activeCursors.has(cursor)) {
        throw new MailroomError(
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
    });
  }

  private async searchUnlocked(input: SearchInput): Promise<SearchPage> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new MailroomError(
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
        throw new MailroomError(
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
        throw new MailroomError(
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
          throw new MailroomError(
            'ACCOUNT_NOT_FOUND',
            `No Gmail account is configured with alias "${alias}".`,
            `Available aliases: ${configured.map((account) => account.alias).join(', ')}.`,
          );
        }
      }
      const userLabelAliases = new Set((input.labelIds ?? []).flatMap((labelId) => {
        if (SYSTEM_LABEL_IDS.has(labelId)) return [];
        if (!labelId.includes(':')) {
          throw new MailroomError(
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
        throw new MailroomError(
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
        if (!(error instanceof MailroomError) || error.code !== 'TIMEOUT') throw error;
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
    if (!hasMore) this.cursors.delete(cursorId);
    const accountConfigs = await Promise.all(
      state.aliases.map(async (alias) => await this.config.get(alias)),
    );
    return {
      results,
      next_cursor: hasMore ? cursorId : null,
      result_count: results.length,
      searched_accounts: accountConfigs,
      partial: partialReason !== null,
      partial_reason: partialReason,
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
        throw new MailroomError(
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
        const { account, gateway } = await this.connections.get(alias);
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
            throw new MailroomError(
              'TIMEOUT',
              'Gmail search reached its 45-second deadline.',
              'Continue with next_cursor, or narrow the accounts, query, or date range.',
              { cause: error },
            );
          }
          throw toMailroomError(error);
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
