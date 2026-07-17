function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  const value = candidate.response?.status ?? candidate.code;
  return typeof value === 'number' ? value : undefined;
}

export function isRetryableGoogleError(error: unknown): boolean {
  const status = statusOf(error);
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? (async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableGoogleError(error) || attempt === attempts - 1) throw error;
      const exponential = baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
      await sleep(Math.min(exponential + jitter, 4_000));
    }
  }
  throw lastError;
}
