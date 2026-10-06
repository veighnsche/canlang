#!/usr/bin/env python3
"""Metadata-only Turbo 2.11.x native discovery probe; never builds project code."""
import json, os, pathlib, shutil, subprocess, time, hashlib
ROOT=pathlib.Path('/Users/vince/Projects/canlang')
BASE=pathlib.Path('/private/tmp/canlang-turbo-probe-20261006.89738Q/native')
EVID=ROOT/'implementation/package-boundaries-probe/evidence/native'
TURBO=BASE.parent/'tooling/node_modules/.bin/turbo'
BASE.mkdir(parents=True,exist_ok=True)
EVID.mkdir(parents=True,exist_ok=True)
ENV={k:v for k,v in os.environ.items() if not k.startswith(('TURBO_TOKEN','TURBO_TEAM','VERCEL','TYPESAFE'))}
ENV.update({'TURBO_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1','TURBO_NO_UPDATE_NOTIFIER':'1','RUSTUP_AUTO_INSTALL':'0','CARGO_NET_OFFLINE':'true'})
# Persist configurations and fixture source, excluding derived tool outputs.
def write(p,text):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
def jsonwrite(p,obj):write(p,json.dumps(obj,indent=2)+'\n')
def record(name,argv,cwd,env=ENV):
 start=time.time()
 try:
  result=subprocess.run([str(x) for x in argv],cwd=cwd,env=env,text=True,capture_output=True,timeout=45)
  output={'argv':[str(x) for x in argv],'cwd':str(cwd),'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'seconds':round(time.time()-start,3)}
 except subprocess.TimeoutExpired as e:
  output={'argv':[str(x) for x in argv],'cwd':str(cwd),'exit':None,'timeout':45,'stdout':str(e.stdout or ''),'stderr':str(e.stderr or '')}
 jsonwrite(EVID/(name+'.json'),output)
 print(name,output['exit'],output['stderr'][:240],flush=True)
 return output
for command in [[],['ls'],['query'],['run']]:record('help-'+('-'.join(command) or 'main'),[TURBO,*command,'--help'],BASE)
record('version',[TURBO,'--version'],BASE)
schema=BASE.parent/'tooling/node_modules/turbo/schema.json'
shutil.copy2(schema,EVID/'installed-schema.json')
jsonwrite(EVID/'tool.json',{'turbo_package':json.loads((schema.parent/'package.json').read_text()),'schema_sha256':hashlib.sha256(schema.read_bytes()).hexdigest()})
actual=BASE/'actual'
files=subprocess.check_output(['git','ls-files','-z','packages','compiler'],cwd=ROOT).decode().split('\0')
files+=[x for x in ['package.json','bun.lock','tsconfig.base.json','tsconfig.check.json','vitest.config.ts','playwright.config.ts'] if (ROOT/x).exists()]
copied=[]
for rel in files:
 if not rel or not (ROOT/rel).is_file():continue
 if any(x in pathlib.Path(rel).parts for x in ('target','node_modules','dist')):continue
 dest=actual/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/rel,dest);copied.append(rel)
