/** S6: delivery-association matching for completion handlers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchAssociatedCompletion } from '../src/observation/association.js';

describe('association: matching current completions', () => {
  it('matches the current id, source and minimum revision', () => {
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_9', source: 'Mail.send', revision: 3 },
        'Mail.send',
        3,
      ),
      { matched: true, reason: 'matched' },
    );
  });

  it('accepts newer revisions as monotone', () => {
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_9', source: 'Mail.send', revision: 5 },
        'Mail.send',
        3,
      ),
      { matched: true, reason: 'matched' },
    );
  });

  it('ignores extra envelope payload beyond the matching keys', () => {
    // Status/result/error travel in the real envelope; payload consistency
    // is the S8 join's job after a match, not matching's.
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        {
          delivery_id: 'del_9',
          source: 'Mail.send',
          revision: 3,
          status: 'succeeded',
          result: { reference: 'm_1' },
          error: null,
        },
        'Mail.send',
        3,
      ),
      { matched: true, reason: 'matched' },
    );
  });
});

describe('association: old attempts and mismatches', () => {
  it('old-attempt completions never match the current association', () => {
    // Old attempts update only their own receipts: a completion for the
    // superseded attempt does not apply to the current association.
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_new',
        { delivery_id: 'del_old', source: 'Mail.send', revision: 9 },
        'Mail.send',
        0,
      ),
      { matched: false, reason: 'id-mismatch' },
    );
  });

  it('rejects foreign sources', () => {
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_9', source: 'Billing.charge', revision: 3 },
        'Mail.send',
        0,
      ),
      { matched: false, reason: 'source-mismatch' },
    );
  });

  it('rejects older revisions at the monotone boundary', () => {
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_9', source: 'Mail.send', revision: 2 },
        'Mail.send',
        3,
      ),
      { matched: false, reason: 'stale-revision' },
    );
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_9', source: 'Mail.send', revision: 0 },
        'Mail.send',
        0,
      ),
      { matched: true, reason: 'matched' },
    );
  });

  it('checks id before source before revision', () => {
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_x', source: 'Billing.charge', revision: 0 },
        'Mail.send',
        99,
      ),
      { matched: false, reason: 'id-mismatch' },
    );
    assert.deepEqual(
      matchAssociatedCompletion(
        'del_9',
        { delivery_id: 'del_9', source: 'Billing.charge', revision: 0 },
        'Mail.send',
        99,
      ),
      { matched: false, reason: 'source-mismatch' },
    );
  });
});

describe('association: malformed input never throws', () => {
  it('returns a safe non-match for adversary-shaped completions', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      0,
      42,
      'del_9',
      true,
      [],
      {},
      { delivery_id: 'del_9' },
      { delivery_id: 'del_9', source: 'Mail.send' },
      { delivery_id: 'del_9', source: 'Mail.send', revision: '3' },
      { delivery_id: 'del_9', source: 'Mail.send', revision: Number.NaN },
      { delivery_id: 'del_9', source: 'Mail.send', revision: 1.5 },
      { delivery_id: 'del_9', source: 'Mail.send', revision: -1 },
      { delivery_id: 'del_9', source: 'Mail.send', revision: Number.POSITIVE_INFINITY },
      { delivery_id: '', source: 'Mail.send', revision: 3 },
      { delivery_id: 'del_9', source: '', revision: 3 },
      { delivery_id: 7, source: 'Mail.send', revision: 3 },
      { delivery_id: 'del_9', source: null, revision: 3 },
      { delivery_id: ['del_9'], source: 'Mail.send', revision: 3 },
    ];
    for (const completion of malformed) {
      assert.deepEqual(matchAssociatedCompletion('del_9', completion, 'Mail.send', 0), {
        matched: false,
        reason: 'malformed-completion',
      });
    }
  });

  it('reasons never reflect adversary content', () => {
    const verdict = matchAssociatedCompletion(
      'del_current',
      { delivery_id: 'PWNED_MARKER_DEL', source: 'Mail.send', revision: 1 },
      'Mail.send',
      0,
    );
    assert.equal(verdict.matched, false);
    assert.equal(verdict.reason, 'id-mismatch');
    assert.ok(!verdict.reason.includes('PWNED'));
  });
});

describe('association: trusted parameters throw loudly', () => {
  const completion = { delivery_id: 'del_9', source: 'Mail.send', revision: 3 };

  it('rejects malformed association ids', () => {
    assert.throws(
      () => matchAssociatedCompletion(7 as unknown as string, completion, 'Mail.send', 0),
      TypeError,
    );
    assert.throws(
      () => matchAssociatedCompletion('', completion, 'Mail.send', 0),
      RangeError,
    );
  });

  it('rejects malformed expected sources', () => {
    assert.throws(
      () => matchAssociatedCompletion('del_9', completion, 7 as unknown as string, 0),
      TypeError,
    );
    assert.throws(() => matchAssociatedCompletion('del_9', completion, '', 0), RangeError);
  });

  it('rejects malformed minimum revisions', () => {
    assert.throws(
      () => matchAssociatedCompletion('del_9', completion, 'Mail.send', '0' as unknown as number),
      TypeError,
    );
    for (const minRevision of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => matchAssociatedCompletion('del_9', completion, 'Mail.send', minRevision),
        RangeError,
      );
    }
  });
});
