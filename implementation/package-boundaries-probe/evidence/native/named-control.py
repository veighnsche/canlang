#!/usr/bin/env python3
import pathlib,json,os,shutil,subprocess,time,hashlib
R=pathlib.Path('/Users/vince/Projects/canlang/implementation/package-boundaries-probe/evidence/native')
B=pathlib.Path('/private/tmp/canlang-turbo-probe-20261006.89738Q/native')
T=B.parent/'tooling/node_modules/.bin/turbo'
C=B/'named-control'
shutil.copytree(B/'root-control',C,dirs_exist_ok=True)
with (C/'Cargo.toml').open('a') as f:f.write('\n[workspace.metadata]\nname="probe-native-workspace"\n')
E={k:v for k,v in os.environ.items() if not k.startswith(('TURBO_TOKEN','TURBO_TEAM','VERCEL','TYPESAFE'))}
E.update({'TURBO_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1','TURBO_NO_UPDATE_NOTIFIER':'1','RUSTUP_AUTO_INSTALL':'0','CARGO_NET_OFFLINE':'true','PATH':str(B/'wrappers/offline')+':'+E['PATH']})
def run(name,args,mode='offline',binary=T,cwd=C):
 env={**E,'PATH':str(B/'wrappers'/mode)+':'+os.environ['PATH']}
 argv=[str(binary),'--skip-infer','--no-update-notifier',*args]
 start=time.time()
 try:
  r=subprocess.run(argv,cwd=cwd,env=env,text=True,capture_output=True,timeout=45)
  o={'argv':argv,'cwd':str(cwd),'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'seconds':round(time.time()-start,3)}
 except subprocess.TimeoutExpired as e:o={'argv':argv,'cwd':str(cwd),'exit':None,'timeout':45,'stdout':str(e.stdout or ''),'stderr':str(e.stderr or '')}
 (R/(name+'.json')).write_text(json.dumps(o,indent=2)+'\n');print(name,o['exit'],o['stderr'][:350],flush=True)
run('named-ls',['ls','--output=json'])
run('named-build-dry',['run','build','--dry-run=json'])
run('named-check-dry',['run','check','--dry-run=json'])
run('named-ts-only-cargo-denied',['run','build','--filter=@probe/js','--dry-run=json'],'denied')
run('named-native-app',['run','build','--filter=probe-app','--dry-run=json'])
run('named-dual-js',['run','build','--filter=@probe/dual','--dry-run=json'])
run('named-dual-cargo',['run','build','--filter=probe-dual','--dry-run=json'])
run('named-ts-only-executed',['run','build','--filter=@probe/js','--cache=local:rw'],'denied')
run('named-native-cargo-denied',['run','build','--filter=probe-app','--dry-run=json'],'denied')
run('named-workspace-check',['run','check','--filter=probe-native-workspace','--dry-run=json'])
# Compare first 2.11 release on same actual topology and named positive control.
old=B.parent/'tooling-2.11.0/node_modules/.bin/turbo'
if old.exists():
 run('old-version',['--version'],binary=old)
 run('old-actual-ls',['ls','--output=json'],binary=old,cwd=B/'actual')
 run('old-named-ls',['ls','--output=json'],binary=old)
for f in C.rglob('*'):
 if f.is_file() and '.turbo' not in f.parts and 'target' not in f.parts:
  d=R/'fixtures/named-control'/f.relative_to(C);d.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,d)
if (B/'cargo-calls.jsonl').exists():shutil.copy2(B/'cargo-calls.jsonl',R/'cargo-calls.jsonl')
