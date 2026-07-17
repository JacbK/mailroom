import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  packages: 'bundle',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
};

await Promise.all([
  build({ ...shared, entryPoints: ['src/server.ts'], outfile: 'dist/server.js' }),
  build({ ...shared, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' }),
]);

if (process.platform === 'darwin') {
  execFileSync('xcrun', [
    'swiftc',
    'src/security/keychain-helper.swift',
    '-framework',
    'Security',
    '-O',
    '-o',
    'dist/keychain-helper',
  ], { stdio: 'inherit' });
}
