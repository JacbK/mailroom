import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';
import { marked } from 'marked';
import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { MailroomError } from '../errors.js';

const MAX_BODY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTGOING_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const transport = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: 'unix',
});

export type ComposeContentType = 'text/markdown' | 'text/html' | 'text/plain';

export interface BinaryAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ComposeInput {
  from: string;
  to: string;
  subject: string;
  body?: string | null;
  htmlBody?: string | null;
  bodyFile?: string;
  contentType?: ComposeContentType;
  cc?: string | null;
  bcc?: string | null;
  attachmentFiles?: string[];
  attachments?: BinaryAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface ParsedDraft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string | null;
  hasAttachments: boolean;
}

function invalid(message: string, recovery: string): MailroomError {
  return new MailroomError('INVALID_INPUT', message, recovery);
}

async function checkedFile(path: string, maxBytes: number): Promise<void> {
  if (!isAbsolute(path)) {
    throw invalid(`File path must be absolute: ${path}`, 'Pass an absolute local file path.');
  }
  const info = await stat(path);
  if (!info.isFile()) throw invalid(`Not a regular file: ${path}`, 'Choose a regular local file.');
  if (info.size > maxBytes) {
    throw invalid(`File is too large: ${path}`, `Use a file no larger than ${maxBytes} bytes.`);
  }
}

async function resolveBody(input: ComposeInput): Promise<{
  text: string;
  html?: string;
}> {
  let body = input.body ?? '';
  let type = input.contentType ?? 'text/markdown';
  if (input.bodyFile) {
    await checkedFile(input.bodyFile, MAX_BODY_FILE_BYTES);
    body = await readFile(input.bodyFile, 'utf8');
    if (!input.contentType && ['.htm', '.html'].includes(extname(input.bodyFile).toLowerCase())) {
      type = 'text/html';
    }
  }
  if (input.htmlBody !== undefined && input.htmlBody !== null) {
    return {
      text: body || convert(input.htmlBody, { wordwrap: false }),
      html: input.htmlBody,
    };
  }
  if (type === 'text/plain') return { text: body };
  if (type === 'text/html') return { text: convert(body, { wordwrap: false }), html: body };
  const rendered = await marked.parse(body, { async: true });
  return {
    text: body,
    html: sanitizeHtml(rendered, {
      allowedTags: sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'img'),
      allowedAttributes: { a: ['href', 'title'] },
      allowedSchemes: ['http', 'https', 'mailto'],
    }),
  };
}

function normalizeRecipients(value: string | null | undefined, self: string): string | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(',')
    .map((item) => item.trim() === 'me' ? self : item.trim())
    .filter(Boolean)
    .join(', ');
}

export async function buildRawMessage(input: ComposeInput): Promise<string> {
  const body = await resolveBody(input);
  let totalAttachmentBytes = input.attachments?.reduce(
    (sum, attachment) => sum + attachment.content.byteLength,
    0,
  ) ?? 0;
  const attachmentFiles = input.attachmentFiles ?? [];
  for (const path of attachmentFiles) {
    await checkedFile(path, MAX_OUTGOING_ATTACHMENT_BYTES);
    totalAttachmentBytes += (await stat(path)).size;
  }
  if (totalAttachmentBytes > MAX_OUTGOING_ATTACHMENT_BYTES) {
    throw invalid(
      'Outgoing attachments exceed the 25 MiB limit.',
      'Remove or shrink attachments before trying again.',
    );
  }
  const to = normalizeRecipients(input.to, input.from);
  if (!to) throw invalid('At least one recipient is required.', 'Pass one or more recipients in `to`.');
  const cc = normalizeRecipients(input.cc, input.from);
  const bcc = normalizeRecipients(input.bcc, input.from);
  const info = await transport.sendMail({
    from: input.from,
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    subject: input.subject,
    text: body.text,
    ...(body.html ? { html: body.html } : {}),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references?.length ? { references: input.references } : {}),
    attachments: [
      ...attachmentFiles.map((path) => ({ path })),
      ...(input.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      })),
    ],
  });
  if (!Buffer.isBuffer(info.message)) throw new Error('Could not build the outgoing MIME message.');
  return info.message.toString('base64url');
}

export async function parseDraft(rawBase64Url: string): Promise<ParsedDraft> {
  const parsed = await simpleParser(Buffer.from(rawBase64Url, 'base64url'));
  const addressText = (value: typeof parsed.to): string => (
    Array.isArray(value) ? value.map((item) => item.text).join(', ') : value?.text ?? ''
  );
  return {
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    bcc: addressText(parsed.bcc),
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : null,
    hasAttachments: parsed.attachments.length > 0,
  };
}
