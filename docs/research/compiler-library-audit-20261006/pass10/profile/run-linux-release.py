#!/usr/bin/env python3
"""Exit-checked matched Linux release qualification for Pass10."""
import hashlib, json, pathlib, re, shutil, subprocess, time
root=pathlib.Path('/Users/vince/Projects/canlang')
tmp=pathlib.Path('/private/tmp/canlang-pass10-profile')
profile=root/'docs/research/compiler-library-audit-20261006/pass10/profile'
image='rust@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273'
sources=tmp/'sources'; artifacts=tmp/'artifacts/linux'
target=pathlib.Path('/private/tmp/canlang-pass5-profile/current-linux-target')
cargo_home=pathlib.Path('/private/tmp/canlang-pass5-profile/cargo-home')
mounts=['-v',f'{sources}/baseline:/src/baseline:ro','-v',f'{sources}/final:/src/final:ro','-v',f'{artifacts}:/artifacts','-v',f'{target}:/linux-target','-v',f'{cargo_home}:/cargo-home']
base=['docker','run','--pull=never','--platform','linux/amd64','--network','none','--rm',*mounts,image]
info=subprocess.run([*base,'sh','-c','rustc -Vv && cargo -V && uname -a'],capture_output=True,text=True)
(profile/'logs/linux-tools-exitchecked.log').write_text(info.stdout+info.stderr)
if info.returncode: raise SystemExit(f'tool inventory failed: {info.returncode}')
results={'image':image,'platform':'linux/amd64','network':'none','pull':'never','cargo_environment':{'CARGO_HOME':'/cargo-home','CARGO_BUILD_JOBS':'1','CARGO_INCREMENTAL':'0'},'target_dir':str(target),'cargo_home':str(cargo_home),'tools_output':info.stdout.strip(),'builds':{}}
for label in ('baseline','final'):
    manifest=f'/src/{label}/compiler/Cargo.toml'
    cargo=['cargo','build','--release','--manifest-path',manifest,'--target-dir','/linux-target','--offline','--locked']
    shell='export CARGO_HOME=/cargo-home CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0; exec '+' '.join(cargo)
    command=[*base,'sh','-c',shell]
    start=time.perf_counter()
    run=subprocess.run(command,capture_output=True,text=True)
    wall=time.perf_counter()-start
    log=profile/f'logs/linux-{label}-exitchecked.log'; log.write_text(run.stdout+run.stderr)
    if run.returncode:
        raise SystemExit(f'{label} Cargo release failed with exit {run.returncode}; stale target binary was not copied; see {log}')
    artifact=artifacts/f'{label}-can'
    shutil.copy2(target/'release/can',artifact)
    cli={}
    for flag,name in (('--version','version'),('--help','help')):
        probe=[*base,'/artifacts/'+artifact.name,flag]
        checked=subprocess.run(probe,capture_output=True,text=True)
        (profile/f'logs/linux-{label}-{name}-exitchecked.txt').write_text(checked.stdout+checked.stderr)
        if checked.returncode:
            raise SystemExit(f'{label} {flag} failed with exit {checked.returncode}')
        cli[name]={'exit':checked.returncode,'output':checked.stdout.strip() if name=='version' else 'captured in logs'}
    data=artifact.read_bytes()
    m=re.search(r'Finished `release` profile .*? in ([0-9.]+)s',run.stdout)
    results['builds'][label]={'command':cargo,'docker_command':command,'cargo_exit':run.returncode,'docker_wall_seconds':wall,'cargo_finished_seconds':float(m.group(1)) if m else None,'artifact':str(artifact),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'cli':cli}
(profile/'linux-release-retry-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
