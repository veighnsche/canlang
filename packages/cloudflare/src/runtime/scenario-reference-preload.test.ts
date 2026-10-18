/** Grant-free preload defers reference owners outside the policy table. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeScenarioReferenceBindingDefersGrantFree } from './invoke.js';

const models = [{ name: 'maintain.Notice' }, { name: 'maintain.Assignment' }];

function planWith(type: string, owner = 'maintain.Notice') {
  return { returns: [{ dependencies: [{ type, model: owner, field: 'parent' }] }] };
}

test('defers a nominal reference whose owner has no policy-table entry', () => {
  assert.equal(
    nativeScenarioReferenceBindingDefersGrantFree(
      planWith('maintain.Assignment'), models, model => model !== 'maintain.Notice'),
    true);
});

test('binds grant-free when every nominal reference owner is covered', () => {
  assert.equal(
    nativeScenarioReferenceBindingDefersGrantFree(
      planWith('maintain.Assignment'), models, () => true),
    false);
});

test('ignores scalar-only disclosures', () => {
  assert.equal(
    nativeScenarioReferenceBindingDefersGrantFree(
      planWith('email'), models, () => false),
    false);
});
