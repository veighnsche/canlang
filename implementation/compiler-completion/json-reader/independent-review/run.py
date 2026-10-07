#!/usr/bin/env python3
"""Independent finite controls: cached archives and exact upstream source only."""
import hashlib, json, os, pathlib, subprocess, tarfile, tempfile, tomllib
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SRC = pathlib.Path.home() / '.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/serde_json-1.0.151'
DEPS = ROOT / 'compiler/target/debug/deps'
def pin(p): return hashlib.sha256(p.read_bytes()).hexdigest()
paths = ['AGENTS.md', 'compiler/Cargo.toml', 'compiler/Cargo.lock', 'compiler/src/json.rs',
         'compiler/src/lsp/transport.rs', 'compiler/src/lsp/server.rs', 'compiler/src/lsp/output.rs',
         'compiler/src/analysis/catalog.rs', 'compiler/src/docs.rs', 'compiler/src/lib.rs',
         'compiler/tests/json_input_contract.rs', 'compiler/tests/catalog_input_contract.rs',
         'compiler/tests/lsp_admission.rs']
receipt = {'scope': 'independent finite API/outcome executable only; no Cargo build',
           'commands': [], 'pins_before': {p: pin(ROOT / p) for p in paths},
           'upstream_pins': {str(SRC / p): pin(SRC / p) for p in ['Cargo.toml','build.rs','src/lib.rs','src/de.rs','src/read.rs','src/raw.rs','src/number.rs']}}
# Cargo registry src and cache are sibling directories under registry.
archive = SRC.parents[2] / 'cache/index.crates.io-1949cf8c6b5b557f/serde_json-1.0.151.crate'
locked = next(p for p in tomllib.loads((ROOT/'compiler/Cargo.lock').read_text())['package'] if p['name'] == 'serde_json')
receipt['upstream_archive'] = {'path': str(archive), 'sha256': pin(archive), 'locked_checksum': locked['checksum']}
assert receipt['upstream_archive']['sha256'] == locked['checksum']
with tarfile.open(archive) as package:
    matches = {}
    for path, sha in receipt['upstream_pins'].items():
        name = pathlib.Path(path).relative_to(SRC).as_posix()
        archived = package.extractfile('serde_json-1.0.151/' + name).read()
        matches[name] = hashlib.sha256(archived).hexdigest() == sha
    receipt['upstream_archive']['source_files_match'] = matches
    assert all(matches.values())
def ext(name, archive):
    p = DEPS / archive
    receipt.setdefault('artifact_pins', {})[str(p)] = pin(p)
    return ['--extern', f'{name}={p}']
def run(name, argv, env=None):
    result = subprocess.run(list(map(str, argv)), cwd=ROOT, env=env, capture_output=True, text=True)
    (HERE / (name + '.stdout')).write_text(result.stdout)
    (HERE / (name + '.stderr')).write_text(result.stderr)
    receipt['commands'].append({'name': name, 'argv': list(map(str, argv)), 'exit': result.returncode})
    if result.returncode: raise RuntimeError(name)
serde = ext('serde','libserde-5f77724b6c1d8dcc.rlib')
current = ext('serde_json','libserde_json-abd07b5320783267.rlib')
try:
    run('rustc-version', ['rustc','--version','--verbose'])
    with tempfile.TemporaryDirectory(prefix='can-dep01-independent-', dir='/private/tmp') as temporary:
        tmp = pathlib.Path(temporary)
        transport = (ROOT/'compiler/src/lsp/transport.rs').read_text()
        (tmp/'transport-body.rs').write_text('\n'.join('//' + line[3:] if line.startswith('//!') else line for line in transport.splitlines()) + '\n')
        env = dict(os.environ, DEP01_TMP=str(tmp))
        run('author-finite-build', ['rustc','--edition=2024','--test',HERE.parent/'finite.rs','-L',f'dependency={DEPS}',*serde,*current,'-o',tmp/'finite'], env)
        run('author-finite-tests', [tmp/'finite','--nocapture'], env)
        run('standard-build', ['rustc','--edition=2024',HERE/'control.rs','-L',f'dependency={DEPS}',*serde,*current,'-o',tmp/'standard'])
        run('standard-control', [tmp/'standard'])
        lib = tmp/'libserde_json_independent.rlib'
        run('arbitrary-library-build', ['rustc','--edition=2021','--crate-name','serde_json','--crate-type','rlib',SRC/'src/lib.rs',
            '--cfg','feature="std"','--cfg','feature="raw_value"','--cfg','feature="arbitrary_precision"','--cfg','fast_arithmetic="64"',
            '-C','metadata=dep01_independent','-L',f'dependency={DEPS}',
            *ext('serde_core','libserde_core-62840b425821f844.rlib'),*ext('itoa','libitoa-0058ccfeb46374f7.rlib'),
            *ext('memchr','libmemchr-2fd701f973603a9e.rlib'),*ext('zmij','libzmij-616818dc6d449fb1.rlib'),'-o',lib])
        run('arbitrary-build', ['rustc','--edition=2024',HERE/'control.rs','--cfg','feature="arbitrary_precision"','-L',f'dependency={DEPS}',*serde,'--extern',f'serde_json={lib}','-o',tmp/'arbitrary'])
        run('arbitrary-control', [tmp/'arbitrary'])
finally:
    receipt['pins_after'] = {p: pin(ROOT / p) for p in paths}
    receipt['inputs_unchanged'] = receipt['pins_before'] == receipt['pins_after']
    (HERE/'controls.json').write_text(json.dumps(receipt, indent=2)+'\n')
