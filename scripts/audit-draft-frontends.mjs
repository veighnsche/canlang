#!/usr/bin/env node
// Read-only source inventory and one corpus analysis; writes only requested reports.
import { readFile, readdir, mkdir, writeFile, realpath, rename } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const HELP = `Usage: node scripts/audit-draft-frontends.mjs --out DIRECTORY [options]

  --root DIRECTORY      Checkout root (default: script's parent checkout)
  --compiler FILE       Compiler binary (default: compiler/target/debug/can)
  --catalog FILE        Catalog (default: packages/values/dist/catalog.json)
  --timeout-ms NUMBER   Compiler deadline, 1..60000 (default: 30000)
  --inventory-only      Skip compiler; output remains unqualified
  --help                Show this help

Discovers draft/apps/*/*.can and draft/shared/*.can; invokes one can check
with every discovered source operand. This is corpus analysis, not selected-app
compilation, dev-server execution, screenshot capture or generation acceptance.
Writes audit.json and index.html; never edits source or generated witnesses.
Exit: 0 explicit inventory only, 1 failed/incomplete/blocked audit, 2 tool failure.
Reruns atomically replace this command's audit.json and index.html reports.
`;
process.on('uncaughtException', error => { process.stderr.write(error.message + '\n'); process.exit(2); });
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write(HELP); process.exit(0); }
const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), timeout: 30000, inventoryOnly: false };
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--inventory-only') { options.inventoryOnly = true; continue; }
  const key = ({ '--out': 'out', '--root': 'root', '--compiler': 'compiler', '--catalog': 'catalog', '--timeout-ms': 'timeout' })[flag];
  if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${flag}. Use --help.`);
  options[key] = args[++i];
}
if (!options.out) throw new Error('--out DIRECTORY is required.');
options.timeout = Number(options.timeout);
if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 60000) throw new Error('--timeout-ms must be 1..60000.');
const root = await realpath(resolve(options.root));
const out = resolve(options.out);
const compilerPath = resolve(root, options.compiler ?? 'compiler/target/debug/can');
const catalogPath = resolve(root, options.catalog ?? 'packages/values/dist/catalog.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rel = path => relative(root, path).split('\\').join('/');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function identity(path) {
  try { const canonicalPath = await realpath(path); const bytes = await readFile(canonicalPath); return { path: rel(path), canonicalPath, sha256: hash(bytes), bytes: bytes.length }; }
  catch (error) { return { path: rel(path), unavailable: error.code ?? error.message }; }
}
async function files(directory, recursive = false) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isFile()) result.push(path);
    else if (recursive && entry.isDirectory()) result.push(...await files(path, true));
  }
  return result;
}
const paths = [];
for (const group of (await readdir(join(root, 'draft/apps'), { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  paths.push(...(await files(join(root, 'draft/apps', group.name))).filter(p => p.endsWith('.can')));
}
const sharedPaths = (await files(join(root, 'draft/shared'))).filter(p => p.endsWith('.can'));
const allPaths = [...paths, ...sharedPaths];
const snapshots = new Map();
for (const path of allPaths) snapshots.set(path, await readFile(path));
const admissionPath = join(root, 'packages/cloudflare/dist/dev/compiler-check.js');
const admissionIdentity = await identity(admissionPath);
let admit, admissionError;
try { ({ admitSingleAppProfile: admit } = await import(pathToFileURL(admissionPath).href)); if (typeof admit !== 'function') throw new Error('admission export unavailable'); }
catch (error) { admissionError = error.message; }
function inventory(path) {
  const bytes = snapshots.get(path), source = bytes.toString('utf8'), lines = source.split(/\r?\n/);
  const apps = [], pages = [], prompts = [], examples = [], packages = [], imports = [];
  const declarations = { scenarios: [], queries: [], handlers: [], crud: [] };
  lines.forEach((line, index) => {
    const text = line.trimStart(), location = { line: index + 1 };
    if (!text || text.startsWith('#')) return;
    let match;
    if ((match = /^app\s+(\w+)\b(.*)/.exec(text))) apps.push({ name: match[1], ...location, composition: /\buses\s*=\s*\[([^\]]*)\]/.exec(match[2])?.[1].split(',').map(s => s.trim()).filter(Boolean) ?? [] });
    if ((match = /^package\s+(\w+)/.exec(text))) packages.push({ name: match[1], ...location });
    if (/^(?:export\s+)?use\b/.test(text)) imports.push({ text, ...location });
    if ((match = /^(?:export\s+)?(scenario|query|handler|crud)\s+([^\s(]+)/.exec(text))) {
      const kind = match[1] === 'crud' ? 'crud' : match[1] === 'query' ? 'queries' : match[1] === 'handler' || /\bon\s*=/.test(text) ? 'handlers' : 'scenarios';
      declarations[kind].push({ name: match[2], ...location, declarationKind: match[1], text });
    }
    if ((match = /^page\s+(\S+)/.exec(text))) pages.push({ route: match[1], ...location, title: /\btitle\s*=\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1] ?? null, promptAttachment: /\$(?:"|[A-Za-z_])/.test(text) });
    if ((match = /^style\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text))) prompts.push({ kind: 'named-use', literal: false, value: match[1], carrier: 'view-root-style', ...location, column: line.length - text.length + 1 });
    if (/^examples\b/.test(text)) {
      const indent = line.length - text.length;
      let rows = 0, header = false;
      for (let j = index + 1; j < lines.length; j++) {
        const child = lines[j].trimStart();
        if (!child || child.startsWith('#')) continue;
        if (lines[j].length - child.length <= indent) break;
        if (!header) { header = true; continue; }
        rows++;
      }
      examples.push({ ...location, authoredRows: rows });
    }
    // Inventory only: a quoted-string scan avoids counting dollar signs inside prose.
    for (let offset = 0; offset < text.length;) {
      if (text[offset] === '"') { offset++; while (offset < text.length) { if (text[offset] === '\\') offset += 2; else if (text[offset++] === '"') break; } continue; }
      if (text[offset] !== '$') { offset++; continue; }
      const tail = text.slice(offset);
      const token = /^\$("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)/.exec(tail);
      if (!token) { offset++; continue; }
      const literal = token[1].startsWith('"');
      const declaration = /^(?:export\s+)?(trait|keyword|view|style)\b/.exec(text)?.[1];
      const kind = literal ? declaration ?? (/\btrait\s+\$/.test(text.slice(0, offset + 2)) ? 'trait' : 'component-style') : 'named-use';
      let value = token[1];
      if (literal) { try { value = JSON.parse(value); } catch {} }
      prompts.push({ kind, literal, value, ...location, column: line.length - text.length + offset + 1 });
      offset += token[0].length;
    }
  });
  const previewAdmission = admit ? admit(source) : { ok: false, unavailable: admissionError };
  return { path: rel(path), requirementCompanion: rel(path.replace(/\.can$/, '.md')), sha256: hash(bytes), bytes: bytes.length, inventoryMethod: 'lexical inventory; not compiler qualification', apps, packages, imports, declarations, pages, prompts, examples, previewAdmission, diagnostics: [], status: 'not-analyzed', qualification: { generation: 'not-executed', compile: 'not-run', preview: previewAdmission.ok ? 'admitted; not-started' : 'profile-unsupported', examples: 'not-run', browser: 'not-run', visual: 'not-inspected', functionality: 'not-qualified' } };
}
const sources = allPaths.map(inventory);
const witnessPaths = (await files(join(root, 'draft/apps'), true)).filter(p => p.includes('/can.generated/') || p.endsWith('.mjs'));
const witnesses = { legacyJavascript: witnessPaths.filter(p => p.endsWith('.mjs')).map(rel), units: [] };
for (const path of witnessPaths.filter(p => p.endsWith('/unit.json'))) {
  try { const unit = JSON.parse(await readFile(path, 'utf8')); witnesses.units.push({ path: rel(path), association: unit, status: 'saved draft witness; not an executed generation receipt' }); }
  catch (error) { witnesses.units.push({ path: rel(path), status: 'invalid association JSON', error: error.message }); }
}
function checkOnce() {
  return new Promise(resolveResult => {
    const argv = ['check', '--format=json', '--catalog', catalogPath, ...allPaths.map(rel)];
    const child = spawn(compilerPath, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reason, bytes = 0, terminationTimer;
    const stop = why => { if (reason) return; reason = why; child.kill('SIGTERM'); terminationTimer = setTimeout(() => child.kill('SIGKILL'), 250); };
    const timer = setTimeout(() => stop('timeout'), options.timeout);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 32 * 1024 * 1024) stop('output-limit'); else stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 8192) stderr = (stderr + data).slice(0, 8192); });
    child.on('error', error => { reason = error.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(terminationTimer);
      let envelope, parseError;
      if (!reason) { try { envelope = JSON.parse(stdout); } catch (error) { parseError = error.message; } }
      resolveResult({ command: [compilerPath, ...argv], exitCode, signal, reason, parseError, stderr, envelope });
    });
  });
}
const compilerIdentity = await identity(compilerPath), catalogIdentity = await identity(catalogPath);
let compilerFreshness;
try {
  const { compilerSourceInputs } = await import(pathToFileURL(join(root, 'packages/cloudflare/dist/dev/preview-inputs.js')).href);
  compilerSourceInputs(root, compilerPath);
  compilerFreshness = { status: 'passes-current-preview-freshness-check', limitation: 'Timestamp check only; not a compiler qualification.' };
} catch (error) { compilerFreshness = { status: 'not-current-for-preview', reason: error.message }; }
const analysis = options.inventoryOnly ? { status: 'skipped', complete: false, omitted: null } : await checkOnce();
const envelope = analysis.envelope;
delete analysis.envelope;
if (envelope) {
  analysis.status = envelope.diagnostics?.some(d => d.severity === 'error') ? 'failed' : 'analysis-only';
  analysis.complete = envelope.complete === true;
  analysis.omitted = envelope.omitted ?? null;
  analysis.toolVersion = envelope.tool_version;
  analysis.reportedSourceCount = envelope.sources?.length ?? 0;
  analysis.diagnosticCount = envelope.diagnostics?.length ?? 0;
  analysis.diagnosticCodes = {};
  analysis.sourceMembershipMatches = envelope.sources?.length === sources.length && envelope.sources.every(s => sources.some(x => x.path === rel(resolve(root, s.path)) && x.sha256 === s.sha256));
  for (const diagnostic of envelope.diagnostics ?? []) {
    analysis.diagnosticCodes[diagnostic.code] = (analysis.diagnosticCodes[diagnostic.code] ?? 0) + 1;
    const reported = envelope.sources?.find(s => s.id === diagnostic.primary?.file);
    const source = reported && sources.find(s => s.path === rel(resolve(root, reported.path)));
    const bytes = source && snapshots.get(resolve(root, source.path));
    const line = bytes ? bytes.subarray(0, diagnostic.primary.start).toString('utf8').split('\n').length : null;
    if (source) source.diagnostics.push({ code: diagnostic.code, severity: diagnostic.severity, message: diagnostic.message, line, span: diagnostic.primary });
  }
  for (const source of sources) source.status = source.diagnostics.some(d => d.severity === 'error') ? 'analysis-errors' : 'no-returned-errors; not qualified';
} else if (!options.inventoryOnly) { analysis.status = 'tool-failure'; analysis.complete = false; analysis.omitted = null; }
const changedInputs = [];
for (const path of allPaths) { try { if (hash(await readFile(path)) !== hash(snapshots.get(path))) changedInputs.push(rel(path)); } catch { changedInputs.push(rel(path)); } }
for (const [path, before] of [[compilerPath, compilerIdentity], [catalogPath, catalogIdentity], [admissionPath, admissionIdentity]]) {
  const after = await identity(path);
  if (before.sha256 !== after.sha256) changedInputs.push(rel(path));
}
const appSources = sources.filter(s => paths.includes(resolve(root, s.path)));
const promptSyntaxRejected = sources.some(s => s.diagnostics.some(d => d.code === 'E1007' && d.message.includes("'$'")));
const invalidAnalysis = !options.inventoryOnly && (analysis.complete !== true || analysis.sourceMembershipMatches !== true || (analysis.omitted ?? 0) > 0);
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), checkoutRoot: root,
  status: changedInputs.length ? 'invalidated-inputs-changed' : options.inventoryOnly ? 'inventory-only; unqualified' : analysis.status === 'tool-failure' ? 'tool-failure; unqualified' : invalidAnalysis ? 'incomplete-or-mismatched-analysis; unqualified' : compilerFreshness.status === 'not-current-for-preview' ? 'nonqualifying compiler baseline; end-to-end qualification absent' : 'blocked; end-to-end qualification absent',
  scope: 'All current draft app sources plus shared sources; complete corpus check is not per-selected-app closure compilation.',
  counts: { appSourceFiles: appSources.length, selectableApps: appSources.reduce((n, s) => n + s.apps.length, 0), sharedSources: sharedPaths.length, authoredPages: appSources.reduce((n, s) => n + s.pages.length, 0), promptLiterals: appSources.reduce((n, s) => n + s.prompts.filter(p => p.literal).length, 0), namedPromptUses: appSources.reduce((n, s) => n + s.prompts.filter(p => !p.literal).length, 0), exampleTables: appSources.reduce((n, s) => n + s.examples.length, 0), authoredExampleRows: appSources.reduce((n, s) => n + s.examples.reduce((r, e) => r + e.authoredRows, 0), 0), savedWitnessUnits: witnesses.units.length, legacyJavascript: witnesses.legacyJavascript.length, previewAdmittedSources: appSources.filter(s => s.previewAdmission.ok).length },
  compiler: { ...compilerIdentity, freshness: compilerFreshness }, catalog: catalogIdentity,
  previewAdmissionProducer: { ...admissionIdentity, export: 'admitSingleAppProfile', loadError: admissionError ?? null },
  analysis, changedInputs, sources, witnesses,
  generation: { status: 'not-exercised-by-this-audit; qualification prerequisites are the existing BGI plan', requestedRecipe: { model: 'gpt-6.1-sol', reasoningEffort: 'medium', scope: ['style', 'component', 'trait', 'keyword'] }, actualProviderProvenance: null, draftConfig: rel(join(root, 'draft/can.gen.toml')), limits: 'Requested recipe is user intent. Saved association records and handwritten outputs do not establish generation execution or validation.' },
  execution: { compile: 'not-run', inlineExamples: 'not-run', devServer: 'not-started; admission only', screenshots: 'not-captured', styles: 'not-rendered' },
  prerequisites: Array.from({ length: 13 }, (_, i) => { const id = `BGI-${String(i + 1).padStart(2, '0')}`; return { id, plan: 'docs/design/proposals/build-generation/implementation-plan.md', status: 'existing owner requirement; this audit closes no implementation criterion' }; }),
  gaps: [
    ...(appSources.some(s => !s.previewAdmission.ok) ? ['Current preview admission rejects at least one draft source; exact producer reasons appear per source. Preserve canonical source composition while providing required owner support.'] : []),
    ...(promptSyntaxRejected ? ['This exact compiler run rejects prompt dollar carriers (E1007); source design remains authoritative.'] : []),
    'Corpus diagnostics may cascade after syntax/import failures; inventory and check results do not establish runtime or requirement acceptance.',
    'Actual selected-app compile, inline example execution, admitted/denied browser journeys, prompt generation and desktop/mobile screenshots remain required.',
  ],
};
const rows = appSources.flatMap(s => s.apps.map(app => `<tr><td>${escape(app.name)}<br><small>${escape(s.path)}:${app.line}</small><br><a href="${escape(resolve(root, s.requirementCompanion))}">Requirements</a></td><td>${escape(app.composition.join(', '))}</td><td>${s.pages.length}</td><td>${s.prompts.filter(p => p.literal).length}</td><td>${s.examples.length} tables / ${s.examples.reduce((n, e) => n + e.authoredRows, 0)} authored rows<br>${s.declarations.scenarios.length} scenarios / ${s.declarations.queries.length} queries / ${s.declarations.handlers.length} handlers / ${s.declarations.crud.length} CRUD declarations</td><td>${escape(s.status)} (${s.diagnostics.length} returned)</td><td>${escape(s.previewAdmission.ok ? 'Profile admitted; execution untested' : s.previewAdmission.reason ?? s.previewAdmission.unavailable)}</td></tr>`)).join('\n');
const diagnosticRows = sources.flatMap(s => s.diagnostics.slice(0, 8).map(d => `<li><code>${escape(s.path)}:${escape(d.line)} ${escape(d.code)}</code> ${escape(d.message)}</li>`)).join('\n');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Draft frontend audit</title><style>body{font:16px system-ui;max-width:1300px;margin:2rem auto;padding:0 1rem;background:#111827;color:#e5e7eb}h1{font-size:1.8rem}.status{padding:1rem;border:1px solid #f59e0b;border-radius:.5rem}table{border-collapse:collapse;width:100%;font-size:.85rem}td,th{text-align:left;padding:.7rem;border-bottom:1px solid #374151;vertical-align:top}small{color:#9ca3af;overflow-wrap:anywhere}code{overflow-wrap:anywhere}a{color:#93c5fd}.scroll{overflow:auto}li{margin:.5rem 0}</style><h1>Draft frontend audit</h1><p class="status">${escape(report.status)}. ${escape(report.scope)}</p><p>${report.counts.appSourceFiles} app source files · ${report.counts.selectableApps} selectable apps · ${report.counts.authoredPages} authored pages · ${report.counts.promptLiterals} prompt literals · ${report.counts.sharedSources} shared sources. Lexical counts are inventory, not qualification.</p><p>Compiler: ${escape(analysis.status)}; complete=${escape(analysis.complete)}; returned=${escape(analysis.diagnosticCount ?? 'not run')}; omitted=${escape(analysis.omitted ?? 'unknown')}. Browser screenshots, examples and generation: not executed.</p><p>Requested generation recipe: gpt-6.1-sol / medium. Actual provider provenance: absent.</p><ul>${report.gaps.map(g => `<li>${escape(g)}</li>`).join('')}</ul><div class="scroll"><table><thead><tr><th>Selection / source</th><th>Composition</th><th>Pages</th><th>Prompts</th><th>Examples</th><th>Analysis</th><th>Current preview admission</th></tr></thead><tbody>${rows}</tbody></table></div><details><summary>Diagnostic sample (up to eight per source; all returned diagnostics in JSON)</summary><ul>${diagnosticRows}</ul></details><p><a href="audit.json">Complete JSON report</a></p></html>`;
await mkdir(out, { recursive: true });
for (const [name, content] of [['audit.json', JSON.stringify(report, null, 2) + '\n'], ['index.html', html]]) {
  const temporary = join(out, `.${name}.${process.pid}.tmp`);
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, join(out, name));
}
process.stdout.write(JSON.stringify({ status: report.status, counts: report.counts, analysis: { status: analysis.status, complete: analysis.complete, returned: analysis.diagnosticCount ?? null, omitted: analysis.omitted }, report: join(out, 'audit.json'), html: join(out, 'index.html') }) + '\n');
process.exitCode = options.inventoryOnly ? 0 : analysis.status === 'tool-failure' ? 2 : 1;
