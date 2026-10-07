#!/usr/bin/env python3
"""Bounded audit receipts, fresh artifacts, no production changes."""
import hashlib,json,pathlib,platform,subprocess,tempfile,time,sys,re
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[4]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,data):(HERE/p).write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
def invoke(name,argv,cwd=ROOT,env=None):
 start=time.time();d=subprocess.run([str(a) for a in argv],cwd=cwd,capture_output=True,env=env)
 r={'name':name,'argv':[str(a) for a in argv],'cwd':str(cwd),'exit':d.returncode,'elapsed_seconds':round(time.time()-start,3)}
 for s in ['stdout','stderr']:
  (HERE/(name+'.'+s)).write_bytes(getattr(d,s));r[s]=name+'.'+s;r[s+'_sha256']=hashlib.sha256(getattr(d,s)).hexdigest()
 return d,r
def prepare():
 cases=[{'id':'controls-precision','mode':'format','source':'app T\r\nGiven\r\n Item { big:int=9223372036854775807, amount:decimal=1.2300, title:text="a\\b\\f\\n\\\"\\\\\\uD83D\\uDE00" }\r\n ## keep comment  \r\nWhen\r\nThen\r\n'},
 {'id':'comments-layout','mode':'format','source':'app T\nGiven\n ## unrelated comment  \n # Item prose.  \n Item {\n title:text desc="Owned prose.",\n amount:decimal=0.0100\n }\nWhen\n scenario s(item:Item)->text by=members\n  do\n   let n=(1+2)*3\n   return item.title\nThen\n'},
 {'id':'bad-escape','mode':'format','source':'app T\nGiven\n Item {title:text="\\q"}\nWhen\nThen\n','refuse':True},
 {'id':'bad-tab','mode':'format','source':'app T\nGiven\n\tItem {title:text}\nWhen\nThen\n','refuse':True},
 {'id':'fix-comments','mode':'fix','source':'app T\nGiven\n Todo {title:text}\n ## unrelated declaration\n Other {value:int=7}\nWhen\n scenario s(task:Todo) by=members\n  do\n   require false\n   ## keep explanatory comment\n   let dead=2\n ## keep following declaration\n scenario keep(task:Todo)->text by=members\n  do return task.title\nThen\n','fix_count':1},
 {'id':'fix-safe-access','mode':'fix','source':'app T\nGiven\n Todo {title:text}\nWhen\n scenario s(task:Todo)->text by=members\n  do\n   let p=task?.title\n   return p\nThen\n','fix_count':1},
 {'id':'fix-semicolon','mode':'fix','source':'app T\nGiven\n Todo {title:text}\nWhen\n scenario s(task:Todo) by=members\n  do require false; let dead=2\nThen\n','fix_count':0}]
 for directory in ['examples','draft','draft/shared']:
  for p in sorted((ROOT/directory).glob('*.can')):
   cases.append({'id':'corpus-'+str(p.relative_to(ROOT)).replace('/','-').removesuffix('.can'),'mode':'format','source_path':str(p.relative_to(ROOT)),'source':p.read_text(),'refuse':p.name in ['CanShift.can','CanVolunteer.can']})
 for c in cases:c['source_sha256']=hashlib.sha256(c['source'].encode()).hexdigest()
 save('cases.json',cases)
 # Rehash historical compiler/runtime manifests without mutating their receipts.
 checked=[];bad=[]
 for name in ['syntax-evidence/inputs.json','syntax-evidence/runtime-inputs.json']:
  data=json.loads((HERE.parent/name).read_text())
  def walk(x):
   if isinstance(x,dict):
    if 'path' in x and 'sha256' in x and isinstance(x['path'],str):
     p=pathlib.Path(x['path']);p=p if p.is_absolute() else ROOT/p
     if p.is_file():
      found=digest(p);checked.append({'path':str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p),'expected':x['sha256'],'found':found})
      if found!=x['sha256'] and p.name!='DECISIONS.md':bad.append(checked[-1])
    for v in x.values():walk(v)
   elif isinstance(x,list):
    for v in x:walk(v)
  walk(data)
 paths=['AGENTS.md','compiler/Cargo.toml','compiler/Cargo.lock','docs/specification/GRAMMAR.md','docs/specification/DESIGN.md','packages/values/dist/catalog.json','packages/interfaces/src/docs/reference.ts','packages/interfaces/dist/src/docs/reference.js','packages/interfaces/dist/src/index.js','packages/cloudflare/dist/cli/platform.js','compiler/tests/fixtures/sourcemap-consumer.mjs','docs/research/compiler-library-audit-20261006/model-allocation-20261007.md']
 pins=[{'path':p,'sha256':digest(ROOT/p),'bytes':(ROOT/p).stat().st_size} for p in paths]
 save('inputs.json',{'scope':'Step10 bounded compiler output/transform audit; no implementation','head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'compiler_source_commit':subprocess.check_output(['git','log','-1','--format=%H','--','compiler'],cwd=ROOT,text=True).strip(),'host':platform.platform(),'machine':platform.machine(),'allocation':{'serialization_and_independent_review':'gpt-6.1-sol medium','other_lanes':'root: extra dispatch unavailable (agent thread limit); no escalation'},'rechecked_pin_references':len(checked),'mismatches':bad,'historical_decisions':'prior prefix retained; append-only decisions are not compiler/runtime input drift','pins':pins,'cases_sha256':digest(HERE/'cases.json')})
 assert not bad,bad
def main():
 if '--prepare' in sys.argv:prepare();print('Prepared bounded cases and input pins.');return
 receipts=[]
 for name,argv in [('rustc-version',['rustc','-Vv']),('cargo-version',['cargo','-V']),('node-version',['node','--version'])]:
  d,r=invoke(name,argv);receipts.append(r);assert d.returncode==0
 d,r=invoke('fresh-build',['cargo','build','--locked','--offline','--manifest-path','compiler/Cargo.toml','--lib','--bin','can','--message-format=json']);receipts.append(r);assert d.returncode==0
 reported=[json.loads(l) for l in d.stdout.splitlines() if l.startswith(b'{')]
 def rlib(name):return next(f for a in reported if a.get('reason')=='compiler-artifact' and a['target']['name']==name for f in a['filenames'] if f.endswith('.rlib'))
 libs=[rlib('canlang_compiler'),rlib('serde_json')];observations=[]
 with tempfile.TemporaryDirectory(prefix='can-step10-') as scratch:
  scratch=pathlib.Path(scratch);exe=scratch/'probe'
  d,r=invoke('compile-probe',['rustc','--edition=2024',HERE/'probe.rs','--extern','canlang_compiler='+libs[0],'--extern','serde_json='+libs[1],'-L','dependency='+str(ROOT/'compiler/target/debug/deps'),'-o',exe]);receipts.append(r);assert d.returncode==0
  for c in json.loads((HERE/'cases.json').read_text()):
   p=scratch/(c['id']+'.can');p.write_text(c['source']);d,r=invoke('case-'+c['id'],[exe,c['mode'],p]);receipts.append(r);assert d.returncode==0
   o=json.loads(d.stdout);assertions=[]
   if c['mode']=='format':
    assertions.append({'contract':'expected admission','pass':('refusal' in o)==bool(c.get('refuse'))})
    if 'result' in o:
     for key in ['structure_equal','idempotent','after_coverage']:assertions.append({'contract':key,'pass':o['result'][key]})
     assertions.append({'contract':'after parse clean','pass':not o['result']['after_codes']})
   else:
    assertions.append({'contract':'expected fix count','pass':len(o['fixes'])==c['fix_count']})
    assertions.append({'contract':'analysis before/after clean','pass':not o['analysis_codes'] and not o['result']['analysis_codes']})
    assertions.append({'contract':'batch idempotent','pass':o['result']['batch_idempotent']})
    if o['fixes']:
     assertions.append({'contract':'stale refused both APIs','pass':'Stale' in o['stale']['driver'] and 'Stale' in o['stale']['ide']})
     for k in ['invalid_range_rejected','overlap_rejected']:assertions.append({'contract':k,'pass':o[k]})
     assertions.append({'contract':'fresh IDE/driver agree','pass':o['stale']['ide_fresh_matches_single']})
   observations.append({'id':c['id'],'source_sha256':c['source_sha256'],'observation':'case-'+c['id']+'.stdout','assertions':assertions})
  for mode in ['coordinates','diagnostics']:
   d,r=invoke(mode,[exe,mode]);receipts.append(r);assert d.returncode==0
 save('observations.json',observations)
 if '--observers-only' in sys.argv:
  save('observer-execution.json',{'commands':receipts,'libraries':[{'path':p,'sha256':digest(pathlib.Path(p))} for p in libs],'scope':'Corrected unique path IDs; fresh bounded observer rerun only; prior focused suites retained separately.'})
  print(json.dumps({'cases':len(observations),'mismatches':[o['id'] for o in observations if any(not a['pass'] for a in o['assertions'])]}));return
 suites=['format','lint','typed_json','typed_artifact','typed_artifact_consumer','typed_descriptors','typed_diagnostics_cli','typed_reference_policy_consumers','typed_bdd','typed_explain','typed_fixes','typed_fixes_cli','typed_policy','typed_references','sourcemap_contract','lsp_typed_output','file_ownership','string_payload_runtime']
 argv=['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml']
 for suite in suites:argv+=['--test',suite]
 d,r=invoke('focused-suites',argv+['--','--nocapture']);receipts.append(r)
 for name in ['source::','cli::replacement_tests','lsp::uri::']:
  u,ur=invoke('unit-'+name.replace(':','-'),['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml','--lib',name,'--','--nocapture']);receipts.append(ur)
 save('execution.json',{'host':platform.platform(),'machine':platform.machine(),'commands':receipts,'libraries':[{'path':p,'sha256':digest(pathlib.Path(p))} for p in libs],'suite_exit':d.returncode,'scope':'Native host only; selected suites and bounded witnesses. Temporary executables removed; recipe retained.'})
 print(json.dumps({'cases':len(observations),'mismatches':[o['id'] for o in observations if any(not a['pass'] for a in o['assertions'])],'suite_exit':d.returncode}))
if __name__=='__main__':main()
