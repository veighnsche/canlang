/**
 * D05a reference-renderer tests: fixture-driven coverage of the localized
 * Markdown slice ONLY (frozen reference model v1 in, Markdown out). These
 * fixtures do not prove source-to-command completion; the Rust extractor
 * (D04b) and CLI wiring (D05b) are separate slices.
 *
 * Fallback matrix (every case through `resolveVariant`, no second engine):
 * English/Dutch direct, canonical-alias/case, regional, app-default,
 * source-owner, null-variant omission and empty-vs-absent distinction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ReferenceDeclaration,
  ReferenceDescriptionValue,
  ReferenceModel,
  ReferenceOperation,
  ReferenceOwner,
} from '@canlang/contracts';
import { REFERENCE_MODEL_VERSION } from '@canlang/contracts';
import {
  renderReferenceMarkdown,
  resolveReferenceDescription,
} from '../src/docs/reference.js';

function description(
  source: string,
  variants: ReadonlyArray<{ tag: string; text: string | null }> = [],
  sourceLang = 'en',
): ReferenceDescriptionValue {
  return {
    source,
    sourceLang,
    variants,
    location: { sourceId: 'app/todo.can', start: 10, end: 42 },
  };
}

function modelWithDescription(
  item: ReferenceDescriptionValue | undefined,
  appDefaultLocale = 'en',
  fieldItem: ReferenceDescriptionValue | undefined = undefined,
): ReferenceModel {
  return {
    version: REFERENCE_MODEL_VERSION,
    sourceRevision: 'rev-001',
    catalogVersion: 'catalog-7',
    languageVersion: 'can-0.1.0',
    appDefaultLocale,
    owners: [
      {
        name: 'TeamTasks',
        declarations: [
          {
            owner: 'TeamTasks',
            name: 'Todo',
            kind: 'model',
            ...(item === undefined ? {} : { description: item }),
            fields: [
              {
                name: 'name',
                type: 'text',
                nullable: false,
                creationRequired: true,
                constraints: [],
                ...(fieldItem === undefined ? {} : { description: fieldItem }),
              },
            ],
            examples: [],
            location: { sourceId: 'app/todo.can', start: 0, end: 120 },
          },
        ],
        operations: [],
      },
    ],
    availability: { status: 'unknown' },
  };
}

const NL = 'De naam die klanten zien.';

// --- resolveReferenceDescription: fallback matrix ---------------------------

test('resolves the requested English source text', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    'en',
    'en',
  );
  assert.equal(resolved.tag, 'en');
  assert.equal(resolved.text, 'The name shown to customers.');
});

test('resolves the requested Dutch variant', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    'nl',
    'en',
  );
  assert.equal(resolved.tag, 'nl');
  assert.equal(resolved.text, NL);
});

test('treats canonical aliases and casing as the same tag', () => {
  const item = description('Color', [{ tag: 'EN-us', text: 'Color (US)' }]);
  const resolved = resolveReferenceDescription(item, 'en-US', 'en');
  assert.equal(resolved.tag, 'en-US');
  assert.equal(resolved.text, 'Color (US)');
});

test('falls back from a regional tag to its language prefix', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    'nl-BE',
    'en',
  );
  assert.equal(resolved.tag, 'nl');
  assert.equal(resolved.text, NL);
});

test('falls back to the app default when the request is untranslated', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    'fr',
    'nl',
  );
  assert.equal(resolved.tag, 'nl');
  assert.equal(resolved.text, NL);
});

test('falls back to the owning source language when nothing else matches', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    'fr',
    'fr',
  );
  assert.equal(resolved.tag, 'en');
  assert.equal(resolved.text, 'The name shown to customers.');
});

test('skips null variants (absent translation, not empty text)', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: null }]),
    'nl',
    'en',
  );
  assert.equal(resolved.tag, 'en');
  assert.equal(resolved.text, 'The name shown to customers.');
});

test('selects an authored empty variant instead of falling back', () => {
  const resolved = resolveReferenceDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: '' }]),
    'nl',
    'en',
  );
  assert.equal(resolved.tag, 'nl');
  assert.equal(resolved.text, '');
});

test('passes literal braces through without ICU interpretation', () => {
  const prose = 'Use {name} and {n,number} literally.';
  const resolved = resolveReferenceDescription(description(prose), 'en', 'en');
  assert.equal(resolved.text, prose);
});

// --- renderReferenceMarkdown ------------------------------------------------

test('renders Dutch prose and headings for locale nl', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    ),
    { locale: 'nl' },
  );
  assert.match(out, /Interne declaratie-referentie/);
  assert.match(out, /De naam die klanten zien\./);
  assert.match(out, /Velden/);
  assert.doesNotMatch(out, /The name shown to customers\./);
});

test('renders English prose and headings for locale en', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    ),
    { locale: 'en' },
  );
  assert.match(out, /Internal declaration reference/);
  assert.match(out, /The name shown to customers\./);
});

test('null locale selects the app default, never an ambient locale', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
      'nl',
    ),
    { locale: null },
  );
  assert.match(out, /De naam die klanten zien\./);
  assert.match(out, /App default locale: `nl`/);
});

test('omitted locale selects the app default', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
      'nl',
    ),
  );
  assert.match(out, /De naam die klanten zien\./);
});

test('regional requested locale renders with stable version identity', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    ),
    { locale: 'nl-BE' },
  );
  assert.match(out, /De naam die klanten zien\./);
  assert.match(out, /Source revision: `rev-001`/);
  assert.match(out, /Catalog version: `catalog-7`/);
  assert.match(out, /Language version: `can-0\.1\.0`/);
  assert.match(out, /Requested locale: `nl-BE`/);
});

test('emits stable anchors and table-of-contents links', () => {
  const out = renderReferenceMarkdown(modelWithDescription(description('Doc.')));
  assert.match(out, /<a id="owner-teamtasks"><\/a>/);
  assert.match(out, /<a id="decl-teamtasks-todo"><\/a>/);
  assert.match(out, /\[`TeamTasks`\]\(#owner-teamtasks\)/);
  assert.match(out, /\[`TeamTasks\.Todo`\]\(#decl-teamtasks-todo\)/);
});

test('renders operation anchors, inputs and results', () => {
  const base = modelWithDescription(description('Doc.'));
  const owner = base.owners[0];
  assert.ok(owner !== undefined);
  const model: ReferenceModel = {
    ...base,
    owners: [
      {
        ...owner,
        operations: [
          {
            id: 'TeamTasks.Todo.read',
            description: description('Read one todo.'),
            inputs: [
              {
                name: 'record',
                type: 'ref(TeamTasks.Todo)',
                nullable: false,
                creationRequired: true,
                constraints: [],
              },
            ],
            result: { type: 'TeamTasks.Todo', nullable: true },
            location: { sourceId: 'app/todo.can', start: 200, end: 260 },
          },
        ],
      },
    ],
  };
  const out = renderReferenceMarkdown(model, { locale: 'en' });
  assert.match(out, /<a id="op-teamtasks-todo-read"><\/a>/);
  assert.match(out, /Read one todo\./);
  assert.match(out, /`record` \| `ref\(TeamTasks\.Todo\)`/);
  assert.match(out, /\*\*Result\*\*: `TeamTasks\.Todo` \(Nullable: yes\)/);
});

test('labels authored examples and renders source plus expected result', () => {
  const base = modelWithDescription(description('Doc.'));
  const owner = base.owners[0];
  assert.ok(owner !== undefined);
  const declaration = owner.declarations[0];
  assert.ok(declaration !== undefined);
  const model: ReferenceModel = {
    ...base,
    owners: [
      {
        ...owner,
        declarations: [
          {
            ...declaration,
            examples: [
              { label: 'rename', source: 'todo.rename("New")', expected: 'ok' },
            ],
          },
        ],
      },
    ],
  };
  const out = renderReferenceMarkdown(model, { locale: 'en' });
  assert.match(out, /\*\*authored example\*\* `rename`/);
  assert.match(out, /todo\.rename\("New"\)/);
  assert.match(out, /\nok\n/);
  assert.doesNotMatch(out, /passed|failed/i);
});

test('reports unknown implementation status without inventing availability', () => {
  const out = renderReferenceMarkdown(modelWithDescription(description('Doc.')));
  assert.match(out, /\*\*implementation status unknown\*\*/);
});

