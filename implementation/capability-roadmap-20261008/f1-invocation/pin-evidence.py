from pathlib import Path
import hashlib,json,os,subprocess
out=Path(__file__).resolve().parent
frozen=Path('/private/tmp/canlang-roadmap-f1-db57c379')
main=Path('/Users/vince/Projects/canlang')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
packages=['contracts','values','state','identity','stdlib','ui','cloudflare']
source_outputs={}
for name in packages:
 for p in sorted((frozen/'packages'/name).rglob('*')):
  if p.is_file() and 'node_modules' not in p.relative_to(frozen/'packages'/name).parts:source_outputs[str(p)]=sha(p)
private_outputs={}
for base in Path('/private/tmp').glob('canlang-f1-invocation*'):
 if base.is_dir():
  for p in sorted(base.rglob('*')):
   if p.is_file() and not p.is_symlink():private_outputs[str(p)]=sha(p)
links={}
for base in [frozen/'node_modules',*[frozen/'packages'/name/'node_modules' for name in packages]]:
 if not base.exists():continue
 for p in base.rglob('*'):
  if p.is_symlink():links[str(p)]=str(p.resolve())
# Pin external installed package files and transitive runtime dependencies.
queue=[]
for name in ['miniflare','es-module-lexer','typescript','csv-parse','decimal.js']:
 choices=[main/'packages/cloudflare/node_modules'/name,main/'packages/ui/node_modules'/name,main/'packages/values/node_modules'/name,main/'node_modules'/name]
 queue += [next(p.resolve() for p in choices if p.exists())]
external={};seen=set();missing=[]
while queue:
 package=queue.pop()
 if package in seen:continue
 seen.add(package)
 manifest=package/'package.json'
 if not manifest.exists():continue
 data=json.loads(manifest.read_text())
 for directory,dirs,files in os.walk(package):
  dirs[:]=[d for d in dirs if d!='node_modules']
  for name in files:
   p=Path(directory)/name
   if p.is_file():external[str(p.resolve())]=sha(p)
 for name in set(data.get('dependencies',{}))|set(data.get('optionalDependencies',{})):
  candidate=None
  for parent in package.parents:
   p=parent/'node_modules'/name
   if p.exists():candidate=p.resolve();break
  if candidate is not None:queue.append(candidate)
  elif name in data.get('dependencies',{}):missing.append({'package':str(package),'dependency':name})
metadata=out.parent/'f1-metadata/pins.json'
evidence={str(p):sha(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name!='pins.json'}
versions={k:subprocess.check_output(cmd,text=True).strip() for k,cmd in {'node':['node','--version'],'typescript':['node',str(main/'node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc'),'--version']}.items()}
pins={'source_pin':'db57c3794d386fcd27f17f54b199272d58106a81','draft_pin':'a55a0f700f07f6f972d9d6091b0fdbceee399eb9','metadata_pins':{'path':str(metadata),'sha256':sha(metadata)},'compiler_binary':{'path':'/private/tmp/canlang-f1-metadata-target/debug/can','sha256':sha(Path('/private/tmp/canlang-f1-metadata-target/debug/can'))},'source_and_outputs':source_outputs,'private_outputs':private_outputs,'external_packages':sorted(map(str,seen)),'external_tooling':external,'unresolved_required_external_dependencies':missing,'workspace_links':links,'evidence':evidence,'versions':versions,'ownership':'Only f1-invocation evidence and private frozen build/runtime outputs changed; no product source, shared Git, DECISIONS or living-filetree changes.'}
(out/'pins.json').write_text(json.dumps(pins,indent=2)+'\n')
print(json.dumps({'source_and_outputs':len(source_outputs),'private_outputs':len(private_outputs),'external_tooling':len(external),'external_packages':len(seen),'evidence':len(evidence),'unresolved_required_external_dependencies':missing},indent=2))
