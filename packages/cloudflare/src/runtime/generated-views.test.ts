import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERATED_VIEW_CONTRACT_VERSION } from '@canlang/contracts';
import type { GeneratedViewDescriptor, PresentationContext, RowView } from '@canlang/contracts';
import {
  assertSavedViewModule,
  loadSavedViewModule,
  readSavedViewStyle,
  renderGeneratedView,
} from './generated-views.js';

function context(): PresentationContext {
  return {
    preferredLocales: [], appDefaultLocale: 'en',
    theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
    path: '/todos', isPartial: false, csrfToken: 'csrf', principal: null, invocation: null,
    query: async () => ({ rows: [], columns: [] }),
  };
}

function descriptor(): GeneratedViewDescriptor {
  return {
    version: GENERATED_VIEW_CONTRACT_VERSION, view: 'TaskTile', rowModel: 'Todo',
    controls: [{ kind: 'edit', fields: ['title'] }],
    rootStyle: 'u7',
  };
}

function row(): RowView {
  return { id: 'row-1', fields: { title: 'Write tests' } };
}

async function fixtureUnit(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'can-view-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe('generated view page/module join', () => {
  it('renders repeated instances through the saved renderer with separate roots', async () => {
    const dir = await fixtureUnit({
      'implementation.js': `export function render({ row, bindings, ui }) {
        return '<h2>' + ui.escapeHtml(String(row.fields.title)) + '</h2>' + bindings.edit;
      }
      export function mount(root, presentation) { return () => {}; }`,
      'style.css': '.a:where([data-can-style~="u7"]) { color: red; }\n',
    });
    try {
      const saved = await loadSavedViewModule(dir, 'TaskTile');
      assert.equal(typeof saved.render, 'function');
      assert.equal(typeof saved.mount, 'function');
      const bindings = [{ name: 'edit', html: '<form>edit</form>' }];
      const first = await renderGeneratedView({
        unitDir: dir, context: context(), descriptor: descriptor(),
        useId: 'can-view-m0-f0-s10', row: row(), bindings,
      });
      const second = await renderGeneratedView({
        unitDir: dir, context: context(), descriptor: descriptor(),
        useId: 'can-view-m0-f0-s11', row: row(), bindings,
      });
      assert.match(first, /<section data-can-view="can-view-m0-f0-s10"/);
      assert.match(first, /<h2>Write tests<\/h2><form>edit<\/form>/);
      assert.match(second, /<section data-can-view="can-view-m0-f0-s11"/);
      assert.equal(await readSavedViewStyle(dir), '.a:where([data-can-style~="u7"]) { color: red; }\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses missing implementations and misshapen exports', async () => {
    const empty = await fixtureUnit({});
    try {
      await assert.rejects(loadSavedViewModule(empty, 'TaskTile'), /missing saved docs/implementation/);
      assert.equal(await readSavedViewStyle(empty), null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    const badRender = await fixtureUnit({ 'implementation.js': 'export const render = 42;\n' });
    try {
      await assert.rejects(loadSavedViewModule(badRender, 'TaskTile'), /exports no render/);
    } finally {
      await rm(badRender, { recursive: true, force: true });
    }
    assert.throws(
      () => assertSavedViewModule('TaskTile', { render: () => '', mount: 'nope' }),
      /non-function mount/,
    );
  });
});
