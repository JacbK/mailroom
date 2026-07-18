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
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return 'Unknown error';
}
