import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAccountRequestAvailable,
  parseAccountSpec,
  requestedAccounts,
} from './setup-accounts.mjs';

test('parses both account flag forms and removes exact duplicates', () => {
  assert.deepEqual(requestedAccounts([
    '--account', 'work=Me@Company.com',
    '--account=personal=me@gmail.com',
    '--account', 'work=me@company.com',
  ]), [
    { alias: 'work', email: 'me@company.com' },
    { alias: 'personal', email: 'me@gmail.com' },
  ]);
});

test('rejects malformed aliases and email addresses before OAuth', () => {
  assert.throws(() => parseAccountSpec('Work=me@company.com'), /Invalid account/);
  assert.throws(() => parseAccountSpec('work=me@company'), /Invalid account/);
  assert.throws(() => requestedAccounts(['--account']), /needs a value/);
});

test('rejects conflicting aliases and duplicate emails in one command', () => {
  assert.throws(() => requestedAccounts([
    '--account=work=one@example.com',
    '--account=work=two@example.com',
  ]), /more than one email/);
  assert.throws(() => requestedAccounts([
    '--account=one=same@example.com',
    '--account=two=same@example.com',
  ]), /more than one alias/);
});

test('rejects collisions with configured aliases and emails', () => {
  const configured = [
    { alias: 'work', email: 'one@example.com', status: 'connected' },
  ];
  assert.throws(
    () => assertAccountRequestAvailable({ alias: 'work', email: 'two@example.com' }, configured),
    /already belongs/,
  );
  assert.throws(
    () => assertAccountRequestAvailable({ alias: 'other', email: 'one@example.com' }, configured),
    /already connected/,
  );
  assert.equal(
    assertAccountRequestAvailable({ alias: 'work', email: 'one@example.com' }, configured),
    configured[0],
  );
});
