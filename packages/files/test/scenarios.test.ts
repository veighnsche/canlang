/**
 * S9a: files authors no scenario tables — pinned so playback never
 * silently gains an invented `files:` vocabulary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FILES_SCENARIO_TABLES } from '../src/scenarios.js';
import { findScenarioTable } from '@canlang/services/scenarios';

describe('scenarios: files authors none', () => {
  it('the files table list is empty', () => {
    assert.deepEqual([...FILES_SCENARIO_TABLES], []);
  });

  it('no files: seed ref resolves', () => {
    assert.equal(findScenarioTable('files', 'up-ok'), null);
  });
});
