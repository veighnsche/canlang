import json, shutil, subprocess, hashlib, datetime
from pathlib import Path
repo=Path('/Users/vince/Projects/canlang')
old=Path('/private/tmp/canlang-rust-port-codex-step10-20261007T015711Z/source')
private=Path('/private/tmp/canlang-rust-port-codex-step11-20261007T024618Z')
new=private/'source';new.mkdir(exist_ok=True)
run=repo/'implementation/rust-port-orchestration/runs/codex-step11-20261007T024618Z'
for f in ['package.json','tsconfig.base.json','vitest.config.ts']: shutil.copy2(old/f,new/f)
(new/'packages').mkdir(exist_ok=True)
for f in (old/'packages').iterdir():
 if f.name!='cloudflare': (new/'packages'/f.name).symlink_to(f.resolve(),target_is_directory=True)
pkg=new/'packages/cloudflare';pkg.mkdir()
for f in ['src','dist']: shutil.copytree(old/'packages/cloudflare'/f,pkg/f)
shutil.copy2(repo/'packages/cloudflare/src/deploy/bundle.ts',pkg/'src/deploy/bundle.ts')
for f in ['package.json','tsconfig.json']: shutil.copy2(repo/'packages/cloudflare'/f,pkg/f)
(pkg/'test').mkdir();shutil.copy2(repo/'packages/cloudflare/test/deploy-bundle.test.ts',pkg/'test/deploy-bundle.test.ts')
# Own mutable outputs, borrow compatible accepted dependencies through read-only links.
nm=new/'node_modules';nm.mkdir()
for dependency_root in [old/'node_modules', old/'packages/cloudflare/node_modules']:
 for f in dependency_root.iterdir():
  if f.name in ['.cache','.vite']: continue
  if f.name.startswith('@') and f.is_dir():
   scope=nm/f.name;scope.mkdir(exist_ok=True)
   for g in f.iterdir():
    link=scope/g.name
    if link.exists() or link.is_symlink(): continue
    link.symlink_to(pkg if f.name=='@canlang' and g.name=='cloudflare' else g.resolve(),target_is_directory=g.is_dir())
  else:
   link=nm/f.name
   if not link.exists() and not link.is_symlink():link.symlink_to(f.resolve(),target_is_directory=f.is_dir())
(pkg/'node_modules').symlink_to(nm,target_is_directory=True)
# Recheck exact accepted byte identities rather than rerunning unrelated unchanged suites.
pins=json.loads((repo/'implementation/rust-port-orchestration/runs/codex-step10-20261007T015711Z/accepted-source-pins.json').read_text())['files']
checks=[]
for path,expected in pins.items():
 actual=hashlib.sha256((repo/path).read_bytes()).hexdigest()
 checks.append(dict(path=path,expected=expected,actual=actual,equal=actual==expected,changed_here=path=='packages/cloudflare/src/deploy/bundle.ts'))
assert all(x['equal'] or x['changed_here'] for x in checks)
source_refs={
 'packages/values/semantics/src/representations/numeric.rs':'a34aa16',
 'packages/values/semantics/src/codecs/numeric.rs':'36df46e',
 'packages/work-kernel/decisions/numeric_text.rs':'5a4e827',
 'packages/cloudflare/src/deploy/module-imports.ts':'324d624',
 'packages/cloudflare/src/deploy/module-maps.ts':'324d624',
 'packages/cloudflare/src/runtime/sourcemap.ts':'324d624',
 'packages/cloudflare/src/runtime/invoke.ts':'2552e7ba',
 'packages/values/bindings/backend.ts':'5a9c768',
 'packages/interfaces/src/http/export.ts':'2552e7ba',
}
for path,ref in source_refs.items():
 expected=hashlib.sha256(subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=repo)).hexdigest()
 actual=hashlib.sha256((repo/path).read_bytes()).hexdigest()
 checks.append(dict(path=path,reference=ref,expected=expected,actual=actual,equal=actual==expected))
assert all(x['equal'] or x.get('changed_here') for x in checks)
(run/'source-equivalence.json').write_text(json.dumps({'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,'unchanged_pins':sum(x['equal'] for x in checks),'only_changed_file':'packages/cloudflare/src/deploy/bundle.ts','claim':'Exact unchanged source/fixture scope only; changed bundler needs renewed focused checks'},indent=2)+'\n')
print(json.dumps({'private_source':str(new),'source_equivalence_checks':len(checks),'unchanged':sum(x['equal'] for x in checks)}))
