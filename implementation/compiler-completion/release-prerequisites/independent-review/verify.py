import hashlib,json,pathlib,re,shutil,subprocess,tarfile,tempfile,tomllib
R=pathlib.Path('/Users/vince/Projects/canlang'); E=R/'implementation/compiler-completion/release-prerequisites'; O=E/'independent-review'; T=pathlib.Path(tempfile.mkdtemp(prefix='dep03-independent-',dir='/private/tmp')); sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest(); out={'private_root':str(T)}
pins=json.loads((E/'source-pins.json').read_text()); actual={p:sha(R/p) if (R/p).is_file() else None for p in pins}; production=[p for p in pins if p.startswith('compiler/src/') or p in ('compiler/Cargo.toml','compiler/Cargo.lock','compiler/build.rs','compiler/can-completions.bash','compiler/can-completions.zsh','compiler/can-completions.fish')]; assert all(actual[p]==pins[p] for p in production); out['actual_build_input_count']=len(production);out['actual_build_input_pins']={p:actual[p] for p in production};out['snapshot_mismatches']=[p for p in pins if actual[p]!=pins[p]]
ipins=json.loads((E/'integration/source-pins.json').read_text());assert all(sha(R/p)==v for p,v in ipins.items());out['integration_pins']=ipins
lock=tomllib.loads((R/'compiler/Cargo.lock').read_text()); locked={(p['name'],p['version']):p['checksum'] for p in lock['package'] if 'checksum' in p}; archives=json.loads((E/'archives.json').read_text())['packages']; assert len(archives)==len(locked)==93; count=0; vcs={}
for a in archives:
 key=(a['name'],a['version']); ap=pathlib.Path(a['archive_path']);assert sha(ap)==locked[key]==a['archive_sha256'];
 with tarfile.open(ap,'r:gz') as tf:
  for n in a['license_notice_files']:
   data=tf.extractfile(n['path']).read();assert hashlib.sha256(data).hexdigest()==n['sha256']==sha(E/'notices'/n['path']);assert data==(E/'notices'/n['path']).read_bytes();count+=1
  if a['name'] in ('base64-simd','vsimd'):
   vcs[a['name']]=json.loads(tf.extractfile(f"{a['name']}-{a['version']}/.cargo_vcs_info.json").read())['git']['sha1']
assert count==152;assert set(vcs.values())=={'d74c030d9dc4f3cae02146d1f497ff62726ef09a'};out['archive_checksums_verified']=93;out['exact_archive_notice_files_verified']=count;out['simd_archive_commits']=vcs
sup=json.loads((E/'supplemental-notices.json').read_text())[0];assert sha(E/sup['path'])==sup['sha256'];out['simd_supplemental_source']=sup
closures=json.loads((E/'target-closures.json').read_text());out['target_checks']=[]
for c in closures:
 target=c['target']; tree=(E/f'tree-{target}-normal-build.stdout').read_text(); seen=set(re.findall(r'^([\w-]+) v([^\s]+)',tree,re.M));seen.discard(('canlang-compiler','0.1.0')); assert seen=={(p['name'],p['version']) for p in c['packages']};assert len(seen)==77
 b=R/'compiler/third-party-notices'/f'THIRD-PARTY-NOTICES-{target}.txt'; assert b.read_bytes()==(E/b.name).read_bytes(); text=b.read_text(); sections=re.split(r'^=== ',text,flags=re.M)[1:];assert len(sections)==77
 for p,section in zip(c['packages'],sections):
  assert section.startswith(f"{p['name']} {p['version']} — declared {p['declared_license']} ===")
  for ns in p['notice_sources']:
   src=E/ns['path'] if ns['path'].startswith('supplemental-') else E/'notices'/ns['path']; assert src.read_text() in section
 out['target_checks'].append({'target':target,'packages':77,'notice_sha256':sha(b),'every_supplied_text_exact':True})
manifest=json.loads((R/'compiler/third-party-notices/manifest.json').read_text());assert all(sha(R/p)==v for p,v in manifest['provenance'].items());out['provenance_hashes_verified']=manifest['provenance']
for raw in ('native-release.stderr','linux-build.stderr'):
 assert 'Finished `release` profile' in (E/raw).read_text()
