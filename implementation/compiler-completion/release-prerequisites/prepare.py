import pathlib,hashlib,json,shutil,tomllib,tarfile,re,urllib.request
ROOT=pathlib.Path('/Users/vince/Projects/canlang'); OUT=ROOT/'implementation/compiler-completion/release-prerequisites'; TMP=pathlib.Path('/private/tmp/canlang-dep03-release-20261008'); TMP.mkdir(exist_ok=True)
CACHE=TMP/'cargo-home/registry/cache/index.crates.io-1949cf8c6b5b557f'; CACHE.mkdir(parents=True,exist_ok=True)
if not (TMP/'cargo-home/registry/index').exists(): shutil.copytree(pathlib.Path.home()/'.cargo/registry/index',TMP/'cargo-home/registry/index')
lock=tomllib.loads((ROOT/'compiler/Cargo.lock').read_text()); rows=[]; fetch=[]
for p in lock['package']:
 if not p.get('source','').startswith('registry+'): continue
 name,ver=p['name'],p['version']; filename=f'{name}-{ver}.crate'; a=CACHE/filename
 old=pathlib.Path.home()/'.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f'/filename
 if not a.exists():
  if old.exists(): shutil.copy2(old,a)
  else:
   url=f'https://static.crates.io/crates/{name}/{filename}'
   data=urllib.request.urlopen(url,timeout=40).read(); assert hashlib.sha256(data).hexdigest()==p['checksum']; a.write_bytes(data); fetch.append({'name':name,'version':ver,'url':url,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 digest=hashlib.sha256(a.read_bytes()).hexdigest(); assert digest==p['checksum']
 with tarfile.open(a,'r:gz') as tar:
  meta=tomllib.loads(tar.extractfile(f'{name}-{ver}/Cargo.toml').read().decode())['package']; files=[]
  for m in tar:
   if m.isfile() and (re.match(r'^(?:licen[sc]e|copying|notice)(?:$|[._-])',pathlib.Path(m.name).name,re.I) or (name=='r-efi' and pathlib.Path(m.name).name=='AUTHORS')):
    data=tar.extractfile(m).read(); dest=OUT/'notices'/m.name; dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);files.append({'path':m.name,'sha256':hashlib.sha256(data).hexdigest()})
 rows.append({'name':name,'version':ver,'archive_sha256':digest,'lock_checksum':p['checksum'],'checksum_matches':True,'archive_path':str(a),'declared_license':meta.get('license'),'declared_license_file':meta.get('license-file'),'declared_rust_version':meta.get('rust-version'),'license_notice_files':sorted(files,key=lambda f:f['path'])})
(OUT/'archives.json').write_text(json.dumps({'schema':1,'fetched':fetch,'packages':rows},indent=2)+'\n')
SRC=TMP/'source/compiler'; SRC.mkdir(parents=True,exist_ok=True); pins={}
for p in sorted((ROOT/'compiler').rglob('*')):
 if p.is_file() and 'target' not in p.relative_to(ROOT/'compiler').parts and '.git' not in p.parts:
  rel=p.relative_to(ROOT); data=p.read_bytes(); pins[str(rel)]=hashlib.sha256(data).hexdigest(); dest=TMP/'source'/rel;dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(data)
for rel in ['.github/workflows/release.yml']:
 pins[rel]=hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()
(OUT/'source-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
print(json.dumps({'packages':len(rows),'verified':sum(r['checksum_matches'] for r in rows),'fetched':fetch,'notice_files':sum(len(r['license_notice_files']) for r in rows),'no_standard_notice':[f"{r['name']} {r['version']}" for r in rows if not r['license_notice_files']],'source_files':len(pins)},indent=2))
