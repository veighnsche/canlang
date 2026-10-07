#!/usr/bin/env python3
"""Finite C09C process contracts, no package installation/service calls."""
import hashlib,json,os,pathlib,subprocess
ROOT=pathlib.Path('/Users/vince/Projects/canlang')
OUT=ROOT/'docs/research/compiler-library-audit-20261006/pass9/cli'
TMP=pathlib.Path('/private/tmp/canlang-pass9-cli');TMP.mkdir(exist_ok=True)
BIN=ROOT/'compiler/target/debug/can'
fake=TMP/'platform.py';fake.write_text('#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps(sys.argv[1:],ensure_ascii=False),flush=True)\nprint("fixture stderr",file=sys.stderr)\nif os.environ.get("FIXTURE_SIGNAL"): os.kill(os.getpid(),15)\nsys.exit(int(os.environ.get("FIXTURE_EXIT","0")))\n');fake.chmod(0o755)
bad=TMP/'bad.can';bad.write_text('???\n')
# Expectations fixed from exe.rs/help aliases, cli module output convention,
# command-help passthrough and catalog explicit override owner. Edge precedence
# without an independent declarative promise is characterized separately below.
cases=[]
def add(args,code,stderr='',stdout=None,env=None): cases.append((args,code,stderr,stdout,env or {}))
for args in [[],['--help'],['-h'],['help'],['--help','--help'],['--help','--version']]:add(args,0,stdout='can 0.1.0')
for cmd in ['compile','check','lint','fmt','explain','lsp','policy','docs','completions','help']:
 add([cmd,'--help'],0,stdout='can '+cmd)
for cmd in ['run','test','build','deploy','activate']:
 add(['help',cmd],0,stdout='can '+cmd)
 add(['--help',cmd],0,stdout='can '+cmd)
 for tail in [['--help'],['--format=json','--catalog','A','--','--help','two words',''],['--','--artifact','x','--','-h']]:add([cmd]+tail,0,'fixture stderr',json.dumps([cmd]+tail,ensure_ascii=False))
for args,msg in [(['frobnicate'],'unknown command'),(['frobnicate','--help'],'unknown command'),(['check','--wat'],'unknown flag'),(['completions'],'expects exactly one'),(['completions','powershell'],'unknown shell'),(['completions','bash','fish'],'expects exactly one'),(['help','check','fmt'],'expects at most one'),(['lsp','--format=json'],'takes no --format'),(['--format=json','run','--help'],'takes no can-side flags'),(['check','--','--help'],"cannot read '--help'"),(['--','--help'],'unknown command'),(['check',str(TMP/'missing.can')],'cannot read'),(['explain','NOPE'],'unknown diagnostic')]:add(args,2,msg)
add(['run','--artifact','x'],7,'fixture stderr',json.dumps(['run','--artifact','x']),{'FIXTURE_EXIT':'7'})
add(['run'],2,'fixture stderr',json.dumps(['run']),{'FIXTURE_SIGNAL':'1'})
add(['run'],2,'E7004',env={'CAN_PLATFORM_BIN':str(TMP/'nonexistent')})
add(['check','--format=text','--format=json',str(bad)],10,stdout='{')
add(['check','--format=json','--format=text',str(bad)],10,stdout=str(bad)+':')
catalog=ROOT/'packages/values/dist/catalog.json'
add(['check','--catalog='+str(TMP/'absent.json'),'--catalog',str(catalog),'--format=json',str(bad)],10,stdout='{')
results=[]
for args,code,err,out,extra in cases:
 env=dict(os.environ,CAN_PLATFORM_BIN=str(fake));env.update(extra)
 p=subprocess.run([str(BIN)]+args,capture_output=True,text=True,env=env,timeout=5,cwd=ROOT)
 checks={'exit':p.returncode==code,'stderr':err in p.stderr if err else p.stderr=='','stdout':out in p.stdout if out is not None else p.stdout==''}
 if '--catalog='+str(TMP/'absent.json') in args: checks['last_catalog_loaded']='E6002' not in p.stdout
 results.append(dict(argv=args,expected=dict(exit=code,stderr_contains=err,stdout_contains=out),exit=p.returncode,stdout=p.stdout,stderr=p.stderr,checks=checks))
# Characterization rather than an independently specified precedence policy.
character=[]
for args in [['check','--help','--format=wat'],['check','--format=wat','--help'],['check','--help','--wat'],['check','--wat','--help'],['check','--help','--format'],['check','--help','--fix'],['fmt','--help','--format=json'],['help','--format=json','check'],['check','--catalog','--help'],['check','--catalog=','--help'],['--version','frobnicate']]:
 p=subprocess.run([str(BIN)]+args,capture_output=True,text=True,timeout=5,cwd=ROOT)
 character.append(dict(argv=args,exit=p.returncode,stdout=p.stdout,stderr=p.stderr))
completion=[]
for shell in ['bash','zsh','fish']:
 p=subprocess.run([str(BIN),'completions',shell],capture_output=True,timeout=5)
 completion.append(dict(shell=shell,exit=p.returncode,stderr=p.stderr.decode(),exact_shipped_bytes=p.stdout==(ROOT/f'compiler/can-completions.{shell}').read_bytes(),bytes=len(p.stdout)))
report=dict(binary_sha256=hashlib.sha256(BIN.read_bytes()).hexdigest(),cases=results,characterization=character,completion_bytes=completion)
(OUT/'process-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'cases':len(results),'failed':[r for r in results if not all(r['checks'].values())],'completion':completion},indent=2))
