import type { StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';

/** Installed by canonical scenario execution; no alternate store/commit path. */
export interface TransitionContext {
  readonly canonical?: {
    stageWrite(write: {
      readonly op: 'update'; readonly model: string; readonly id: string;
      readonly transition: { readonly field: string; readonly from: string; readonly to: string };
    }): Promise<StoredRow | null>;
  };
}

/** Stage an ordered lifecycle edge under the admitted operation identity. */
export async function transition(
  c: TransitionContext, model: string, id: string, field: string, from: string, to: string,
): Promise<StoredRow> {
  if (c.canonical === undefined) throw new StateError('validation', 'transition requires canonical execution scope.');
  if ([model, id, field, from, to].some((value) => typeof value !== 'string' || value === '')) {
    throw new StateError('validation', 'transition requires non-empty model, id, field and states.');
  }
  const row = await c.canonical.stageWrite({ op: 'update', model, id, transition: { field, from, to } });
  if (row === null) throw new StateError('validation', 'transition staged no row.');
  return row;
}
