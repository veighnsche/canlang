from pathlib import Path
import json,hashlib,tarfile,shutil,platform,subprocess
root=Path('/Users/vince/Projects/canlang');out=root/'docs/research/compiler-library-audit-20261006/pass10/consumers';temp=Path('/private/tmp/canlang-pass10-consumers');install=temp/'installed'
digest=lambda x:hashlib.sha256(x).hexdigest()
pre=json.loads((out/'pre-pins.json').read_text());post={p:digest((root/p).read_bytes()) for p in pre};drift={p:{'before':pre[p],'after':post[p]} for p in pre if pre[p]!=post[p]};assert not drift,drift
manifest=json.loads((root/'output/release-artifacts/manifest.json').read_text());verified=[]
for p in manifest['packages']:
 tar=temp/'tarballs'/p['tarball'];assert digest(tar.read_bytes())==p['sha256'];owner=(install/'node_modules'/p['name']).resolve();assert owner.is_relative_to(install) and not owner.is_relative_to(root);files={}
 with tarfile.open(tar) as t:
  for member in t.getmembers():
   if not member.isfile():continue
   relative=Path(member.name).relative_to('package');file=(owner/relative).resolve();assert file.is_relative_to(install);expected=t.extractfile(member).read();assert file.read_bytes()==expected,(p['name'],relative);files[str(relative)]=digest(expected)
 verified.append({'name':p['name'],'tarballSha256':p['sha256'],'ownerRealpath':str(owner),'verifiedFileCount':len(files),'files':files})
for file in install.rglob('*'):
 if file.is_symlink():assert file.resolve().is_relative_to(install),(file,file.resolve())
(out/'installed-provenance.json').write_text(json.dumps(verified,indent=2)+'\n');(out/'post-pins.json').write_text(json.dumps(post,indent=2)+'\n')
(out/'artifacts').mkdir(exist_ok=True)
for name in ['wire.can','bad.can','artifact.json']:shutil.copy2(temp/name,out/'artifacts'/name)
for mode in ['current','installed']:
 dest=out/'artifacts'/f'{mode}-emitted';shutil.copytree(temp/f'{mode}-emitted',dest,dirs_exist_ok=True)
binary=Path('/private/tmp/canlang-pass10-profile/release/can');assert digest(binary.read_bytes())=='6405484cb6156faf26f3efc3a32e57cb193b662581c61995842d78f41baa3c4f'
receipt={'sourceFrozenByRoot':'db495c6','productionBuildGit':'aca27c2d483ee1d0d6e7f514868597e109ef7ba7','binary':str(binary),'binarySha256':digest(binary.read_bytes()),'binaryBytes':binary.stat().st_size,'host':platform.platform(),'tools':{tool:subprocess.check_output([tool,'--version']).decode().strip() for tool in ['node','bun','python3']},'inputDrift':drift,'originalApp':{'unchanged':True,'exit':10,'completeDiagnostics':True,'codes':['E3001','E3010','E3010'],'parentsRemainOpen':['T02','T37','FP.QUALIFY']},'installed':{'packageTarballs':len(verified),'installedFilesMatchedTarballs':sum(v['verifiedFileCount'] for v in verified),'offline':True,'ignoreScripts':True,'linker':'isolated','checkoutRead':'ERR_ACCESS_DENIED','parentRemainsOpen':'FP.INSTALLED-RELEASE','cache':'read-only existing Bun cache cloned into tasklocal cache; no network, global installs or package rebuild'},'scope':'direct final process, actual complete frontend artifact, emitted import/canApp/defaults and real refused generated handler + mapper/testkit; no synthetic artifact, no app workflow/browser/Worker qualification'}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'drift':drift,'verifiedInstalledFiles':receipt['installed']['installedFilesMatchedTarballs']}))
