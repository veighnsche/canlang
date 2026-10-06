/**
 * TEST-ONLY bridge: loads the REAL lane-4 T25a functions for the join
 * proofs. The compiled state suite cannot statically import lane-4
 * sources (the T24a precedent: no `@canlang/work` runtime import from
 * `@canlang/state`), so this loader resolves them here via a computed
 * file URL — the same out-of-dist reach the durable suites use for the
 * DO test worker — and hands the live functions to the join's injected
 * ports. Every join proof below therefore runs the REAL
 * `observeSelectedReceipt` / `applyReceiptProgress` /
 * `isConsistentCompletion` on the REAL store; no reimplementation.
 *
 * The loader asserts each export is a function and fails loudly
 * otherwise, so a work-side rename breaks the suite instead of silently
 * running a fallback. There is no fallback and no mirror here.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AssociatedReceipt,
  ReceiptAssociation,
} from '../../../contracts/src/work.js';
import type { SelectedReceiptObserver } from './join.js';

/** Structural mirror of the work-side `ReceiptProgressOutcome`. */
export type WorkProgressOutcome =
  | {
      readonly applied: true;
      readonly association: ReceiptAssociation;
      readonly receipt: AssociatedReceipt;
    }
  | {
      readonly applied: false;
      readonly reason:
        | 'malformed-completion'
        | 'id-mismatch'
        | 'source-mismatch'
        | 'stale-revision'
        | 'inconsistent-envelope';
    };

/** Structural mirror of the work-side `applyReceiptProgress`. */
export type ApplyReceiptProgressFn = (
  association: ReceiptAssociation,
  receipt: AssociatedReceipt,
  progress: unknown,
) => WorkProgressOutcome;

/** Structural mirror of the work-side `isConsistentCompletion`. */
export type IsConsistentCompletionFn = (
  status: unknown,
  result: unknown,
  error: unknown,
) => boolean;

export interface WorkReceiptFns {
  readonly observeSelectedReceipt: SelectedReceiptObserver;
  readonly applyReceiptProgress: ApplyReceiptProgressFn;
  readonly isConsistentCompletion: IsConsistentCompletionFn;
}

function requireFn(value: unknown, name: string): (...args: never[]) => unknown {
  if (typeof value !== 'function') {
    throw new Error(`receipt join tests: work export ${name} is not a function.`);
  }
  return value as (...args: never[]) => unknown;
}

/**
 * Load the real T25a functions from the work sources. `import.meta.url`
 * is the COMPILED loader (`dist/state/src/receipt/`), so the work tree
 * sits five levels up plus `work/src/...`; Node strips the `.ts`
 * sources natively, and the work observation closure imports nothing
 * but sibling `.ts` modules plus type-only contracts.
 */
export async function loadWorkReceiptFns(): Promise<WorkReceiptFns> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const observationPath = path.resolve(
    here,
    '../../../../../work/src/observation/observation.ts',
  );
  const receiptPath = path.resolve(here, '../../../../../work/src/receipt/index.ts');
  const observation = (await import(pathToFileURL(observationPath).href)) as Record<
    string,
    unknown
  >;
  const association = (await import(
    pathToFileURL(path.resolve(here, '../../../../../work/src/observation/association.ts')).href
  )) as Record<string, unknown>;
  const receipt = (await import(pathToFileURL(receiptPath).href)) as Record<string, unknown>;
  return {
    observeSelectedReceipt: requireFn(
      observation['observeSelectedReceipt'],
      'observeSelectedReceipt',
    ) as unknown as SelectedReceiptObserver,
    applyReceiptProgress: requireFn(
      association['applyReceiptProgress'],
      'applyReceiptProgress',
    ) as unknown as ApplyReceiptProgressFn,
    isConsistentCompletion: requireFn(
      receipt['isConsistentCompletion'],
      'isConsistentCompletion',
    ) as unknown as IsConsistentCompletionFn,
  };
}
