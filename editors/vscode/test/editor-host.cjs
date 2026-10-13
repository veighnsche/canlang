/** Acceptance checks run inside the real VS Code/Cursor extension host.
 * Pass this file with --extensionTestsPath and this extension's directory with
 * --extensionDevelopmentPath; use a disposable workspace with can.serverPath
 * and the current producer catalog at can-catalog.json.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const source = 'app Tasks\nGiven\n Todo { title:text }\nWhen\n scenario complete(task:Todo,other:Todo) by=members\n  do\n   let label=task.title\n   set task {title=label}\nThen\n';
function position(text, needle, shift = 0) {
  const index = text.indexOf(needle);
  assert(index >= 0, needle);
  const lines = text.slice(0, index + shift).split('\n');
  return new vscode.Position(lines.length - 1, lines.at(-1).length);
}
async function until(get, accept, label) {
  const deadline = Date.now() + 15000;
  do {
    const result = await get();
    if (accept(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function replace(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), text);
  if (document.getText() === text) return;
  let listener;
  const changed = new Promise(resolve => {
    listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === document) { listener.dispose(); resolve(); }
    });
  });
  assert(await vscode.workspace.applyEdit(edit));
  await changed;
}
exports.run = async () => {
  const output = process.env.CAN_EDITOR_TEST_OUTPUT || '/tmp/can-editor-host-results.json';
  const passes = [];
  const pass = name => { passes.push(name); console.log(`PASS actual editor: ${name}`); };
  try {
    const extension = vscode.extensions.getExtension('canlang.canlang-draft-highlighting');
    assert(extension, 'development extension is loaded');
    await extension.activate();
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(folder, 'EditorAcceptance.can');
    fs.writeFileSync(file, source);
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, 'can');
    await until(() => vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position(source, 'Todo {', 1)), h => h?.length, 'server initialization');
    pass('extension activation and .can language detection');

    const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position(source, 'task.title', 5), '.');
    const title = completion.items.find(i => i.label === 'title');
    assert(title, 'typed model field offered after dot');
    assert.equal(title.kind, vscode.CompletionItemKind.Field);
    assert(title.detail?.includes('text'), `completion detail: ${title.detail}`);
    assert(!completion.items.some(i => i.label === 'and'));
    pass('typed member completion, field kind and type detail');
    const partial = source.replace('task.title', 'task.');
    await replace(document, partial);
    const partialCompletion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position(partial, 'task.', 5), '.');
    assert(partialCompletion.items.some(i => i.label === 'title'), 'completion while the member name is still missing');
    await replace(document, source);
    pass('member completion while typing an incomplete expression');

    const locals = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position(source, 'task.title', 2));
    assert(!locals.items.some(i => i.label === 'label'), 'initializer cannot see its own binding');
    const member = position(source, 'task.title', 6);
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, member);
    assert(hover.length && hover.flatMap(h => h.contents).some(c => (typeof c === 'string' ? c : c.value || '').includes('title')), 'member hover text');
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, member);
    assert.equal(definitions[0].range.start.line, 2);
    const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, member);
    assert.equal(references.length, 3);
    pass('member hover, definition, references and initializer scope');

    const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri);
    assert(folds.some(range => range.start === 1 && range.end === 2), 'Given folds only its body');
    assert(folds.some(range => range.start === 4 && range.end === 7), 'scenario folds its execution body');
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('editor.fold', { selectionLines: [1] });
    await vscode.commands.executeCommand('cursorDown');
    assert.equal(editor.selection.active.line, 3, 'cursor skips the folded Given body');
    await vscode.commands.executeCommand('editor.unfoldAll');
    pass('CST folding ranges and real Fold/Unfold editor commands');

    const selections = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', document.uri, [member]);
    assert(selections.length === 1 && selections[0].parent, 'logical selection parents');
    editor.selection = new vscode.Selection(member, member);
    for (let i = 0; i < 4 && document.getText(editor.selection) !== 'task.title'; i++) {
      await vscode.commands.executeCommand('editor.action.smartSelect.expand');
    }
    assert.equal(document.getText(editor.selection), 'task.title');
    pass('CST selection ranges and real Expand Selection editor command');


    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, member, 'name');
    assert(rename && await vscode.workspace.applyEdit(rename));
    assert.equal(document.getText(), source.replaceAll('title', 'name'));
    await until(() => vscode.languages.getDiagnostics(document.uri), ds => !ds.some(d => d.severity === vscode.DiagnosticSeverity.Error), 'renamed program diagnostics');
    pass('field rename updates declaration, read and write together');
    await replace(document, source);
    let collision;
    try { collision = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position(source, 'task:Todo', 1), 'other'); }
    catch (error) { assert(/rename|collision|safely|conflict/i.test(String(error)), String(error)); }
    assert(!collision || collision.size === 0, 'colliding rename is refused');
    assert.equal(document.getText(), source);
    pass('colliding rename refused without changing the buffer');

    const outline = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    assert.equal(outline[0].name, 'Tasks');
    assert(outline[0].children.some(s => s.name === 'Todo' && s.children.some(f => f.name === 'title')));
    assert(outline[0].children.some(s => s.name === 'complete'));
    pass('hierarchical Outline symbols');

    const sloppy = source.replace('title:text', 'title : text').replace('task:Todo', 'task : Todo').replace('Given\n', 'Given  \n');
    await replace(document, sloppy);
    const formatting = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 1, insertSpaces: true });
    assert(formatting?.length);
    const formatEdit = new vscode.WorkspaceEdit();
    formatEdit.set(document.uri, formatting);
    assert(await vscode.workspace.applyEdit(formatEdit));
    assert.equal(document.getText(), source);
    pass('document formatting uses canonical compiler output');

    editor.selection = new vscode.Selection(6, 0, 6, 0);
    await vscode.commands.executeCommand('editor.action.commentLine');
    assert(document.lineAt(6).text.trimStart().startsWith('##'), document.lineAt(6).text);
    await vscode.commands.executeCommand('editor.action.commentLine');
    assert.equal(document.getText(), source);
    pass('Toggle Line Comment uses ## and round-trips');

    const scratch = await vscode.workspace.openTextDocument({ language: 'can', content: '' });
    await vscode.window.showTextDocument(scratch);
    await vscode.commands.executeCommand('type', { text: '(' });
    assert.equal(scratch.getText(), '()');
    await replace(scratch, '');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.window.showTextDocument(document);
    await document.save();
    pass('language-defined bracket auto-close');
    const packageDoc = await vscode.workspace.openTextDocument({ language: 'can', content: '' });
    await vscode.window.showTextDocument(packageDoc);
    await vscode.commands.executeCommand('type', { text: 'package P' });
    // Immediate scripted Enter can outrun background tokenization. Cursor then
    // copies indentation without consulting the language's indentation rules.
    await vscode.commands.executeCommand('editor.action.forceRetokenize');
    await vscode.commands.executeCommand('type', { text: '\n' });
    assert.equal(packageDoc.lineAt(1).text, ' ', 'indent package body by one space');
    await vscode.commands.executeCommand('type', { text: 'Given' });
    assert.equal(packageDoc.lineAt(1).text, ' Given', 'keep nested Given at package level');
    await vscode.commands.executeCommand('editor.action.forceRetokenize');
    await vscode.commands.executeCommand('type', { text: '\n' });
    assert.equal(packageDoc.lineAt(2).text, '  ', 'indent nested Given declarations');
    await replace(packageDoc, '');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.window.showTextDocument(document);
    pass('real Enter indentation after package and nested Given');

    await vscode.commands.executeCommand('can.restartServer');
    await until(() => vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, member), h => h?.length, 'restart recovery');
    pass('restart command restores member tools');
    fs.writeFileSync(output, JSON.stringify({ editor: vscode.env.appName, version: vscode.version, passes }, null, 2));
  } catch (error) {
    fs.writeFileSync(output, JSON.stringify({ editor: vscode.env.appName, version: vscode.version, passes, error: String(error), stack: error.stack }, null, 2));
    throw error;
  }
};
