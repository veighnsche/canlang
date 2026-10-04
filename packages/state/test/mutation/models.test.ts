/**
 * Lane 03 S5 model-table tests (coordinator): buildModelTable fails fast with
 * descriptive plain Errors (never bare TypeErrors) on malformed descriptors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelTable,
  type InterimModelDef,
  type InterimRefDef,
} from '../../src/mutation/index.js';
import { StateError } from '../../src/errors.js';
import { captureFailure } from '../invocation/fixtures.js';
import { field, modelDef } from './fixtures.js';

async function buildError(def: InterimModelDef): Promise<Error> {
  const failure = await captureFailure(() => buildModelTable([def]));
  assert.ok(failure instanceof Error, 'expected an Error');
  assert.ok(!(failure instanceof StateError), 'expected a plain Error, not a StateError');
  return failure;
}

describe('mutation model table', () => {
  it('rejects non-string and empty model names with a descriptive Error', async () => {
    for (const model of ['', 5, undefined]) {
      const failure = await buildError(
        modelDef(model as unknown as string, { fields: { title: field() } }),
      );
      assert.match(failure.message, /model names are non-empty strings/);
    }
  });

  it('rejects null field defs with a descriptive Error, not a TypeError', async () => {
    const def = modelDef('Acme.Doc', { fields: { title: field() } });
    (def.fields as Record<string, unknown>)['title'] = null;
    const failure = await buildError(def);
    assert.match(failure.message, /field defs must be objects/);
  });

  it('rejects malformed ref defs with descriptive Errors', async () => {
    const cases: Array<{ label: string; refs: InterimRefDef[]; match: RegExp }> = [
      {
        label: 'null ref',
        refs: [null as unknown as InterimRefDef],
        match: /ref defs must be objects/,
      },
      {
        label: 'non-string field',
        refs: [{ field: 5 as unknown as string, model: 'Acme.Target' as never }],
        match: /ref fields are dot-path strings/,
      },
      {
        label: 'non-string model',
        refs: [{ field: 'target', model: 5 as unknown as never }],
        match: /target models are non-empty strings/,
      },
    ];
    for (const { label, refs, match } of cases) {
      const failure = await buildError(modelDef('Acme.Doc', { fields: { target: field() }, refs }));
      assert.match(failure.message, match, label);
    }
  });
});
