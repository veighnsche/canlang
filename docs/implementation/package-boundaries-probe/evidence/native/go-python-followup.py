#!/usr/bin/env python3
from pathlib import Path
exec(Path(__file__).with_name('named-control.py').read_text().split("run('named-ls'")[0])
E.update({'GOTOOLCHAIN':'local','GOPROXY':'off','GOSUMDB':'off','GOCACHE':str(B/'go-cache'),'GOMODCACHE':str(B/'go-mod-cache'),'UV_OFFLINE':'true','UV_PYTHON_DOWNLOADS':'never','UV_CACHE_DIR':str(B/'uv-cache')})
os.environ['PATH']=str(B/'language-wrappers')+':'+os.environ['PATH']
G=B/'go-local-replace-control';shutil.copytree(B/'go-control',G,dirs_exist_ok=True)
with (G/'go/app/go.mod').open('a') as f:f.write('\nreplace example.test/probe/core => ../core\n')
P=B/'python-named-control';shutil.copytree(B/'python-control',P,dirs_exist_ok=True)
with (P/'pyproject.toml').open('a') as f:f.write('\n[tool.turbo]\nname="probe-python-workspace"\n')
for name,d in [('go-local',G),('python-named',P)]:
 run(name+'-ls',['ls','--output=json'],cwd=d)
 run(name+'-build-dry',['run','build','--dry-run=json'],cwd=d)
 run(name+'-check-dry',['run','check','--dry-run=json'],cwd=d)
 for f in d.rglob('*'):
  if f.is_file() and '.turbo' not in f.parts and '.venv' not in f.parts:
   dest=R/'fixtures'/d.name/f.relative_to(d);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,dest)
if (B/'language-calls.jsonl').exists():shutil.copy2(B/'language-calls.jsonl',R/'language-calls.jsonl')
