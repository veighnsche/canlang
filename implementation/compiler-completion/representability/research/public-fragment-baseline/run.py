#!/usr/bin/env python3
"""Tiny public-fragment baseline; no source edits or invented refusal contract."""
import hashlib, json, resource, subprocess, tempfile, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
CASES = ['normal','empty-max','name-fit','name-overflow','multi-fit','multi-overflow','utf8-fit','utf8-overflow','tab-fit','hash-fit']
results = []
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def no_core(): resource.setrlimit(resource.RLIMIT_CORE, (0,0))
def run(name, cmd, timeout=30):
    t=time.monotonic()
    p=subprocess.run(cmd,cwd=ROOT,capture_output=True,timeout=timeout,preexec_fn=no_core)
    row={'name':name,'command':list(map(str,cmd)),'exit':p.returncode,'seconds':round(time.monotonic()-t,3)}
    for ch in ['stdout','stderr']:
        path=HERE/(name+'.'+ch);path.write_bytes(getattr(p,ch))
        row[ch]={'path':path.name,'sha256':sha(path),'bytes':path.stat().st_size}
    results.append(row)
    return p

def pins():
    inputs=list((ROOT/'compiler/src').rglob('*.rs'))+[ROOT/'compiler/Cargo.toml',ROOT/'compiler/Cargo.lock',ROOT/'compiler/build.rs']
    return {str(p.relative_to(ROOT)):sha(p) for p in inputs}
receipt={'scope':'10 tiny public API inputs, separately executed native debug/release; no actual >u32 owned source/count test','source_pins_before':pins(),'observer_sha256':sha(HERE/'probe.rs'),'cases':CASES,'limits':['30-second tiny processes, no cores','Only cargo --lib builds (locked/offline), reusing existing targets; no full suite','High-base tokens not sliced against the fragment; no forged carrier text witness','No refusal semantics or error code selected']}
for tool in ['rustc','cargo']:
    receipt[tool]=subprocess.check_output([tool,'--version','--verbose'],cwd=ROOT,text=True)
with tempfile.TemporaryDirectory(prefix='can-fragment-baseline-') as temp:
    for profile in ['debug','release']:
        cmd=['cargo','build','--manifest-path','compiler/Cargo.toml','--locked','--offline','--lib']
        if profile=='release':cmd+=['--release']
        p=run(profile+'-library-build',cmd,300)
        if p.returncode: raise SystemExit(p.stderr.decode())
        lib=ROOT/'compiler/target'/profile/'libcanlang_compiler.rlib'
        receipt[profile+'_rlib_sha256']=sha(lib)
        exe=Path(temp)/profile
        cmd=['rustc','--edition=2024',str(HERE/'probe.rs'),'--extern','canlang_compiler='+str(lib),'-L','dependency='+str(lib.parent/'deps'),'-o',str(exe)]
        if profile=='release':cmd+=['-C','opt-level=z','-C','overflow-checks=off','-C','debug-assertions=off','-C','lto=fat','-C','codegen-units=1']
        p=run(profile+'-observer-build',cmd,300)
        if p.returncode:raise SystemExit(p.stderr.decode())
        receipt[profile+'_observer_sha256']=sha(exe)
        for case in CASES:run(profile+'-'+case,[str(exe),case])
receipt['source_pins_after']=pins()
receipt['sources_stable_during_execution']=receipt['source_pins_before']==receipt['source_pins_after']
receipt['results']=results
(HERE/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'cases':20,'sources_stable':receipt['sources_stable_during_execution'],'exits':{r['name']:r['exit'] for r in results}}))
