/**
 * D3b Q2 observer seam: ambient shape of the owning Work receipt
 * producer for `packages/state/src/receipt/observer.ts`.
 *
 * State cannot resolve `@canlang/work/receipt` through its manifest —
 * any manifest edge would cycle (`@canlang/work` depends on
 * `@canlang/state`) — so the build must not require work's dist.
 * Hand-authored source (tracked despite the generated-`.d.ts` ignore);
 * the observer shape-checks the loaded producer again at load (loud
 * t16b on drift) and the B-owned no-injection proof exercises it.
 * Source of truth: `packages/work/src/receipt/index.ts`
 * (`loadWorkReceiptFns`).
 */
declare module '@canlang/work/receipt' {
  export function loadWorkReceiptFns(): Promise<{
    readonly observeSelectedReceipt: (input: unknown) => unknown;
  }>;
}
