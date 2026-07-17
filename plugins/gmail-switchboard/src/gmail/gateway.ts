import type { gmail_v1 } from '@googleapis/gmail';
import { withRetry } from './retry.js';

const GOOGLE_REQUEST_TIMEOUT_MS = 20_000;
function requestOptions(signal?: AbortSignal): { timeout: number; signal?: AbortSignal } {
  return signal
    ? { timeout: GOOGLE_REQUEST_TIMEOUT_MS, signal }
    : { timeout: GOOGLE_REQUEST_TIMEOUT_MS };
}

export interface GmailGateway {
  profile(signal?: AbortSignal): Promise<gmail_v1.Schema$Profile>;
  listMessages(query: string, maxResults: number, pageToken?: string, signal?: AbortSignal, labelIds?: string[]): Promise<{
    messages: gmail_v1.Schema$Message[];
    nextPageToken?: string;
  }>;
  getMessage(id: string, format: 'metadata' | 'full' | 'raw', signal?: AbortSignal): Promise<gmail_v1.Schema$Message>;
  getThread(id: string, signal?: AbortSignal): Promise<gmail_v1.Schema$Thread>;
  getAttachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<gmail_v1.Schema$MessagePartBody>;
  listLabels(signal?: AbortSignal): Promise<gmail_v1.Schema$Label[]>;
  createLabel(label: gmail_v1.Schema$Label): Promise<gmail_v1.Schema$Label>;
  batchModify(messageIds: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
  trashMessage(messageId: string): Promise<gmail_v1.Schema$Message>;
  listDrafts(maxResults: number, pageToken?: string, signal?: AbortSignal): Promise<{
    drafts: gmail_v1.Schema$Draft[];
    nextPageToken?: string;
  }>;
  getDraft(id: string, format: 'full' | 'raw', signal?: AbortSignal): Promise<gmail_v1.Schema$Draft>;
  createDraft(raw: string, threadId?: string): Promise<gmail_v1.Schema$Draft>;
  updateDraft(id: string, raw: string, threadId?: string): Promise<gmail_v1.Schema$Draft>;
  sendDraft(id: string): Promise<gmail_v1.Schema$Message>;
  sendMessage(raw: string, threadId?: string): Promise<gmail_v1.Schema$Message>;
}

export class GoogleGmailGateway implements GmailGateway {
  public constructor(private readonly gmail: gmail_v1.Gmail) {}

  public async profile(signal?: AbortSignal): Promise<gmail_v1.Schema$Profile> {
    const response = await withRetry(async () => await this.gmail.users.getProfile(
      { userId: 'me' },
      requestOptions(signal),
    ));
    return response.data;
  }

  public async listMessages(
    query: string,
    maxResults: number,
    pageToken?: string,
    signal?: AbortSignal,
    labelIds?: string[],
  ): Promise<{ messages: gmail_v1.Schema$Message[]; nextPageToken?: string }> {
    const params: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: 'me',
      maxResults,
    };
    if (query) params.q = query;
    if (pageToken) params.pageToken = pageToken;
    if (labelIds?.length) params.labelIds = labelIds;
    const response = await withRetry(async () => await this.gmail.users.messages.list(
      params,
      requestOptions(signal),
    ));
    const result: { messages: gmail_v1.Schema$Message[]; nextPageToken?: string } = {
      messages: response.data.messages ?? [],
    };
    if (response.data.nextPageToken) result.nextPageToken = response.data.nextPageToken;
    return result;
  }

  public async getMessage(
    id: string,
    format: 'metadata' | 'full' | 'raw',
    signal?: AbortSignal,
  ): Promise<gmail_v1.Schema$Message> {
    const params: gmail_v1.Params$Resource$Users$Messages$Get = {
      userId: 'me',
      id,
      format,
    };
    if (format === 'metadata') params.metadataHeaders = ['Subject', 'From', 'To', 'Date'];
    const response = await withRetry(async () => await this.gmail.users.messages.get(
      params,
      requestOptions(signal),
    ));
    return response.data;
  }

