import pathlib, shutil, hashlib, json, datetime, subprocess
root=pathlib.Path('/Users/vince/Projects/canlang')
out=root/'docs/research/compiler-library-audit-20261006/pass9/profile'
snapshot=pathlib.Path('/private/tmp/canlang-pass9-profile/current')
if snapshot.exists(): raise SystemExit('Refuse to replace existing snapshot')
paths=[]
for path in (root/'compiler').rglob('*'):
    rel=path.relative_to(root)
    if path.is_file() and not any(x in {'target','.git','.DS_Store'} for x in rel.parts): paths.append(rel)
paths.extend(map(pathlib.Path,['examples/ExpenseFlow.can','examples/TeamTasks.can','editors/vscode/test/lsp-capabilities.can','editors/vscode/test/lsp-codeaction.can','docs/research/compiler-library-audit-20261006/pass3/url/vectors.json']))
manifest={}
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
for rel in sorted(paths):
    dest=snapshot/rel; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(root/rel,dest)
    data=dest.read_bytes(); manifest[str(rel)]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
end=datetime.datetime.now(datetime.timezone.utc).isoformat()
(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(out/'snapshot.json').write_text(json.dumps({'started_at':start,'completed_at':end,'snapshot':str(snapshot),'source_root':str(root),'source_count':len(manifest),'source_bytes':sum(v['bytes'] for v in manifest.values()),'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'excluded':['compiler/target','.git','.DS_Store','full packages','full editor'],'extra_fixtures':[str(p) for p in paths if p.parts[0]!='compiler']},indent=2)+'\n')
for name in ['Cargo.toml','Cargo.lock']: shutil.copy2(snapshot/'compiler'/name,out/(name+'.txt'))
print((out/'snapshot.json').read_text())
