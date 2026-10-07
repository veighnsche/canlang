#!/usr/bin/env python3
"""Paired actual-server references and workspace-edit capability audit; evidence only."""
import hashlib,json,os,pathlib,tempfile
from process import BIN,Session,req,note,open_doc
from run import HERE,ROOT,save,digest,invoke

def main():
 source_path=ROOT/'editors/vscode/test/lsp-capabilities.can'
 source=source_path.read_text()
 offset=source.index('task.title'); before=source[:offset]
 position={'line':before.count('\n'),'character':len(before.rsplit('\n',1)[-1])}
 declaration_offset=source.index('task:Todo');before=source[:declaration_offset]
 declaration={'line':before.count('\n'),'character':len(before.rsplit('\n',1)[-1])}
 env=os.environ.copy();env['CAN_CATALOG']=str(ROOT/'packages/values/dist/catalog.json')
 receipts=[];observations=[]
 with tempfile.TemporaryDirectory(prefix='can-step11-options-') as temp:
  fixture=pathlib.Path(temp)/'options.can';fixture.write_text(source)
  checked,receipt=invoke('server-options-cli-control',[BIN,'check','--format=json','--catalog',env['CAN_CATALOG'],fixture],env=env,timeout=15)
  receipts.append(receipt);control=json.loads(checked.stdout)
  assert checked.returncode==0 and not control['diagnostics'],'valid clean CLI source control required'
  uri=fixture.as_uri();target={'textDocument':{'uri':uri},'position':position}
  for name,capabilities in [('server-options-absent',{}),('server-options-versioned',{'workspace':{'workspaceEdit':{'documentChanges':True}}})]:
   s=Session(name,ROOT,env)
   initialization=s.request(req(1,'initialize',{'processId':None,'rootUri':None,'capabilities':capabilities}))
   assert 'capabilities' in initialization.get('result',{}),'valid initialization required'
   assert initialization['result']['capabilities']['referencesProvider'] is True
   assert initialization['result']['capabilities']['renameProvider'] is True
   s.send(note('initialized',{}));s.send(open_doc(uri,1,source))
   included=s.request(req(3,'textDocument/references',{**target,'context':{'includeDeclaration':True}}))
   excluded=s.request(req(4,'textDocument/references',{**target,'context':{'includeDeclaration':False}}))
   renamed=s.request(req(5,'textDocument/rename',{**target,'newName':'job'}))
   receipts.append(s.finish())
   diagnostics=[f for f in s.frames if f.get('method')=='textDocument/publishDiagnostics']
   assert diagnostics and all(not f['params']['diagnostics'] for f in diagnostics),'clean real diagnostics control required'
   assert 'result' in included and 'result' in excluded and 'result' in renamed
   assert included['result'] and any(x['range']['start']==declaration for x in included['result']),'resolvable known declaration positive control required'
   assert renamed['result']['documentChanges'][0]['textDocument']['version']==1
   observations.append({'id':name,'initialization_success':True,'source_diagnostics':[],'capabilities_input':capabilities,'uri':uri,'position':position,'declaration_position':declaration,'references_true':included,'references_false':excluded,'rename':renamed,'references_equal':included['result']==excluded['result'],'false_includes_declaration':any(x['range']['start']==declaration for x in excluded['result']),'rename_carrier':'documentChanges' if 'documentChanges' in renamed['result'] else 'changes','frames':s.frames})
 save('server-options.json',{'schema':1,'scope':'Actual framed binary, paired valid requests; no client GUI or edit application','pins':[{'path':str(p.relative_to(ROOT)),'sha256':digest(p)} for p in [BIN,source_path,ROOT/'packages/values/dist/catalog.json',HERE/'server-options.py',HERE/'process.py',HERE/'run.py']],'fixture':{'source':source,'sha256':hashlib.sha256(source.encode()).hexdigest(),'version':1,'position':position,'declaration_position':declaration},'controls':{'cli_exit':checked.returncode,'cli_diagnostics':control['diagnostics'],'both_initializations_successful':True,'both_real_source_diagnostics_clean':True},'expectations':{'references_false':'Omit declaration while true includes it; official ReferenceContext.includeDeclaration contract','rename_absent':'Plain changes carrier when documentChanges/resourceOperations unsupported','rename_supported':'Versioned documentChanges allowed when documentChanges true'},'normative_urls':{'references':'https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/language/references.md','workspace_edit':'https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/types/workspaceEdit.md'},'observations':observations,'commands':receipts,'summary':{'references_false_includes_declaration':all(x['false_includes_declaration'] for x in observations),'references_true_false_equal':all(x['references_equal'] for x in observations),'rename_carrier_both': [x['rename_carrier'] for x in observations]}})
 print(json.dumps({'sessions':len(observations),'cli_exit':checked.returncode,'references_true_false_equal':[x['references_equal'] for x in observations],'false_includes_declaration':[x['false_includes_declaration'] for x in observations],'rename_carriers':[x['rename_carrier'] for x in observations]}))
if __name__=='__main__':main()
