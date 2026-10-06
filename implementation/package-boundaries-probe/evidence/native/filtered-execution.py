#!/usr/bin/env python3
# Reuse runner definitions without replaying earlier recorded tests.
from pathlib import Path
exec(Path(__file__).with_name('named-control.py').read_text().split("run('named-ls'")[0])
run('named-ts-only-executed',['run','build','--filter=@probe/js','--cache=local:rw'],'denied')
run('named-native-cargo-denied',['run','build','--filter=probe-app','--dry-run=json'],'denied')
# Same-path, same-name identities distinguish path duplication from name collision.
S=B/'same-name-control';shutil.copytree(C,S,dirs_exist_ok=True)
p=S/'packages/dual/package.json';j=json.loads(p.read_text());j['name']='probe-dual';p.write_text(json.dumps(j,indent=2)+'\n')
# Refresh minimal lockfile name for this synthetic identity.
l=S/'bun.lock';l.write_text(l.read_text().replace('@probe/dual','probe-dual'))
run('same-name-ls',['ls','--output=json'],cwd=S)
run('same-name-build-dry',['run','build','--filter=probe-dual','--dry-run=json'],cwd=S)
for f in S.rglob('*'):
 if f.is_file() and '.turbo' not in f.parts and 'target' not in f.parts:
  d=R/'fixtures/same-name-control'/f.relative_to(S);d.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,d)
if (B/'cargo-calls.jsonl').exists():shutil.copy2(B/'cargo-calls.jsonl',R/'cargo-calls.jsonl')
