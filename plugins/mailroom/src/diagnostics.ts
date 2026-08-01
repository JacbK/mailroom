export interface DoctorReport {
  node: { version: string; ok: boolean };
  platform: { value: string; ok: boolean };
  oauth_client: {
    ok: boolean;
    mode?: 'shared' | 'self-hosted' | null;
    [key: string]: unknown;
  };
  account_count: number;
  accounts: Array<{
    alias: string;
    email: string;
    status: 'connected' | 'needs_auth' | 'error';
  }>;
  ok: boolean;
}

interface RedactedDoctorReport {
  node: DoctorReport['node'];
  platform: DoctorReport['platform'];
  oauth_client: {
    ok: boolean;
    mode?: DoctorReport['oauth_client']['mode'];
  };
  account_count: number;
  accounts: Array<{ alias: string; status: 'connected' | 'needs_auth' | 'error' }>;
  ok: boolean;
}

function displayAlias(alias: string, index: number, redact: boolean): string {
  return redact ? `account-${index + 1}` : alias;
}

export function doctorJson(report: DoctorReport, redact: boolean): DoctorReport | RedactedDoctorReport {
  if (!redact) return report;
  return {
    node: report.node,
    platform: report.platform,
    oauth_client: {
      ok: report.oauth_client.ok,
      ...(report.oauth_client.mode !== undefined ? { mode: report.oauth_client.mode } : {}),
    },
    account_count: report.account_count,
    accounts: report.accounts.map(({ status }, index) => ({
      alias: displayAlias('', index, true),
      status,
    })),
    ok: report.ok,
  };
}

export function doctorText(report: DoctorReport, redact: boolean): string {
  const accounts = report.accounts.map((account, index) => ({
    ...account,
    alias: displayAlias(account.alias, index, redact),
  }));
  const recovery = [
    ...(!report.node.ok ? ['Install Node 22 or newer, then rerun ./mailroom doctor.'] : []),
    ...(!report.platform.ok ? ['Run Mailroom on macOS so it can use Keychain.'] : []),
    ...(!report.oauth_client.ok ? ['Run ./setup --personal to configure your personal Google app.'] : []),
    ...(report.accounts.length === 0 ? ['Run ./setup --account alias=you@example.com.'] : []),
    ...accounts.flatMap((account) => {
      if (account.status === 'needs_auth') {
        return [redact
          ? `Run ./mailroom auth list, then ./mailroom auth reauth <alias for ${account.alias}>.`
          : `Run ./mailroom auth reauth ${account.alias}.`];
      }
      if (account.status === 'error') {
        return [redact
          ? `Retry ./mailroom doctor; if ${account.alias} still fails, run ./mailroom auth reauth <alias for ${account.alias}>.`
          : `Retry ./mailroom doctor; if ${account.alias} still fails, run ./mailroom auth reauth ${account.alias}.`];
      }
      return [];
    }),
  ];
  return [
    `Node ${report.node.version}: ${report.node.ok ? 'ok' : 'needs Node 22+'}`,
    `macOS Keychain: ${report.platform.ok ? 'ok' : 'unsupported platform'}`,
    `Google OAuth: ${report.oauth_client.ok
      ? report.oauth_client.mode === 'shared' ? 'legacy shared app' : 'personal app'
      : 'needs setup'}`,
    ...(accounts.length > 0
      ? accounts.map((account) => redact
        ? `${account.alias}: ${account.status}`
        : `${account.alias} (${account.email}): ${account.status}`)
      : ['Gmail accounts: none configured']),
    `Overall: ${report.ok ? 'healthy' : 'needs attention'}`,
    ...(recovery.length > 0 ? ['', 'Next:', ...recovery.map((item) => `- ${item}`)] : []),
    '',
  ].join('\n');
}
