import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const docs = resolve(root, 'docs');

async function text(path) {
  return await readFile(path, 'utf8');
}

function canonical(html, label) {
  const match = html.match(/<link rel="canonical" href="([^"]+)" \/>/);
  assert(match, `${label} needs one canonical URL.`);
  return new URL(match[1]);
}

const [homeHtml, privacyHtml, termsHtml, cname, pluginManifest] = await Promise.all([
  text(resolve(docs, 'index.html')),
  text(resolve(docs, 'privacy.html')),
  text(resolve(docs, 'terms.html')),
  text(resolve(docs, 'CNAME')).then((value) => value.trim()),
  text(resolve(root, 'plugins/mailroom/.codex-plugin/plugin.json')).then(JSON.parse),
]);

const home = canonical(homeHtml, 'Homepage');
const privacy = canonical(privacyHtml, 'Privacy page');
const terms = canonical(termsHtml, 'Terms page');
const expectedPrivacy = new URL('privacy.html', home);
const expectedTerms = new URL('terms.html', home);

assert.equal(cname, home.hostname, 'GitHub Pages CNAME must match the homepage hostname.');
assert.equal(privacy.href, expectedPrivacy.href, 'Privacy canonical must use the homepage origin.');
assert.equal(terms.href, expectedTerms.href, 'Terms canonical must use the homepage origin.');
assert.equal(
  pluginManifest.interface.websiteURL,
  home.href,
  'Codex website URL must match the homepage canonical.',
);
assert.equal(
  pluginManifest.interface.privacyPolicyURL,
  privacy.href,
  'Codex privacy URL must match the privacy canonical.',
);
assert.equal(
  pluginManifest.interface.termsOfServiceURL,
  terms.href,
  'Codex terms URL must match the terms canonical.',
);

for (const [label, html] of [
  ['Homepage', homeHtml],
  ['Privacy page', privacyHtml],
  ['Terms page', termsHtml],
]) {
  assert.match(html, /http-equiv="Content-Security-Policy"/, `${label} needs a CSP.`);
  assert.doesNotMatch(html, /<(?:iframe|script)[^>]+src="https?:\/\//i, `${label} loads remote code.`);
}

assert.match(
  privacyHtml,
  /Google API Services User Data Policy/,
  'Privacy page needs the Google Limited Use disclosure.',
);

if (process.env.MAILROOM_REQUIRE_OWNED_DOMAIN === '1') {
  const thirdPartyHosts = [
    'github.io',
    'vercel.app',
    'netlify.app',
    'pages.dev',
    'web.app',
    'firebaseapp.com',
    'notion.site',
  ];
  const rejected = thirdPartyHosts.some((host) => (
    home.hostname === host || home.hostname.endsWith(`.${host}`)
  ));
  assert(
    !rejected,
    `Release requires a developer-owned domain; Google rejected ${home.hostname}.`,
  );
}

process.stdout.write(`Public site validation passed: ${home.href}\n`);
