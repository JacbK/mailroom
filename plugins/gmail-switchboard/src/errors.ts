export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'WRONG_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'AMBIGUOUS_ID'
  | 'INVALID_INPUT'
  | 'CURSOR_EXPIRED'
  | 'CURSOR_IN_USE'
  | 'TIMEOUT'
  | 'GOOGLE_API_ERROR'
  | 'ATTACHMENT_BLOCKED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'CREDENTIAL_FILE_CLEANUP_FAILED'
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
  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      response?: { status?: unknown; data?: { error?: unknown } };
    };
    const status = candidate.response?.status ?? candidate.code;
    const responseError = candidate.response?.data?.error;
    const message = [
      typeof candidate.message === 'string' ? candidate.message : '',
      typeof responseError === 'string' ? responseError : JSON.stringify(responseError ?? ''),
    ].join(' ').toLowerCase();
    const scopeFailure = status === 403 && (
      message.includes('insufficientpermissions')
      || message.includes('access_token_scope_insufficient')
      || message.includes('insufficient authentication scopes')
    );
    if (status === 401 || message.includes('invalid_grant') || scopeFailure) {
      return new SwitchboardError(
        'AUTH_REQUIRED',
        'Google access for this Gmail account expired or was revoked.',
        'Run `./setup --reauth` and reconnect the affected account.',
        { cause: error },
      );
    }
  }
  return new SwitchboardError(
    'GOOGLE_API_ERROR',
    'Gmail returned an unexpected error.',
    'Run `./setup --doctor`. If authentication is unhealthy, run `./setup --reauth`.',
    { cause: error },
  );
}
