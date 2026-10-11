/**
 * B3 delivery-schema proofs (colocated): the receipt join's
 * `DeliveryFieldSchema` is loader-built from L1-emitted T15b
 * `kind: 'delivery'` model field tags — never hand-built. Proves:
 * - the loader collects delivery-tagged fields per model into the
 *   `deliveryFields` channel (multi-model, exact membership);
 * - every non-delivery tag (scalars, ref, enum, T04b previews,
 *   unknown futures) stays out of the channel;
 * - malformed delivery envelopes (bad capability/operation/version,
 *   missing result shape) reject the WHOLE artifact;
 * - delivery tags on array fields still record membership (arrays
 *   don't affect delivery-field membership);
 * - models without deliveries get an empty (declared) entry, so
 *   downstream `assertDeliveryField` reports unknown-field — never
 *   unknown-model — for them;
 * - the loader-built schema drives `assertDeliveryField` verdicts
 *   (declared ok; unknown model / non-delivery field rejected).
 *
 * The t25 memory + durable suites re-prove the full join (leaf
 * grants, null/stale/revoked associations, fence enrollment) with
 * their worlds switched to this loader-built schema. `InterimModelPolicy`
 * stays hand-built per the B3 ruling (T04b/I00, not B3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IncompatibleArtifactError,
  artifactToDescriptorSet,
  loadArtifactDescriptors,
  loadExecutionDescriptorSet,
  type ArtifactDescriptorSlice,
} from '../invocation/registry.js';
import { assertDeliveryField } from './grants.js';
import { asModel } from '../../test/invocation/fixtures.js';

const ITEM = asModel('Acme.Item');
const ORDER = asModel('Acme.Order');

function deliveryTag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'delivery',
    capability: 'std.MailV1',
    operation: 'send',
    version: 1,
    result: { name: 'MailSend', fields: [] },
    ...over,
  };
}

function sliceWith(models: ReadonlyArray<Record<string, unknown>>): ArtifactDescriptorSlice {
  return { artifact_version: 1, operations: [], models: models as never };
}

function itemModel(fields: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return { name: 'Acme.Item', fields, deleteMode: 'none' };
}

function fieldDef(name: string, tag: Record<string, unknown>): Record<string, unknown> {
  return { name, field: tag, required: false, serverOnly: false };
}

describe('B3 loader: deliveryFields channel', () => {
  it('collects delivery-tagged fields per model', () => {
    const tag = deliveryTag({ result: { name: 'MailSend', fields: [
      { name: 'detail', type: 'text?', trim: true, min: 1, max: 128, format: 'name' },
      { name: 'recipients', type: 'User[]', distinctBy: 'id', excludedIds: ['excluded'] },
    ] } });
    const expected = structuredClone(tag);
    const slice = sliceWith([
        itemModel([
          fieldDef('service', { kind: 'string' }),
          { ...fieldDef('notification', tag), nullable: true },
        ]),
        {
          name: 'Acme.Order',
          fields: [
            { ...fieldDef('receipt', deliveryTag({ capability: 'std.ShipV2', operation: 'track' })), nullable: false },
            fieldDef('note', { kind: 'string' }),
          ],
          deleteMode: 'none',
        },
      ]);
    const converted = artifactToDescriptorSet(slice);
    const artifact = loadArtifactDescriptors(slice, { by: 'members' });
    const direct = loadExecutionDescriptorSet(converted.set, { by: 'members' });
    assert.equal(converted.deliveryFields.size, 2);
    assert.deepEqual([...(converted.deliveryFields.get(ITEM) ?? [])], ['notification']);
    assert.deepEqual([...(converted.deliveryFields.get(ORDER) ?? [])], ['receipt']);
    assert.deepEqual(artifact.models, direct.models);
    for (const loaded of [converted.set, artifact, direct]) {
      assert.deepEqual(loaded.models[0]!.fields.notification!.delivery, expected);
      assert.equal(loaded.models[0]!.fields.notification!.nullable, true);
      assert.equal(loaded.models[1]!.fields.receipt!.nullable, false);
      assert.equal(Object.hasOwn(loaded.models[0]!.fields.notification!, 'valueType'), false);
    }
    assert.ok(Object.isFrozen(artifact.models[0]!.fields.notification!.delivery!.result.fields[1]!.excludedIds));
    (tag.result as { fields: Array<{ max?: number; excludedIds?: string[] }> }).fields[0]!.max = 1;
    (tag.result as { fields: Array<{ excludedIds?: string[] }> }).fields[1]!.excludedIds!.push('changed');
    for (const loaded of [converted.set, artifact, direct]) assert.deepEqual(loaded.models[0]!.fields.notification!.delivery, expected);
  });

  it('ignores non-delivery tags (ref, enum, previews, futures)', () => {
    const converted = artifactToDescriptorSet(
      sliceWith([
        itemModel([
          fieldDef('owner', { kind: 'ref', model: 'Acme.Item' }),
          fieldDef('kind', { kind: 'enum', values: ['a'] }),
          fieldDef('made', { kind: 'datetime' }),
          fieldDef('blob', { kind: 'bytes' }),
          fieldDef('mystery', { kind: 'future-tag' }),
        ]),
      ]),
    );
    assert.deepEqual([...(converted.deliveryFields.get(ITEM) ?? ['MISSING'])], []);
  });

  it('rejects a malformed delivery envelope for the whole set', () => {
    assert.throws(
      () =>
        artifactToDescriptorSet(
          sliceWith([itemModel([fieldDef('notification', deliveryTag({ version: 'one' }))])]),
        ),
      (error: unknown) =>
        error instanceof IncompatibleArtifactError &&
        error.reason === 'malformed_descriptor' &&
        /delivery identity\/version must match its standard or source Judgment profile\./.test(error.message),
    );
    assert.throws(
      () =>
        artifactToDescriptorSet(
          sliceWith([itemModel([fieldDef('notification', deliveryTag({ result: null }))])]),
        ),
      (error: unknown) =>
        error instanceof IncompatibleArtifactError &&
        /delivery descriptors carry a result/.test(error.message),
    );
    let getterCalls = 0;
    const accessor = Object.defineProperty({ name: 'detail' }, 'type', {
      enumerable: true, get() { getterCalls++; return 'text'; },
    });
    const inherited = Object.create({ name: 'detail', type: 'text' });
    for (const tag of [
      deliveryTag({ result: { name: 'MailSend', fields: [accessor] } }),
      deliveryTag({ result: { name: 'MailSend', fields: [inherited] } }),
      deliveryTag({ result: { name: 'MailSend', fields: [{ name: 'detail', type: 1 }] } }),
    ]) {
      const artifact = sliceWith([itemModel([fieldDef('notification', tag)])]);
      assert.throws(() => loadArtifactDescriptors(artifact, { by: 'members' }), IncompatibleArtifactError);
      assert.throws(() => loadExecutionDescriptorSet({ contractVersion: 1, operations: [], models: [
        { name: ITEM, deleteMode: 'none', fields: { notification: { required: false, serverOnly: false, delivery: tag } } },
      ] } as never, { by: 'members' }), IncompatibleArtifactError);
    }
    assert.equal(getterCalls, 0, 'delivery metadata is inspected without invoking getters');
    const nullableGetter = Object.defineProperty(fieldDef('notification', deliveryTag()), 'nullable', {
      enumerable: true, get() { getterCalls++; return true; },
    });
    for (const field of [{ ...fieldDef('notification', deliveryTag()), nullable: 'yes' }, nullableGetter,
      Object.assign(Object.create({ nullable: true }), fieldDef('notification', deliveryTag()))]) {
      assert.throws(() => loadArtifactDescriptors(sliceWith([itemModel([field])]), { by: 'members' }), IncompatibleArtifactError);
    }
    assert.equal(getterCalls, 0, 'nullable metadata is inspected before values');
    const inheritedField = Object.assign(Object.create(Object.defineProperty({}, 'field', {
      get() { getterCalls++; return deliveryTag(); },
    })), { name: 'notification', required: false, serverOnly: false });
    const inheritedKind = fieldDef('notification', Object.create(Object.defineProperty({}, 'kind', {
      get() { getterCalls++; return 'delivery'; },
    })));
    for (const field of [inheritedField, inheritedKind]) {
      const converted = artifactToDescriptorSet(sliceWith([itemModel([field])]));
      assert.equal(Object.hasOwn(converted.set.models[0]!.fields.notification!, 'delivery'), false);
      assert.deepEqual([...(converted.deliveryFields.get(ITEM) ?? [])], []);
    }
    assert.equal(getterCalls, 0, 'inherited future tags remain unassociated without evaluating getters');
  });

  it('records delivery membership on array fields too', () => {
    const converted = artifactToDescriptorSet(
      sliceWith([
        itemModel([
          {
            name: 'broadcasts',
            field: deliveryTag(),
            required: false,
            serverOnly: false,
            array: { required: false },
          },
        ]),
      ]),
    );
    assert.deepEqual([...(converted.deliveryFields.get(ITEM) ?? [])], ['broadcasts']);
    const direct = loadExecutionDescriptorSet(converted.set, { by: 'members' });
    assert.deepEqual(direct.models[0]!.fields.broadcasts!.delivery, deliveryTag());
    assert.deepEqual(direct.models[0]!.fields.broadcasts!.array, { required: false });
  });

  it('drives assertDeliveryField verdicts from the loader-built schema', () => {
    const converted = artifactToDescriptorSet(
      sliceWith([itemModel([fieldDef('notification', deliveryTag())])]),
    );
    const schema = converted.deliveryFields;
    assertDeliveryField(schema, ITEM, 'notification');
    assert.throws(
      () => assertDeliveryField(schema, ITEM, 'service'),
      /is not a declared delivery field/,
    );
    assert.throws(
      () => assertDeliveryField(schema, asModel('Acme.Missing'), 'notification'),
      /unknown model/,
    );
  });
});