test('renders verified availability with owner and catalog', () => {
  const base = modelWithDescription(description('Doc.'));
  const out = renderReferenceMarkdown(
    { ...base, availability: { status: 'available', owner: 'TeamTasks', catalog: 'catalog-7' } },
    { locale: 'en' },
  );
  assert.match(out, /- Owner: `TeamTasks`/);
  assert.match(out, /- Catalog: `catalog-7`/);
  assert.doesNotMatch(out, /implementation status unknown/);
});

test('escapes authored prose so it cannot inject Markdown or HTML', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('<script>alert(1)</script> **bold** [link](x) `code` {brace}'),
    ),
    { locale: 'en' },
  );
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /\\\*\\\*bold\\\*\\\*/);
  assert.match(out, /\\\[link\\\]\\\(x\\\)/);
  assert.match(out, /\\`code\\`/);
  assert.match(out, /\\\{brace\\\}/);
});

test('neutralizes a line-leading ordered-list marker in prose', () => {
  const out = renderReferenceMarkdown(modelWithDescription(description('1. not a list')), {
    locale: 'en',
  });
  assert.match(out, /1\\\. not a list/);
});

test('keeps names, types and ids unlocalized', () => {
  const out = renderReferenceMarkdown(
    modelWithDescription(
      description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
    ),
    { locale: 'nl' },
  );
  assert.match(out, /`TeamTasks\.Todo`/);
  assert.match(out, /`name` \| `text`/);
});

