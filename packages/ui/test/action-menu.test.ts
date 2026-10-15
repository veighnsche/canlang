import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { HTMLButtonElement, HTMLElement, HTMLDialogElement, HTMLInputElement } from 'happy-dom';
import type { PresentationContext } from '@canlang/contracts';
import { actionMenu, primaryActions, modal, drawer, tooltip } from '../src/overlays.js';
import { button } from '../src/navigation.js';
import { list, table } from '../src/collections.js';
import { detailsDrawer } from '../src/groups.js';
import { renderActionScope } from '../src/internal/action-groups.js';
import { card, styledComponent } from '../src/components.js';
import { message } from '../src/messages.js';
import { action, deleteRecord, edit, form } from '../src/forms.js';
import { applyPollResponse, startNativeBrowserClient, type DocumentLike, type ElementLike } from '../src/browser/bootstrap.js';

const context: PresentationContext = {
  preferredLocales: [], appDefaultLocale: 'en',
  theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
  path: '/items', isPartial: false, csrfToken: 'csrf', principal: null, invocation: null,
  query: async () => ({ rows: [], columns: [] }),
};
const base = { context, action: '/operations/item', operation: 'Store.Item.delete',
  operationId: 'op', record: { id: 'row', version: '3' }, idPrefix: 'item-1' };
const archive = () => deleteRecord({ ...base, mode: 'archive', itemLabel: 'Item', confirm: 'Archive this item?', display: 'menu' });