jsonwrite(EVID/'actual-copy.json',{'source_root':str(ROOT),'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'files':copied,'no_root_cargo':not (actual/'Cargo.toml').exists(),'omits':['target','node_modules','dist'],'includes_tracked_generated_bindings':True})
config={'futureFlags':{'experimentalCargoWorkspaces':True},'tasks':{'build':{'dependsOn':['^build']},'check':{},'test':{}}}
jsonwrite(actual/'turbo.json',config);shutil.copy2(actual/'turbo.json',EVID/'actual-turbo.json')
# Cargo wrappers alter only subprocess metadata resolution, never global config/toolchains.
cargo=shutil.which('cargo')
for mode in ['offline','denied']:
 wrapper=BASE/'wrappers'/mode/'cargo'
 if mode=='offline':
  body=f'''#!/usr/bin/env python3\nimport json,os,sys\nwith open({str(BASE/'cargo-calls.jsonl')!r},'a') as f:f.write(json.dumps({{'mode':'offline','argv':sys.argv[1:]}})+'\\n')\nargs=sys.argv[1:]\nif 'metadata' in args and '--offline' not in args:args.append('--offline')\nos.execv({cargo!r},[{cargo!r}]+args)\n'''
 else:body=f'''#!/usr/bin/env python3\nimport json,sys\nwith open({str(BASE/'cargo-calls.jsonl')!r},'a') as f:f.write(json.dumps({{'mode':'denied','argv':sys.argv[1:]}})+'\\n')\nprint('controlled probe: cargo unavailable',file=sys.stderr)\nsys.exit(127)\n'''
 write(wrapper,body);wrapper.chmod(0o755);shutil.copy2(wrapper,EVID/f'cargo-{mode}.py')
def wrapenv(mode):return {**ENV,'PATH':str(BASE/'wrappers'/mode)+':'+ENV['PATH']}
def inspect(label,path):
 env=wrapenv('offline')
 record(label+'-ls',[TURBO,'ls','--output=json','--no-update-notifier'],path,env)
 record(label+'-build-dry',[TURBO,'run','build','--dry-run=json','--no-update-notifier'],path,env)
 record(label+'-check-dry',[TURBO,'run','check','--dry-run=json','--no-update-notifier'],path,env)
inspect('actual',actual)
record('actual-ts-only-cargo-denied',[TURBO,'run','build','--filter=@canlang/contracts','--dry-run=json','--no-update-notifier'],actual,wrapenv('denied'))
record('actual-native-filter',[TURBO,'run','check','--filter=canlang-compiler','--dry-run=json','--no-update-notifier'],actual,wrapenv('offline'))
# Synthetic controls: root workspace/member dependency/dual JS+Cargo owner.
control=BASE/'root-control'
jsonwrite(control/'package.json',{'name':'native-probe-root','private':True,'packageManager':'bun@1.4.2','workspaces':['packages/*']})
write(control/'bun.lock','{"lockfileVersion": 1,"configVersion": 1,"workspaces": {"": {"name": "native-probe-root"}, "packages/dual": {"name": "@probe/dual", "version": "0.0.0"}, "packages/js": {"name": "@probe/js", "version": "0.0.0"}}, "packages": {}}\n')
jsonwrite(control/'turbo.json',config)
write(control/'Cargo.toml','[workspace]\nmembers=["crates/core","crates/app","packages/dual"]\nresolver="2"\n')
write(control/'crates/core/Cargo.toml','[package]\nname="probe-core"\nversion="0.1.0"\nedition="2021"\n')
write(control/'crates/core/src/lib.rs','pub fn answer()->u32{42}\n')
write(control/'crates/app/Cargo.toml','[package]\nname="probe-app"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nprobe-core={path="../core"}\n')
write(control/'crates/app/src/main.rs','fn main(){println!("{}",probe_core::answer());}\n')
write(control/'packages/dual/Cargo.toml','[package]\nname="probe-dual"\nversion="0.1.0"\nedition="2021"\n')
write(control/'packages/dual/src/lib.rs','pub const VERSION:u32=1;\n')
jsonwrite(control/'packages/dual/package.json',{'name':'@probe/dual','version':'0.0.0','scripts':{'build':'node -e "console.log(\'JS dual build\')"'}})
jsonwrite(control/'packages/js/package.json',{'name':'@probe/js','version':'0.0.0','scripts':{'build':'node -e "console.log(\'JS build\')"'}})
record('control-cargo-metadata',[cargo,'metadata','--offline','--format-version=1','--manifest-path',control/'Cargo.toml'],control,ENV)
inspect('control',control)
for name,filter,mode in [('ts-only','@probe/js','denied'),('native-app','probe-app','offline'),('dual-js','@probe/dual','offline'),('dual-cargo','probe-dual','offline')]:
 record('control-'+name,[TURBO,'run','build','--filter='+filter,'--dry-run=json','--no-update-notifier'],control,wrapenv(mode))
# Same complete control layout without the root manifest; root package/bun unchanged.
nested=BASE/'nested-control';shutil.copytree(control,nested,dirs_exist_ok=True)
(nested/'Cargo.toml').unlink()
if (nested/'Cargo.lock').exists():(nested/'Cargo.lock').unlink()
inspect('nested',nested)
record('nested-ts-only-cargo-denied',[TURBO,'run','build','--filter=@probe/js','--dry-run=json','--no-update-notifier'],nested,wrapenv('denied'))
# Save fixture inputs only; no caches/target generated output.
for name,path in [('root-control',control),('nested-control',nested)]:
 for file in path.rglob('*'):
  if file.is_file() and '.turbo' not in file.parts and 'target' not in file.parts:
   dest=EVID/'fixtures'/name/file.relative_to(path);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,dest)
if (BASE/'cargo-calls.jsonl').exists():shutil.copy2(BASE/'cargo-calls.jsonl',EVID/'cargo-calls.jsonl')
