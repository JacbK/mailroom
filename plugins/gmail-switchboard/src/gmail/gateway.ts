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
  listMessages(query: string, maxResults: number, pageToken?: string, signal?: AbortSignal): Promise<{
    messages: gmail_v1.Schema$Message[];
    nextPageToken?: string;
  }>;
  getMessage(id: string, format: 'metadata' | 'full', signal?: AbortSignal): Promise<gmail_v1.Schema$Message>;
  getThread(id: string, signal?: AbortSignal): Promise<gmail_v1.Schema$Thread>;
  getAttachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<gmail_v1.Schema$MessagePartBody>;
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
  ): Promise<{ messages: gmail_v1.Schema$Message[]; nextPageToken?: string }> {
    const params: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: 'me',
      maxResults,
    };
    if (query) params.q = query;
    if (pageToken) params.pageToken = pageToken;
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
    format: 'metadata' | 'full',
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
}
