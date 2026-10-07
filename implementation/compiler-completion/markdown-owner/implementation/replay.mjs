import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from '../../../../node_modules/typescript/lib/typescript.js';
import { Window } from '../../../../node_modules/happy-dom/lib/index.js';
import { marked } from '/Users/vince/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/marked/lib/marked.esm.js';
import { renderReferenceMarkdown as baseline } from '../../../../packages/interfaces/src/docs/reference.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(`${root}/package.json`);
const source = readFileSync(`${root}/packages/interfaces/src/docs/reference.ts`, 'utf8');
// Research candidate only: production source is never written.
const helper = String.raw`function codeSpan(text: string, table = false): string {
  if (text === "" || (table && text.includes("|"))) {
    // Entities prevent authored content from becoming HTML or Markdown.
    const safe = text.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g,
      (char) => "&#" + char.charCodeAt(0) + ";");
    return "<code>" + safe + "</code>";
  }
  const longest = Math.max(0, ...(text.match(/[\x60]+/g) ?? []).map(run => run.length));
  const fence = String.fromCharCode(96).repeat(longest + 1);
  const pad = text.startsWith(String.fromCharCode(96)) || text.endsWith(String.fromCharCode(96)) ||
    (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text));
  return fence + (pad ? " " : "") + text + (pad ? " " : "") + fence;
}
`;
const helperStart = source.includes('/** Escapes a value rendered inside') ? source.indexOf('/** Escapes a value rendered inside') : source.indexOf('function codeSpan(');
assert.ok(helperStart >= 0);
let candidateSource = source.slice(0, helperStart) + helper + source.slice(source.indexOf('/**\n * Readable base slug'));
for (const object of ['field', 'input']) {
  for (const key of ['name', 'type', 'default']) {
    candidateSource = candidateSource.replaceAll(`codeSpan(${object}.${key})`, `codeSpan(${object}.${key}, true)`);
  }
}
let js = ts.transpileModule(candidateSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
for (const name of ['@canlang/contracts', '@canlang/values']) js = js.replaceAll(`"${name}"`, JSON.stringify(pathToFileURL(require.resolve(name)).href));
const { renderReferenceMarkdown: candidate } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const cases = ['plain', 'a`b', '`', '``', '````````', 'a``b`c', ' ', '  ', '', ' a ', '  a  ', ' a', 'a ', 'a  b', 'a|b', '|', '||', String.raw`a\b`, String.raw`\|`, String.raw`\\|`, String.raw`\\\|`, String.raw`a\|b\\|c`, '`|\\`', '<script>&amp;[x](y)*_~!', '[x](y)'];
for (const run of [3, 17, 64]) cases.push('`'.repeat(run) + '|\\x' + '`'.repeat(run - 1));
const example = 'row|\\value\n````````\n<script>&literal';
function model(value) {
  const field = { name: value, type: value, default: value, nullable: false, creationRequired: true, constraints: [], description: { source: "prefix " + value + " suffix", sourceLang: 'en', variants: [], location: { sourceId: 'app.can', start: 0, end: 1 } } };
  return { version: 1, sourceRevision: value, catalogVersion: 'v1', languageVersion: 'can', appDefaultLocale: 'en', owners: [{ name: 'Probe', declarations: [{ owner: 'Probe', name: 'Thing', kind: 'model', fields: [field], examples: [{ label: value, source: example, expected: example }], location: { sourceId: value, start: 0, end: 1 } }], operations: [{ id: 'Probe.run', inputs: [field], result: { type: value, nullable: false }, examples: [], location: { sourceId: value, start: 0, end: 1 } }] }], availability: { status: 'unknown' } };
}
function observe(render, value) {
  const markdown = render(model(value));
  const html = marked.parse(markdown, { gfm: true, breaks: false });
  const window = new Window();
  window.document.body.innerHTML = html;
  const document = window.document;
  const inline = document.querySelector('li code')?.textContent ?? null;
  const tables = [...document.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => ({ text: cell.textContent, code: cell.querySelector('code')?.textContent ?? null })));
  const fences = [...document.querySelectorAll('pre code')].map(node => node.textContent);
  const result = { markdown, html, inline, tables, fences, exact: inline === value && tables.length === 2 && tables.every(row => row.length === 7 && [0, 1, 4].every(index => row[index].code === value)) };
  return result;
}
const results = cases.map(value => ({ value, baseline: observe(baseline, value), candidate: observe(candidate, value) }));
for (const result of results) {
  assert.equal(result.baseline.exact, true, JSON.stringify(result.value));
  assert.equal(result.candidate.exact, true, JSON.stringify(result.value));
  assert.deepEqual(result.candidate.fences, [example + '\n', example + '\n']);
  assert.deepEqual(result.candidate.fences, result.baseline.fences);
  for (const row of result.candidate.tables) assert.equal(row[6].text, "prefix " + result.value + " suffix");
}
const evidence = { ownerSourceSha256: createHash('sha256').update(source).digest('hex'), parser: { name: 'marked', version: '17.0.5', options: { gfm: true, breaks: false }, origin: 'existing desktop bundled dependencies, external qualification oracle; not repository dependency or designated viewer' }, consumer: 'CLI stdout/output-file Markdown; no repository-specified HTML viewer found', negativeControls: [String.raw`\|`, String.raw`\\|`, String.raw`\\\|`].map(value => ({ value, naiveSinglePipeEscapeHTML: marked.parse('| X | Y |\n|---|---|\n| ' + String.fromCharCode(96) + value.replaceAll('|', '\\|') + String.fromCharCode(96) + ' | z |\n', { gfm: true }) })), cases: results, summary: { count: results.length, actualPublicExact: results.filter(row => row.baseline.exact).length, candidateExact: results.filter(row => row.candidate.exact).length } };
writeFileSync(new URL('./raw.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');

console.log(JSON.stringify(evidence.summary));
