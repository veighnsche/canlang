#!/usr/bin/env python3
"""Bounded native qualification for FAIL-R01; no package writes or language cap."""
import hashlib
import json
import resource
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCES = [
    'compiler/src/analysis/resolve.rs', 'compiler/src/analysis/types.rs',
    'compiler/src/codegen/ir.rs', 'compiler/src/codegen/js.rs',
    'compiler/tests/flat_expression_runtime.rs',
]
RESULTS = []

def sha(data):
    return hashlib.sha256(data).hexdigest()

def core_zero():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

def run(name, command, timeout=30, retain=False):
    began = time.monotonic()
    result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=timeout,
                            preexec_fn=core_zero)
    row = dict(name=name, command=[str(v) for v in command], exit=result.returncode,
               seconds=round(time.monotonic()-began, 3))
    for channel in ['stdout', 'stderr']:
        content = getattr(result, channel)
        row[channel+'_sha256'] = sha(content)
        row[channel+'_bytes'] = len(content)
        if retain:
            path = HERE / (name + '.' + channel)
            path.write_bytes(content)
            row[channel] = path.name
    RESULTS.append(row)
    assert result.returncode == 0, (name, result.stderr.decode(errors='replace'))
    return result

def main():
    receipt = dict(scope='Current-source bounded native debug/release arithmetic consumer qualification',
                   source_pins={path: sha((ROOT/path).read_bytes()) for path in SOURCES},
                   catalog_sha256=sha((ROOT/'packages/values/dist/catalog.json').read_bytes()),
                   observer_sha256=sha((HERE/'stages.rs').read_bytes()),
                   rustc=subprocess.check_output(['rustc','--version'],text=True).strip(),
                   node=subprocess.check_output(['node','--version'],text=True).strip(),
                   limits=['Child core0; arithmetic/stage/runtime30s each; build/test300s',
                           'No allocator/RSS/exhaustion or universal depth/other-host claim',
                           'Full scenario runtime remains gated by missing real stdlib require/hasRole exports',
                           'Runtime sums use the debug lowered expression and real stdlib; permanent tests also execute unmodified compiled derive modules',
                           'Async long-tree IIFE adds a Promise continuation; tested operand order/once/laziness, not arbitrary cross-task microtask equivalence'])
    with tempfile.TemporaryDirectory(prefix='can-flat-final-') as scratch:
        scratch=Path(scratch)
        run('debug-build',['cargo','build','--manifest-path','compiler/Cargo.toml','--locked','--offline','--lib','--bin','can'],300,True)
        observer=scratch/'stages'
        run('observer-build',['rustc','--edition=2024',str(HERE/'stages.rs'),'--extern','canlang_compiler=compiler/target/debug/libcanlang_compiler.rlib','-L','dependency=compiler/target/debug/deps','-o',str(observer)],300,True)
        receipt['binary_pins']={path:sha((ROOT/path).read_bytes()) for path in ['compiler/target/debug/can','compiler/target/debug/libcanlang_compiler.rlib']}
        receipt['observer_binary_sha256']=sha(observer.read_bytes())
        receipt['authored_source_pins']={}
        for terms in [64,512,1024,2048,3000]:
            source='docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/source-flat-'+str(terms)+'.can'
            receipt['authored_source_pins'][source]=sha((ROOT/source).read_bytes())
            result=run('debug-all-'+str(terms),[str(observer),source,'all'],30,True)
            assert result.stderr.endswith(b'all stages complete\n')
            if terms in [1024,2048,3000]:
                result=run('debug-lower-'+str(terms),[str(observer),source,'lower'])
                # Keep small stage markers, not redundant hundreds-of-KiB generated expressions.
                (HERE/('debug-lower-'+str(terms)+'.stderr')).write_bytes(result.stderr)
                js=scratch/(str(terms)+'.mjs')
                js.write_text('import {int64} from '+json.dumps((ROOT/'packages/stdlib/dist/src/index.js').as_uri())+';\nconst value=('+result.stdout.decode().strip()+');\nif(value!=='+str(terms)+'n)throw Error(String(value));console.log(String(value));\n')
                run('node-sum-'+str(terms),['node',str(js)],30,True)
        result=run('debug-clone-3000',[str(observer),'docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/source-flat-3000.can','clone'],30,True)
        assert result.stderr.endswith(b'all stages complete\n')
        logical=scratch/'logical-3000.can'
        logical.write_text('app T\nGiven\nWhen\n scenario s() read=true -> bool by=members\n  do return '+' and '.join(['true']*3000)+'\nThen\n')
        receipt['logical3000_source_sha256']=sha(logical.read_bytes())
        result=run('debug-logical-3000',[str(observer),str(logical),'all'],30,True)
        assert result.stderr.endswith(b'all stages complete\n')
        run('focused-tests',['cargo','test','--manifest-path','compiler/Cargo.toml','--locked','--offline','--test','flat_expression_runtime','--test','b4_check','--test','b4_resolve','--test','b4_witness','--test','codegen'],300,True)
        run('release-build',['cargo','build','--manifest-path','compiler/Cargo.toml','--locked','--offline','--release','--bin','can'],300,True)
        receipt['binary_pins']['compiler/target/release/can']=sha((ROOT/'compiler/target/release/can').read_bytes())
        for terms in [1024,2048,3000]:
            source='docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/source-flat-'+str(terms)+'.can'
            for stage in ['check','compile']:
                result=run('release-'+stage+'-'+str(terms),['compiler/target/release/can',stage,'--format=json','--catalog','packages/values/dist/catalog.json',source])
                payload=json.loads(result.stdout)
                assert payload.get('artifact_version')==1 if stage=='compile' else payload.get('complete') is True
    receipt['results']=RESULTS
    (HERE/'results.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(dict(observations=len(RESULTS),exit='all passed',receipt=str(HERE/'results.json'))))

if __name__=='__main__':
    main()
