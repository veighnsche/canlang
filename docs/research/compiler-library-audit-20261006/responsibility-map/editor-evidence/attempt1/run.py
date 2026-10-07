#!/usr/bin/env python3
"""Step11 audit command capture; writes evidence only."""
import hashlib,json,pathlib,platform,subprocess,time,tempfile,sys
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[4]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(name,value):(HERE/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
def invoke(name,argv,cwd=ROOT,env=None,stdin=None,timeout=120):
 start=time.time();d=subprocess.run([str(a) for a in argv],cwd=cwd,env=env,input=stdin,capture_output=True,timeout=timeout)
 r={'name':name,'argv':[str(a) for a in argv],'cwd':str(cwd),'exit':d.returncode,'elapsed_seconds':round(time.time()-start,4)}
 for s in ['stdout','stderr']:
  (HERE/(name+'.'+s)).write_bytes(getattr(d,s));r[s]=name+'.'+s;r[s+'_sha256']=hashlib.sha256(getattr(d,s)).hexdigest()
 if stdin is not None:(HERE/(name+'.stdin')).write_bytes(stdin);r['stdin']=name+'.stdin';r['stdin_sha256']=hashlib.sha256(stdin).hexdigest()
 return d,r
def prepare():
 paths=subprocess.check_output(['git','ls-files','compiler'],cwd=ROOT,text=True).splitlines()
 paths+=['AGENTS.md','docs/specification/GRAMMAR.md','implementation/DIAGNOSTICS.md','editors/vscode/src/client.ts','editors/vscode/src/extension.ts','editors/vscode/package.json','editors/vscode/README.md','editors/vscode/test/server-startup.cjs','editors/vscode/test/lsp-capabilities.cjs','packages/values/dist/catalog.json','docs/research/compiler-library-audit-20261006/model-allocation-20261007.md']
 save('inputs.json',{'scope':'Step11 bounded editor/compiler state/lifecycle audit; no implementation','head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'compiler_source_commit':subprocess.check_output(['git','log','-1','--format=%H','--','compiler'],cwd=ROOT,text=True).strip(),'initial_git_status':subprocess.check_output(['git','status','--short'],cwd=ROOT,text=True),'host':platform.platform(),'machine':platform.machine(),'allocation':{'server':'reused gpt-6.1-sol medium','client':'reused gpt-6.1-sol medium','root':'execution/resource/ledger; no escalation'},'pins':[{'path':p,'sha256':digest(ROOT/p),'bytes':(ROOT/p).stat().st_size} for p in paths]})
 print('Pinned compiler, actual client, catalog and tool allocation inputs.')
def main():
 if '--prepare' in sys.argv:prepare();return
 receipts=[]
 for name,argv in [('rustc-version',['rustc','-Vv']),('cargo-version',['cargo','-V']),('node-version',['node','--version'])]:
  d,r=invoke(name,argv);receipts.append(r);assert d.returncode==0
 d,r=invoke('fresh-build',['cargo','build','--locked','--offline','--manifest-path','compiler/Cargo.toml','--lib','--bin','can','--message-format=json']);receipts.append(r);assert d.returncode==0
 reported=[json.loads(l) for l in d.stdout.splitlines() if l.startswith(b'{')]
 def rlib(name):return next(f for a in reported if a.get('reason')=='compiler-artifact' and a['target']['name']==name for f in a['filenames'] if f.endswith('.rlib'))
 libs=[rlib('canlang_compiler'),rlib('serde_json')]
 with tempfile.TemporaryDirectory(prefix='can-step11-') as t:
  exe=pathlib.Path(t)/'probe'
  d,r=invoke('compile-probe',['rustc','--edition=2024',HERE/'probe.rs','--extern','canlang_compiler='+libs[0],'--extern','serde_json='+libs[1],'-L','dependency='+str(ROOT/'compiler/target/debug/deps'),'-o',exe]);receipts.append(r);assert d.returncode==0
  for mode in ['batch','retention']:
   d,r=invoke('public-'+mode,[exe,mode]);receipts.append(r);assert d.returncode==0
 d,r=invoke('focused-suites',['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml','--test','ide','--test','authoring','--test','lsp_admission','--test','lsp_typed_output','--test','b3_authoring_join','--test','b3_s4','--','--nocapture']);receipts.append(r)
 d2,r2=invoke('lsp-unit',['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml','--lib','lsp::','--','--nocapture']);receipts.append(r2)
 save('execution.json',{'commands':receipts,'libraries':[{'path':p,'sha256':digest(pathlib.Path(p))} for p in libs],'binary':{'path':'compiler/target/debug/can','sha256':digest(ROOT/'compiler/target/debug/can')},'suite_exit':d.returncode,'unit_exit':d2.returncode,'scope':'Native host; public Server queue/retention observers and selected suites, not GUI or universal workload benchmark'})
 print(json.dumps({'suite_exit':d.returncode,'unit_exit':d2.returncode}))
if __name__=='__main__':main()
