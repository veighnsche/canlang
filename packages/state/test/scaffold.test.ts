import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stateCatalog, StateError, isStateError, ruleFailed } from '../src/index.js';
import { STATE_CONTRACT_VERSION } from '@canlang/contracts';

describe('scaffold', () => {
  it('catalog tracks the owned contract version', () => {
    const catalog = stateCatalog();
    assert.equal(catalog.name, '@canlang/state');
    assert.equal(catalog.contractVersion, STATE_CONTRACT_VERSION);
    assert.deepEqual(catalog.entries, []);
  });

  it('business rejections carry stable codes and safe messages', () => {
    const error = ruleFailed();
    assert.ok(isStateError(error));
    assert.equal(error.code, 'rule_failed');
    assert.equal(new StateError('conflict', 'Stale version.').code, 'conflict');
    assert.equal(isStateError(new Error('boom')), false);
  });
});
