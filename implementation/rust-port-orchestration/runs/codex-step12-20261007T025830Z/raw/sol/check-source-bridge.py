import hashlib,json,pathlib
repo=pathlib.Path('/Users/vince/Projects/canlang')
root=repo/'implementation/rust-port-orchestration/runs'
private=pathlib.Path('/private/tmp/canlang-rust-port-codex-step12-20261007T025830Z/sol')
hash_file=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
rows=[]
step11=json.loads((root/'codex-step11-20261007T024618Z/source-equivalence.json').read_text())
for r in step11['checks']:
 p=r['path'];expected=r['actual']
 actual=hash_file(repo/p)
 rows.append({'path':p,'prior':'step11 reviewed source','expected':expected,'current':actual,'equal':actual==expected})
pins=json.loads(pathlib.Path('/private/tmp/canlang-rust-port-codex-step9-20261007T012914Z/values/corrected/source-pins-final.json').read_text())
for p,expected in pins.items():
 if p.startswith(('packages/values/semantics/src/','packages/values/bindings/')) or p in ['packages/values/semantics/Cargo.toml','packages/values/semantics/Cargo.lock']:
  actual=hash_file(repo/p);rows.append({'path':p,'prior':'step9 corrected actual values source','expected':expected,'current':actual,'equal':actual==expected})
step8=json.loads((root/'codex-step8-20261007T005702Z/delivery-receipt.json').read_text())
for p in ['packages/cloudflare/src/runtime/modules.ts','packages/cloudflare/src/runtime/invoke.ts','packages/cloudflare/src/deploy/module-maps.ts','packages/cloudflare/src/deploy/module-imports.ts','packages/cloudflare/src/runtime/sourcemap.ts']:
 expected=step8['sourcePins'][p];actual=hash_file(repo/p);rows.append({'path':p,'prior':'step8 raw map consumer delivery source','expected':expected,'current':actual,'equal':actual==expected})
result={'base':'aca27c2d483ee1d0d6e7f514868597e109ef7ba7','checks':rows,'mismatches':[r for r in rows if not r['equal']]}
(private/'source-bridge.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'checks':len(rows),'mismatches':result['mismatches']},indent=2))