test('distinguishes absent descriptions from empty source text', () => {
  const absent = renderReferenceMarkdown(modelWithDescription(undefined), { locale: 'en' });
  assert.match(absent, /No description\./);
  const empty = renderReferenceMarkdown(
    modelWithDescription(description(''), 'en', description('Customer-facing name.')),
    { locale: 'en' },
  );
  assert.doesNotMatch(empty, /No description\./);
});

test('keeps source links project-relative with offsets', () => {
  const out = renderReferenceMarkdown(modelWithDescription(description('Doc.')));
  assert.match(out, /- Source: `app\/todo\.can` \(0–120\)/);
  assert.doesNotMatch(out, /\/Users\//);
});

test('renders field facts: requiredness, defaults and constraints', () => {
  const base = modelWithDescription(description('Doc.'));
  const owner = base.owners[0];
  assert.ok(owner !== undefined);
  const declaration = owner.declarations[0];
  assert.ok(declaration !== undefined);
  const model: ReferenceModel = {
    ...base,
    owners: [
      {
        ...owner,
        declarations: [
          {
            ...declaration,
            fields: [
              {
                name: 'amount',
                type: 'int',
                nullable: true,
                creationRequired: false,
                default: '0',
                constraints: [{ kind: 'min', detail: '>= 0' }],
              },
            ],
          },
        ],
      },
    ],
  };
  const out = renderReferenceMarkdown(model, { locale: 'en' });
  assert.match(out, /`amount` \| `int` \| yes \| no \| `0` \| min: &gt;= 0 \|/);
});

test('rendering is deterministic for the same model and locale', () => {
  const model = modelWithDescription(
    description('The name shown to customers.', [{ tag: 'nl', text: NL }]),
  );
  const first = renderReferenceMarkdown(model, { locale: 'nl' });
  const second = renderReferenceMarkdown(model, { locale: 'nl' });
  assert.equal(first, second);
});

test('emits no wall-clock timestamps', () => {
  const out = renderReferenceMarkdown(modelWithDescription(description('Doc.')));
  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.doesNotMatch(out, /generated at|rendered at/i);
});

test('rejects a malformed model with a truthful error', () => {
  assert.throws(
    () => renderReferenceMarkdown({ version: 99 } as unknown as ReferenceModel),
    /invalid reference model/,
  );
});

test('rejects an invalid requested locale with a truthful error', () => {
  assert.throws(
    () =>
      renderReferenceMarkdown(modelWithDescription(description('Doc.')), {
        locale: 'not a locale!!!',
      }),
    /BCP 47|locale/i,
  );
});

// --- collision-free anchors (R-D07-02) ---------------------------------------

function bareDeclaration(owner: string, name: string): ReferenceDeclaration {
  return {
    owner,
    name,
    kind: 'model',
    fields: [],
    examples: [],
    location: { sourceId: 'app/todo.can', start: 0, end: 10 },
  };
}

function bareOperation(id: string): ReferenceOperation {
  return {
    id,
    inputs: [],
    result: { type: 'text', nullable: false },
    location: { sourceId: 'app/todo.can', start: 0, end: 10 },
  };
}

function modelWithOwners(owners: readonly ReferenceOwner[]): ReferenceModel {
  return {
    version: REFERENCE_MODEL_VERSION,
    sourceRevision: 'rev-001',
    catalogVersion: 'catalog-7',
    languageVersion: 'can-0.1.0',
    appDefaultLocale: 'en',
    owners,
    availability: { status: 'unknown' },
  };
}

/** Every `<a id="..."></a>` anchor defined in the output, in render order. */
function anchorIds(out: string): string[] {
  return [...out.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1] as string);
}

