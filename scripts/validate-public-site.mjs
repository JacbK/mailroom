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

const [homeHtml, privacyHtml, termsHtml, styles, copyScript, readme, cname, pluginManifest] = await Promise.all([
  text(resolve(docs, 'index.html')),
  text(resolve(docs, 'privacy.html')),
  text(resolve(docs, 'terms.html')),
  text(resolve(docs, 'styles.css')),
  text(resolve(docs, 'copy.js')),
  text(resolve(root, 'README.md')),
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

const homepagePrompt = homeHtml.match(/<span id="install-prompt">([^<]+)<\/span>/)?.[1]?.trim();
const readmePrompt = readme.match(/\*\*Paste this into Codex, Claude Code, or Cursor:\*\*\s+```text\s+([^\n]+)\s+```/)?.[1]?.trim();
assert(homepagePrompt, 'Homepage needs the install prompt.');
assert(readmePrompt, 'README needs the install prompt.');
assert.equal(homepagePrompt, readmePrompt, 'README and homepage install prompts must stay identical.');

assert.equal((homeHtml.match(/<h1>/g) ?? []).length, 1, 'Homepage needs exactly one h1.');
assert.match(homeHtml, /<main>/, 'Homepage needs a main landmark.');
assert.match(homeHtml, /tokens in Keychain/, 'Homepage needs the compact local-storage note.');
assert.match(homeHtml, /Claude Code, and Cursor/, 'Homepage needs all supported clients.');
assert.match(styles, /:focus-visible/, 'Site needs visible keyboard focus.');
assert.match(styles, /prefers-reduced-motion/, 'Site needs a reduced-motion rule.');
assert.match(styles, /overflow-wrap:\s*anywhere/, 'Install prompt needs narrow-screen wrapping.');
assert.doesNotMatch(styles, /transition:\s*all\b/, 'Site must transition only explicit properties.');
assert.doesNotMatch(styles, /animation:\s*(?:fade-in|mark-in|rise-in)/, 'Homepage content must render immediately.');
assert.match(copyScript, /copyButton\.hidden = false/, 'Copy control must use progressive enhancement.');
assert.match(copyScript, /execCommand\('copy'\)/, 'Copy control needs a clipboard fallback.');
assert.match(homeHtml, /data-copy-target="install-prompt"/, 'Copy control needs an explicit target.');
assert.match(homeHtml, /role="status"/, 'Copy feedback needs a separate live status.');
assert.doesNotMatch(homeHtml, /aria-controls="install-prompt"/, 'Copy target lookup must not imply control.');
assert.match(
  privacyHtml,
  /Data protection/,
  'Privacy page needs an explicit data protection disclosure.',
);
assert.match(
  privacyHtml,
  /encrypted at rest by macOS\s+Keychain/,
  'Privacy page needs to explain how OAuth tokens are protected.',
);
assert.match(
  privacyHtml,
  /does not write them to a hosted database, analytics service, or\s+application log/,
  'Privacy page needs to explain how Gmail data is protected from remote retention.',
);
assert.match(
  privacyHtml,
  /Data sharing, transfer, and disclosure/,
  'Privacy page needs an explicit Google user data sharing disclosure.',
);
assert.match(
  privacyHtml,
  /does not share, transfer, or disclose Google user data/,
  'Privacy page needs to identify parties that do not receive Google user data.',
);
assert.match(
  privacyHtml,
  /OpenAI Codex or Anthropic\s+Claude Code/,
  'Privacy page needs to identify user-selected MCP or AI client recipients.',
);
assert.match(
  privacyHtml,
  /email recipients\s+you explicitly select/,
  'Privacy page needs to disclose user-directed email recipient transfers.',
);
assert.match(
  privacyHtml,
  /training generalized AI\s+or ML models/,
  'Privacy page needs to prohibit generalized AI or ML model training.',
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
