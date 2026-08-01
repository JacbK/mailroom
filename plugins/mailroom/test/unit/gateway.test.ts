import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it, vi } from 'vitest';
import { GoogleGmailGateway } from '../../src/gmail/gateway.js';

function response<T>(data: T) {
  return vi.fn(async (...args: unknown[]) => {
    void args;
    return { data };
  });
}

function gmailWithSpies() {
  const getProfile = response({ emailAddress: 'user@example.com' });
  const listMessages = response({ messages: [{ id: 'm1' }] });
  const getMessage = response({ id: 'm1' });
  const getThread = response({ id: 't1' });
  const getAttachment = response({ data: 'YQ', size: 1 });
  const listLabels = response({ labels: [{ id: 'INBOX', name: 'INBOX' }] });
  const listDrafts = response({ drafts: [{ id: 'd1' }] });
  const getDraft = response({ id: 'd1' });
  const gmail = {
    users: {
      getProfile,
      messages: {
        list: listMessages,
        get: getMessage,
        attachments: { get: getAttachment },
      },
      threads: { get: getThread },
      labels: { list: listLabels },
      drafts: {
        list: listDrafts,
        get: getDraft,
      },
    },
  } as unknown as gmail_v1.Gmail;
  return {
    gmail,
    getProfile,
    listMessages,
    getMessage,
    getThread,
    getAttachment,
    listLabels,
    listDrafts,
    getDraft,
  };
}

describe('Google Gmail gateway response shaping', () => {
  it('requests only the fields used by search and account views', async () => {
    const spies = gmailWithSpies();
    const gateway = new GoogleGmailGateway(spies.gmail);

    await gateway.profile();
    await gateway.listMessages('from:person@example.com', 25);
    await gateway.getMessage('m1', 'metadata');
    await gateway.listLabels();

    expect(spies.getProfile.mock.calls[0]?.[0]).toMatchObject({
      fields: 'emailAddress,messagesTotal,threadsTotal,historyId',
    });
    expect(spies.listMessages.mock.calls[0]?.[0]).toMatchObject({
      fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate',
    });
    expect(spies.getMessage.mock.calls[0]?.[0]).toMatchObject({
      fields: 'id,threadId,labelIds,internalDate,snippet,payload(headers)',
      metadataHeaders: ['Subject', 'From', 'To', 'Date'],
    });
    expect(spies.listLabels.mock.calls[0]?.[0]).toMatchObject({
      fields: 'labels(id,name,type,messagesTotal,messagesUnread,threadsTotal,threadsUnread)',
    });
  });

  it('uses bounded field sets for draft listings and reads', async () => {
    const spies = gmailWithSpies();
    const gateway = new GoogleGmailGateway(spies.gmail);

    await gateway.listDrafts(20);
    await gateway.getDraft('d1', 'raw');
    await gateway.getDraft('d1', 'full');

    expect(spies.listDrafts.mock.calls[0]?.[0]).toMatchObject({
      fields: 'drafts(id,message(id,threadId)),nextPageToken,resultSizeEstimate',
    });
    expect(spies.getDraft.mock.calls[0]?.[0]).toMatchObject({
      fields: 'id,message(id,threadId,raw)',
    });
    expect(spies.getDraft.mock.calls[1]?.[0]).toMatchObject({
      fields: 'id,message(id,threadId,labelIds,internalDate,snippet,payload)',
    });
  });

  it('pins full, raw, thread, and attachment field masks', async () => {
    const spies = gmailWithSpies();
    const gateway = new GoogleGmailGateway(spies.gmail);

    await gateway.getMessage('m1', 'full');
    await gateway.getMessage('m1', 'raw');
    await gateway.getThread('t1');
    await gateway.getAttachment('m1', 'a1');

    expect(spies.getMessage.mock.calls[0]?.[0]).toMatchObject({
      fields: 'id,threadId,labelIds,internalDate,snippet,payload',
    });
    expect(spies.getMessage.mock.calls[1]?.[0]).toMatchObject({
      fields: 'id,threadId,raw',
    });
    expect(spies.getThread.mock.calls[0]?.[0]).toMatchObject({
      fields: 'id,messages(id,threadId,labelIds,internalDate,snippet,payload)',
    });
    expect(spies.getAttachment.mock.calls[0]?.[0]).toMatchObject({
      fields: 'data,size',
    });
  });

  it('passes abort signals through Google request options', async () => {
    const spies = gmailWithSpies();
    const gateway = new GoogleGmailGateway(spies.gmail);
    const controller = new AbortController();

    await gateway.profile(controller.signal);

    expect(spies.getProfile.mock.calls[0]?.[1]).toMatchObject({
      timeout: 20_000,
      signal: controller.signal,
    });
  });
});
