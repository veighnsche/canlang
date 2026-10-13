import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type {
  GeneratedViewDescriptor,
  GeneratedViewInstanceProps,
  GeneratedViewPresentation,
  GeneratedViewRenderInput,
  PresentationContext,
  RowView,
} from '@canlang/contracts';
import {
  GENERATED_VIEW_CONTRACT_VERSION,
  styleHostAttributes,
  styleUseAttributes,
} from '@canlang/contracts';
import { generatedViewInstance } from '../src/components.js';
import { formFragmentWrap, viewControlIdPrefix } from '../src/forms.js';
import { rerenderFormPreservingFocus } from '../src/client.js';
import {
  applyPollResponse,
  registerGeneratedViewMount,
  releaseGeneratedViewMount,
  startBrowserClient,
  type BrowserClientOptions,
} from '../src/browser/bootstrap.js';

function context(): PresentationContext {
  return {
    preferredLocales: [], appDefaultLocale: 'en',
    theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
    path: '/todos', isPartial: false, csrfToken: 'csrf', principal: null, invocation: null,
    query: async () => ({ rows: [], columns: [] }),
  };
}

function plainDescriptor(view: string): GeneratedViewDescriptor {
  return {
    version: GENERATED_VIEW_CONTRACT_VERSION, view, rowModel: 'Todo',
    controls: [{ kind: 'edit', fields: ['title'] }, { kind: 'delete' }],
  };
}

function descriptor(): GeneratedViewDescriptor {
  return {
    version: GENERATED_VIEW_CONTRACT_VERSION, view: 'TaskTile', rowModel: 'Todo',
    controls: [{ kind: 'edit', fields: ['title'] }, { kind: 'delete' }],
    rootStyle: 'u7',
  };
}

function row(): RowView {
  return { id: 'row-1', version: 'v1', fields: { title: 'Write tests', done: false } };
}

function props(useId: string, render: GeneratedViewInstanceProps['render']): GeneratedViewInstanceProps {
  return {
    context: context(), descriptor: descriptor(), useId, row: row(),
    bindings: [
      { name: 'edit', html: '<form>edit-title</form>' },
      { name: 'delete', html: '<form>delete</form>' },
    ],
    render,
  };
}

describe('generated view instances', () => {
  it('renders one root per instance and calls render once with the evaluated row', async () => {
    const seen: Array<{ row: RowView; names: string[] }> = [];
    const first = await generatedViewInstance(props('can-view-m0-f0-s10', (input: GeneratedViewRenderInput) => {
      seen.push({ row: input.row, names: Object.keys(input.bindings) });
      return `<h2>${input.ui.escapeHtml(String(input.row.fields['title']))}</h2>${input.bindings['edit']}${input.bindings['delete']}`;
    }));
    const second = await generatedViewInstance(props('can-view-m0-f0-s99', async (input: GeneratedViewRenderInput) => `<p>${input.bindings['edit'] ?? ''}</p>`));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.row.id, 'row-1');
    assert.deepEqual(seen[0]?.names, ['edit', 'delete']);
    assert.match(first, /<section data-can-view="can-view-m0-f0-s10"/);
    assert.match(first, /data-can-style="u7" data-can-style-root="u7:can-view-m0-f0-s10"/);
    assert.match(first, /data-can-view-presentation="/);
    assert.match(first, /<h2>Write tests<\/h2>/);
    assert.match(second, /<section data-can-view="can-view-m0-f0-s99"/);
    assert.ok(!second.includes('can-view-m0-f0-s10'));
  });

  it('refuses version, identity, and binding misuse before the renderer runs', async () => {
    let calls = 0;
    const render = () => { calls += 1; return ''; };
    await assert.rejects(
      generatedViewInstance({ ...props('bogus', render) }),
      /invalid use id/,
    );
    await assert.rejects(
      generatedViewInstance({
        ...props('can-view-m0-f0-s10', render),
        descriptor: { ...descriptor(), version: 'canlang.presentation.generated-view/9' as GeneratedViewDescriptor['version'] },
      }),
      /unsupported contract/,
    );
    await assert.rejects(
      generatedViewInstance({
        ...props('can-view-m0-f0-s10', render),
        bindings: [{ name: 'edit', html: 'a' }, { name: 'edit', html: 'b' }],
      }),
      /duplicate binding/,
    );
    assert.equal(calls, 0);
  });

  it('derives distinct control prefixes per instance', () => {
    const edit = viewControlIdPrefix('can-view-m0-f0-s10', 'edit');
    const other = viewControlIdPrefix('can-view-m0-f0-s99', 'edit');
    assert.equal(edit, 'can-view-m0-f0-s10-edit');
    assert.notEqual(edit, other);
    assert.throws(() => viewControlIdPrefix('bogus', 'edit'), /invalid use id/);
    assert.throws(() => viewControlIdPrefix('can-view-m0-f0-s10', 'Edit!'), /invalid control/);
  });

  it('emits compiler-owned style hook attributes', () => {
    assert.equal(styleUseAttributes('u7', 's12'), 'data-can-style="u7" data-can-style-root="u7:s12"');
    assert.equal(styleHostAttributes('u8', 'u7'), 'data-can-style="u8" data-can-style-host="u7"');
  });
});

