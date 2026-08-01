const SECRET_PATTERNS: RegExp[] = [
  /(?:access|refresh|id)[_-]?token["'\s:=]+[^\s"']+/gi,
  /authorization["'\s:=]+bearer\s+[^\s"']+/gi,
  /client[_-]?secret["'\s:=]+[^\s"']+/gi,
  /ya29\.[A-Za-z0-9._-]+/g,
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, '[REDACTED]'),
    value,
  );
}

export function safeDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    const recovery = error.name === 'MailroomError'
      && 'recovery' in error
      && typeof error.recovery === 'string'
      ? `\nRecovery: ${error.recovery}`
      : '';
    return redact(`${error.name}: ${error.message}${recovery}`);
  }
  return 'Unknown error';
}
