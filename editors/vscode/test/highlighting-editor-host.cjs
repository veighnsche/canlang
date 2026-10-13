/** Run with Cursor/VS Code --extensionTestsPath. The token inspector remains
 * open for visual verification while CAN_HIGHLIGHT_FINISH is absent. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const source = `app Colors
## A comment
# A description
Given
 Todo {title:text,done:bool=false,count:int=42}
 message greeting = "Hello"@{nl="Hoi"}
When
 scenario change(task:Todo) by=members
  do
   let label=task.title
   require true
   return label
Then
 page /todos title="Tasks"
  text row.title
`;
exports.run = async () => {
 const output = process.env.CAN_HIGHLIGHT_OUTPUT || '/tmp/can-highlight-editor.json';
 try {
  const extension = vscode.extensions.getExtension('canlang.canlang-draft-highlighting');
  assert(extension); await extension.activate();
  const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Colors.can');
  fs.writeFileSync(file, source);
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  assert.equal(vscode.workspace.getConfiguration('editor', document).get('semanticHighlighting.enabled'), true);
  const deadline = Date.now() + 20000;
  let legend, tokens;
  while (Date.now() < deadline) {
   legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', document.uri);
   tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
   if (tokens?.data?.length) break;
   await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(tokens?.data?.length, 'real language server returns semantic tokens');
  assert(legend.tokenTypes.every(t => t.startsWith('can')));
  assert(legend.tokenModifiers.every(t => t.startsWith('can')));
  const manifest = extension.packageJSON.contributes;
  assert.deepEqual(legend.tokenTypes, manifest.semanticTokenTypes.map(t => t.id));
  assert.deepEqual(legend.tokenModifiers, manifest.semanticTokenModifiers.map(t => t.id));
  assert(manifest.semanticTokenTypes.every(t => !t.superType));
  assert(!manifest.semanticTokenScopes, 'no generic fallback scopes');
  const decoded = []; let line = 0, column = 0;
  for (let i = 0; i < tokens.data.length; i += 5) {
   const [dl, dc, length, type, modifiers] = tokens.data.slice(i, i + 5);
   line += dl; column = dl ? dc : column + dc;
   decoded.push({line:line+1,column:column+1,text:document.lineAt(line).text.slice(column,column+length),type:legend.tokenTypes[type],modifiers});
  }
  for (const marker of ['Given','When','Then']) assert(decoded.some(t => t.text === marker && t.type === 'canKeyword'));
  assert(decoded.some(t => t.text === 'title' && t.type === 'canProperty'));
  assert(decoded.some(t => t.type === 'canClass'));
  editor.selection = new vscode.Selection(3,1,3,1);
  await vscode.commands.executeCommand('editor.action.inspectTMScopes');
  fs.writeFileSync(output, JSON.stringify({status:'ready for visual inspection',semanticHighlighting:true,decoded},null,2));
  const finish = process.env.CAN_HIGHLIGHT_FINISH;
  if (finish) {
   const stop = Date.now() + 600000;
   while (!fs.existsSync(finish) && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 500));
   assert(fs.existsSync(finish), 'visual inspection finished');
  }
  fs.writeFileSync(output,JSON.stringify({status:'passed semantic integration',semanticHighlighting:true,visualInspection:'manual; not asserted by this host test',decoded},null,2));
 } catch (error) {
  fs.writeFileSync(output,JSON.stringify({status:'failed',error:String(error.stack||error)},null,2));
  throw error;
 }
};
