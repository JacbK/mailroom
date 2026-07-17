import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'src/auth/oauth.ts',
        'src/cli.ts',
        'src/gmail/client-factory.ts',
        'src/gmail/gateway.ts',
        'src/security/keychain.ts',
        'src/server.ts',
      ],
      thresholds: {
        branches: 65,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
