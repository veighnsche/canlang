/**
 * T26 related-progress resume: restart re-drives only unfinished rows.
 * ISOLATED MECHANISM proofs: pure scan over supplied row views, no
 * store, no writes. Durable (D1/DO) restart proofs ride the companion
 * durable suite, which plans from rows surviving a real kill.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptStatus,
} from '@canlang/contracts';
import { planRelatedProgressResume } from './index.js';
import type { RelatedProgressRowView } from './index.js';

const RELATION = 'std.ImagesV1.submit';
const OTHER = 'std.EmailV1.send';

function pair(
  deliveryId: string,
  status: ReceiptStatus,
  overrides: { relation?: string; revision?: number } = {},
): RelatedProgressRowView {
  const revision = overrides.revision ?? 7;
  const association: ReceiptAssociation = {
    locator: { recordId: `rec_${deliveryId}`, field: 'artwork' },
    deliveryId,
    source: 'Testprogress.send',
    revision,
  };
  const receipt: AssociatedReceipt = {
    deliveryId,
    revision,
    status,
    result: status === 'succeeded' ? { outputs: [] } : null,
    error: status === 'failed' ? { code: 'bad', message: 'bad' } : null,
  };
  return { relation: overrides.relation ?? RELATION, association, receipt };
}

describe('t26 resume scan', () => {
  it('resumes pending and unknown rows, settles terminal rows', () => {
    assert.deepEqual(
      planRelatedProgressResume({
        relation: RELATION,
        rows: [
          pair('del_pending', 'pending'),
          pair('del_unknown', 'unknown'),
          pair('del_ok', 'succeeded'),
          pair('del_bad', 'failed'),
          pair('del_void', 'skipped'),
        ],
      }),
      {
        relation: RELATION,
        resume: ['del_pending', 'del_unknown'],
        settled: ['del_bad', 'del_ok', 'del_void'],
      },
    );
  });

  it('sorts both lists by delivery id for stable evidence', () => {
    const plan = planRelatedProgressResume({
      relation: RELATION,
      rows: [pair('del_c', 'pending'), pair('del_a', 'unknown'), pair('del_b', 'succeeded')],
    });
    assert.deepEqual(plan.resume, ['del_a', 'del_c']);
    assert.deepEqual(plan.settled, ['del_b']);
  });

  it('plans nothing over an empty row set', () => {
    assert.deepEqual(planRelatedProgressResume({ relation: RELATION, rows: [] }), {
      relation: RELATION,
      resume: [],
      settled: [],
    });
  });

  it('refuses cross-relation rows instead of scanning them', () => {
    assert.throws(
      () =>
        planRelatedProgressResume({
          relation: RELATION,
          rows: [pair('del_x', 'pending', { relation: OTHER })],
        }),
      /carries relation/,
    );
  });

  it('throws loudly on corrupt rows instead of planning around them', () => {
    assert.throws(
      () => planRelatedProgressResume({ relation: 'std.HandbookV1.ask', rows: [] }),
      /unknown progress relation/,
    );
    const foreign = pair('del_f', 'pending');
    assert.throws(
      () =>
        planRelatedProgressResume({
          relation: RELATION,
          rows: [
            {
              ...foreign,
              receipt: { ...foreign.receipt, deliveryId: 'del_other' },
            },
          ],
        }),
      /does not belong/,
    );
    const skewed = pair('del_s', 'pending');
    assert.throws(
      () =>
        planRelatedProgressResume({
          relation: RELATION,
          rows: [
            {
              ...skewed,
              receipt: { ...skewed.receipt, revision: 8 },
            },
          ],
        }),
      /disagrees/,
    );
    const drifted = pair('del_d', 'pending');
    assert.throws(
      () =>
        planRelatedProgressResume({
          relation: RELATION,
          rows: [
            {
              ...drifted,
              receipt: { ...drifted.receipt, status: 'cancelled' as ReceiptStatus },
            },
          ],
        }),
      /unknown status/,
    );
  });
});
