/** A failed startup still owns resources when cleanup fails. The caller must
 * retain this error and retry disposal before allocating another runtime. */
export class DevCleanupError extends Error {
  constructor(cause: unknown, cleanupError: unknown, readonly dispose: () => Promise<void>) {
    const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
    super(`${message(cause)}; cleanup failed: ${message(cleanupError)}`, { cause });
    this.name = "DevCleanupError";
  }
}

/** Share concurrent calls, remember success, but allow failed cleanup to retry. */
export function retryableDispose(action: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= action().catch(error => {
    pending = undefined;
    throw error;
  });
}

export async function cleanupAfterFailure(error: unknown, dispose: () => Promise<void>): Promise<never> {
  try { await dispose(); }
  catch (cleanupError) { throw new DevCleanupError(error, cleanupError, dispose); }
  throw error;
}
