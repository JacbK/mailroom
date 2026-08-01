import { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, SearchPage } from '../types.js';
import { GmailClientFactory } from './client-factory.js';
import {
  OperationConnections,
  type ConnectedGateway,
  type GatewayProvider,
} from './connections.js';
import { GmailDrafts, type OutgoingMessageInput } from './drafts.js';
import { GoogleGmailGateway } from './gateway.js';
import { GmailMutations } from './mutations.js';
import { GmailReads } from './reads.js';
import { GmailSearch, type SearchInput } from './search.js';

function defaultProvider(factory: GmailClientFactory): GatewayProvider {
  return async (alias): Promise<ConnectedGateway> => {
    const connection = await factory.connect(alias);
    return { account: connection.account, gateway: new GoogleGmailGateway(connection.gmail) };
  };
}

/**
 * Stable façade for the MCP and CLI surfaces. Domain behavior lives in focused
 * readers, search/pagination, mutation, and draft/compose services.
 */
export class GmailService {
  private readonly reads: GmailReads;
  private readonly searchService: GmailSearch;
  private readonly mutations: GmailMutations;
  private readonly drafts: GmailDrafts;

  public constructor(
    config = new ConfigStore(),
    factory = new GmailClientFactory(config),
    provideGateway: GatewayProvider = defaultProvider(factory),
  ) {
    const connections = new OperationConnections(provideGateway);
    this.reads = new GmailReads(config, connections);
    this.searchService = new GmailSearch(config, connections);
    this.mutations = new GmailMutations(config, connections);
    this.drafts = new GmailDrafts(connections);
  }

  public async accounts(): ReturnType<GmailReads['accounts']> {
    return await this.reads.accounts();
  }

  public async profiles(aliases?: string[]): ReturnType<GmailReads['profiles']> {
    return await this.reads.profiles(aliases);
  }

  public async search(input: SearchInput): Promise<SearchPage> {
    return await this.searchService.search(input);
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

  public async readEmail(
    qualifiedMessageId: string,
    includeRawMime = false,
  ): ReturnType<GmailReads['readEmail']> {
    return await this.reads.readEmail(qualifiedMessageId, includeRawMime);
  }

  public async batchReadEmail(messageIds: string[]): ReturnType<GmailReads['batchReadEmail']> {
    return await this.reads.batchReadEmail(messageIds);
  }

  public async readEmailThread(
    input: Parameters<GmailReads['readEmailThread']>[0],
  ): ReturnType<GmailReads['readEmailThread']> {
    return await this.reads.readEmailThread(input);
  }

  public async batchReadEmailThreads(
    input: Parameters<GmailReads['batchReadEmailThreads']>[0],
  ): ReturnType<GmailReads['batchReadEmailThreads']> {
    return await this.reads.batchReadEmailThreads(input);
  }

  public async getMessage(qualifiedMessageId: string): ReturnType<GmailReads['getMessage']> {
    return await this.reads.getMessage(qualifiedMessageId);
  }

  public async getThread(
    qualifiedThreadId: string,
    maxMessages = 100,
  ): ReturnType<GmailReads['getThread']> {
    return await this.reads.getThread(qualifiedThreadId, maxMessages);
  }

  public async getAttachment(
    input: Parameters<GmailReads['getAttachment']>[0],
  ): ReturnType<GmailReads['getAttachment']> {
    return await this.reads.getAttachment(input);
  }

  public async listLabels(aliases?: string[]): ReturnType<GmailMutations['listLabels']> {
    return await this.mutations.listLabels(aliases);
  }

  public async createLabel(
    input: Parameters<GmailMutations['createLabel']>[0],
  ): ReturnType<GmailMutations['createLabel']> {
    return await this.mutations.createLabel(input);
  }

  public async applyLabelsToEmails(
    input: Parameters<GmailMutations['applyLabelsToEmails']>[0],
  ): ReturnType<GmailMutations['applyLabelsToEmails']> {
    return await this.mutations.applyLabelsToEmails(input);
  }

  public async bulkLabelMatchingEmails(
    input: Parameters<GmailMutations['bulkLabelMatchingEmails']>[0],
  ): ReturnType<GmailMutations['bulkLabelMatchingEmails']> {
    return await this.mutations.bulkLabelMatchingEmails(input);
  }

  public async batchModifyEmail(
    input: Parameters<GmailMutations['batchModifyEmail']>[0],
  ): ReturnType<GmailMutations['batchModifyEmail']> {
    return await this.mutations.batchModifyEmail(input);
  }

  public async archiveEmails(messageIds: string[]): ReturnType<GmailMutations['archiveEmails']> {
    return await this.mutations.archiveEmails(messageIds);
  }

  public async trashEmails(messageIds: string[]): ReturnType<GmailMutations['trashEmails']> {
    return await this.mutations.trashEmails(messageIds);
  }

  public async listDrafts(
    input: Parameters<GmailDrafts['listDrafts']>[0],
  ): ReturnType<GmailDrafts['listDrafts']> {
    return await this.drafts.listDrafts(input);
  }

  public async createDraft(input: OutgoingMessageInput): ReturnType<GmailDrafts['createDraft']> {
    return await this.drafts.createDraft(input);
  }

  public async updateDraft(
    input: Parameters<GmailDrafts['updateDraft']>[0],
  ): ReturnType<GmailDrafts['updateDraft']> {
    return await this.drafts.updateDraft(input);
  }

  public async sendDraft(draftId: string): ReturnType<GmailDrafts['sendDraft']> {
    return await this.drafts.sendDraft(draftId);
  }

  public async sendEmail(input: OutgoingMessageInput): ReturnType<GmailDrafts['sendEmail']> {
    return await this.drafts.sendEmail(input);
  }

  public async forwardEmails(
    input: Parameters<GmailDrafts['forwardEmails']>[0],
  ): ReturnType<GmailDrafts['forwardEmails']> {
    return await this.drafts.forwardEmails(input);
  }
}

export type { OutgoingMessageInput, SearchInput };
