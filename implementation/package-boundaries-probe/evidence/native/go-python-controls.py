#!/usr/bin/env python3
"""Optional synthetic metadata-only Go/uv controls; no project or tool upgrades."""
from pathlib import Path
exec(Path(__file__).with_name('named-control.py').read_text().split("run('named-ls'")[0])
E.update({'GOTOOLCHAIN':'local','GOPROXY':'off','GOSUMDB':'off','GOCACHE':str(B/'go-cache'),'GOMODCACHE':str(B/'go-mod-cache'),'UV_OFFLINE':'true','UV_PYTHON_DOWNLOADS':'never','UV_CACHE_DIR':str(B/'uv-cache')})
def fixture(name,flag):
 d=B/name;d.mkdir(exist_ok=True)
 (d/'package.json').write_text(json.dumps({'name':name,'private':True,'packageManager':'bun@1.4.2','workspaces':['packages/*']},indent=2)+'\n')
 (d/'bun.lock').write_text(json.dumps({'lockfileVersion':1,'configVersion':1,'workspaces':{'':{'name':name}},'packages':{}},indent=2)+'\n')
 (d/'turbo.json').write_text(json.dumps({'futureFlags':{flag:True},'tasks':{'build':{'dependsOn':['^build']},'check':{},'test':{}}},indent=2)+'\n')
 return d
G=fixture('go-control','experimentalGoWorkspaces')
(G/'go.work').write_text('go 1.27.1\n\nuse (\n ./go/core\n ./go/app\n)\n')
for name in ['core','app']:(G/'go'/name).mkdir(parents=True,exist_ok=True)
(G/'go/core/go.mod').write_text('module example.test/probe/core\n\ngo 1.27.1\n')
(G/'go/core/core.go').write_text('package core\nfunc Answer() int { return 42 }\n')
(G/'go/app/go.mod').write_text('module example.test/probe/app\n\ngo 1.27.1\n\nrequire example.test/probe/core v0.0.0\n')
(G/'go/app/main.go').write_text('package main\nimport "example.test/probe/core"\nfunc main() { println(core.Answer()) }\n')
P=fixture('python-control','experimentalPythonWorkspaces')
(P/'pyproject.toml').write_text('[project]\nname="probe-python-root"\nversion="0.1.0"\nrequires-python=">=3.11"\n\n[tool.uv.workspace]\nmembers=["py/core","py/app"]\n')
for name in ['core','app']:(P/'py'/name).mkdir(parents=True,exist_ok=True)
(P/'py/core/pyproject.toml').write_text('[project]\nname="probe-python-core"\nversion="0.1.0"\nrequires-python=">=3.11"\n')
(P/'py/app/pyproject.toml').write_text('[project]\nname="probe-python-app"\nversion="0.1.0"\nrequires-python=">=3.11"\ndependencies=["probe-python-core"]\n\n[tool.uv.sources]\nprobe-python-core={workspace=true}\n')
# Intercept Go/uv calls to record exact Turbo tool usage. Offline settings above
# constrain tool behavior without replacing its semantics or version.
W=B/'language-wrappers';W.mkdir(exist_ok=True)
for tool in ['go','uv']:
 real=shutil.which(tool)
 if not real:continue
 wrapper=W/tool
 wrapper.write_text(f'''#!/usr/bin/env python3\nimport os,sys,json\nwith open({str(B/'language-calls.jsonl')!r},'a') as f:f.write(json.dumps({{'tool':{tool!r},'argv':sys.argv[1:]}})+'\\n')\nos.execv({real!r},[{real!r}]+sys.argv[1:])\n''');wrapper.chmod(0o755)
 # run() adds cargo wrapper path ahead of E but replaces other PATH entries from
 # os.environ; add our explicit language wrapper to process environment too.
os.environ['PATH']=str(W)+':'+os.environ['PATH']
for name,d in [('go',G),('python',P)]:
 run(name+'-ls',['ls','--output=json'],cwd=d)
 run(name+'-build-dry',['run','build','--dry-run=json'],cwd=d)
 run(name+'-check-dry',['run','check','--dry-run=json'],cwd=d)
 for f in d.rglob('*'):
  if f.is_file() and '.turbo' not in f.parts and '.venv' not in f.parts:
   dest=R/'fixtures'/d.name/f.relative_to(d);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,dest)
for tool,args in [('go',['version']),('uv',['--version'])]:
 real=shutil.which(tool)
 if real:
  r=subprocess.run([real,*args],env=E,text=True,capture_output=True,timeout=20)
  (R/(tool+'-version.json')).write_text(json.dumps({'argv':[real,*args],'cwd':str(B),'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2)+'\n')
if (B/'language-calls.jsonl').exists():shutil.copy2(B/'language-calls.jsonl',R/'language-calls.jsonl')
