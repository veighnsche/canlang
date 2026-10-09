/** S6: delivery-association matching for completion handlers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cancelRelatedProgress, applyReceiptProgress, applyRelatedProgress, applyRetainedRelatedProgress, matchAssociatedCompletion } from '../src/observation/association.js';
import type { AssociatedReceipt, CanonicalJudgmentDeliveryDescriptor, CanonicalValueTypes, JudgmentSpec, ReceiptAssociation, ReceiptResultContext } from '@canlang/contracts';
import { createJudgmentReceiptContext, isJudgmentReceiptContext, isJudgmentReceiptPayload, isStoredReceiptPayload, newReceiptRow, readJudgmentResult, readReceiptRow } from '@canlang/state/receipt/tables';

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


describe('association: source-owned static Judgment receipt gate', () => {
  const declaration = 'inbox.Triage';
  const specification: JudgmentSpec = { declaration, version: 9007199254740993n,
    revision: `sha256:${'a'.repeat(64)}`, language: 'en',
    noul: [{ id: 'human', instructions: 'Needs staff?', yes: null, no: null }],
    choice: [{ id: 'route', instructions: 'Which queue?', options: [
      { id: 'billing', description: 'Invoices' }, { id: 'support', description: 'Help' },
    ] }], score: [{ id: 'urgency', instructions: 'How urgent?', levels: [
      { id: 'routine', description: 'Routine' }, { id: 'urgent', description: 'Urgent' },
    ] }] };
  const contract = (name: string, fields: Record<string, string>) => ({ name,
    fields: Object.entries(fields).map(([name, type]) => ({ name, type })) });
  const resultDeclaration = contract(declaration, { specification_revision: 'text', model: 'text',
    input_tokens: 'int', output_tokens: 'int', urgency: 'inbox.Triage.urgency',
    human: 'inbox.Triage.human', route: 'inbox.Triage.route' });
  const valueTypes: CanonicalValueTypes = { contracts: [resultDeclaration,
    contract('inbox.Triage.human', { probability: 'decimal' }),
    contract('inbox.Triage.route', { choice: 'inbox.Triage.route.choice',
      probabilities: 'inbox.Triage.route.probabilities.item[]!', confidence: 'decimal' }),
    contract('inbox.Triage.route.probabilities.item', { option: 'inbox.Triage.route.choice', probability: 'decimal' }),
    contract('inbox.Triage.urgency', { score: 'decimal', levels: 'inbox.Triage.urgency.levels.item[]!', confidence: 'decimal' }),
    contract('inbox.Triage.urgency.levels.item', { level: 'inbox.Triage.urgency.level', index: 'int',
      description: 'text', probability: 'decimal' }),
  ], enums: [{ name: 'inbox.Triage.route.choice', cases: ['billing', 'support'] },
    { name: 'inbox.Triage.urgency.level', cases: ['routine', 'urgent'] }] };
  const delivery: CanonicalJudgmentDeliveryDescriptor = { kind: 'delivery', judgment: true,
    capability: declaration, operation: 'evaluate', version: specification.version.toString(), result: resultDeclaration };
  const context = createJudgmentReceiptContext(delivery, specification, valueTypes);
  const wire = { specification_revision: specification.revision, model: 'actual-model',
    input_tokens: '9007199254740993', output_tokens: '18',
    human: { probability: '0.123456789012345678' },
    route: { choice: 'support', probabilities: [{ option: 'billing', probability: '0.2' },
      { option: 'support', probability: '0.8' }], confidence: '0.9' },
    urgency: { score: '0.8', levels: [{ level: 'routine', index: '0', description: 'Routine', probability: '0.2' },
      { level: 'urgent', index: '1', description: 'Urgent', probability: '0.8' }], confidence: '0.9' } };
  const association: ReceiptAssociation = { locator: { recordId: 'item', field: 'analysis' },
    deliveryId: 'current', source: context.source, revision: 0 };
  const pending: AssociatedReceipt = { deliveryId: 'current', revision: 0, status: 'pending', result: null, error: null };
  const progress = (result: unknown = wire) => ({ relation: context.source, delivery_id: pending.deliveryId,
    source: context.source, revision: 1, status: 'succeeded', result, error: null });

  it('detaches declaration data and preserves exact native usage through both State and Work gates', () => {
    const mutableSpec = structuredClone(specification), mutableTypes = structuredClone(valueTypes);
    const frozen = createJudgmentReceiptContext(structuredClone(delivery), mutableSpec, mutableTypes);
    (mutableSpec as { revision: string }).revision = `sha256:${'b'.repeat(64)}`;
    (mutableTypes.contracts[0]!.fields[0]! as { type: string }).type = 'int';
    assert.equal(frozen.judgment!.specification.revision, specification.revision);
    assert.ok(Object.isFrozen(frozen.judgment!.valueTypes.contracts[0]!.fields));
    assert.equal(isJudgmentReceiptContext(frozen), true);
    assert.equal(readJudgmentResult(wire, frozen)?.input_tokens, 9007199254740993n);
    assert.equal(isStoredReceiptPayload('succeeded', wire, null, frozen), true);
    const receipt = { ...pending, revision: 1, status: 'succeeded' as const, result: wire };
    const row = newReceiptRow({ ...receipt, contentRef: null, resultExpiresAtMs: null }, { nowMs: 1, actor: 'test' }, frozen);
    assert.deepEqual(readReceiptRow(row, frozen).receipt.result, wire);
    assert.equal(applyReceiptProgress(association, pending, progress(), frozen).applied, true);
    const current = applyRelatedProgress(context.source, association, pending, progress(), frozen);
    assert.equal(current.applied, true);
    if (!current.applied) assert.fail('expected current receipt');
    assert.equal(current.notification?.status, 'succeeded');
    const retained = applyRetainedRelatedProgress(context.source, { ...pending, deliveryId: 'old' },
      { ...progress(), delivery_id: 'old' }, frozen);
    assert.equal(retained.applied, true);
    const cancel = cancelRelatedProgress({ relation: context.source, association, receipt: pending, revision: 1, context: frozen });
    assert.equal(cancel.cancelled, true);
    if (cancel.cancelled) assert.equal(cancel.receipt.status, 'skipped');
    assert.throws(() => cancelRelatedProgress({ relation: context.source,
      association: { ...association, source: 'other.Triage.evaluate' }, receipt: pending, revision: 1, context: frozen }),
      /trusted receipt source/);
    assert.throws(() => cancelRelatedProgress({ relation: 'other.Triage.evaluate', association,
      receipt: pending, revision: 1, context: frozen }), /unknown progress relation/);
    assert.throws(() => applyRelatedProgress(context.source, association, pending, progress()), /unknown progress relation/);
    assert.deepEqual(applyRelatedProgress(context.source, association, pending,
      { ...progress(), relation: 'other.Triage.evaluate' }, frozen), { applied: false, reason: 'unknown-relation' });
    assert.throws(() => applyReceiptProgress(association, pending, progress(),
      { ...frozen, source: 'other.Triage.evaluate' }), /trusted receipt source/);
  });

  it('rejects malformed typed results on current, retained and stored paths without an untyped fallback', () => {
    const missing = structuredClone(wire) as Record<string, unknown>; delete missing.output_tokens;
    const variants = [missing, null, { ...wire, extra: 'invented' }, { ...wire, specification_revision: `sha256:${'b'.repeat(64)}` },
      { ...wire, human: { choice: 'support' } }, { ...wire, human: { probability: 0.5 } },
      { ...wire, input_tokens: '-1' }, { ...wire, input_tokens: '9223372036854775808' },
      { ...wire, input_tokens: '09007199254740993' }, { ...wire, input_tokens: 9007199254740992 },
      { ...wire, route: { ...wire.route, choice: 'invented' } },
      { ...wire, urgency: { ...wire.urgency, extra: 'invented' } },
      { ...wire, route: { ...wire.route, probabilities: [{ option: 'invented', probability: '1' }] } },
    ];
    for (const result of variants) {
      assert.equal(isStoredReceiptPayload('succeeded', result, null, context), false);
      assert.deepEqual(applyReceiptProgress(association, pending, progress(result), context),
        { applied: false, reason: 'inconsistent-envelope' });
      assert.deepEqual(applyRetainedRelatedProgress(context.source, pending, progress(result), context),
        { applied: false, reason: 'inconsistent-envelope' });
    }
    assert.equal(isStoredReceiptPayload('succeeded', { legacy: true }, null), true);
    let reads = 0;
    const getter = { ...wire, human: Object.defineProperty({}, 'probability', { enumerable: true,
      get() { reads++; return '0.5'; } }) };
    assert.equal(isJudgmentReceiptPayload('succeeded', getter, null, context), false);
    assert.throws(() => newReceiptRow({ ...pending, status: 'succeeded', result: getter, contentRef: null,
      resultExpiresAtMs: null }, { nowMs: 1, actor: 'test' }, context), /inconsistent/);
    const inherited = { ...wire, human: Object.create({ probability: '0.5' }) };
    assert.equal(isJudgmentReceiptPayload('succeeded', inherited, null, context), false);
    const accessorContext = Object.defineProperty({ ...context }, 'judgment', { enumerable: true,
      get() { reads++; return context.judgment; } });
    assert.equal(isStoredReceiptPayload('succeeded', wire, null, accessorContext), false);
    const errorGetter = Object.defineProperty({ message: 'Unavailable' }, 'code', { enumerable: true,
      get() { reads++; return 'unavailable'; } });
    assert.equal(isJudgmentReceiptPayload('failed', null, errorGetter, context), false);
    const inheritedContext = Object.assign(Object.create({ judgment: context.judgment }),
      { source: context.source, declaredResult: context.declaredResult });
    assert.equal(isStoredReceiptPayload('succeeded', wire, null, inheritedContext), false);
    assert.deepEqual(applyReceiptProgress(association, pending, progress(), accessorContext),
      { applied: false, reason: 'inconsistent-envelope' });
    assert.equal(reads, 0);
  });

  it('binds runtime choice aliases to the original frozen candidate union and complete distribution', () => {
    const alias = { name: 'inbox.Triage.route.choice', type: 'text' as const, min: 1, max: 80, format: 'name' as const };
    const runtimeTypes: CanonicalValueTypes = { ...valueTypes,
      enums: valueTypes.enums!.filter(declaration => declaration.name !== alias.name), aliases: [alias] };
    const runtimeSpec: JudgmentSpec = { ...specification, choice: [{ ...specification.choice[0]!, options: [
      { id: 'billing', description: 'Invoices' }, { id: 'candidate_42', description: 'Original authorized candidate' },
    ] }] };
    const runtime = createJudgmentReceiptContext(delivery, runtimeSpec, runtimeTypes);
    const runtimeWire = { ...wire, route: { ...wire.route, choice: 'candidate_42', probabilities: [
      { option: 'billing', probability: '0.2' }, { option: 'candidate_42', probability: '0.8' },
    ] } };
    assert.equal(isJudgmentReceiptContext(runtime), true);
    assert.equal(readJudgmentResult(runtimeWire, runtime)?.input_tokens, 9007199254740993n);
    assert.equal(isStoredReceiptPayload('succeeded', runtimeWire, null, runtime), true);
    for (const route of [
      { ...runtimeWire.route, choice: 'forged_candidate' },
      { ...runtimeWire.route, probabilities: [{ option: 'billing', probability: '0.2' }] },
      { ...runtimeWire.route, probabilities: [...runtimeWire.route.probabilities, { option: 'forged_candidate', probability: '0' }] },
      { ...runtimeWire.route, probabilities: [{ option: 'billing', probability: '0.2' }, { option: 'billing', probability: '0.8' }] },
      { ...runtimeWire.route, probabilities: [{ option: 'billing', probability: '0.2' }, { option: 'forged_candidate', probability: '0.8' }] },
    ]) assert.equal(isStoredReceiptPayload('succeeded', { ...runtimeWire, route }, null, runtime), false);
    for (const invalid of [{ ...alias, min: 0 }, { ...alias, max: 81 }, { ...alias, format: undefined }]) {
      assert.equal(isJudgmentReceiptContext({ ...context, judgment: { specification: runtimeSpec,
        valueTypes: { ...runtimeTypes, aliases: [invalid] } } } as unknown as ReceiptResultContext), false);
    }
    const genericText = { ...runtimeTypes, contracts: runtimeTypes.contracts.map(declaration => ({ ...declaration,
      fields: declaration.fields.map(field => field.type === alias.name ? { ...field, type: 'text' } : field) })) };
    assert.equal(isJudgmentReceiptContext({ ...context, judgment: { specification: runtimeSpec, valueTypes: genericText } }), false);
    assert.equal(isStoredReceiptPayload('succeeded', { ...runtimeWire, route: { ...runtimeWire.route,
      probabilities: [{ option: 'billing', probability: 0.2 }, { option: 'candidate_42', probability: '0.8' }] } }, null, runtime), false);
    const oversized = { ...runtimeSpec, choice: [{ ...runtimeSpec.choice[0]!, options: [
      { id: 'a'.repeat(81), description: 'Too long' }, { id: 'billing', description: 'Invoices' },
    ] }] };
    assert.equal(isJudgmentReceiptContext({ ...context, judgment: { specification: oversized, valueTypes: runtimeTypes } }), false);
  });

  it('rejects malformed explicit provenance and preserves null failure/unknown/static lifecycle rules', () => {
    const malformed: ReceiptResultContext[] = [
      { ...context, judgment: undefined } as unknown as ReceiptResultContext,
      { ...context, declaredResult: { ...resultDeclaration, fields: [...resultDeclaration.fields].reverse() } },
      { ...context, judgment: { specification: { ...specification, version: -1n }, valueTypes } },
      { ...context, judgment: { specification: { ...specification, version: 9223372036854775808n }, valueTypes } },
      { ...context, judgment: { specification: { ...specification, revision: 'invented' }, valueTypes } },
      { ...context, judgment: { specification: { ...specification, declaration: 'other.Triage' }, valueTypes } },
      { ...context, judgment: { specification, valueTypes: { contracts: [...valueTypes.contracts, resultDeclaration] } } },
    ];
    for (const invalid of malformed) {
      assert.equal(isJudgmentReceiptContext(invalid), false);
      assert.equal(isStoredReceiptPayload('succeeded', wire, null, invalid), false);
      assert.equal(isStoredReceiptPayload('pending', null, null, invalid), false);
      assert.deepEqual(applyReceiptProgress(association, pending, progress(), invalid),
        { applied: false, reason: 'inconsistent-envelope' });
    }
    assert.throws(() => createJudgmentReceiptContext({ ...delivery, version: '9007199254740992' }, specification, valueTypes));
    const error = { code: 'provider_unavailable', message: 'Try later.' };
    for (const [status, failure] of [['pending', null], ['unknown', null], ['unknown', error], ['failed', error], ['skipped', null]] as const) {
      assert.equal(isStoredReceiptPayload(status, null, failure, context), true);
      assert.equal(isStoredReceiptPayload(status, wire, failure, context), false);
    }
    assert.equal(isStoredReceiptPayload('failed', null, null, context), false);
    assert.throws(() => applyRelatedProgress(context.source, { ...association, revision: 1 },
      { ...pending, revision: 1, status: 'succeeded', result: { ...wire, input_tokens: '-1' } },
      progress(), context), /stored Judgment receipt/);
    assert.equal(isStoredReceiptPayload('succeeded', wire, error, context), false);
    const terminal = { ...pending, revision: 1, status: 'succeeded' as const, result: wire };
    const replay = applyRelatedProgress(context.source, { ...association, revision: 1 }, terminal,
      { ...progress(), result: { ...wire, model: 'another-valid-model' } }, context);
    assert.equal(replay.applied, true);
    if (replay.applied) { assert.equal(replay.receipt, terminal); assert.equal(replay.replay, true); }
    assert.deepEqual(applyRetainedRelatedProgress(context.source, terminal, { ...progress(), revision: 2 }, context),
      { applied: false, reason: 'terminal-immutable' });
  });
});
