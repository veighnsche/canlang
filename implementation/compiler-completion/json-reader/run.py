#!/usr/bin/env python3
"""Finite DEP-01 controls. Builds only included JSON/transport and cached serde_json."""
import hashlib, json, os, pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
SRC = pathlib.Path.home() / '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/serde_json-1.0.151'
DEPS = ROOT / 'compiler/target/debug/deps'
def pin(p): return hashlib.sha256(p.read_bytes()).hexdigest()
inputs = ['AGENTS.md', 'compiler/Cargo.toml', 'compiler/Cargo.lock', 'compiler/src/json.rs',
          'compiler/src/lsp/transport.rs', 'compiler/src/lsp/server.rs', 'compiler/src/lsp/output.rs',
          'compiler/src/analysis/catalog.rs', 'compiler/src/cli.rs', 'compiler/src/docs.rs',
          'compiler/src/lib.rs', 'compiler/src/main.rs', 'compiler/tests/json_input_contract.rs',
          'compiler/tests/catalog_input_contract.rs', 'compiler/tests/lsp_admission.rs',
          'compiler/tests/lsp_typed_output.rs', 'compiler/tests/lsp_frame_reader.rs', 'compiler/tests/common/lsp_driver.rs']
inputs = [p for p in inputs if (ROOT / p).exists()]
receipt = {'scope': 'isolated JSON/transport source tests and pinned public API finite feature controls; no compiler build',
           'commands': [], 'pins_before': {p: pin(ROOT/p) for p in inputs},
           'upstream_pins': {str(SRC/p): pin(SRC/p) for p in ['Cargo.toml','build.rs','src/lib.rs','src/de.rs','src/read.rs','src/raw.rs','src/number.rs','src/error.rs']}}
def run(name, argv, env=None):
    result = subprocess.run(list(map(str,argv)), cwd=ROOT, env=env, capture_output=True, text=True)
    (HERE/(name+'.stdout')).write_text(result.stdout)
    (HERE/(name+'.stderr')).write_text(result.stderr)
    receipt['commands'].append({'name': name, 'argv': list(map(str,argv)), 'exit': result.returncode})
    if result.returncode: raise RuntimeError(name)
def ext(name, filename):
    path = DEPS/filename
    receipt.setdefault('artifact_pins',{})[str(path)] = pin(path)
    return ['--extern', f'{name}={path}']
serde = ext('serde','libserde-5f77724b6c1d8dcc.rlib')
current_json = ext('serde_json','libserde_json-abd07b5320783267.rlib')
try:
    run('rustc-version', ['rustc','--version','--verbose'])
    with tempfile.TemporaryDirectory(prefix='can-dep01-', dir='/private/tmp') as tmp:
        tmp = pathlib.Path(tmp)
        text = (ROOT/'compiler/src/lsp/transport.rs').read_text()
        (tmp/'transport-body.rs').write_text('\n'.join('//' + line[3:] if line.startswith('//!') else line for line in text.splitlines())+'\n')
        env = dict(os.environ, DEP01_TMP=str(tmp))
        run('finite-build', ['rustc','--edition=2024','--test',HERE/'finite.rs','-L',f'dependency={DEPS}',*serde,*current_json,'-o',tmp/'finite'], env)
        run('finite-tests', [tmp/'finite','--nocapture'], env)
        run('standard-build', ['rustc','--edition=2024',HERE/'feature-control.rs','-L',f'dependency={DEPS}',*serde,*current_json,'-o',tmp/'standard'])
        run('standard-control', [tmp/'standard'])
        # Isolated feature build from the exact cached package; no manifest/lock edit.
        feature_lib = tmp/'libserde_json_dep01.rlib'
        run('arbitrary-library-build', ['rustc','--edition=2021','--crate-name','serde_json','--crate-type','rlib',SRC/'src/lib.rs',
             '--cfg','feature="std"','--cfg','feature="raw_value"','--cfg','feature="arbitrary_precision"',
             '--cfg','fast_arithmetic="64"',
             '-C','metadata=dep01_arbitrary','-L',f'dependency={DEPS}',
             *ext('serde_core','libserde_core-62840b425821f844.rlib'),
             *ext('itoa','libitoa-0058ccfeb46374f7.rlib'),*ext('memchr','libmemchr-2fd701f973603a9e.rlib'),
             *ext('zmij','libzmij-616818dc6d449fb1.rlib'),'-o',feature_lib])
        run('arbitrary-control-build', ['rustc','--edition=2024',HERE/'feature-control.rs','--cfg','feature="arbitrary_precision"',
             '-L',f'dependency={DEPS}',*serde,'--extern',f'serde_json={feature_lib}','-o',tmp/'arbitrary'])
        run('arbitrary-control', [tmp/'arbitrary'])
finally:
    receipt['pins_after'] = {p: pin(ROOT/p) for p in inputs}
    receipt['inputs_unchanged'] = receipt['pins_before'] == receipt['pins_after']
    (HERE/'controls.json').write_text(json.dumps(receipt,indent=2)+'\n')
