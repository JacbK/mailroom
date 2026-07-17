export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'WRONG_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'AMBIGUOUS_ID'
  | 'INVALID_INPUT'
  | 'CURSOR_EXPIRED'
  | 'GOOGLE_API_ERROR'
  | 'ATTACHMENT_BLOCKED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'UNSUPPORTED_PLATFORM';

export class SwitchboardError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly recovery: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SwitchboardError';
  }

  public toJSON(): { code: ErrorCode; message: string; recovery: string } {
    return { code: this.code, message: this.message, recovery: this.recovery };
  }
}

export function toSwitchboardError(error: unknown): SwitchboardError {
  if (error instanceof SwitchboardError) return error;
  return new SwitchboardError(
    'GOOGLE_API_ERROR',
    'Gmail returned an unexpected error.',
    'Run `./setup --doctor`. If authentication is unhealthy, run `./setup --reauth`.',
    { cause: error },
  );
}
