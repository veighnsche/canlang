/**
 * D3b Q2 B-half: worker-safe selected-receipt observer module.
 *
 * Resolves the owning Work receipt producer through the dynamic leg
 * (`@canlang/work/receipt` + `loadWorkReceiptFns`) and hands its
 * `observeSelectedReceipt` to the serving path with no adaptation and
 * no wrapping. The dynamic leg exists because a static edge would
 * cycle (`@canlang/work` depends on `@canlang/state`); the package
 * boundary guard carries a declared exception for exactly this
 * consumer + specifier, and the deploy vendor map rewrites the
 * literal to the staged `vendor/work/receipt/index.js` so the worker
 * resolves it without a bare specifier.
 *
 * Worker-safe: zero node-only imports, no file-URL loading, no static
 * `@canlang/work` import (not even type-only — the served function is
 * described structurally and shape-checked at load).
 *
 * `selectedReceiptObserverLoads` records every `loadSelectedReceiptObserver`
 * call (one per served read; the seam never caches). The B-owned
 * no-injection proof asserts this record positively — output equality
 * alone cannot distinguish the observer leg from the work-loader leg.
 */
/** One `'B'` marker per served observer load, in call order. */
export const selectedReceiptObserverLoads: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function loadSelectedReceiptObserver(): Promise<{
  readonly observeSelectedReceipt: (input: unknown) => unknown;
}> {
  let receiptMod: unknown;
  try {
    // Syntactic literal: the deploy vendor map rewrites exactly this
    // specifier to the staged work receipt producer.
    receiptMod = await import('@canlang/work/receipt');
  } catch {
    throw new Error(
      't16b: state receipt observer producer cannot load the work receipt producer ' +
        '(@canlang/work/receipt); build @canlang/work dist (root build) or stage the vendor seam',
    );
  }
  if (!isRecord(receiptMod) || typeof receiptMod['loadWorkReceiptFns'] !== 'function') {
    throw new Error(
      't16b: state receipt observer producer found no loadWorkReceiptFns function (stale dist?)',
    );
  }
  const fns = (await (receiptMod['loadWorkReceiptFns'] as () => Promise<unknown>)()) as unknown;
  if (!isRecord(fns) || typeof fns['observeSelectedReceipt'] !== 'function') {
    throw new Error(
      't16b: state receipt observer producer served no observeSelectedReceipt function',
    );
  }
  selectedReceiptObserverLoads.push('B');
  return {
    observeSelectedReceipt: fns['observeSelectedReceipt'] as (input: unknown) => unknown,
  };
}
