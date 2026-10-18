/** Saved disclosure plans admit the checked `email` dependency transport. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkScenarioResultDisclosurePlan } from '../../src/invocation/scenario-receipt.js';

const source = {
  path: 'maintain.can',
  sha256: '7fba1c716761bae8f9bc0d806c493091893ae7f7ae8fb8869823eef4593d1567',
  module: 'OriginalMaintainMail.mjs',
};

function planWith(dependencyType: unknown) {
  return {
    version: 1,
    source,
    returns: [
      {
        id: '260af288424d7769541523d2680ce7fc187b1c951a78ce93d4fd2e54cc56c829',
        source,
        dependencies: [
          {
            id: '260af288424d7769541523d2680ce7fc187b1c951a78ce93d4fd2e54cc56c829',
            source,
            role: 'data',
            model: 'maintain.Assignment',
            field: 'contact',
            type: dependencyType,
          },
        ],
        influences: [],
      },
    ],
  };
}

describe('scenario disclosure email dependency', () => {
  it('admits the checked email transport identity the compiler discloses', () => {
    const plan = checkScenarioResultDisclosurePlan(planWith('email'));
    assert.equal(plan.returns[0]!.dependencies[0]!.type, 'email');
  });

  it('still refuses a non-type dependency value', () => {
    // Bare words parse as bare nominal spellings (pre-existing Values
    // semantics); a non-string is neither scalar nor nominal.
    assert.throws(() => checkScenarioResultDisclosurePlan(planWith(42)), /scalar type|nominal type/);
  });
});
