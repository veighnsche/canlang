import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderReferenceMarkdown as sourceRender } from '../../../../packages/interfaces/src/docs/reference.ts';
import { renderReferenceMarkdown as distRender } from '../../../../packages/interfaces/dist/src/docs/reference.js';
import { Window } from '../../../../node_modules/happy-dom/lib/index.js';
import { marked } from '/Users/vince/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/marked/lib/marked.esm.js';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sha = path => createHash('sha256').update(readFileSync(root + path)).digest('hex');
const pins = JSON.parse(readFileSync(new URL('../implementation/source-pins.json', import.meta.url)));
for (const [path, expected] of Object.entries(pins.sha256)) assert.equal(sha(path), expected, path);
const values = ['', '     ', ' leading', 'trailing   ', '  both edges    ', '`edge', 'edge```', '``middle```tail`', '`'.repeat(127), 'a' + '`'.repeat(31) + 'b' + '`'.repeat(9), '&lt;&#124;&amp;', '<code>literal</code>', String.raw`path\dir\file`, String.raw`\|end`, String.raw`\\|end`, String.raw`\\\|end`, String.raw`\\\\|end`, String.raw`start|\|\\|end`, '   `<b>&#92;|&amp;`    ', '|<>"\'&;[](){}!*_~#', 'a  b   c', '雪|é\\`'];
const location = { sourceId: 'source\\literal`id', start: 17, end: 93 };
const prose = 'Literal <em>&amp; `ticks` | \\ [link](target)';
const desc = text => ({ source: text, sourceLang: 'en', variants: [{ tag: 'nl', text: 'Nederlands ' + text }], location });
const fixture = 'literal \\|<&amp;>\n' + '`'.repeat(19) + '\nend';
function model(value) {
  const field = { name: value, type: value, default: value, nullable: false, creationRequired: true, constraints: [{ kind: 'minimum', detail: prose }], description: desc(prose) };
  return { version: 1, sourceRevision: value, catalogVersion: value, languageVersion: value, appDefaultLocale: 'en', owners: [{ name: value, declarations: [{ owner: value, name: value, kind: 'model', description: desc(prose), fields: [field, { ...field, name: 'absent', default: undefined }, { ...field, name: 'literal', default: '"literal\\\\|&amp;`"' }], examples: [{ label: value, source: fixture, expected: fixture }], location }], operations: [{ id: value, inputs: [field], result: { type: value, nullable: false, description: desc(prose) }, examples: [{ label: value, source: fixture, expected: fixture }], location }] }], availability: { status: 'known', owner: value, catalog: value } };
}
const observations = [];
for (const value of values) {
  const markdown = sourceRender(model(value));
  assert.equal(distRender(model(value)), markdown, 'built and source public output differ');
  const html = marked.parse(markdown, { gfm: true, breaks: false });
  const window = new Window(); window.document.body.innerHTML = html;
  const doc = window.document;
  const rows = [...doc.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(td => ({ text: td.textContent, code: td.querySelector('code')?.textContent ?? null })));
  assert.equal(doc.querySelectorAll('table').length, 2);
  assert.deepEqual(rows.map(row => row.length), [7, 7, 7, 7]);
  for (const row of [rows[0], rows[3]]) {
    for (const index of [0, 1, 4]) assert.equal(row[index].code, value, JSON.stringify(value));
    assert.equal(row[5].text, 'minimum: ' + prose);
    assert.equal(row[6].text, prose);
  }
  assert.equal(rows[1][4].text, '—'); assert.equal(rows[1][4].code, null);
  assert.equal(rows[2][4].code, '"literal\\\\|&amp;`"');
  const metadata = [...doc.querySelectorAll('body > ul:first-of-type > li code')].map(node => node.textContent);
  assert.deepEqual(metadata, [value, value, value, 'en', 'en']);
  assert.deepEqual([...doc.querySelectorAll('h3 code, h5 code')].map(node => node.textContent), [value, value + '.' + value, value]);
  const listCodes = [...doc.querySelectorAll('li code')].map(node => node.textContent);
  assert.deepEqual(listCodes, [value, value, value, 'en', 'en', value, value + '.' + value, value, location.sourceId, value, location.sourceId, value, value, value]);
  const inline = [...doc.querySelectorAll('p code')].filter(node => !node.closest('pre')).map(node => node.textContent);
  assert.ok(inline.includes(value));
  assert.deepEqual([...doc.querySelectorAll('pre code')].map(node => node.textContent), Array(4).fill(fixture + '\n'));
  const ids = [...doc.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const a of doc.querySelectorAll('a[href^="#"]')) assert.ok(ids.includes(a.getAttribute('href').slice(1)));
  const nl = sourceRender(model(value), { locale: 'nl' });
  assert.ok(nl.includes('Nederlands'));
  observations.push({ value, markdown, html, rows, metadata, ids });
  window.happyDOM.cancelAsync();
}
const evidence = { reviewer: 'Sol 6.1 medium independent review', parser: { name: 'marked', version: '17.0.5', options: { gfm: true, breaks: false } }, scope: 'bounded single-line DOM text and GFM table structure; no designated viewer, universal consumer, pixel or raw multiline guarantee', count: values.length, passed: observations.length, observations };
writeFileSync(new URL('./raw.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(new URL('./pins.json', import.meta.url), JSON.stringify({ inheritedHead: pins.head, sha256: Object.fromEntries([...Object.keys(pins.sha256), 'packages/interfaces/dist/src/docs/reference.js', 'packages/interfaces/dist/test/docs-reference.test.js', 'implementation/compiler-completion/markdown-owner/implementation/test.log', 'implementation/compiler-completion/markdown-owner/implementation/typecheck.log', 'implementation/compiler-completion/markdown-owner/implementation/build.log', 'implementation/compiler-completion/markdown-owner/independent-review/reproduce.mjs'].map(path => [path, sha(path)])) }, null, 2) + '\n');
console.log(JSON.stringify({ count: values.length, passed: observations.length, sourceMatchesBuilt: true, productionPinsMatch: true }));