/** Every `](#...)` link target in the output, in render order. */
function linkTargets(out: string): string[] {
  return [...out.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string);
}

/** TOC link target for one code-span label (labels used here need no escaping). */
function tocTarget(out: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return out.match(new RegExp(`\\[\`${escaped}\`\\]\\(#([^)]+)\\)`))?.[1];
}

/** Every TOC (label, target) pair, sorted by label then target. */
function tocTargetPairs(out: string): Array<[string, string]> {
  return [...out.matchAll(/\[(`[^`]*`)\]\(#([^)]+)\)/g)]
    .map((m) => [m[1] as string, m[2] as string] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
}

function assertDefinedOnce(out: string, target: string): void {
  assert.equal(out.split(`<a id="${target}"></a>`).length - 1, 1, `anchor defined once: ${target}`);
}

test('disambiguates a_b from a__b under one owner', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      {
        name: 'Acme',
        declarations: [bareDeclaration('Acme', 'a_b'), bareDeclaration('Acme', 'a__b')],
        operations: [],
      },
    ]),
    { locale: 'en' },
  );
  const single = tocTarget(out, 'Acme.a_b');
  const double = tocTarget(out, 'Acme.a__b');
  assert.ok(single !== undefined && double !== undefined);
  assert.notEqual(single, double);
  // Readable base kept; minimal content-derived hex suffix appended.
  assert.match(single, /^decl-acme-a-b-[0-9a-f]{8,}$/);
  assert.match(double, /^decl-acme-a-b-[0-9a-f]{8,}$/);
  assertDefinedOnce(out, single);
  assertDefinedOnce(out, double);
});

test('disambiguates a case pair under one owner', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      {
        name: 'Acme',
        declarations: [bareDeclaration('Acme', 'Widget'), bareDeclaration('Acme', 'widget')],
        operations: [],
      },
    ]),
    { locale: 'en' },
  );
  const upper = tocTarget(out, 'Acme.Widget');
  const lower = tocTarget(out, 'Acme.widget');
  assert.ok(upper !== undefined && lower !== undefined);
  assert.notEqual(upper, lower);
  assert.match(upper, /^decl-acme-widget-[0-9a-f]{8,}$/);
  assert.match(lower, /^decl-acme-widget-[0-9a-f]{8,}$/);
  assertDefinedOnce(out, upper);
  assertDefinedOnce(out, lower);
});

test('disambiguates a Unicode pair sharing one readable base', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      {
        name: 'Acme',
        declarations: [bareDeclaration('Acme', 'café'), bareDeclaration('Acme', 'cafè')],
        operations: [],
      },
    ]),
    { locale: 'en' },
  );
  const acute = tocTarget(out, 'Acme.café');
  const grave = tocTarget(out, 'Acme.cafè');
  assert.ok(acute !== undefined && grave !== undefined);
  assert.notEqual(acute, grave);
  assert.match(acute, /^decl-acme-caf-[0-9a-f]{8,}$/);
  assert.match(grave, /^decl-acme-caf-[0-9a-f]{8,}$/);
  assertDefinedOnce(out, acute);
  assertDefinedOnce(out, grave);
});

test('keeps the bare readable slug when no collision exists', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      { name: 'Acme', declarations: [bareDeclaration('Acme', 'a_b')], operations: [] },
    ]),
  );
  assert.match(out, /<a id="decl-acme-a-b"><\/a>/);
  assert.equal(tocTarget(out, 'Acme.a_b'), 'decl-acme-a-b');
  const owners = renderReferenceMarkdown(
    modelWithOwners([{ name: 'a_b', declarations: [], operations: [] }]),
  );
  assert.match(owners, /<a id="owner-a-b"><\/a>/);
  assert.equal(tocTarget(owners, 'a_b'), 'owner-a-b');
});

test('disambiguates colliding owner anchors', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      { name: 'a_b', declarations: [], operations: [] },
      { name: 'a__b', declarations: [], operations: [] },
    ]),
    { locale: 'en' },
  );
  const single = tocTarget(out, 'a_b');
  const double = tocTarget(out, 'a__b');
  assert.ok(single !== undefined && double !== undefined);
  assert.notEqual(single, double);
  assert.match(single, /^owner-a-b-[0-9a-f]{8,}$/);
  assert.match(double, /^owner-a-b-[0-9a-f]{8,}$/);
  assertDefinedOnce(out, single);
  assertDefinedOnce(out, double);
});

test('disambiguates colliding operation anchors', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      {
        name: 'Acme',
        declarations: [],
        operations: [bareOperation('Acme.a_b'), bareOperation('Acme.a__b')],
      },
    ]),
    { locale: 'en' },
  );
  const single = tocTarget(out, 'Acme.a_b');
  const double = tocTarget(out, 'Acme.a__b');
  assert.ok(single !== undefined && double !== undefined);
  assert.notEqual(single, double);
  assert.match(single, /^op-acme-a-b-[0-9a-f]{8,}$/);
  assert.match(double, /^op-acme-a-b-[0-9a-f]{8,}$/);
  assertDefinedOnce(out, single);
  assertDefinedOnce(out, double);
});

test('keeps same-name declarations distinct across owners without suffixes', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      { name: 'Alpha', declarations: [bareDeclaration('Alpha', 'Widget')], operations: [] },
      { name: 'Beta', declarations: [bareDeclaration('Beta', 'Widget')], operations: [] },
    ]),
    { locale: 'en' },
  );
  assert.match(out, /<a id="decl-alpha-widget"><\/a>/);
  assert.match(out, /<a id="decl-beta-widget"><\/a>/);
  assert.equal(tocTarget(out, 'Alpha.Widget'), 'decl-alpha-widget');
  assert.equal(tocTarget(out, 'Beta.Widget'), 'decl-beta-widget');
});

test('anchor mapping is stable across source-order permutations', () => {
  const first = modelWithOwners([
    {
      name: 'Acme',
      declarations: [
        bareDeclaration('Acme', 'a_b'),
        bareDeclaration('Acme', 'a__b'),
        bareDeclaration('Acme', 'Widget'),
      ],
      operations: [bareOperation('Acme.a_b'), bareOperation('Acme.a__b')],
    },
    { name: 'Beta', declarations: [bareDeclaration('Beta', 'Widget')], operations: [] },
  ]);
  const second = modelWithOwners([
    { name: 'Beta', declarations: [bareDeclaration('Beta', 'Widget')], operations: [] },
    {
      name: 'Acme',
      declarations: [
        bareDeclaration('Acme', 'a__b'),
        bareDeclaration('Acme', 'Widget'),
        bareDeclaration('Acme', 'a_b'),
      ],
      operations: [bareOperation('Acme.a__b'), bareOperation('Acme.a_b')],
    },
  ]);
  const outFirst = renderReferenceMarkdown(first, { locale: 'en' });
  const outSecond = renderReferenceMarkdown(second, { locale: 'en' });
  assert.deepEqual([...anchorIds(outFirst)].sort(), [...anchorIds(outSecond)].sort());
  assert.deepEqual(tocTargetPairs(outFirst), tocTargetPairs(outSecond));
});

test('every link resolves to a unique defined anchor under collisions', () => {
  const out = renderReferenceMarkdown(
    modelWithOwners([
      {
        name: 'a_b',
        declarations: [bareDeclaration('a_b', 'Widget'), bareDeclaration('a_b', 'widget')],
        operations: [bareOperation('a_b.Widget.read'), bareOperation('a_b.widget.read')],
      },
      {
        name: 'a__b',
        declarations: [bareDeclaration('a__b', 'café'), bareDeclaration('a__b', 'cafè')],
        operations: [],
      },
    ]),
    { locale: 'en' },
  );
  const ids = anchorIds(out);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, 'anchors are unique');
  const defined = new Set(ids);
  const targets = linkTargets(out);
  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.ok(defined.has(target), `dangling link target: ${target}`);
  }
});
