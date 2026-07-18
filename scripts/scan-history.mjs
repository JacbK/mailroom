import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const commits = execFileSync('git', ['rev-list', '--all'], {
  cwd: root,
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean);
const blobs = new Map();

for (const commit of commits) {
  const entries = execFileSync('git', ['ls-tree', '-r', '-z', commit], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (match) blobs.set(match[1], match[2]);
  }
}

const signatures = [
  { name: 'Google access token', pattern: new RegExp(['ya29', '\\.', '[A-Za-z0-9._-]{30,}'].join('')) },
  { name: 'Google refresh token', pattern: new RegExp(['1', '\\/\\/', '[A-Za-z0-9._-]{30,}'].join('')) },
  { name: 'Google Desktop OAuth client', pattern: new RegExp(['GOCSPX', '-', '[A-Za-z0-9_-]{20,}'].join('')) },
  { name: 'GitHub token', pattern: new RegExp(['gh', '[opusr]', '_', '[A-Za-z0-9]{30,}'].join('')) },
  { name: 'private key', pattern: new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('')) },
];
const allow = new Map([
  ['Google access token', new Set(['plugins/gmail-switchboard/test/unit/redact.test.ts'])],
  ['Google Desktop OAuth client', new Set(['plugins/mailroom/src/auth/shared-client.ts'])],
]);
const findings = [];

for (const [oid, path] of blobs) {
  const content = execFileSync('git', ['cat-file', 'blob', oid], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
  });
  if (content.includes('\0')) continue;
  for (const signature of signatures) {
    if (signature.pattern.test(content) && !allow.get(signature.name)?.has(path)) {
      findings.push(`${path}: ${signature.name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Potential secrets found in Git history:\n${[...new Set(findings)].join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Git history secret scan passed (${blobs.size} unique blobs).\n`);
}