describe('validation drafts and focus', () => {
  it('retains the server draft and restores focus plus selection', async () => {
    const window = new Window({ url: 'https://can.test/todos' });
    try {
      const prefix = 'can-view-m0-f0-s10-edit';
      window.document.body.innerHTML = formFragmentWrap(
        prefix,
        `<form><input id="${prefix}-title" value="draft title"></form>`,
      );
      const document = window.document as unknown as Parameters<typeof rerenderFormPreservingFocus>[0];
      const input = window.document.getElementById(`${prefix}-title`) as unknown as {
        focus(): void;
        setSelectionRange(start: number, end: number): void;
      };
      input.focus();
      input.setSelectionRange(0, 5);
      // The error re-render carries the submitted draft plus the outlet.
      rerenderFormPreservingFocus(
        document,
        prefix,
        formFragmentWrap(
          prefix,
          `<form><input id="${prefix}-title" value="draft title"><p id="${prefix}-title-error">Required.</p></form>`,
        ),
      );
      const kept = window.document.getElementById(`${prefix}-title`) as unknown as {
        getAttribute(name: string): string | null;
        readonly selectionStart: number | null;
        readonly selectionEnd: number | null;
      };
      assert.equal(kept.getAttribute('value'), 'draft title');
      assert.equal(window.document.activeElement, kept as unknown as object);
      assert.equal(kept.selectionStart, 0);
      assert.equal(kept.selectionEnd, 5);
    } finally {
      await window.happyDOM.close();
    }
  });

  it('keeps fresh markup when the focused control is gone, and throws without a target', async () => {
    const window = new Window({ url: 'https://can.test/todos' });
    try {
      window.document.body.innerHTML = formFragmentWrap('p', '<form><input id="p-a" value="x"></form>');
      const document = window.document as unknown as Parameters<typeof rerenderFormPreservingFocus>[0];
      (window.document.getElementById('p-a') as unknown as { focus(): void }).focus();
      rerenderFormPreservingFocus(document, 'p', formFragmentWrap('p', '<form><input id="p-b" value="y"></form>'));
      assert.equal((window.document.getElementById('p-b') as unknown as { getAttribute(name: string): string | null }).getAttribute('value'), 'y');
      assert.throws(() => rerenderFormPreservingFocus(document, 'missing', '<div></div>'), /missing swap target/);
    } finally {
      await window.happyDOM.close();
    }
  });
});

describe('generated view mounts', () => {
  const MAIN_ATTRS = 'id="can-main" data-can-context="owner" data-can-poll-context="owner"';

  async function world(mainHtml: string) {
    const window = new Window({ url: 'https://can.test/todos' });
    window.document.body.innerHTML = `<main ${MAIN_ATTRS}>${mainHtml}</main>`;
    const options: BrowserClientOptions = {
      window: window as unknown as BrowserClientOptions['window'],
      fetchImpl: async () => ({ status: 200, headers: { get: () => 'text/html' }, text: async () => '' }),
    };
    const client = startBrowserClient(options);
    return {
      window, client,
      close: async () => { client.stop(); await window.happyDOM.close(); },
    };
  }

  it('mounts each instance once with its presentation and cleans up only replaced roots', async () => {
    const mounted: string[] = [];
    const cleaned: string[] = [];
    registerGeneratedViewMount('TaskTileMount', (root: unknown, presentation: GeneratedViewPresentation) => {
      mounted.push(`${presentation.useId}:${presentation.row.id}`);
      assert.ok(typeof root === 'object' && root !== null);
      return () => { cleaned.push(presentation.useId); };
    });
    const render = (id: string) => async () => `<p>${id}</p>`;
    const first = await generatedViewInstance({
      ...props('can-view-m0-f0-s10', render('a')),
      descriptor: plainDescriptor('TaskTileMount'),
      row: { id: 'row-a', fields: {} },
    });
    const second = await generatedViewInstance({
      ...props('can-view-m0-f0-s11', render('b')),
      descriptor: plainDescriptor('TaskTileMount'),
      row: { id: 'row-b', fields: {} },
    });
    const page = await world(`${first}${second}`);
    try {
      assert.deepEqual(mounted, ['can-view-m0-f0-s10:row-a', 'can-view-m0-f0-s11:row-b']);
      // Replace the first root; the survivor keeps its mount.
      page.window.document.querySelector('section[data-can-view="can-view-m0-f0-s10"]')?.remove();
      page.client.rescan();
      assert.deepEqual(cleaned, ['can-view-m0-f0-s10']);
      // Idempotent release never double-runs cleanup.
      releaseGeneratedViewMount('can-view-m0-f0-s10');
      releaseGeneratedViewMount('unknown-id');
      assert.deepEqual(cleaned, ['can-view-m0-f0-s10']);
    } finally {
      await page.close();
    }
    assert.deepEqual(cleaned, ['can-view-m0-f0-s10', 'can-view-m0-f0-s11']);
  });

  it('releases mounts when a poll morph removes the root', async () => {
    const cleaned: string[] = [];
    registerGeneratedViewMount('TaskTileMorph', () => () => { cleaned.push('trimmed'); });
    const first = await generatedViewInstance({
      ...props('can-view-m0-f0-s20', async () => '<p>a</p>'),
      descriptor: plainDescriptor('TaskTileMorph'),
    });
    const page = await world(first);
    try {
      const document = page.window.document as unknown as Parameters<typeof applyPollResponse>[0];
      const region = page.window.document.getElementById('can-main') as unknown as Parameters<typeof applyPollResponse>[1];
      const applied = applyPollResponse(document, region, `<main ${MAIN_ATTRS}><p>replaced</p></main>`, 200);
      assert.equal(applied, true);
      assert.deepEqual(cleaned, ['trimmed']);
    } finally {
      await page.close();
    }
  });

  it('leaves roots without a registered mount inert', async () => {
    const html = await generatedViewInstance(props('can-view-m0-f0-s30', async () => '<p>plain</p>'));
    const page = await world(html);
    try {
      page.client.rescan();
      assert.ok(page.window.document.querySelector('section[data-can-view="can-view-m0-f0-s30"]') !== null);
    } finally {
      await page.close();
    }
  });
});
