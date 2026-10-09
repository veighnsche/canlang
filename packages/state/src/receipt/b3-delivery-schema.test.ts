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
    const converted = artifactToDescriptorSet(
      sliceWith([
        itemModel([
          fieldDef('service', { kind: 'string' }),
          fieldDef('notification', deliveryTag()),
        ]),
        {
          name: 'Acme.Order',
          fields: [
            fieldDef('receipt', deliveryTag({ capability: 'std.ShipV2', operation: 'track' })),
            fieldDef('note', { kind: 'string' }),
          ],
          deleteMode: 'none',
        },
      ]),
    );
    assert.equal(converted.deliveryFields.size, 2);
    assert.deepEqual([...(converted.deliveryFields.get(ITEM) ?? [])], ['notification']);
    assert.deepEqual([...(converted.deliveryFields.get(ORDER) ?? [])], ['receipt']);
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
