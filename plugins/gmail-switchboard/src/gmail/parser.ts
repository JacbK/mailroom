import { convert } from 'html-to-text';
import type { gmail_v1 } from '@googleapis/gmail';
import type { AccountConfig, AttachmentInfo, MessageView, SearchResult } from '../types.js';
import { qualifyId } from './ids.js';

const BODY_LIMIT = 50_000;
const THREAD_MESSAGE_BODY_LIMIT = 20_000;

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export function headerOf(message: gmail_v1.Schema$Message, name: string): string {
  const match = message.payload?.headers?.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return match?.value?.trim() ?? '';
}

function recipients(value: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectParts(part: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap((child) => collectParts(child))];
}

function bodyText(message: gmail_v1.Schema$Message, limit: number): {
  text: string;
  truncated: boolean;
} {
  const parts = collectParts(message.payload);
  const plain = parts
    .filter((part) => part.mimeType?.toLowerCase() === 'text/plain' && part.body?.data)
    .map((part) => decodeBase64Url(part.body?.data ?? ''))
    .join('\n\n')
    .trim();
  const html = parts
    .filter((part) => part.mimeType?.toLowerCase() === 'text/html' && part.body?.data)
    .map((part) => decodeBase64Url(part.body?.data ?? ''))
    .join('\n\n');
  const full = plain || (html ? convert(html, {
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
    wordwrap: false,
  }).trim() : '');
  if (full.length <= limit) return { text: full, truncated: false };
  return { text: `${full.slice(0, limit)}\n[truncated]`, truncated: true };
}

function dateOf(message: gmail_v1.Schema$Message): string | null {
  const millis = Number(message.internalDate);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  const parsed = Date.parse(headerOf(message, 'Date'));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function gmailUrl(account: AccountConfig, threadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.email)}#all/${encodeURIComponent(threadId)}`;
}

export function attachmentsOf(message: gmail_v1.Schema$Message): AttachmentInfo[] {
  return collectParts(message.payload)
    .filter((part) => Boolean(part.body?.attachmentId))
    .map((part) => ({
      id: part.body?.attachmentId ?? '',
      filename: part.filename || 'attachment',
      mimeType: part.mimeType || 'application/octet-stream',
      size: part.body?.size ?? 0,
    }));
}

function requiredId(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`Gmail message is missing ${label}.`);
  return value;
}

export function toSearchResult(
  message: gmail_v1.Schema$Message,
  account: AccountConfig,
): SearchResult {
  const messageId = requiredId(message.id, 'message ID');
  const threadId = requiredId(message.threadId, 'thread ID');
  return {
    account_alias: account.alias,
    account_email: account.email,
    message_id: qualifyId(account.alias, messageId),
    thread_id: qualifyId(account.alias, threadId),
    subject: headerOf(message, 'Subject') || '(no subject)',
    from: headerOf(message, 'From'),
    to: recipients(headerOf(message, 'To')),
    date: dateOf(message),
    snippet: message.snippet?.trim() ?? '',
    labels: message.labelIds ?? [],
    gmail_url: gmailUrl(account, threadId),
  };
}

export function toMessageView(
  message: gmail_v1.Schema$Message,
  account: AccountConfig,
  bodyLimit = BODY_LIMIT,
): MessageView {
  const summary = toSearchResult(message, account);
  const body = bodyText(message, bodyLimit);
  return {
    ...summary,
    cc: recipients(headerOf(message, 'Cc')),
    body_text: body.text,
    body_truncated: body.truncated,
    attachments: attachmentsOf(message),
  };
}

export function toThreadMessageView(
  message: gmail_v1.Schema$Message,
  account: AccountConfig,
): MessageView {
  return toMessageView(message, account, THREAD_MESSAGE_BODY_LIMIT);
}