describe('action menu', () => {
  it('omits empty authorized controls and renders a localized native disclosure', async () => {
    assert.equal(await actionMenu({ context, id: 'empty', children: ['', Promise.resolve('')] }), '');
    const html = await actionMenu({ context: { ...context, preferredLocales: ['nl'] }, id: 'menu-1', children: [archive()] });
    assert.ok(html.includes('aria-label="Meer acties"'));
    assert.ok(html.includes('popovertarget="menu-1-popover"'));
    assert.ok(html.includes('id="menu-1-popover" popover'));
    assert.ok(!html.includes('role="menu"'));
    await assert.rejects(actionMenu({ context, id: 'unsafe id', children: ['control'] }), /region id/);
  });

  it('retains the canonical confirmation form and record metadata behind a non-submit opener', async () => {
    const window = new Window();
    try {
      window.document.body.innerHTML = await archive();
      const opener = window.document.querySelector('[data-can-menu-dialog-open]');
      assert.equal(opener?.getAttribute('type'), 'button');
      assert.equal(opener?.textContent, 'Archive');
      const dialog = window.document.querySelector('dialog')!;
      assert.equal(dialog.hasAttribute('open'), false);
      assert.ok(dialog.querySelector('form[data-can-delete-form]'));
      assert.equal(dialog.querySelector('input[name="inputs[record][version]"]')?.getAttribute('value'), '3');
      assert.equal(dialog.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf');
      assert.ok(dialog.textContent.includes('Archive this item?'));
    } finally { await window.happyDOM.close(); }
  });

  it('gives every menu input/confirmation form one adjacent Cancel then commit footer on one surface', async () => {
    const fields = [{ path: 'note', label: 'Note', type: 'text', required: false, value: 'Draft note' }];
    const common = { ...base, timeZone: 'UTC', fields, display: 'menu' as const };
    const cases = [
      { commit: 'Create item', html: form({ ...common, mode: 'create', submit: 'Create item' }) },
      { commit: 'Edit item', html: form({ ...common, mode: 'update', submit: 'Edit item' }) },
      { commit: 'Save edit', html: edit({ ...common, submit: 'Save edit' }) },
      { commit: 'Run action', html: action({ ...common, label: 'Run action' }) },
      { commit: 'Confirm action', html: action({ ...base, display: 'menu', label: 'Confirm action', confirm: 'Run this action?' }) },
      { commit: 'Archive', html: archive() },
      { commit: 'Delete', html: deleteRecord({ ...base, display: 'menu', mode: 'remove', itemLabel: 'Item', confirm: 'Delete this item?' }) },
    ];
    const window = new Window();
    try {
      for (const entry of cases) {
        window.document.body.innerHTML = await entry.html;
        const dialog = window.document.querySelector('dialog')!;
        const canonical = dialog.querySelector('form')!;
        assert.equal(dialog.querySelectorAll('form').length, 1);
        assert.equal(dialog.querySelectorAll('.modal-box').length, 1);
        assert.equal(dialog.querySelectorAll('.card').length, 0, 'confirmation acquires no nested surface');
        assert.equal(dialog.querySelectorAll('.modal-action').length, 0, 'wrapper acquires no extra action row');
        const footer = canonical.querySelector('[data-can-dialog-actions]')!;
        assert.equal(dialog.querySelectorAll('[data-can-dialog-actions]').length, 1);
        const controls = Array.from(footer.querySelectorAll('button'));
        assert.deepEqual(controls.map(control => control.textContent), ['Cancel', entry.commit]);
        assert.deepEqual(controls.map(control => control.type), ['button', 'submit']);
        assert.ok(controls[0]!.hasAttribute('data-can-menu-dialog-close'));
        assert.equal(controls[0]!.parentElement, controls[1]!.parentElement);
        assert.equal(canonical.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf');
        assert.equal(canonical.querySelector('input[name="operation_id"]')?.getAttribute('value'), 'op');
      }
      window.document.body.innerHTML = await archive();
      const canonical = window.document.querySelector('dialog form')!;
      assert.ok(canonical.textContent.includes('Item'));
      assert.ok(canonical.textContent.includes('Archive this item?'));
      assert.equal(canonical.querySelector('input[name="inputs[record][version]"]')?.getAttribute('value'), '3');
      assert.ok(canonical.querySelector('button[type="submit"]')?.classList.contains('btn-warning'));
    } finally { await window.happyDOM.close(); }
  });

  it('retains one explicit navigation cancel in menu forms and leaves immediate/inline/drawer behavior intact', async () => {
    const common = { ...base, timeZone: 'UTC', fields: [], submit: 'Save', cancelHref: '/items?from=form' };
    const window = new Window();
    try {
      const menus = [form({ ...common, mode: 'create', display: 'menu' }), edit({ ...common, display: 'menu' }),
        deleteRecord({ ...base, mode: 'archive', itemLabel: 'Item', confirm: 'Archive?', display: 'menu', cancelHref: common.cancelHref })];
      for (const html of menus) {
        window.document.body.innerHTML = await html;
        const footer = window.document.querySelector('[data-can-dialog-actions]')!;
        assert.equal(footer.querySelectorAll('a').length, 1);
        assert.equal(footer.firstElementChild?.textContent, 'Cancel');
        assert.equal(footer.querySelector('a')?.getAttribute('href'), common.cancelHref);
        assert.equal(window.document.querySelectorAll('[data-can-menu-dialog-close]').length, 0);
      }
      for (const display of ['inline', 'drawer'] as const) {
        window.document.body.innerHTML = await form({ ...common, mode: 'create', display });
        assert.equal(window.document.querySelectorAll('[data-can-dialog-actions]').length, 0);
        const controls = window.document.querySelector('form [data-can-form-actions]')!;
        assert.deepEqual(Array.from(controls.children, control => control.textContent), ['Save', 'Cancel']);
      }
      const immediate = await form({ ...common, mode: 'scenario', display: 'menu' });
      assert.ok(!immediate.includes('<dialog'));
      assert.ok(!immediate.includes('data-can-dialog-actions'));
      assert.ok(!(await action({ ...base, label: 'Run', display: 'menu' })).includes('<dialog'));
    } finally { await window.happyDOM.close(); }
  });

  it('uses Edit for the edit opener and owning captions for form/action openers', async () => {
    const props = { ...base, timeZone: 'UTC', fields: [], submit: 'Save', display: 'menu' as const };
    const editing = await edit(props);
    assert.ok(editing.includes('aria-controls="item-1-menu-dialog">Edit</button>'));
    assert.ok(editing.includes('>Save</button>'));
    assert.ok((await form({ ...props, mode: 'create' })).includes('aria-controls="item-1-menu-dialog">Save</button>'));
    const immediate = await action({ ...base, label: 'Run', display: 'menu' });
    assert.ok(immediate.includes('type="submit"'));
    assert.ok(!immediate.includes('<dialog'));
    assert.ok((await action({ ...base, label: 'Run', display: 'menu', confirm: 'Run this action?' })).includes('aria-controls="item-1-menu-dialog">Run</button>'));
    assert.equal(await primaryActions({ context, children: [''] }), '');
    assert.ok((await primaryActions({ context, children: [editing, immediate] })).startsWith('<div class="can-primary-actions" data-can-primary-actions>'));
  });

  it('derives source update and default create opener captions without changing submit labels', async () => {
    const props = { ...base, timeZone: 'UTC', fields: [], submit: message('Submit', { nl: 'Verzenden' }), display: 'menu' as const };
    const update = await form({ ...props, mode: 'update' });
    assert.ok(update.includes('aria-controls="item-1-menu-dialog">Edit</button>'));
    assert.ok(update.includes('type="submit" class="btn btn-primary" data-can-standard-submit>Submit</button>'));
    const create = await form({ ...props, mode: 'create', context: { ...context, preferredLocales: ['nl'] } });
    assert.ok(create.includes('aria-controls="item-1-menu-dialog">Aanmaken</button>'));
    assert.ok(create.includes('type="submit" class="btn btn-primary" data-can-standard-submit>Verzenden</button>'));
    const authored = await form({ ...props, mode: 'create', submit: 'Publish item' });
    assert.ok(authored.includes('aria-controls="item-1-menu-dialog">Publish item</button>'));
  });

  it('keeps prepared source scenario actions immediate while create and authored content use dialogs', async () => {
    const props = { context, action: '/operations/run', operation: 'Store.run', operationId: 'op-run',
      timeZone: 'UTC', fields: [], submit: 'Run', idPrefix: 'run-action', display: 'menu' as const };
    const immediate = await form({ ...props, mode: 'scenario', derived: {
      operation: 'Store.run', kind: 'scenario', artifactVersion: 1, inputs: [],
    } });
    assert.ok(immediate.startsWith('<form'));
    assert.ok(immediate.includes('data-can-generated-form'));
    assert.ok(immediate.includes('type="submit"'));
    assert.ok(!immediate.includes('<dialog'));
    assert.ok((await form({ ...props, mode: 'create' })).includes('<dialog'));
    assert.ok((await form({ ...props, mode: 'scenario', children: ['<p>Confirm this action</p>'] })).includes('<dialog'));
  });

  it('uses an explicit primitive caption on an update opener and retains canonical submit and binding', async () => {
    const html = await form({ ...base, mode: 'update', timeZone: 'UTC', fields: [],
      submit: 'Save', controlLabel: message('Change details', { nl: 'Details wijzigen' }),
      context: { ...context, preferredLocales: ['nl'] }, display: 'menu',
      sourceBinding: 'sealed-binding', sourceBindingIdentity: 'source-occurrence' });
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      assert.equal(window.document.querySelector('[data-can-menu-dialog-open]')?.textContent, 'Details wijzigen');
      assert.equal(window.document.querySelector('button[type="submit"]')?.textContent, 'Save');
      assert.equal(window.document.querySelector('input[name="form_binding"]')?.getAttribute('value'), 'sealed-binding');
      assert.equal(window.document.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf');
      assert.equal(window.document.querySelectorAll('form').length, 1);
    } finally { await window.happyDOM.close(); }
  });

  it('keeps one authored submit inside the owning canonical form', async () => {
    const child = await primaryActions({ context, children: [button({ context, caption: 'Publish', submit: true })] });
    const html = await form({ ...base, mode: 'create', timeZone: 'UTC', fields: [], submit: 'Submit',
      authoredSubmit: true, cancelHref: '/items', children: [child, '<p>Form body</p>'] });
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      assert.equal(window.document.querySelectorAll('form').length, 1);
      assert.equal(window.document.querySelectorAll('button[type="submit"]').length, 1);
      assert.equal(window.document.querySelector('button[type="submit"]')?.textContent, 'Publish');
      assert.equal(window.document.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf');
      assert.equal(window.document.querySelector('[data-can-form-actions] button')?.textContent, 'Publish');
      assert.equal(window.document.querySelector('[data-can-form-actions] a')?.getAttribute('href'), '/items');
      assert.ok(html.indexOf('<p>Form body') < html.indexOf('data-can-form-actions'));
    } finally { await window.happyDOM.close(); }
    const automatic = await form({ ...base, mode: 'create', timeZone: 'UTC', fields: [], submit: 'Submit' });
    assert.ok(automatic.includes('data-can-standard-submit'));
    assert.ok(!styledComponent(automatic, 'unit-1', 'use-1').includes('data-can-standard-submit data-can-style="'));
    await assert.rejects(form({ ...base, mode: 'create', timeZone: 'UTC', fields: [], submit: 'Submit',
      children: [primaryActions({ context, children: [archive()] })] }), /direct primary submit controls/);
  });

  it('aggregates multiple direct entries once in source order and keeps a nested owner local', async () => {
    const calls: string[] = [];
    const control = async (label: string) => {
      calls.push(label);
      return action({ ...base, idPrefix: `control-${label.toLowerCase()}`, operationId: `op-${label}`, label,
        confirm: `Confirm ${label}`, display: 'menu' });
    };
    const nested = await card({ context, title: 'Nested', children: [
      actionMenu({ context, id: 'nested-menu', children: [control('Nested')] }),
    ] });
    const html = await card({ context, title: 'Owner', children: [
      primaryActions({ context, children: [control('First')] }),
      actionMenu({ context, id: 'first-menu', children: [control('Second')] }),
      primaryActions({ context, children: [''] }),
      '<p>Metadata</p>', nested,
      actionMenu({ context, id: 'denied-menu', children: [''] }),
      primaryActions({ context, children: [control('Third')] }),
      actionMenu({ context, id: 'last-menu', children: [control('Fourth')] }),
    ] });
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      const owner = window.document.querySelector('[data-can-card]')!;
      const menu = owner.querySelector('.can-card-heading [data-can-action-menu]')!;
      assert.deepEqual(Array.from(menu.querySelectorAll('[data-can-menu-dialog-open]'), entry => entry.textContent), ['Second', 'Fourth']);
      assert.equal(menu.querySelector('[popover]')?.id, 'first-menu-popover');
      assert.equal(owner.querySelector('#last-menu-popover'), null);
      const footer = owner.querySelector(':scope > .card-body > .can-card-footer')!;
      assert.equal(footer.querySelectorAll('[data-can-primary-actions]').length, 1);
      assert.deepEqual(Array.from(footer.querySelectorAll('[data-can-menu-dialog-open]'), entry => entry.textContent), ['First', 'Third']);
      assert.equal(owner.querySelectorAll('[data-can-action-menu-trigger]').length, 2);
      assert.equal(owner.querySelectorAll('form').length, 5);
      const ids = Array.from(owner.querySelectorAll('[id]'), node => node.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(calls, ['Nested', 'First', 'Second', 'Third', 'Fourth']);
    } finally { await window.happyDOM.close(); }
  });

  it('keeps standard action descendants outside generated style stamps', async () => {
    const controls = await primaryActions({ context, children: [archive()] });
    const window = new Window();
    try {
      window.document.body.innerHTML = styledComponent(`<section><p>Styled body</p>${controls}</section>`, 'unit-1', 'use-1');
      assert.equal(window.document.querySelector('p')?.getAttribute('data-can-style'), 'unit-1');
      assert.equal(window.document.querySelector('[data-can-primary-actions]')?.hasAttribute('data-can-style'), false);
      assert.equal(window.document.querySelector('button')?.hasAttribute('data-can-style'), false);
      assert.equal(window.document.querySelector('form')?.hasAttribute('data-can-style'), false);
    } finally { await window.happyDOM.close(); }
  });

  it('merges secondary entries within each row while keeping nested detail scopes independent', async () => {
    const rowContext: PresentationContext = { ...context, query: async () => ({
      rows: [{ id: 'one', version: '1', fields: {} }, { id: 'two', version: '1', fields: {} }], columns: [],
    }) };
    const html = await list({ context: rowContext, model: 'Store.Item', renderRow: async row => {
      const menu = (suffix: string) => actionMenu({ context, id: `${row.id}-${suffix}`, children: [
        action({ ...base, idPrefix: `${row.id}-${suffix}-control`, label: `${row.id} ${suffix}`, display: 'menu', confirm: 'Confirm' }),
      ] });
      return [menu('first'), `<p>${row.id} body</p>`,
        card({ context, title: 'Nested details', children: [menu('nested-first'), menu('nested-second')] }),
        menu('second')];
    } });
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      for (const row of window.document.querySelectorAll('.list-row')) {
        const direct = row.querySelectorAll(':scope > .can-row-actions > [data-can-action-menu]');
        assert.equal(direct.length, 1);
        const labels = Array.from(direct[0]!.querySelectorAll('[data-can-menu-dialog-open]'), entry => entry.textContent);
        const id = labels[0]!.split(' ')[0];
        assert.deepEqual(labels, [`${id} first`, `${id} second`]);
        assert.equal(row.querySelectorAll('[data-can-card] [data-can-action-menu]').length, 1);
        assert.deepEqual(Array.from(row.querySelectorAll('[data-can-card] [data-can-menu-dialog-open]'), entry => entry.textContent),
          [`${id} nested-first`, `${id} nested-second`]);
        assert.ok(row.innerHTML.indexOf('<p>') < row.innerHTML.indexOf('class="can-row-actions"'));
        assert.equal(row.querySelectorAll('form').length, 4);
        assert.ok(row.firstElementChild?.classList.contains('can-row-content'));
        assert.ok(row.lastElementChild?.classList.contains('can-row-actions'));
      }
      assert.equal(window.document.querySelectorAll('.list-row').length, 2);
      window.document.body.innerHTML = await list({ context: rowContext, model: 'Store.Item',
        renderRow: row => [card({ context, title: `${row.id} first`, children: ['<p>First body</p>'] }),
          card({ context, title: `${row.id} second`, children: ['<p>Second body</p>'] })] });
      assert.equal(window.document.querySelectorAll('.list-row > [data-can-card]').length, 4);
      assert.equal(window.document.querySelectorAll('.can-row-content').length, 0);
      assert.deepEqual(Array.from(window.document.querySelector('.list-row')!.querySelectorAll(':scope > [data-can-card] h2'), node => node.textContent),
        ['one first', 'one second']);
    } finally { await window.happyDOM.close(); }
  });

  it('places table row actions beside data while retaining authored detail body', async () => {
    const rowContext: PresentationContext = { ...context, query: async () => ({
      rows: [{ id: 'one', fields: { name: 'One' } }], columns: [{ field: 'name', label: 'Name', type: 'text' }],
    }) };
    const html = await table({ context: rowContext, model: 'Store.Item', columns: ['name'], renderRow: async () => [
      actionMenu({ context, id: 'table-first', children: [archive()] }), '<p>Row detail</p>',
      actionMenu({ context, id: 'table-second', children: [action({ ...base, idPrefix: 'table-second-control', label: 'Other' })] }),
    ] });
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      const rows = window.document.querySelectorAll('tbody tr');
      assert.equal(rows.length, 2);
      assert.ok(rows[0]!.textContent.includes('One'));
      assert.equal(rows[0]!.querySelectorAll('[data-can-action-menu]').length, 1);
      assert.equal(rows[0]!.querySelectorAll('form').length, 2);
      assert.equal(rows[1]!.querySelector('td')?.getAttribute('colspan'), '2');
      assert.equal(rows[1]!.textContent, 'Row detail');
    } finally { await window.happyDOM.close(); }
  });

  it('places split selected-row actions in the detail panel without evaluating unselected rows', async () => {
    const calls: string[] = [];
    const rowContext: PresentationContext = { ...context, collectionSelections: new Map([['split-owner', 'two']]),
      query: async () => ({ rows: [{ id: 'one', fields: {} }, { id: 'two', fields: {} }], columns: [] }) };
    const props = { context: rowContext, model: 'Store.Item', display: 'split' as const, occurrence: 'split-owner',
      renderRow: async (row: { id: string }) => {
        calls.push(row.id);
        return [primaryActions({ context, children: [button({ context, caption: 'Continue', target: '/next' })] }),
          '<p>Selected body</p>', card({ context, title: 'Nested card', children: [
            actionMenu({ context, id: 'split-nested', children: [action({ ...base, label: 'Nested' })] }),
          ] }), actionMenu({ context, id: 'split-first', children: [action({ ...base, label: 'First' })] }),
          actionMenu({ context, id: 'split-second', children: [action({ ...base, label: 'Second' })] })];
      } };
    const window = new Window();
    try {
      window.document.body.innerHTML = await list(props);
      assert.deepEqual(calls, ['two']);
      const panel = window.document.querySelector('[data-can-split-panel]')!;
      assert.equal(panel.querySelectorAll(':scope > .can-panel-heading [data-can-action-menu]').length, 1);
      assert.equal(panel.querySelectorAll(':scope > footer [data-can-primary-actions]').length, 1);
      assert.equal(panel.querySelectorAll('[data-can-card] [data-can-action-menu]').length, 1);
      assert.ok(panel.innerHTML.indexOf('class="can-panel-heading"') < panel.innerHTML.indexOf('<p>Selected body'));
      assert.ok(panel.innerHTML.indexOf('<p>Selected body') < panel.innerHTML.indexOf('<footer>'));
      window.document.body.innerHTML = await list({ ...props, context: { ...rowContext, collectionSelections: new Map() } });
      assert.deepEqual(calls, ['two'], 'unselected read does not render any row action suite');
      assert.equal(window.document.querySelectorAll('[data-can-action-menu]').length, 0);
    } finally { await window.happyDOM.close(); }
  });

  it('places explicit modal/drawer slot actions and selected details in shared heading and footer regions', async () => {
    const actions = async (prefix: string) => [
      primaryActions({ context, children: [button({ context, caption: 'Continue', target: '/next' })] }),
      actionMenu({ context, id: `${prefix}-first`, children: [action({ ...base, idPrefix: `${prefix}-first-control`, label: 'First' })] }),
      actionMenu({ context, id: `${prefix}-second`, children: [action({ ...base, idPrefix: `${prefix}-second-control`, label: 'Second' })] }),
    ];
    const detailContext = { ...context, collectionSelections: new Map([['detail-source', 'row']]) };
    const cases = [
      await modal({ context, id: 'owner-modal', caption: 'Modal', content: ['<p>Panel body</p>'], actions: await actions('modal') }),
      await drawer({ context, id: 'owner-drawer', caption: 'Drawer', content: ['<p>Panel body</p>'], actions: await actions('drawer') }),
      await detailsDrawer({ context: detailContext, occurrence: 'detail-source', record: { id: 'row', fields: {} },
        caption: 'Details', renderBody: async () => ['<p>Panel body</p>', ...await actions('details')] }),
    ];
    const window = new Window();
    try {
      for (const html of cases) {
        window.document.body.innerHTML = html;
        assert.equal(window.document.querySelectorAll('.can-panel-heading [data-can-action-menu]').length, 1);
        assert.equal(window.document.querySelectorAll('.can-panel-heading button[type="submit"]').length, 2);
        const footer = window.document.querySelector('.modal-action, footer')!;
        assert.equal(footer.querySelector('[data-can-primary-actions]')?.textContent, 'Continue');
        assert.ok(html.indexOf('class="can-panel-heading"') < html.indexOf('<p>Panel body'));
        assert.ok(html.indexOf('<p>Panel body') < html.indexOf('data-can-primary-actions>'));
      }
    } finally { await window.happyDOM.close(); }
  });

  it('does not turn an annotation into an action owner', async () => {
    const first = await actionMenu({ context, id: 'annotation-first', children: [archive()] });
    const second = await actionMenu({ context, id: 'annotation-second', children: [action({ ...base, label: 'Other' })] });
    const html = await tooltip({ context, caption: 'Annotation', content: [first, second] });
    assert.equal(html.split('data-can-action-menu>').length - 1, 2);
  });

  it('keeps a mixed declaration body local rather than recognizing its first group as the whole body', async () => {
    const primary = await primaryActions({ context, children: [archive()] });
    const secondary = await actionMenu({ context, id: 'composite-menu', children: [
      action({ ...base, idPrefix: 'composite-control', label: 'Other', confirm: 'Confirm', display: 'menu' }),
    ] });
    const composite = renderActionScope([primary, '<p>Declared body</p>', secondary]);
    const html = await card({ context, title: 'Outer owner', children: [composite] });
    assert.ok(!html.includes('<footer'));
    assert.ok(!html.includes('class="can-card-heading"'));
    assert.ok(html.includes(composite));
    const reverse = await card({ context, title: 'Outer owner', children: [secondary + '<p>Body</p>' + primary] });
    assert.ok(!reverse.includes('<footer'));
    assert.ok(!reverse.includes('class="can-card-heading"'));
    // Literal tag-like text in a quoted attribute/comment must not prematurely
    // end a valid root containing nested canonical dialogs and forms.
    const quoted = await primaryActions({ context, children: ['<div title="</div>"><!-- </div> --><button type="button">Local</button></div>'] });
    const grouped = await card({ context, title: 'Valid root', children: [quoted, primary] });
    assert.equal(grouped.split('data-can-primary-actions>').length - 1, 1);
    assert.ok(grouped.includes('<footer'));
  });

  it('cancels a visible primary dialog without submitting and restores its opener', async () => {
    const window = new Window({ url: 'https://can.test/items' });
    window.document.body.innerHTML = await primaryActions({ context, children: [archive()] });
    const opener = window.document.querySelector<HTMLButtonElement>('[data-can-menu-dialog-open]')!;
    const cancel = window.document.querySelector<HTMLButtonElement>('[data-can-menu-dialog-close]')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('dialog')!;
    let submits = 0;
    dialog.querySelector('form')!.addEventListener('submit', () => submits++);
    Object.defineProperty(dialog, 'showModal', { value: () => dialog.setAttribute('open', '') });
    Object.defineProperty(dialog, 'close', { value: () => {
      dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close'));
    } });
    const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    try {
      opener.click();
      assert.equal(dialog.open, true);
      cancel.click();
      assert.equal(dialog.open, false);
      assert.equal(submits, 0);
      assert.equal(window.document.activeElement, opener);
    } finally { client.stop(); await window.happyDOM.close(); }
  });

  it('activates checked local modal and drawer targets, dismisses overflow, and restores close/Escape focus', async () => {
    const window = new Window({ url: 'https://can.test/items' });
    window.document.body.innerHTML =
      await primaryActions({ context, children: [button({ context, caption: 'Open modal', opens: 'local-modal' })] }) +
      await actionMenu({ context, id: 'local-overflow', children: [button({ context, caption: 'Open drawer', opens: 'local-drawer' })] }) +
      await modal({ context, caption: 'Modal', id: 'local-modal', externalTrigger: true, content: ['<p>Modal body</p>'] }) +
      await drawer({ context, caption: 'Drawer', id: 'local-drawer', externalTrigger: true, content: ['<p>Drawer body</p>'] });
    const modalOpen = window.document.querySelector<HTMLElement>('[data-can-panel-open="local-modal"]')!;
    const drawerOpen = window.document.querySelector<HTMLElement>('[data-can-panel-open="local-drawer"]')!;
    const trigger = window.document.querySelector<HTMLElement>('[data-can-action-menu-trigger]')!;
    const popover = window.document.querySelector<HTMLElement>('[popover]')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('dialog#local-modal')!;
    const checkbox = window.document.querySelector<HTMLInputElement>('#local-drawer')!;
    const drawerRoot = checkbox.parentElement!;
    const pane = drawerRoot.querySelector<HTMLElement>('aside')!;
    const events: string[] = [];
    Object.defineProperty(popover, 'hidePopover', { value: () => events.push('hide') });
    Object.defineProperty(dialog, 'showModal', { value: () => { events.push('modal'); dialog.setAttribute('open', ''); dialog.focus(); } });
    Object.defineProperty(dialog, 'close', { value: () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
    const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    try {
      assert.equal(window.document.querySelectorAll('[data-can-panel-open="local-modal"]').length, 1);
      assert.equal(window.document.querySelectorAll('[data-can-panel-open="local-drawer"]').length, 1);
      modalOpen.click();
      assert.equal(dialog.open, true);
      dialog.querySelector<HTMLElement>('[data-can-panel-close]')!.click();
      assert.equal(dialog.open, false);
      assert.equal(window.document.activeElement, modalOpen);
      modalOpen.click(); dialog.close(); // Native modal Escape dispatches this close event.
      assert.equal(window.document.activeElement, modalOpen);
      drawerOpen.click();
      assert.equal(checkbox.checked, true);
      assert.equal(window.document.activeElement, pane);
      assert.deepEqual(events, ['modal', 'modal', 'hide']);
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(checkbox.checked, false);
      assert.equal(window.document.activeElement, trigger);
      drawerOpen.click(); drawerRoot.querySelector<HTMLElement>('[data-can-panel-close]')!.click();
      assert.equal(checkbox.checked, false);
      assert.equal(window.document.activeElement, trigger);
      drawerOpen.click(); checkbox.checked = false; checkbox.dispatchEvent(new window.Event('change'));
      assert.equal(window.document.activeElement, trigger);
      const unbound = window.document.createElement('a');
      unbound.href = '#unrelated'; unbound.setAttribute('data-can-panel-open', 'unrelated');
      window.document.body.append(unbound);
      unbound.click();
      assert.equal(checkbox.checked, false, 'unmatched local target never activates another panel');
      client.stop(); drawerOpen.click();
      assert.equal(checkbox.checked, false, 'disposed binding releases activation');
    } finally { client.stop(); await window.happyDOM.close(); }
  });

  it('hands off selected split state when a retained owner rebinds after a query change', async () => {
    const window = new Window({ url: 'https://can.test/items' });
    window.document.body.innerHTML = '<div data-can-split><input type="checkbox" class="drawer-toggle" checked><dialog data-can-split-panel></dialog></div>';
    const root = window.document.querySelector<HTMLElement>('[data-can-split]')!;
    const oldPane = root.querySelector<HTMLDialogElement>('dialog')!;
    let oldCloses = 0;
    const native = (pane: HTMLDialogElement) => {
      Object.defineProperty(pane, 'show', { value: () => pane.setAttribute('open', '') });
      Object.defineProperty(pane, 'showModal', { value: () => pane.setAttribute('open', '') });
      Object.defineProperty(pane, 'close', { value: () => {
        if (pane === oldPane) oldCloses++;
        pane.removeAttribute('open'); queueMicrotask(() => pane.dispatchEvent(new window.Event('close')));
      } });
    };
    native(oldPane);
    const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    try {
      assert.equal(oldPane.open, true, 'initial selected pane is active before replacement');
      root.innerHTML = '<input type="checkbox" class="drawer-toggle" checked><dialog data-can-split-panel open><footer><button>Edit detail item</button></footer></dialog>';
      const selected = root.querySelector<HTMLInputElement>('input')!;
      const newPane = root.querySelector<HTMLDialogElement>('dialog')!;
      native(newPane);
      Object.defineProperty(selected, 'getClientRects', { value: () => ({ length: 1 }) });
      window.history.replaceState({}, '', '/items?selection=two');
      client.rescan();
      await Promise.resolve();
      assert.equal(oldCloses, 1, 'old native pane released even after child replacement');
      assert.equal(selected.checked, true, 'new request selection survives old binder disposal');
      assert.equal(newPane.open, true);
      assert.equal(newPane.querySelector('footer button')?.textContent, 'Edit detail item');
      window.history.replaceState({}, '', '/items?selection=two&refresh=1');
      client.rescan();
      await Promise.resolve();
      assert.equal(selected.checked, true, 'same retained selected checkbox also survives rebind');
      assert.equal(newPane.open, true);
    } finally { client.stop(); await window.happyDOM.close(); }
  });

  it('does not close selected split nodes transferred to a new owner before obsolete-root cleanup', async () => {
    const window = new Window({ url: 'https://can.test/items?selected=one' });
    window.document.body.innerHTML = '<ul><li><div data-can-split><input class="drawer-toggle" type="checkbox" checked><dialog data-can-split-panel><footer><button>Edit detail item</button></footer></dialog></div></li><li><div></div></li><li>Third row</li></ul>';
    const roots = window.document.querySelectorAll<HTMLElement>('li > div');
    const previous = roots[0]!, current = roots[1]!;
    const selected = previous.querySelector<HTMLInputElement>('input')!;
    const pane = previous.querySelector<HTMLDialogElement>('dialog')!;
    let closes = 0;
    Object.defineProperty(selected, 'getClientRects', { value: () => ({ length: 1 }) });
    Object.defineProperty(pane, 'show', { value: () => pane.setAttribute('open', '') });
    Object.defineProperty(pane, 'showModal', { value: () => pane.setAttribute('open', '') });
    Object.defineProperty(pane, 'close', { value: () => {
      closes++; pane.removeAttribute('open'); queueMicrotask(() => pane.dispatchEvent(new window.Event('close')));
    } });
    const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    try {
      assert.equal(pane.open, true);
      previous.removeAttribute('data-can-split');
      current.setAttribute('data-can-split', '');
      current.append(selected, pane);
      client.rescan(); // Binds current first, then releases the obsolete previous root.
      await Promise.resolve();
      assert.equal(closes, 1, 'only new-owner native promotion closes the prior nonmodal state');
      assert.equal(selected.checked, true);
      assert.equal(pane.open, true);
      assert.equal(pane.closest('[data-can-split]'), current);
      assert.equal(pane.querySelector('footer button')?.textContent, 'Edit detail item');
      client.stop();
      assert.equal(selected.checked, false, 'normal current-owner shutdown still releases selection');
      assert.equal(pane.open, false);
      assert.equal(closes, 2);
    } finally { client.stop(); await window.happyDOM.close(); }
  });

  it('places secondary in the header and primary in the footer after evaluating authored children', async () => {
    const calls: string[] = [];
    const html = await card({ context, title: 'Item', children: [
      Promise.resolve().then(async () => { calls.push('primary'); return primaryActions({ context, children: ['<button type="button">Save</button>'] }); }),
      Promise.resolve().then(() => { calls.push('body'); return '<p>Body</p>'; }),
      Promise.resolve().then(async () => { calls.push('menu'); return actionMenu({ context, id: 'card-menu', children: [archive()] }); }),
    ] });
    assert.deepEqual(calls, ['primary', 'body', 'menu']);
    assert.ok(html.includes('class="can-card-heading"'));
    assert.ok(html.indexOf('data-can-action-menu>') < html.indexOf('<p>Body'));
    assert.ok(html.indexOf('<h2') < html.indexOf('<p>Body'));
    assert.ok(html.indexOf('<p>Body') < html.indexOf('<footer'));
    assert.ok(html.indexOf('<footer') < html.indexOf('data-can-primary-actions>'));
    const bare = await card({ context, children: [
      primaryActions({ context, children: ['<button type="button">Save</button>'] }),
      '<p>Bare body</p>',
      actionMenu({ context, id: 'bare-card-menu', children: [archive()] }),
    ] });
    assert.ok(!bare.includes('<h2 class="card-title">'));
    assert.ok(bare.indexOf('data-can-action-menu>') < bare.indexOf('<p>Bare body'));
    assert.ok(bare.indexOf('<p>Bare body') < bare.indexOf('<footer'));
    assert.ok(bare.includes('data-can-primary-actions>'));
    const empty = await card({ context, title: 'Empty', layout: 'columns', children: [] });
    assert.ok(!empty.includes('<footer'));
    assert.ok(!empty.includes('class="grid'));
  });

  it('native-closes a settled dialog before morphing open and preserves unrelated active dialogs', async () => {
    const window = new Window({ url: 'https://can.test/items' });
    const markup = `<main id="can-main">${await archive()}</main>`;
    window.document.body.innerHTML = markup;
    const main = window.document.querySelector('main')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('dialog')!;
    const target = dialog.querySelector('form')!;
    let closes = 0;
    Object.defineProperty(dialog, 'close', { value: () => {
      assert.equal(dialog.hasAttribute('open'), true, 'native close runs before the attribute diff');
      closes++; dialog.removeAttribute('open');
    } });
    try {
      dialog.setAttribute('open', '');
      const document = window.document as unknown as DocumentLike;
      assert.equal(applyPollResponse(document, main as unknown as ElementLike, markup, 200), true);
      assert.equal(closes, 0);
      assert.equal(dialog.open, true, 'background refresh retains active dialog');
      assert.equal(applyPollResponse(document, main as unknown as ElementLike, markup, 200, target as unknown as ElementLike), true);
      assert.equal(closes, 1);
      assert.equal(dialog.open, false);
      dialog.setAttribute('open', '');
      assert.equal(applyPollResponse(document, main as unknown as ElementLike, '<main id="can-main"></main>', 200), true);
      assert.equal(closes, 2, 'removal releases native modal state before detaching');
    } finally { await window.happyDOM.close(); }
  });

  it('preserves managed owner modals during reads and native-closes them on settlement or removal', async () => {
    const window = new Window({ url: 'https://can.test/items' });
    const markup = `<main id="can-main">${await modal({ context, caption: 'Owner', id: 'read-owner',
      content: [await action({ ...base, label: 'Run' })] })}</main>`;
    window.document.body.innerHTML = markup;
    const main = window.document.querySelector('main')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('dialog')!;
    const target = dialog.querySelector('form')!;
    let closes = 0;
    Object.defineProperty(dialog, 'close', { value: () => {
      assert.equal(dialog.open, true, 'native close runs before removing open');
      closes++; dialog.removeAttribute('open');
    } });
    try {
      const document = window.document as unknown as DocumentLike;
      dialog.setAttribute('open', '');
      assert.equal(applyPollResponse(document, main as unknown as ElementLike, markup, 200), true);
      assert.equal(dialog.open, true, 'background read retains the owner modal');
      assert.equal(closes, 0);
      assert.equal(applyPollResponse(document, main as unknown as ElementLike, markup, 200, target as unknown as ElementLike), true);
      assert.equal(dialog.open, false);
      assert.equal(closes, 1);
      dialog.setAttribute('open', '');
      assert.equal(applyPollResponse(document, main as unknown as ElementLike, '<main id="can-main"></main>', 200), true);
      assert.equal(closes, 2, 'removal releases native modal state');
    } finally { await window.happyDOM.close(); }
  });

  it('dismisses the popover before modal opening, restores visible trigger focus, and releases bindings', async () => {
    const window = new Window({ url: 'https://can.test/items' });
    window.document.body.innerHTML = await actionMenu({ context, id: 'browser-menu', children: [archive()] });
    const trigger = window.document.querySelector<HTMLButtonElement>('[data-can-action-menu-trigger]')!;
    const opener = window.document.querySelector<HTMLButtonElement>('[data-can-menu-dialog-open]')!;
    const cancel = window.document.querySelector<HTMLButtonElement>('[data-can-menu-dialog-close]')!;
    const panel = window.document.querySelector<HTMLElement>('[popover]')!;
    const dialog = window.document.querySelector<HTMLDialogElement>('dialog')!;
    const events: string[] = [];
    Object.defineProperty(window, 'innerWidth', { value: 320 });
    Object.defineProperty(window, 'innerHeight', { value: 200 });
    Object.defineProperty(trigger, 'getBoundingClientRect', { value: () => ({ left: 260, right: 304, top: 140, bottom: 184, width: 44, height: 44 }) });
    Object.defineProperty(panel, 'getBoundingClientRect', { value: () => ({ left: 0, right: 160, top: 0, bottom: 80, width: 160, height: 80 }) });
    Object.defineProperty(panel, 'hidePopover', { value: () => events.push('hide') });
    Object.defineProperty(dialog, 'showModal', { value: () => { events.push('show'); dialog.setAttribute('open', ''); } });
    Object.defineProperty(dialog, 'close', { value: () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } });
    const client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    try {
      panel.dispatchEvent(new window.Event('toggle'));
      assert.equal(panel.style.left, '144px');
      assert.equal(panel.style.top, '60px');
      assert.equal(panel.style.maxHeight, '132px');
      opener.click();
      assert.deepEqual(events, ['hide', 'show']);
      cancel.click();
      assert.equal(dialog.open, false);
      assert.equal(window.document.activeElement, trigger);
      opener.click();
      dialog.close(); // Native Escape follows this same close event.
      assert.equal(window.document.activeElement, trigger);
      client.stop();
      panel.style.left = '1px';
      panel.dispatchEvent(new window.Event('toggle'));
      assert.equal(panel.style.left, '1px');
      opener.click();
      assert.equal(dialog.open, false);
      assert.equal(events.length, 4);
    } finally { client.stop(); await window.happyDOM.close(); }
  });
});
