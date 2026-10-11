/**
 * Optional state observer seam. The module is intentionally absent until its
 * owning implementation lands. Callers distinguish that exact absence from a
 * present module whose dependencies, initialization, or exports are broken.
 */
// Worker module identifiers need not be absolute URLs. Keep the exact relative
// specifier and let the owning module resolver evaluate it only when requested.
export const receiptObserverModuleUrl = './observer.js';
export async function loadReceiptObserver(): Promise<unknown> {
  return import(receiptObserverModuleUrl);
}
