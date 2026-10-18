/** Failed row disposal retains its original handle until a successful retry. */
import { cleanupAfterFailure, DevCleanupError, retryableDispose } from "./cleanup.js";
export class RuntimeExampleResources {
  async using<T>(key: object, action: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await action(); }
    catch (error) { return cleanupAfterFailure(error, () => this.dispose(key)); }
    await this.dispose(key);
    return result;
  }
  fail(error: unknown): Promise<never> {
    if (error instanceof DevCleanupError) this.retain(error, error.dispose);
    return cleanupAfterFailure(error, () => this.drain());
  }
  private readonly pending = new Set<Promise<unknown>>();
  async allocate<T>(create: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(create);
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }
  private readonly owned = new Map<object, () => Promise<void>>();
  retain(key: object, dispose: () => Promise<void>): void {
    this.owned.set(key, retryableDispose(async () => { await dispose(); this.owned.delete(key); }));
  }
  dispose(key: object): Promise<void> {
    const release = this.owned.get(key);
    return release === undefined ? Promise.resolve() : release();
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled([...this.owned.values()].map(release => release()));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
