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
  public labelFilters: string[][] = [];
  public readonly attachments = new Map<string, string>();
  public readonly labels: gmail_v1.Schema$Label[] = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'DRAFT', name: 'DRAFT', type: 'system' },
  ];
  public readonly drafts = new Map<string, gmail_v1.Schema$Draft>();
  public readonly modifications: Array<{
    messageIds: string[];
    addLabelIds: string[];
    removeLabelIds: string[];
  }> = [];
  public readonly trashed: string[] = [];
  public readonly sent: Array<{ raw: string; threadId?: string }> = [];

  public constructor(
    private readonly messages: gmail_v1.Schema$Message[],
    private readonly pageSize = 2,
    private readonly profileEmail = 'user@example.com',
  ) {}

  public async profile(): Promise<gmail_v1.Schema$Profile> {
    return { emailAddress: this.profileEmail };
  }

  public async listMessages(
    query: string,
    _maxResults: number,
    pageToken?: string,
    _signal?: AbortSignal,
    labelIds?: string[],
  ): Promise<{
    messages: gmail_v1.Schema$Message[];
    nextPageToken?: string;
  }> {
    this.queries.push(query);
    this.labelFilters.push(labelIds ?? []);
    const offset = pageToken ? Number(pageToken) : 0;
    const page = this.messages.slice(offset, offset + this.pageSize).map((item) => ({ id: item.id ?? null }));
    const next = offset + this.pageSize;
    return next < this.messages.length
      ? { messages: page, nextPageToken: String(next) }
      : { messages: page };
  }

  public async getMessage(id: string, format: 'metadata' | 'full' | 'raw'): Promise<gmail_v1.Schema$Message> {
    const found = this.messages.find((item) => item.id === id);
    if (!found) throw Object.assign(new Error('Not found'), { code: 404 });
    if (format === 'raw') return { ...found, raw: encodeBody('From: user@example.com\n\nDraft body') };
    return found;
  }

  public async getThread(id: string): Promise<gmail_v1.Schema$Thread> {
    return { id, messages: this.messages.filter((item) => item.threadId === id) };
  }

  public async getAttachment(_messageId: string, attachmentId: string): Promise<gmail_v1.Schema$MessagePartBody> {
    const value = this.attachments.get(attachmentId) ?? '';
    return { data: Buffer.from(value).toString('base64url'), size: Buffer.byteLength(value) };
  }

  public async listLabels(): Promise<gmail_v1.Schema$Label[]> {
    return this.labels;
  }

  public async createLabel(label: gmail_v1.Schema$Label): Promise<gmail_v1.Schema$Label> {
    const created = { ...label, id: `label-${this.labels.length}` };
    this.labels.push(created);
    return created;
  }

  public async batchModify(
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    this.modifications.push({ messageIds, addLabelIds, removeLabelIds });
  }

  public async trashMessage(messageId: string): Promise<gmail_v1.Schema$Message> {
    this.trashed.push(messageId);
    return this.messages.find((item) => item.id === messageId) ?? { id: messageId };
  }

  public async listDrafts(maxResults: number, pageToken?: string): Promise<{
    drafts: gmail_v1.Schema$Draft[];
    nextPageToken?: string;
  }> {
    const offset = pageToken ? Number(pageToken) : 0;
    const values = [...this.drafts.values()];
    const drafts = values.slice(offset, offset + maxResults);
    const next = offset + maxResults;
    return next < values.length ? { drafts, nextPageToken: String(next) } : { drafts };
  }

  public async getDraft(id: string): Promise<gmail_v1.Schema$Draft> {
    const draft = this.drafts.get(id);
    if (!draft) throw Object.assign(new Error('Not found'), { code: 404 });
    return draft;
  }

  public async createDraft(raw: string, threadId?: string): Promise<gmail_v1.Schema$Draft> {
    const id = `draft-${this.drafts.size + 1}`;
    const draft = { id, message: { id: `message-${id}`, threadId: threadId ?? `thread-${id}`, raw } };
    this.drafts.set(id, draft);
    return draft;
  }

  public async updateDraft(id: string, raw: string, threadId?: string): Promise<gmail_v1.Schema$Draft> {
    const draft = { id, message: { id: `message-${id}`, threadId: threadId ?? `thread-${id}`, raw } };
    this.drafts.set(id, draft);
    return draft;
  }

  public async sendDraft(id: string): Promise<gmail_v1.Schema$Message> {
    const draft = await this.getDraft(id);
    this.drafts.delete(id);
    return draft.message ?? { id: `message-${id}`, threadId: `thread-${id}` };
  }

  public async sendMessage(raw: string, threadId?: string): Promise<gmail_v1.Schema$Message> {
    this.sent.push({ raw, ...(threadId ? { threadId } : {}) });
    const id = `sent-${this.sent.length}`;
    return { id, threadId: threadId ?? `thread-${id}` };
  }
}
