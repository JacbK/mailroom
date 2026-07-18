import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.MAILROOM_LIVE_E2E !== '1') {
  throw new Error('Live Gmail tests are disabled. Set MAILROOM_LIVE_E2E=1 for a release check.');
}

const aliases = {
  personal: process.env.MAILROOM_E2E_PERSONAL_ALIAS ?? 'personal',
  work: process.env.MAILROOM_E2E_WORK_ALIAS ?? 'work',
};
const expectedEmails = {
  personal: process.env.MAILROOM_E2E_PERSONAL_EMAIL ?? 'jacobk2112@gmail.com',
  work: process.env.MAILROOM_E2E_WORK_EMAIL ?? 'jacob@embrasure.ai',
};
const runId = randomUUID();
const marker = `mailroom-e2e-${runId}`;
const labelName = 'mailroom-e2e';
const directory = await mkdtemp(join(tmpdir(), 'mailroom-live-e2e-'));
const attachment = join(directory, 'mailroom-e2e.txt');
await writeFile(attachment, `Mailroom live test ${runId}\n`, { mode: 0o600 });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, '../dist/server.js')],
  stderr: 'inherit',
});
const client = new Client({ name: 'mailroom-live-e2e', version: '1.0.0' });

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) {
    const detail = response.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`);
  }
  if (response.structuredContent) return response.structuredContent;
  const text = response.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : {};
}

async function pollSearch(account, query, minimum = 1) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const page = await call('gmail_search_emails', { accounts: [account], query, limit: 20 });
    if (page.results.length >= minimum) return page;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for Gmail search: ${query}`);
}

async function cleanupDrafts() {
  for (const alias of Object.values(aliases)) {
    const page = await call('gmail_list_drafts', { account: alias, max_results: 100 });
    for (const draft of page.drafts.filter((item) => item.message.subject.includes(marker))) {
      await call('gmail_send_draft', { draft_id: draft.draft_id });
    }
  }
}

async function trashRunMail() {
  const ids = await call('gmail_search_email_ids', {
    accounts: Object.values(aliases),
    query: `in:anywhere ${marker}`,
    limit: 50,
  });
  if (ids.message_ids.length > 0) {
    await call('gmail_delete_emails', { message_ids: ids.message_ids });
  }
  return ids.message_ids.length;
}

let cleanupCount = 0;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 22);

  const accountResult = await call('gmail_accounts');
  const byAlias = new Map(accountResult.accounts.map((account) => [account.alias, account]));
  assert.equal(byAlias.get(aliases.personal)?.email, expectedEmails.personal);
  assert.equal(byAlias.get(aliases.work)?.email, expectedEmails.work);
  assert.equal(byAlias.get(aliases.personal)?.status, 'connected');
  assert.equal(byAlias.get(aliases.work)?.status, 'connected');

  const profiles = await call('gmail_get_profile', { accounts: Object.values(aliases) });
  assert.equal(profiles.profiles.length, 2);

  await call('gmail_create_label', { account: aliases.personal, name: labelName });
  await call('gmail_create_label', { account: aliases.work, name: labelName });
  const labels = await call('gmail_list_labels', { accounts: Object.values(aliases) });
  assert.equal(labels.accounts.length, 2);

  const draft = await call('gmail_create_draft', {
    account: aliases.personal,
    to: expectedEmails.work,
    subject: `${marker} draft`,
    body: `Created by Mailroom release test ${runId}.`,
  });
  const updatedDraft = await call('gmail_update_draft', {
    draft_id: draft.draft_id,
    subject: `${marker} updated draft`,
    body: `Updated by Mailroom release test ${runId}.`,
  });
  const drafts = await call('gmail_list_drafts', { account: aliases.personal, max_results: 100 });
  assert(drafts.drafts.some((item) => item.draft_id === updatedDraft.draft_id));
  await call('gmail_send_draft', { draft_id: updatedDraft.draft_id });

  await call('gmail_send_email', {
    account: aliases.personal,
    to: expectedEmails.work,
    subject: `${marker} attachment`,
    body: `Attachment check ${runId}.`,
    attachment_files: [attachment],
  });
  await call('gmail_send_email', {
    account: aliases.work,
    to: expectedEmails.personal,
    subject: `${marker} routing`,
    body: `Cross-account routing check ${runId}.`,
  });

  const workPage = await pollSearch(aliases.work, `subject:"${marker} attachment"`);
  const personalPage = await pollSearch(aliases.personal, `subject:"${marker} routing"`);
  const workMessage = workPage.results[0];
  const personalMessage = personalPage.results[0];
  assert(workMessage.message_id.startsWith(`${aliases.work}:`));
  assert(personalMessage.message_id.startsWith(`${aliases.personal}:`));

  const merged = await call('gmail_search_emails', {
    accounts: Object.values(aliases),
    query: marker,
    limit: 20,
  });
  assert(merged.results.some((item) => item.account_alias === aliases.personal));
  assert(merged.results.some((item) => item.account_alias === aliases.work));
  const ids = await call('gmail_search_email_ids', {
    accounts: Object.values(aliases),
    query: marker,
    limit: 20,
  });
  assert(ids.message_ids.every((id) => id.includes(':')));

  await call('gmail_read_email', { message_id: workMessage.message_id });
  await call('gmail_batch_read_email', {
    message_ids: [workMessage.message_id, personalMessage.message_id],
  });
  await call('gmail_read_email_thread', { id: workMessage.message_id });
  await call('gmail_batch_read_email_threads', {
    ids: [workMessage.thread_id, personalMessage.thread_id],
    id_type: 'thread',
  });
  const attachmentResult = await call('gmail_read_attachment', {
    message_id: workMessage.message_id,
    filename: 'mailroom-e2e.txt',
  });
  assert.equal(attachmentResult.filename, 'mailroom-e2e.txt');

  await call('gmail_apply_labels_to_emails', {
    message_ids: [workMessage.message_id],
    add_label_names: [labelName],
  });
  await call('gmail_bulk_label_matching_emails', {
    account: aliases.personal,
    query: `subject:"${marker} routing"`,
    label_name: labelName,
  });
  await call('gmail_batch_modify_email', {
    message_ids: [personalMessage.message_id],
    add_labels: ['STARRED'],
  });
  await call('gmail_archive_emails', { message_ids: [personalMessage.message_id] });
  await call('gmail_forward_emails', {
    message_ids: [workMessage.message_id],
    to: expectedEmails.personal,
    note: marker,
  });

  await pollSearch(aliases.personal, marker, 2);
  cleanupCount = await trashRunMail();
  assert(cleanupCount >= 3);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    accounts: Object.values(aliases),
    tools_checked: tools.tools.length,
    trashed_messages: cleanupCount,
  })}\n`);
} finally {
  try {
    await cleanupDrafts();
    cleanupCount = Math.max(cleanupCount, await trashRunMail());
  } catch (error) {
    process.stderr.write(`Live E2E cleanup needs attention: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  }
  await client.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
