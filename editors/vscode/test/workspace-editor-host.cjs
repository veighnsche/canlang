/** Project acceptance in the real editor host. Use a disposable local workspace. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const provider = 'package Domain\n Given\n  export Todo { title:text }\n When\n Then\n';
const consumer = 'app Consumer\nuse Domain {Todo}\nGiven\nWhen\n scenario get(task:Todo) by=members\n  do\n   let result=task.title\nThen\n';
const other = 'app OtherConsumer\nuse Domain {Todo as Task}\nGiven\nWhen\n scenario get(task:Task) by=members\n  do\n   let result=task.title\nThen\n';
function pos(text, needle, delta=0) {
  const index = text.indexOf(needle); assert(index>=0,needle);
  const lines = text.slice(0,index+delta).split('\n');
  return new vscode.Position(lines.length-1,lines.at(-1).length);
}
async function until(get, accept, label) {
  const deadline=Date.now()+20000;
  do { const result=await get(); if(accept(result))return result;
    await new Promise(r=>setTimeout(r,100));
  } while(Date.now()<deadline);
  throw new Error(`Timed out: ${label}`);
}
exports.run=async()=>{
  const passes=[];
  const output=process.env.CAN_EDITOR_TEST_OUTPUT || '/tmp/can-workspace-editor-results.json';
  const pass=name=>{passes.push(name);console.log(`PASS actual editor project: ${name}`);};
  try {
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
    const paths={provider:path.join(root,'Provider.can'),consumer:path.join(root,'Consumer.can'),other:path.join(root,'Other.can')};
    for(const [name,text]of Object.entries({provider,consumer,other})) fs.writeFileSync(paths[name],text);
    fs.writeFileSync(path.join(root,'Unrelated.can'),'app Consumer\nGiven\n Broken { n:Unknown }\nWhen\nThen\n');
    const doc=await vscode.workspace.openTextDocument(paths.consumer);
    await vscode.window.showTextDocument(doc);
    await vscode.extensions.getExtension('canlang.canlang-draft-highlighting').activate();
    const member=pos(consumer,'task.title',6);
    const definitions=await until(()=>vscode.commands.executeCommand('vscode.executeDefinitionProvider',doc.uri,member), ds=>ds?.length && ds[0].uri.fsPath===paths.provider,'unopened imported provider definition');
    assert.equal(definitions[0].range.start.line,2);
    assert(!vscode.workspace.textDocuments.some(d=>d.uri.fsPath===paths.provider),'provider navigation does not require opening its file');
    pass('definition resolves an unopened imported file');
    const providerUri=vscode.Uri.file(paths.provider);
    fs.writeFileSync(paths.provider,provider.replace('title:text','title:Missing'));
    await until(()=>vscode.languages.getDiagnostics(providerUri),ds=>ds.some(d=>d.severity===vscode.DiagnosticSeverity.Error),'unopened imported-file diagnostics');
    fs.writeFileSync(paths.provider,provider);
    await until(()=>vscode.languages.getDiagnostics(providerUri),ds=>!ds.some(d=>d.severity===vscode.DiagnosticSeverity.Error),'repaired imported-file diagnostics');
    pass('errors in unopened imported files appear and clear after disk repair');
    fs.unlinkSync(paths.provider);
    await until(()=>vscode.commands.executeCommand('vscode.executeDefinitionProvider',doc.uri,member),r=>!r?.length,'deleted unopened provider');
    pass('deleted unopened imported file removes obsolete navigation');
    fs.writeFileSync(paths.provider,provider);
    await until(()=>vscode.commands.executeCommand('vscode.executeDefinitionProvider',doc.uri,member),r=>r?.length,'recreated unopened provider');
    pass('recreated unopened imported file restores project tools');


    const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',doc.uri,pos(consumer,'task.title',5),'.');
    assert(completion.items.some(i=>i.label==='title' && i.detail?.includes('text')));
    const refs=await vscode.commands.executeCommand('vscode.executeReferenceProvider',doc.uri,member);
    assert.equal(new Set(refs.map(r=>r.uri.fsPath)).size,3);
    assert.equal(refs.length,3);
    assert(!vscode.languages.getDiagnostics(doc.uri).some(d=>d.severity===vscode.DiagnosticSeverity.Error));
    pass('project member completion/references and unrelated-app isolation');
    const secondRoot=vscode.workspace.workspaceFolders[1]?.uri.fsPath;
    assert(secondRoot,'multi-root acceptance workspace');
    fs.writeFileSync(path.join(secondRoot,'Provider.can'),provider.replace('title:text','title:bool'));
    fs.writeFileSync(path.join(secondRoot,'Consumer.can'),consumer);
    const second=await vscode.workspace.openTextDocument(path.join(secondRoot,'Consumer.can'));
    await vscode.window.showTextDocument(second);
    await until(()=>vscode.commands.executeCommand('vscode.executeCompletionItemProvider',second.uri,pos(consumer,'task.title',5),'.'),r=>r.items.some(i=>i.label==='title' && i.detail?.includes('bool')),'isolated second root type');
    const secondRefs=await vscode.commands.executeCommand('vscode.executeReferenceProvider',second.uri,member);
    assert.equal(secondRefs.length,2);
    assert(secondRefs.every(r=>r.uri.fsPath.startsWith(secondRoot+path.sep)));
    await vscode.window.showTextDocument(doc);
    pass('two workspace folders isolate identical module names and references');

    const rename=await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',doc.uri,member,'caption');
    assert(rename && await vscode.workspace.applyEdit(rename));
    for(const [name,text]of Object.entries({provider,consumer,other})){
      const target=vscode.workspace.textDocuments.find(d=>d.uri.fsPath===paths[name]);
      assert(target,`rename opened/synced ${name}`);
      assert.equal(target.getText(),text.replaceAll('title','caption'));
      await target.save();
    }
    pass('cross-file field rename edits unopened targets with live versions');
    const providerDoc=vscode.workspace.textDocuments.find(d=>d.uri.fsPath===paths.provider);
    const renamedProvider=provider.replace('title','caption');
    const modelRename=await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',providerDoc.uri,pos(renamedProvider,'Todo',1),'Item');
    assert(modelRename && await vscode.workspace.applyEdit(modelRename));
    const consumerDoc=vscode.workspace.textDocuments.find(d=>d.uri.fsPath===paths.consumer);
    const otherDoc=vscode.workspace.textDocuments.find(d=>d.uri.fsPath===paths.other);
    assert(consumerDoc.getText().includes('use Domain {Item}'));
    assert(consumerDoc.getText().includes('task:Item'));
    assert(otherDoc.getText().includes('use Domain {Item as Task}'));
    assert(otherDoc.getText().includes('task:Task'));
    pass('provider rename updates imports and preserves explicit aliases');
    for(const target of [providerDoc,consumerDoc,otherDoc])await target.save();

    const editedProvider=providerDoc.getText().replace('caption:text','caption:int');
    const edit=new vscode.WorkspaceEdit();
    edit.replace(providerDoc.uri,new vscode.Range(0,0,providerDoc.lineCount,0),editedProvider);
    assert(await vscode.workspace.applyEdit(edit));
    await until(()=>vscode.commands.executeCommand('vscode.executeCompletionItemProvider',consumerDoc.uri,pos(consumerDoc.getText(),'task.caption',5),'.'),r=>r.items.some(i=>i.label==='caption' && i.detail?.includes('int')),'unsaved provider type');
    pass('unsaved imported-file changes override disk contents');
    await providerDoc.save();

    // Close its visible editor, then edit disk: the editor synchronizes any retained model.
    await vscode.window.showTextDocument(providerDoc);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.writeFileSync(paths.provider,editedProvider.replace('caption:int','caption:bool'));
    await until(()=>vscode.commands.executeCommand('vscode.executeCompletionItemProvider',consumerDoc.uri,pos(consumerDoc.getText(),'task.caption',5),'.'),r=>r.items.some(i=>i.label==='caption' && i.detail?.includes('bool')),'watched disk edit');
    pass('imported-file disk changes refresh project completion');
    await vscode.window.showTextDocument(consumerDoc);
    fs.writeFileSync(output,JSON.stringify({editor:vscode.env.appName,version:vscode.version,passes},null,2));
  }catch(error){fs.writeFileSync(output,JSON.stringify({editor:vscode.env.appName,version:vscode.version,passes,error:String(error),stack:error.stack},null,2));throw error;}
};
