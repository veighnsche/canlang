/**
 * stdio round-trip test: every advertised `can lsp` capability, one assertion
 * group per method, against the REAL built `can` binary.
 *
 * No npm dependencies: plain node + child_process, so it runs in CI with
 * only a built binary. Run: `bun run test:lsp` from editors/vscode/
 * (or `node test/lsp-capabilities.cjs` directly).
 *
 * Binary resolution (first that spawns): `$CAN_BIN`, then
 * `compiler/target/debug/can` relative to the repo root, then `can` on PATH.
 * Fixture offsets mirror `compiler/tests/ide.rs` (same file bytes), so the
 * expectations below trace to observed analysis output, not guesses.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const FIXTURE = fs.readFileSync(path.join(HERE, 'lsp-capabilities.can'), 'utf8');
const CA_FIXTURE = fs.readFileSync(path.join(HERE, 'lsp-codeaction.can'), 'utf8');
const CAP_URI = 'file:///lsp-capabilities.can';
const CA_URI = 'file:///lsp-codeaction.can';

// Legend copy the extension client declares; the test fails loudly if the
// live server legend drifts from it (source of truth: ide/tokens.rs).
const EXPECTED_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'interface', 'enum', 'struct', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method',
  'keyword', 'comment', 'string', 'number', 'operator',
];
const EXPECTED_TOKEN_MODIFIERS = ['declaration', 'documentation', 'defaultLibrary', 'readonly'];

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`);
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Byte offset -> LSP position (ASCII fixtures: 1 byte = 1 UTF-16 unit). */
function posOf(text, offset) {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

function resolveBinary() {
  const candidates = [];
  if (process.env.CAN_BIN) candidates.push(process.env.CAN_BIN);
  candidates.push(path.join(HERE, '..', '..', '..', 'compiler', 'target', 'debug', 'can'));
  candidates.push('can');
  for (const bin of candidates) {
    try {
      const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
      if (probe.status === 0) return bin;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function main() {
  const bin = resolveBinary();
  if (!bin) {
    console.log('FAIL resolve: no `can` binary (set $CAN_BIN, build compiler/, or put `can` on PATH)');
    process.exit(1);
  }
  console.log(`binary: ${bin}`);

  const child = spawn(bin, ['lsp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();

  function send(method, params) {
    const id = ++nextId;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`request ${method} timed out`));
        }
      }, 15000).unref();
    });
  }
  function notify(method, params) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, headerEnd).toString());
      if (!match) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (buf.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buf.slice(headerEnd + 4, headerEnd + 4 + length).toString());
      buf = buf.slice(headerEnd + 4 + length);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
      // Notifications (publishDiagnostics) are ignored.
    }
  });

  const guard = setTimeout(() => {
    console.log('FAIL harness: timed out');
    child.kill();
    process.exit(1);
  }, 60000);
  guard.unref();

  (async () => {
    // initialize: all 7 providers + legend + utf-16.
    const init = await send('initialize', { processId: null, rootUri: null,
      capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } });
    const caps = init.capabilities;
    check('initialize/hoverProvider', caps.hoverProvider === true, JSON.stringify(caps.hoverProvider));
    check(
      'initialize/completionProvider',
      typeof caps.completionProvider === 'object' && caps.completionProvider !== null,
      JSON.stringify(caps.completionProvider),
    );
    check('initialize/definitionProvider', caps.definitionProvider === true);
    check('initialize/referencesProvider', caps.referencesProvider === true);
    check('initialize/renameProvider', caps.renameProvider === true);
    check(
      'initialize/semanticTokensProvider.full',
      caps.semanticTokensProvider && caps.semanticTokensProvider.full === true,
    );
    check('initialize/codeActionProvider', caps.codeActionProvider === true);
    check('initialize/positionEncoding', caps.positionEncoding === 'utf-16');
    check(
      'initialize/legend.tokenTypes',
      eq(caps.semanticTokensProvider.legend.tokenTypes, EXPECTED_TOKEN_TYPES),
      JSON.stringify(caps.semanticTokensProvider.legend.tokenTypes),
    );
    check(
      'initialize/legend.tokenModifiers',
      eq(caps.semanticTokensProvider.legend.tokenModifiers, EXPECTED_TOKEN_MODIFIERS),
      JSON.stringify(caps.semanticTokensProvider.legend.tokenModifiers),
    );
    notify('initialized', {});

    notify('textDocument/didOpen', {
      textDocument: { uri: CAP_URI, languageId: 'can', version: 1, text: FIXTURE },
    });
    notify('textDocument/didOpen', {
      textDocument: { uri: CA_URI, languageId: 'can', version: 1, text: CA_FIXTURE },
    });

    // 1. hover (offset 18: `Todo` declaration).
    const hover = await send('textDocument/hover', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 18),
    });
    check(
      'hover/Todo-decl',
      hover && hover.contents && hover.contents.value === '**Tasks.Todo** — model',
      JSON.stringify(hover),
    );
    const hoverParam = await send('textDocument/hover', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 102),
    });
    check(
      'hover/param-use',
      hoverParam && hoverParam.contents && hoverParam.contents.value.includes('**Tasks.complete.task**'),
      JSON.stringify(hoverParam),
    );
    const hoverEmpty = await send('textDocument/hover', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 1),
    });
    check('hover/keyword-empty', hoverEmpty === null, JSON.stringify(hoverEmpty));

    // 2. completion (offset 103: expression scope; offset 68: type position).
    const completion = await send('textDocument/completion', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 103),
    });
    const labels = completion.map((item) => item.label);
    for (const expected of ['task', 'label', 'Todo', 'complete', 'and', 'or']) {
      check(`completion/has-${expected}`, labels.includes(expected), `${labels.length} items`);
    }
    const kindOf = (label) => completion.find((item) => item.label === label).kind;
    check('completion/kind-Todo-Class', kindOf('Todo') === 7, JSON.stringify(kindOf('Todo')));
    check('completion/kind-task-Variable', kindOf('task') === 6);
    check('completion/kind-and-Keyword', kindOf('and') === 14);
    const sorted = [...labels].sort();
    check('completion/sorted', eq(labels, sorted));
    const typeCompletion = await send('textDocument/completion', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 68),
    });
    const typeLabels = typeCompletion.map((item) => item.label);
    check('completion/type-position', typeLabels.includes('Todo') && typeLabels.includes('int'));

    // 3. definition (offset 102: `task` use -> param decl 61..65).
    const definition = await send('textDocument/definition', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 102),
    });
    check(
      'definition/task-use',
      eq(definition, [
        {
          uri: CAP_URI,
          range: { start: { line: 4, character: 19 }, end: { line: 4, character: 23 } },
        },
      ]),
      JSON.stringify(definition),
    );
    const defEmpty = await send('textDocument/definition', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 1),
    });
    check('definition/keyword-empty', eq(defEmpty, []), JSON.stringify(defEmpty));

    // 4. references (offset 63: `task` decl -> decl + receiver use).
    const references = await send('textDocument/references', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 63),
      context: { includeDeclaration: true },
    });
    check(
      'references/task',
      references.length === 3 &&
        eq(references[0].range, {
          start: { line: 4, character: 19 },
          end: { line: 4, character: 23 },
        }) &&
        eq(references[1].range, {
          start: { line: 6, character: 13 },
          end: { line: 6, character: 17 },
        }) &&
        eq(references[2].range, {
          start: { line: 7, character: 7 },
          end: { line: 7, character: 11 },
        }),
      JSON.stringify(references),
    );

    // 5. rename (offset 102, newName `job` -> documentChanges, 3 edits).
    const rename = await send('textDocument/rename', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 102),
      newName: 'job',
    });
    const edits = rename && rename.documentChanges && rename.documentChanges[0].edits;
    check(
      'rename/task',
      edits && edits.length === 3 && edits.every((edit) => edit.newText === 'job'),
      JSON.stringify(rename),
    );
    const renameBad = await send('textDocument/rename', {
      textDocument: { uri: CAP_URI },
      position: posOf(FIXTURE, 102),
      newName: 'not a name',
    });
    const badEdits = renameBad && renameBad.documentChanges && renameBad.documentChanges[0].edits;
    check('rename/invalid-name-empty', badEdits && badEdits.length === 0, JSON.stringify(renameBad));

    // 6. semanticTokens/full (delta quintuples; spot-check legend indices).
    const tokens = await send('textDocument/semanticTokens/full', {
      textDocument: { uri: CAP_URI },
    });
    const data = tokens.data;
    check('semanticTokens/quintuples', data.length > 0 && data.length % 5 === 0, `${data.length} numbers`);
    const decoded = [];
    let line = 0;
    let col = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      col = data[i] === 0 ? col + data[i + 1] : data[i + 1];
      decoded.push([line, col, data[i + 2], data[i + 3], data[i + 4]]);
    }
    const typeIndex = (name) => caps.semanticTokensProvider.legend.tokenTypes.indexOf(name);
    const has = (l, c, len, ty, mods) =>
      decoded.some((t) => eq(t, [l, c, len, ty, mods]));
    const DECL = 1;
    check('semanticTokens/Todo-decl', has(2, 1, 4, typeIndex('class'), DECL), JSON.stringify(decoded.slice(0, 6)));
    check('semanticTokens/field-decl', has(2, 8, 5, typeIndex('property'), DECL));
    check('semanticTokens/param-use', has(6, 13, 4, typeIndex('parameter'), 0));
    check('semanticTokens/keyword', has(1, 0, 5, typeIndex('keyword'), 0));

    // 7. codeAction (I1002 redundant `?.` at bytes 73..75 in the CA fixture).
    const actions = await send('textDocument/codeAction', {
      textDocument: { uri: CA_URI },
      range: { start: posOf(CA_FIXTURE, 73), end: posOf(CA_FIXTURE, 75) },
      context: { diagnostics: [] },
    });
    check('codeAction/nonempty', actions.length >= 1, JSON.stringify(actions));
    const fix = actions[0];
    check('codeAction/title', fix.title === 'replace redundant `?.` with `.`', fix.title);
    check('codeAction/kind', fix.kind === 'quickfix', fix.kind);
    const fixEdits = fix.edit && fix.edit.documentChanges && fix.edit.documentChanges[0].edits;
    check(
      'codeAction/rewrite',
      fixEdits && fixEdits.length === 1 && fixEdits[0].newText === '.',
      JSON.stringify(fixEdits),
    );
    const noActions = await send('textDocument/codeAction', {
      textDocument: { uri: CA_URI },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      context: { diagnostics: [] },
    });
    check('codeAction/clean-range-empty', eq(noActions, []), JSON.stringify(noActions));

    await send('shutdown', null);
    notify('exit', null);
    child.stdin.end();
    setTimeout(() => child.kill(), 500).unref();
    console.log(failures === 0 ? 'ALL LSP CAPABILITY CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })().catch((err) => {
    console.log(`FAIL harness: ${err && err.message}`);
    child.kill();
    process.exit(1);
  });
}

main();
