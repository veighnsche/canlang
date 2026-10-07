#!/usr/bin/env python3
"""Exit-checked baseline unknown-commit release build for Pass10."""
import hashlib, json, os, pathlib, shutil, subprocess, time
repo=pathlib.Path('/Users/vince/Projects/canlang')
source=pathlib.Path('/private/tmp/canlang-pass10-profile/sources/baseline/compiler/Cargo.toml')
target=pathlib.Path('/private/tmp/canlang-pass5-profile/current-native-target')
out=pathlib.Path('/private/tmp/canlang-pass10-profile/artifacts/native/baseline-can')
profile=repo/'docs/research/compiler-library-audit-20261006/pass10/profile'
command=['cargo','build','--release','--manifest-path',str(source),'--target-dir',str(target),'--offline','--locked']
env=dict(os.environ,CARGO_HOME='/private/tmp/canlang-pass5-profile/cargo-home',CARGO_BUILD_JOBS='1',CARGO_INCREMENTAL='0')
start=time.perf_counter(); run=subprocess.run(command,cwd=repo,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True); elapsed=time.perf_counter()-start
(profile/'logs/native-baseline-exitchecked.log').write_text(run.stdout)
if run.returncode: raise SystemExit(f'Cargo release build failed with exit {run.returncode}')
shutil.copy2(target/'release/can',out)
def check(flag,path):
 p=subprocess.run([str(out),flag],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True); path.write_text(p.stdout)
 if p.returncode: raise SystemExit(f'{flag} failed with exit {p.returncode}')
 return p.stdout.strip()
version=check('--version',profile/'logs/native-baseline-version.txt'); check('--help',profile/'logs/native-baseline-help.txt')
b=out.read_bytes(); result={'command':command,'env':{'CARGO_HOME':env['CARGO_HOME'],'CARGO_BUILD_JOBS':1,'CARGO_INCREMENTAL':0},'cargo_exit':run.returncode,'elapsed_seconds':elapsed,'artifact':str(out),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'version':version,'version_exit':0,'help_exit':0}
(profile/'native-baseline-retry-results.json').write_text(json.dumps(result,indent=2)+'\n'); print(json.dumps(result,indent=2))
