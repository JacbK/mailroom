import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const suspiciousNames = /(?:client[_-]?secret|credentials|refresh[_-]?token|access[_-]?token).*\.json$/i;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ya29\.[A-Za-z0-9._-]{30,}/,
  /1\/\/[A-Za-z0-9._-]{30,}/,
  /gh[opusr]_[A-Za-z0-9]{30,}/,
  /"client_secret"\s*:\s*"[^"<]{12,}"/,
];

const findings = [];
for (const name of names) {
  if (suspiciousNames.test(name)) findings.push(`${name}: suspicious credential filename`);
  let content;
  try {
    content = readFileSync(resolve(root, name), 'utf8');
  } catch {
    continue;
  }
  for (const pattern of patterns) {
    if (pattern.test(content)) findings.push(`${name}: matched ${pattern.source}`);
  }
}

if (findings.length) {
  process.stderr.write(`Potential secrets found:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan passed (${names.length} files).\n`);
}
