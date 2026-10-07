from pathlib import Path
import hashlib,json,shutil
root=Path('/Users/vince/Projects/canlang'); out=root/'docs/research/compiler-library-audit-20261006/pass10/consumers'; temp=Path('/private/tmp/canlang-pass10-consumers')
manifest=json.loads((root/'output/release-artifacts/manifest.json').read_text()); deps={}; tar=temp/'tarballs';tar.mkdir(exist_ok=True)
for p in manifest['packages']:
 src=root/'output/release-artifacts'/p['tarball']; assert hashlib.sha256(src.read_bytes()).hexdigest()==p['sha256'];shutil.copy2(src,tar/src.name);deps[p['name']]='file:'+str(tar/src.name)
consumer=temp/'installed';consumer.mkdir(exist_ok=True)
(consumer/'package.json').write_text(json.dumps({'name':'pass10-compiler-consumer','private':True,'type':'module','dependencies':deps,'overrides':deps},indent=2))
(consumer/'bunfig.toml').write_text('[install]\nlinker = "isolated"\n')
pins={}
for p in [root/'compiler/src/cli.rs',root/'compiler/src/lsp/server.rs',root/'compiler/src/codegen/artifact.rs',root/'compiler/Cargo.toml',root/'compiler/Cargo.lock',root/'packages/values/dist/catalog.json',root/'packages/cloudflare/dist/runtime/artifact.js',root/'output/release-artifacts/manifest.json',root/'docs/ideal-filetree-plan/finished-product/tasks.json',root/'tests/e2e/apps/challenge-pilot.spec.ts',root/'tests/e2e/apps/challenge-pilot-patched.spec.ts',root/'tests/e2e/apps/compiled-journey.spec.ts',root/'tests/e2e/fixtures/artifact-loader.ts',root/'draft/CanDo.can',root/'draft/shared/Locations.can',root/'draft/shared/Employees.can',root/'scripts/verify-installed-worker.mjs',root/'scripts/verify-installed-types.mjs']:
 pins[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
(out/'pre-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
(temp/'wire.can').write_text('app Shop\nGiven\n Gadget { title:text="é😀\\b\\f", stock:int=9223372036854775807, price:decimal, active:bool=true, nick:text? }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,stock,price,active,nick\nThen\n')
(temp/'bad.can').write_text('app Broken\n')
print(json.dumps({'tarballsValidated':len(deps),'pinnedInputs':len(pins),'manifestScope':manifest['scope']}))
