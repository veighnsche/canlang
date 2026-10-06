/**
 * Optional state observer seam. The module is intentionally absent until its
 * owning implementation lands. Callers distinguish that exact absence from a
 * present module whose dependencies, initialization, or exports are broken.
 */
const OBSERVER_MODULE = './observer.js';
export const receiptObserverModuleUrl = new URL(OBSERVER_MODULE, import.meta.url).href;
export async function loadReceiptObserver(): Promise<unknown> {
  return import(OBSERVER_MODULE);
}
