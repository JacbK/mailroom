import type { gmail_v1 } from '@googleapis/gmail';
import type { GmailGateway } from '../src/gmail/gateway.js';

export function encodeBody(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function message(input: {
  id: string;
  threadId?: string;
  date: string;
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  mimeType?: string;
  attachment?: { id: string; filename: string; mimeType: string; size: number };
}): gmail_v1.Schema$Message {
  const parts: gmail_v1.Schema$MessagePart[] = [];
  if (input.body !== undefined) {
    parts.push({
      mimeType: input.mimeType ?? 'text/plain',
      body: { data: encodeBody(input.body), size: Buffer.byteLength(input.body) },
    });
  }
  if (input.attachment) {
    parts.push({
      filename: input.attachment.filename,
      mimeType: input.attachment.mimeType,
      body: { attachmentId: input.attachment.id, size: input.attachment.size },
    });
  }
  return {
    id: input.id,
    threadId: input.threadId ?? `thread-${input.id}`,
    internalDate: String(Date.parse(input.date)),
    snippet: `snippet-${input.id}`,
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'Subject', value: input.subject ?? `Subject ${input.id}` },
        { name: 'From', value: input.from ?? 'sender@example.com' },
        { name: 'To', value: input.to ?? 'recipient@example.com' },
        { name: 'Date', value: input.date },
      ],
      parts,
    },
  };
}

export class FakeGateway implements GmailGateway {
  public queries: string[] = [];
  public readonly attachments = new Map<string, string>();

  public constructor(
    private readonly messages: gmail_v1.Schema$Message[],
    private readonly pageSize = 2,
    private readonly profileEmail = 'user@example.com',
  ) {}

  public async profile(): Promise<gmail_v1.Schema$Profile> {
    return { emailAddress: this.profileEmail };
  }

  public async listMessages(query: string, _maxResults: number, pageToken?: string): Promise<{
    messages: gmail_v1.Schema$Message[];
    nextPageToken?: string;
  }> {
    this.queries.push(query);
    const offset = pageToken ? Number(pageToken) : 0;
    const page = this.messages.slice(offset, offset + this.pageSize).map((item) => ({ id: item.id ?? null }));
    const next = offset + this.pageSize;
    return next < this.messages.length
      ? { messages: page, nextPageToken: String(next) }
      : { messages: page };
  }

  public async getMessage(id: string): Promise<gmail_v1.Schema$Message> {
    const found = this.messages.find((item) => item.id === id);
    if (!found) throw Object.assign(new Error('Not found'), { code: 404 });
    return found;
  }

  public async getThread(id: string): Promise<gmail_v1.Schema$Thread> {
    return { id, messages: this.messages.filter((item) => item.threadId === id) };
  }

  public async getAttachment(_messageId: string, attachmentId: string): Promise<gmail_v1.Schema$MessagePartBody> {
    const value = this.attachments.get(attachmentId) ?? '';
    return { data: Buffer.from(value).toString('base64url'), size: Buffer.byteLength(value) };
  }
}
