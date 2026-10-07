#!/usr/bin/env python3
"""Verify receipt integrity/controls; explicitly keep unmet contracts separate."""
import json,pathlib,re,hashlib,subprocess
from run import HERE,ROOT,save,digest
from process import decode
checks=[]
def check(label,condition):
 checks.append({'check':label,'verified':bool(condition)})
 assert condition,label

def read(n):return json.loads((HERE/n).read_text())
def main():
 for x in read('inputs.json')['pins']:check('unchanged baseline '+x['path'],digest(ROOT/x['path'])==x['sha256'])
 n=0
 for name in ['execution.json','process-execution.json','client-execution.json','server-options.json']:
  for c in read(name)['commands']:
   for k in ['stdin','stdout','stderr']:
    if k in c and k+'_sha256' in c:check(name+'/'+c['name']+'/'+k,digest(HERE/c[k])==c[k+'_sha256']);n+=1
 for x in read('execution.json')['libraries']:check('Cargo reported library '+x['path'],digest(pathlib.Path(x['path']))==x['sha256'])
 binary=digest(ROOT/'compiler/target/debug/can');check('fresh can binary',binary==read('execution.json')['binary']['sha256']==read('process-execution.json')['binary']['sha256']==read('client-execution.json')['binary_sha256'])
 suites=[]
 for f in ['focused-suites.stdout','lsp-unit.stdout']:
  suites+=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out', (HERE/f).read_text())
 check('seven selected harness results',len(suites)==7);check('128 native passes',sum(int(x[0])for x in suites)==128);check('zero selected failures/ignored',all(int(x[1])==int(x[2])==0 for x in suites));check('97 unit filter exclusions',sum(int(x[4])for x in suites)==97)
 check('11 existing startup mock passes',len(re.findall(r'^PASS ',(HERE/'client-startup.stdout').read_text(),re.M))==11)
 obs={x['id']:x for x in read('process-observations.json')};check('12 process observations',len(obs)==12)
 for c in read('process-cases.json'):
  if 'messages' in c and 'expected_exit' in c:check('declared exit '+c['id'],obs[c['id']]['exit']==c['expected_exit'])
 for key in ['catalog-invalidation','catalog-restart','cross-file-server','reopen','lifecycle','cancel-sync']:
  check('successful initialization '+key,any(x.get('id')==1 and 'capabilities' in x.get('result',{}) for x in obs[key]['frames']))
 def notes(key):return[x for x in obs[key]['frames']if x.get('method')=='textDocument/publishDiagnostics']
 check('malformed source E1006 then repair clear',[x['params']['diagnostics'] for x in notes('lifecycle')][0][0]['code']=='E1006' and not notes('lifecycle')[1]['params']['diagnostics'])
 check('close/reopen lacks intervening server clear',len(notes('reopen'))==2 and notes('reopen')[0]['params']['diagnostics'] and not notes('reopen')[1]['params']['diagnostics'])
 check('catalog captured for both roots and after mutation',len(notes('catalog-invalidation'))==3 and all(not x['params']['diagnostics']for x in notes('catalog-invalidation')))
 check('restart reloads changed catalog',notes('catalog-restart')[0]['params']['diagnostics'][0]['code']=='E2001')
 check('CLI crossfile clean control',obs['cross-file-cli-check']['exit']==0 and obs['cross-file-cli-check']['codes']==[])
 check('LSP crossfile unsupported contrast',any(x.get('code')=='E2005' for n in notes('cross-file-server') for x in n['params']['diagnostics']) and obs['cross-file-server']['definition']['result']==[])
 b=read('public-batch.stdout');check('public epoch duplicates current content',b['same_version_reopen_pending']==2 and len(b['same_version_reopen_publications'])==2 and b['stats'][0]['current_id']==b['stats'][1]['current_id']==1 and b['stats'][0]['current_text_sha256']==b['stats'][1]['current_text_sha256']);check('public queued work after shutdown',len(b['after_shutdown_publications'])==1)
 r=read('public-retention.stdout');check('129 delegated actual analyses',r['analysis_calls']==129 and len(r['samples'])==129);check('retention drain',r['pending_after_pumps']==0 and r['closed_pump_notifications']==0)
 stages=r['stages'];check('96 distinct sources and text bytes',stages[4]['sample']['retained_sources']==96 and stages[4]['sample']['retained_text_bytes']==791031);check('identical live content reuses source',stages[5]['sample']['retained_sources']==96 and stages[5]['sample']['retained_text_bytes']==791031);check('closed reopen adds same text revision',stages[6]['sample']['retained_sources']==97 and stages[6]['sample']['retained_text_bytes']==799271 and stages[5]['sample']['current_text_sha256']==stages[6]['sample']['current_text_sha256']);check('retention clean current source',all(x['codes']==[]for x in r['samples']))
 options=read('server-options.json');check('references false retains declaration',options['summary']['references_false_includes_declaration'] and options['summary']['references_true_false_equal']);check('unnegotiated edit carrier',options['summary']['rename_carrier_both']==['documentChanges','documentChanges'])
 c=read('client-observations.json');check('4 real client child sessions and9 observations',len(c['sessions'])==4 and len(c['observations'])==9)
 for s in c['sessions']:
  check(s['name']+' actual input frames',decode((HERE/(s['name']+'.stdin')).read_bytes())==s['sent']);check(s['name']+' actual output frames',decode((HERE/(s['name']+'.stdout')).read_bytes())==s['received'])
 co={x['id']:x for x in c['observations']}
 check('delayed stale diagnostic installed',co['client-stale-diagnostic']['actualWireVersion']==1 and co['client-stale-diagnostic']['currentVersion']==2 and co['client-stale-diagnostic']['installed']['count']>0)
 check('late closed diagnostic installed',co['client-closed-diagnostic']['deletedOnClose'] and co['client-closed-diagnostic']['installed']['count']>0)
 check('versioned rename fence discarded',co['stale-versioned-rename']['actualWireVersion']==1 and co['stale-versioned-rename']['currentVersion']==2 and 'version' not in json.dumps(co['stale-versioned-rename']['converted']))
 check('completion API enums differ',len(co['completion-kinds']['selected'])==3 and all(x['kind']!=x['expected']for x in co['completion-kinds']['selected']))
 check('cancelled provider offers result',co['cancelled-provider']['resultOffered'] and co['cancelled-provider']['cancelFrames']==0 and co['cancelled-provider']['cancelListenerCount']==0)
 check('client stop lifecycle positive',co['client-stop']['exit']['code']==0 and co['client-stop']['droppedAfterStop'] and co['client-stop']['disposed']==1)
 check('manual restart current replay',co['extension-restart-replay']['replayedVersion']==2 and co['extension-restart-replay']['replayedCurrentText']);check('cooperative deactivate exit',co['extension-deactivate']['exit']['code']==0)
 check('undelivered response on child death',co['client-death-pending']['pendingResult'] is None and co['client-death-pending']['onExitCalls']==1 and co['client-death-pending']['droppedAfterDeath'])
 server=read('server.json')['finite_duties'];client=read('client.json')['duties'];check('31 unique bounded duties',len(server)==17 and len(client)==14 and len({x['id']for x in server+client})==31)
 manifest=[{'path':str(p.relative_to(HERE)),'sha256':digest(p),'bytes':p.stat().st_size} for p in sorted(HERE.rglob('*')) if p.is_file() and '__pycache__' not in p.parts and p.name not in ['outcome-verification.json','evidence-files.json']]
 save('evidence-files.json',manifest)
 save('outcome-verification.json',{'scope':'Receipt/control/inventory verification, not intended-contract success or whole compiler certification','checks':checks,'verified':len(checks),'nonverified':0,'command_stream_hash_checks':n,'compiler_paths_unchanged':107,'selected_native_harness_passes':128,'existing_startup_mock_passes':11,'framed_processes':17,'CLI_controls':2,'public_analysis_calls':129,'client_observations':9,'duties':31,'unmet_contracts':['old/closed diagnostic rejection','versioned edit currentness','completion enum conversion','provider cancellation','server diagnostic clear on close','includeDeclaration:false','workspace edit capability negotiation'],'qualification_gates':['cross-file/workspace/catalog support','public batched scheduling epoch/shutdown','startup/host timeout/race coverage','bounded history ownership/representative workloads'],'limits':['selective host API stand-ins, no GUI/actual edit application','no interrupted in-flight server analysis','no RSS/crash/exhaustion/benchmark/other-host claim','no full suite/release/installed-original app closure','failed first observations excluded; originals retained']})
 print(json.dumps({'verified':len(checks),'duties':31,'native_passes':128,'framed_processes':17}))
if __name__=='__main__':main()
