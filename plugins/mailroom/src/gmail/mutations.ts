import { MailroomError, toMailroomError } from '../errors.js';
import type { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig } from '../types.js';
import { mapLimit } from './concurrency.js';
import type { OperationConnections } from './connections.js';
import { parseQualifiedId, qualifyId } from './ids.js';
import { SYSTEM_LABEL_IDS } from './search.js';

export class GmailMutations {
  public constructor(
    private readonly config: ConfigStore,
    private readonly connections: OperationConnections,
  ) {}

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
      const { gateway } = await this.connections.get(account.alias);
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
    const { account, gateway } = await this.connections.get(input.account);
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
      error?: ReturnType<MailroomError['toJSON']>;
    }>;
  }> {
    const groups = this.groupQualifiedIds(input.messageIds, 1_000);
    const accounts: Array<{
      alias: string;
      modified: number;
      error?: ReturnType<MailroomError['toJSON']>;
    }> = [];
    let modified = 0;
    for (const [alias, ids] of groups) {
      try {
        const { gateway } = await this.connections.get(alias);
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
              throw new MailroomError(
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
        accounts.push({ alias, modified: 0, error: toMailroomError(error).toJSON() });
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
    const { gateway } = await this.connections.get(input.account);
    const labels = await gateway.listLabels();
    let label = labels.find((item) => item.name === input.labelName);
    if (!label && input.createLabelIfMissing) label = await gateway.createLabel({ name: input.labelName });
    if (!label?.id) {
      throw new MailroomError(
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
        throw new MailroomError(
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
      error?: ReturnType<MailroomError['toJSON']>;
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
        throw new MailroomError(
          'INVALID_INPUT',
          'At least one label must be added or removed for each target account.',
          'Use qualified user-label IDs, system label IDs, or a purpose-built archive tool.',
        );
      }
    }
    const accounts: Array<{
      alias: string;
      modified: number;
      error?: ReturnType<MailroomError['toJSON']>;
    }> = [];
    let modified = 0;
    for (const { alias, ids, add, remove } of operations) {
      try {
        const { gateway } = await this.connections.get(alias);
        await gateway.batchModify(ids, add, remove);
        modified += ids.length;
        accounts.push({ alias, modified: ids.length });
      } catch (error) {
        accounts.push({ alias, modified: 0, error: toMailroomError(error).toJSON() });
      }
    }
    return { modified, accounts };
  }

  public async archiveEmails(messageIds: string[]): Promise<{
    archived: number;
    accounts: Array<{
      alias: string;
      archived: number;
      error?: ReturnType<MailroomError['toJSON']>;
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

  public async trashEmails(messageIds: string[]): Promise<{
    trashed: number;
    accounts: Array<{
      alias: string;
      trashed: number;
      failures: Array<{ message_id: string; error: ReturnType<MailroomError['toJSON']> }>;
    }>;
  }> {
    const groups = this.groupQualifiedIds(messageIds, 1_000);
    const accounts: Array<{
      alias: string;
      trashed: number;
      failures: Array<{ message_id: string; error: ReturnType<MailroomError['toJSON']> }>;
    }> = [];
    let trashed = 0;
    for (const [alias, ids] of groups) {
      const { gateway } = await this.connections.get(alias);
      const outcomes = await mapLimit(ids, 5, async (id) => {
        try {
          await gateway.trashMessage(id);
          return { id, ok: true as const };
        } catch (error) {
          return { id, ok: false as const, error: toMailroomError(error).toJSON() };
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

  private groupQualifiedIds(ids: string[], max: number): Map<string, string[]> {
    if (ids.length < 1 || ids.length > max) {
      throw new MailroomError('INVALID_INPUT', `Expected 1-${max} account-qualified IDs.`, 'Use a smaller batch.');
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
        throw new MailroomError(
          'AMBIGUOUS_ID',
          `User label ID "${label}" is missing its account alias.`,
          'Use the qualified label ID returned by `gmail_list_labels`.',
        );
      }
      const parsed = parseQualifiedId(label);
      return parsed.alias === alias ? [parsed.gmailId] : [];
    }))];
  }
}
