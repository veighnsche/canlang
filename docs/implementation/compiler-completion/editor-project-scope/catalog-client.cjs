'use strict';
// Actual exported client and can child; VS Code diagnostic host is a stand-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const [out, binary] = process.argv.slice(2);
assert(out && binary, 'usage: node catalog-client.cjs COMPILED_CLIENT_DIR CAN_BINARY');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-editor-catalog-'));
const roots = ['a', 'b'].map(name => path.join(dir, name));
const source = 'app T\nGiven\nWhen\n scenario s(value:text) read=true -> text by=members\n  do return lower(value)\nThen\n';
const catalog = enabled => JSON.stringify({ language_version: '1.0', catalog_version: 'client-scope',
  entries: enabled ? [{ id: 'lower', kind: 'builtin', signature: 'lower(value:text)->text',
    effects: 'pure', availability: 'implemented', js: 'lower', owner: 'test' }] : [] });
const documents = roots.map(root => {
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'main.can'), source);
  const uri = pathToFileURL(path.join(root, 'main.can')).href;
  return { languageId: 'can', version: 1, uri: { toString: () => uri }, getText: () => source };
});
const updates = new Map();
const host = {
  languages: { createDiagnosticCollection: () => ({ set: (uri, values) => updates.set(uri.toString(), values), delete() {}, dispose() {} }) },
  Uri: { parse: value => ({ toString: () => value }) },
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
  Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
};
const exportsObject = {};
const launches = [];
const environment = { ...process.env };
delete environment.CAN_CATALOG;
vm.runInNewContext(fs.readFileSync(path.join(out, 'client.js'), 'utf8'), {
  exports: exportsObject, setTimeout, clearTimeout,
  require: name => name === 'vscode' ? host : name === 'child_process' ? {
    spawn(command, args, options) {
      launches.push(options.cwd);
      return cp.spawn(command, args, { ...options, env: environment });
    },
  } : (() => { throw Error(name); })(),
});
const channel = { appendLine() {}, dispose() {} };
const codes = doc => Array.from(updates.get(doc.uri.toString()) || [], value => value.code);
const clients = [];
async function start() {
  const client = new exportsObject.CanLanguageClient(binary, channel, false, roots[0]);
  clients.push(client);
  await client.start();
  for (const document of documents) client.didOpen(document);
  await client.request('textDocument/hover', { textDocument: { uri: documents[1].uri.toString() }, position: { line: 4, character: 13 } });
  return client;
}
function cli(root, expected) {
  const result = cp.spawnSync(binary, ['check', '--format=json', path.join(root, 'main.can')], { cwd: root, env: environment, encoding: 'utf8' });
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return JSON.parse(result.stdout).diagnostics.map(value => value.code);
}
(async () => {
  try {
    fs.writeFileSync(path.join(roots[0], 'can-catalog.json'), catalog(true));
    fs.writeFileSync(path.join(roots[1], 'can-catalog.json'), catalog(false));
    assert.deepEqual(cli(roots[0], 0), []);
    assert(cli(roots[1], 10).includes('E2001'));
    const client = await start();
    for (const document of documents) assert.deepEqual(codes(document), []);
    console.log('PASS actual client uses one startup cwd catalog across two document roots; CLI uses each invocation cwd');
    fs.writeFileSync(path.join(roots[0], 'can-catalog.json'), catalog(false));
    assert(cli(roots[0], 10).includes('E2001'));
    for (const document of documents) { document.version++; client.didChange(document); }
    await client.request('textDocument/hover', { textDocument: { uri: documents[0].uri.toString() }, position: { line: 4, character: 13 } });
    for (const document of documents) assert.deepEqual(codes(document), []);
    await client.stop();
    await start();
    for (const document of documents) assert(codes(document).includes('E2001'));
    assert.deepEqual(launches, [roots[0], roots[0]]);
    console.log('PASS catalog mutation is visible to fresh CLI and restarted actual client; live client retains startup catalog');
  } finally {
    for (const client of clients) await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
