import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedOperationInputs, RowView } from '@canlang/contracts';
import { projectViewRow } from '../src/http/presentation.js';
import { admitGeneratedViewControls } from '../src/http/operations.js';

function derived(): DerivedOperationInputs {
  return {
    operation: 'Todo.create', kind: 'create', artifactVersion: 1,
    inputs: [
      { name: 'title', kind: 'string', required: true },
      { name: 'done', kind: 'boolean', required: false },
    ],
  };
}

function row(): RowView {
  return { id: 'row-1', version: 'v3', fields: { title: 'Write tests', done: false, secret: 'x' } };
}

describe('row-bound renderer admission', () => {
  it('projects the admitted row fields and leaves refused fields absent', () => {
    const projected = projectViewRow('TaskTile', row(), ['title']);
    assert.deepEqual(projected, { id: 'row-1', version: 'v3', fields: { title: 'Write tests' } });
    assert.ok(!('secret' in projected.fields));
    assert.ok(!('done' in projected.fields));
    assert.ok(Object.isFrozen(projected));
  });

  it('refuses unknown admitted names before the renderer runs', () => {
    assert.throws(() => projectViewRow('TaskTile', row(), ['title', 'nope']), (error: unknown) => {
      assert.equal(typeof error === 'object' && error !== null && (error as { code: unknown }).code, 'validation');
      assert.match(
        String((error as { message: unknown }).message ?? ''),
        /unknown row field "nope"/,
      );
      return true;
    });
  });

  it('narrows control derivations to declared fields and reports refusals', () => {
    const { admitted, refused } = admitGeneratedViewControls(derived(), ['title', 'secret']);
    assert.deepEqual(admitted.inputs.map((input) => input.name), ['title']);
    assert.deepEqual(refused, ['secret']);
    assert.equal(admitted.operation, 'Todo.create');
    assert.ok(Object.isFrozen(admitted.inputs));
  });

  it('admits declared controls in emission order with no refusals', () => {
    const { admitted, refused } = admitGeneratedViewControls(derived(), ['done', 'title']);
    assert.deepEqual(admitted.inputs.map((input) => input.name), ['done', 'title']);
    assert.deepEqual(refused, []);
  });
});
