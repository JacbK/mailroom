import type { gmail_v1 } from '@googleapis/gmail';
import { withRetry } from './retry.js';

export interface GmailGateway {
  profile(): Promise<gmail_v1.Schema$Profile>;
  listMessages(query: string, maxResults: number, pageToken?: string): Promise<{
    messages: gmail_v1.Schema$Message[];
    nextPageToken?: string;
  }>;
  getMessage(id: string, format: 'metadata' | 'full'): Promise<gmail_v1.Schema$Message>;
  getThread(id: string): Promise<gmail_v1.Schema$Thread>;
  getAttachment(messageId: string, attachmentId: string): Promise<gmail_v1.Schema$MessagePartBody>;
}

export class GoogleGmailGateway implements GmailGateway {
  public constructor(private readonly gmail: gmail_v1.Gmail) {}

  public async profile(): Promise<gmail_v1.Schema$Profile> {
    const response = await withRetry(async () => await this.gmail.users.getProfile({ userId: 'me' }));
    return response.data;
  }

  public async listMessages(
    query: string,
    maxResults: number,
    pageToken?: string,
  ): Promise<{ messages: gmail_v1.Schema$Message[]; nextPageToken?: string }> {
    const params: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: 'me',
      maxResults,
    };
    if (query) params.q = query;
    if (pageToken) params.pageToken = pageToken;
    const response = await withRetry(async () => await this.gmail.users.messages.list(params));
    const result: { messages: gmail_v1.Schema$Message[]; nextPageToken?: string } = {
      messages: response.data.messages ?? [],
    };
    if (response.data.nextPageToken) result.nextPageToken = response.data.nextPageToken;
    return result;
  }

  public async getMessage(id: string, format: 'metadata' | 'full'): Promise<gmail_v1.Schema$Message> {
    const params: gmail_v1.Params$Resource$Users$Messages$Get = {
      userId: 'me',
      id,
      format,
    };
    if (format === 'metadata') params.metadataHeaders = ['Subject', 'From', 'To', 'Date'];
    const response = await withRetry(async () => await this.gmail.users.messages.get(params));
    return response.data;
  }

  public async getThread(id: string): Promise<gmail_v1.Schema$Thread> {
    const response = await withRetry(async () => await this.gmail.users.threads.get({
      userId: 'me',
      id,
      format: 'full',
    }));
    return response.data;
  }

  public async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<gmail_v1.Schema$MessagePartBody> {
    const response = await withRetry(async () => await this.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    }));
    return response.data;
  }
}
