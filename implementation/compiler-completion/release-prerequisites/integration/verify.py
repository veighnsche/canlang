import pathlib,tempfile,subprocess,shutil,json,hashlib
ROOT=pathlib.Path('/Users/vince/Projects/canlang');OUT=ROOT/'implementation/compiler-completion/release-prerequisites/integration';tmp=pathlib.Path(tempfile.mkdtemp(prefix='canlang-dep03-notice-join-',dir='/private/tmp'));rows=[]
def fixture(name):
 p=tmp/name;(p/'compiler').mkdir(parents=True);(p/'scripts').mkdir()
 for f in ['Cargo.toml','Cargo.lock']:shutil.copyfile(ROOT/'compiler'/f,p/'compiler'/f)
 shutil.copytree(ROOT/'compiler/third-party-notices',p/'compiler/third-party-notices');shutil.copyfile(ROOT/'scripts/check-compiler-release-notices.py',p/'scripts/check-compiler-release-notices.py');return p
def guard(p,target):
 return subprocess.run(['python3',str(p/'scripts/check-compiler-release-notices.py'),'--target',target,'--output-dir',str(p/'artifact')],capture_output=True,text=True)
for target,binary in [('aarch64-apple-darwin','native-target/release/can'),('x86_64-unknown-linux-gnu','linux-can')]:
 p=fixture('positive-'+target);r=guard(p,target);assert r.returncode==0
 shutil.copyfile(pathlib.Path('/private/tmp/canlang-dep03-release-20261008')/binary,p/'artifact/can');hashes=subprocess.run(['shasum','-a','256','can','THIRD-PARTY-NOTICES.txt'],cwd=p/'artifact',capture_output=True,text=True);assert hashes.returncode==0;(p/'artifact/SHA256SUMS.txt').write_text(hashes.stdout);checked=subprocess.run(['shasum','-a','256','-c','SHA256SUMS.txt'],cwd=p/'artifact',capture_output=True,text=True);assert checked.returncode==0;rows.append({'case':p.name,'guard_exit':r.returncode,'checksum_exit':checked.returncode,'guard_stdout':r.stdout,'checksums':hashes.stdout,'verify_stdout':checked.stdout})
def mutate(p,case):
 m=p/'compiler/third-party-notices/manifest.json'
 if case in ['stale-lock','stale-package']:
  f=p/'compiler'/('Cargo.lock' if case=='stale-lock' else 'Cargo.toml');f.write_bytes(f.read_bytes()+b'\n# changed input\n')
 elif case=='corrupt-manifest':m.write_text('{')
 elif case in ['stale-manifest','wrong-schema','wrong-notice-path']:
  data=json.loads(m.read_text())
  if case=='stale-manifest':data['inputs']['compiler/Cargo.lock']='0'*64
  elif case=='wrong-schema':data['schema']=2
  else:data['targets']['aarch64-apple-darwin']['file']='../../Cargo.lock'
  m.write_text(json.dumps(data))
 elif case in ['corrupt-notice','missing-notice','missing-other-target']:
  target='x86_64-unknown-linux-gnu' if case=='missing-other-target' else 'aarch64-apple-darwin';f=p/'compiler/third-party-notices'/f'THIRD-PARTY-NOTICES-{target}.txt'
  if case=='corrupt-notice':f.write_bytes(f.read_bytes()+b'changed')
  else:f.unlink()
for case in ['stale-lock','stale-package','corrupt-manifest','stale-manifest','wrong-schema','wrong-notice-path','corrupt-notice','missing-notice','missing-other-target','unsupported-target']:
 p=fixture(case);mutate(p,case);r=guard(p,'unknown-target' if case=='unsupported-target' else 'aarch64-apple-darwin');assert r.returncode!=0;assert not (p/'artifact').exists();rows.append({'case':case,'exit':r.returncode,'stderr':r.stderr,'no_output':True})
for target,expected in [('aarch64-apple-darwin',0),('x86_64-unknown-linux-gnu',1)]:
 r=subprocess.run(['sh','-c',f'test "$(rustc -Vv | sed -n \'s/^host: //p\')" = "{target}"'],capture_output=True,text=True);assert r.returncode==expected;rows.append({'case':'actual-host-guard-'+target,'exit':r.returncode,'expected':expected})
before=(OUT/'workflow-before.yml').read_bytes();after=(ROOT/'.github/workflows/release.yml').read_bytes();assert before.split(b'  node-libraries:',1)[1]==after.split(b'  node-libraries:',1)[1];assert b'run: cargo build --release --locked\n' in after;assert b'toolchain: "1.99.0"' in after
(OUT/'results.json').write_text(json.dumps({'fixture_root':str(tmp),'results':rows,'unrelated_workflow_jobs_identical':True,'original_release_command_preserved':True,'toolchain_pin_preserved':True},indent=2)+'\n');print(json.dumps({'fixture_root':str(tmp),'positive_artifacts':2,'negative_cases':10,'host_guard_cases':2,'all_passed':True}))