commands=json.loads((E/'commands.json').read_text()); assert all(c['exit']==0 for c in commands['results']); native=json.loads((E/'native-artifact.json').read_text()); assert sha(pathlib.Path(native['path']))==native['sha256']; linux=json.loads((E/'linux-artifact.json').read_text()); assert all(p['exit']==0 for p in linux['probes'].values());assert 'build_exit=0' in (E/'linux-release.stdout').read_text();out['reused_native_build_evidence']={'native':native,'linux':linux,'commands_sha256':sha(E/'commands.json'),'linux_raw_sha256':sha(E/'linux-release.stdout')}
cases=[]
def case(name,mut=None,target='aarch64-apple-darwin',positive=False):
 d=T/name;(d/'scripts').mkdir(parents=True);(d/'compiler').mkdir();shutil.copy2(R/'scripts/check-compiler-release-notices.py',d/'scripts');shutil.copytree(R/'compiler/third-party-notices',d/'compiler/third-party-notices');
 for n in ('Cargo.toml','Cargo.lock','build.rs'):shutil.copy2(R/'compiler'/n,d/'compiler'/n)
 if mut:mut(d)
 p=subprocess.run(['python3',str(d/'scripts/check-compiler-release-notices.py'),'--target',target,'--output-dir',str(d/'output')],capture_output=True,text=True);present=(d/'output/THIRD-PARTY-NOTICES.txt').exists();assert (p.returncode==0 and present) if positive else (p.returncode!=0 and not present);cases.append({'case':name,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'copied':present});return d
for target in manifest['targets']:
 d=case('positive-'+target,target=target,positive=True);assert sha(d/'output/THIRD-PARTY-NOTICES.txt')==manifest['targets'][target]['sha256']
for name,path in [('stale-lock','compiler/Cargo.lock'),('stale-manifest','compiler/Cargo.toml'),('corrupt-selected','compiler/third-party-notices/THIRD-PARTY-NOTICES-aarch64-apple-darwin.txt'),('corrupt-other','compiler/third-party-notices/THIRD-PARTY-NOTICES-x86_64-unknown-linux-gnu.txt')]:case(name,lambda d,p=path:(d/p).write_bytes((d/p).read_bytes()+b'\n'))
for name,path in [('missing-lock','compiler/Cargo.lock'),('missing-manifest','compiler/third-party-notices/manifest.json'),('missing-selected','compiler/third-party-notices/THIRD-PARTY-NOTICES-aarch64-apple-darwin.txt'),('missing-other','compiler/third-party-notices/THIRD-PARTY-NOTICES-x86_64-unknown-linux-gnu.txt')]:case(name,lambda d,p=path:(d/p).unlink())
def mutate_manifest(d,change):
 p=d/'compiler/third-party-notices/manifest.json';m=json.loads(p.read_text());change(m);p.write_text(json.dumps(m))
case('schema-bool',lambda d:mutate_manifest(d,lambda m:m.update(schema=True)))
case('wrong-target-set',lambda d:mutate_manifest(d,lambda m:m['targets'].pop('x86_64-unknown-linux-gnu')))
case('path-traversal',lambda d:mutate_manifest(d,lambda m:m['targets']['aarch64-apple-darwin'].update(file='../Cargo.lock')))
case('extra-input',lambda d:mutate_manifest(d,lambda m:m['inputs'].update({'compiler/build.rs':'x'})))
case('unsupported-target',target='aarch64-pc-windows-msvc')
case('build-rs-unbound',lambda d:(d/'compiler/build.rs').write_text('fn main() {}\n'),positive=True)
out['guard_cases']=cases
before=(E/'integration/workflow-before.yml').read_text();after=(R/'.github/workflows/release.yml').read_text();assert before.split('  node-libraries:',1)[1]==after.split('  node-libraries:',1)[1];assert 'run: cargo build --release --locked' in after;assert 'toolchain: "1.99.0"' in after;out['unrelated_workflow_jobs_identical']=True;out['workflow_sha256']=sha(R/'.github/workflows/release.yml')
(O/'results.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'build_inputs':len(production),'archives':93,'notice_sources':count,'guard_cases':len(cases),'production_mismatches':[],'snapshot_mismatches':out['snapshot_mismatches']},indent=2))