  public async getThread(id: string, signal?: AbortSignal): Promise<gmail_v1.Schema$Thread> {
    const response = await withRetry(async () => await this.gmail.users.threads.get(
      {
        userId: 'me',
        id,
        format: 'full',
      },
      requestOptions(signal),
    ));
    return response.data;
  }

  public async getAttachment(
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<gmail_v1.Schema$MessagePartBody> {
    const response = await withRetry(async () => await this.gmail.users.messages.attachments.get(
      {
        userId: 'me',
        messageId,
        id: attachmentId,
      },
      requestOptions(signal),
    ));
    return response.data;
  }

  public async listLabels(signal?: AbortSignal): Promise<gmail_v1.Schema$Label[]> {
    const response = await withRetry(async () => await this.gmail.users.labels.list(
      { userId: 'me' },
      requestOptions(signal),
    ));
    return response.data.labels ?? [];
  }

  public async createLabel(label: gmail_v1.Schema$Label): Promise<gmail_v1.Schema$Label> {
    const response = await this.gmail.users.labels.create(
      { userId: 'me', requestBody: label },
      requestOptions(),
    );
    return response.data;
  }

  public async batchModify(
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    await withRetry(async () => await this.gmail.users.messages.batchModify(
      {
        userId: 'me',
        requestBody: {
          ids: messageIds,
          addLabelIds,
          removeLabelIds,
        },
      },
      requestOptions(),
    ));
  }

  public async trashMessage(messageId: string): Promise<gmail_v1.Schema$Message> {
    const response = await withRetry(async () => await this.gmail.users.messages.trash(
      { userId: 'me', id: messageId },
      requestOptions(),
    ));
    return response.data;
  }

  public async listDrafts(
    maxResults: number,
    pageToken?: string,
    signal?: AbortSignal,
  ): Promise<{ drafts: gmail_v1.Schema$Draft[]; nextPageToken?: string }> {
    const params: gmail_v1.Params$Resource$Users$Drafts$List = { userId: 'me', maxResults };
    if (pageToken) params.pageToken = pageToken;
    const response = await withRetry(async () => await this.gmail.users.drafts.list(
      params,
      requestOptions(signal),
    ));
    const result: { drafts: gmail_v1.Schema$Draft[]; nextPageToken?: string } = {
      drafts: response.data.drafts ?? [],
    };
    if (response.data.nextPageToken) result.nextPageToken = response.data.nextPageToken;
    return result;
  }

  public async getDraft(
    id: string,
    format: 'full' | 'raw',
    signal?: AbortSignal,
  ): Promise<gmail_v1.Schema$Draft> {
    const response = await withRetry(async () => await this.gmail.users.drafts.get(
      { userId: 'me', id, format },
      requestOptions(signal),
    ));
    return response.data;
  }

  public async createDraft(raw: string, threadId?: string): Promise<gmail_v1.Schema$Draft> {
    const response = await this.gmail.users.drafts.create(
      {
        userId: 'me',
        requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
      },
      requestOptions(),
    );
    return response.data;
  }

  public async updateDraft(
    id: string,
    raw: string,
    threadId?: string,
  ): Promise<gmail_v1.Schema$Draft> {
    const response = await this.gmail.users.drafts.update(
      {
        userId: 'me',
        id,
        requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
      },
      requestOptions(),
    );
    return response.data;
  }

  public async sendDraft(id: string): Promise<gmail_v1.Schema$Message> {
    const response = await this.gmail.users.drafts.send(
      { userId: 'me', requestBody: { id } },
      requestOptions(),
    );
    return response.data;
  }

  public async sendMessage(raw: string, threadId?: string): Promise<gmail_v1.Schema$Message> {
    const response = await this.gmail.users.messages.send(
      {
        userId: 'me',
        requestBody: { raw, ...(threadId ? { threadId } : {}) },
      },
      requestOptions(),
    );
    return response.data;
  }
}
