/**
 * Own process signals around the pinned Miniflare runner. Miniflare's internal
 * exit-hook calls process.exit(143) on SIGTERM before asynchronous disposal can
 * finish. Keep that runner in a child and request awaited shutdown over private
 * IPC. This is lifecycle plumbing; application state and bindings stay owned by
 * the normal Canlang runner.
 */
import { spawn } from 'node:child_process';

const STOP = 'can-workerd-shutdown';

/** Return the actual child exit status; forced termination is a failure. */
export async function superviseWorkerd(entry: string, args: readonly string[], shutdownGraceMs = 15_000): Promise<number> {
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs <= 0) {
    throw new Error('workerd shutdown grace must be a positive integer');
  }
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let stopping = false;
  let forced = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (child.connected) child.send(STOP);
    deadline = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, shutdownGraceMs);
    deadline.unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(forced || signal !== null ? 1 : (code ?? 1)));
    });
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

/** Install before runtime startup. The disposer must await startup and all owned resources. */
export function installWorkerdShutdown(dispose: () => Promise<void>): () => void {
  if (process.send === undefined) throw new Error('workerd child requires its supervising IPC channel');
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve().then(dispose).catch(error => {
      console.error(error);
      process.exitCode = 1;
    }).finally(() => {
      process.off('message', onMessage);
      process.off('disconnect', stop);
      if (process.connected) process.disconnect?.();
    });
  };
  const onMessage = (message: unknown): void => { if (message === STOP) stop(); };
  process.on('message', onMessage);
  // Unexpected supervisor death also retires the worker and its retained
  // writer lock. A new launcher cannot inherit an orphaned live worker.
  process.on('disconnect', stop);
  return () => { process.off('message', onMessage); process.off('disconnect', stop); };
}
