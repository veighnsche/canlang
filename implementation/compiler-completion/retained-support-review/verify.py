#!/usr/bin/env python3
"""Independent bounded retention review; never rebuilds or edits production."""
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = ROOT / 'implementation/compiler-completion'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
docs = json.loads((BASE / 'docs-support/inventory.json').read_text())
maps = json.loads((BASE / 'map-support/pins.json').read_text())
baseline = json.loads((BASE / 'producer-refresh/compiler-inputs-before-full-suite.json').read_text())
checks = {'docs': {}, 'map': {}, 'matching_frozen_owner_inputs': {}}
for name, pin in docs['pins'].items():
    actual = sha(ROOT / name)
    checks['docs'][name] = {'expected': pin['sha256'], 'actual': actual, 'match': actual == pin['sha256']}
for name, expected in maps.items():
    actual = sha(pathlib.Path(name))
    checks['map'][name] = {'expected': expected, 'actual': actual, 'match': actual == expected}
for name in ['compiler/src/docs.rs', 'compiler/src/json.rs', 'compiler/src/cli.rs', 'compiler/src/codegen/sourcemap.rs', 'compiler/src/codegen/artifact.rs', 'compiler/src/codegen/mod.rs', 'compiler/src/lib.rs', 'compiler/Cargo.toml', 'compiler/Cargo.lock', 'compiler/tests/docs.rs', 'compiler/tests/typed_references.rs', 'compiler/tests/typed_reference_policy_consumers.rs', 'compiler/tests/codegen.rs', 'compiler/tests/sourcemap_contract.rs']:
    actual = sha(ROOT / name)
    checks['matching_frozen_owner_inputs'][name] = {'expected': baseline.get(name), 'actual': actual, 'match': actual == baseline.get(name)}
source = (ROOT / 'compiler/src/docs.rs').read_text()
methods = re.findall(r'pub fn to_json\(&self\) -> Json \{\n        reference_json\(self\)\n    \}', source)
assert len(methods) == 13
assert sum(len(m.splitlines()) for m in methods) == 39
helper = re.search(r'fn reference_json<T: serde::Serialize>.*?\n\}', source, re.S).group()
assert len(helper.splitlines()) == 5
map_source = (ROOT / 'compiler/src/codegen/sourcemap.rs').read_text()
map_lines = map_source.splitlines()
declaration_ranges = [(136, 147), (155, 201), (203, 207), (212, 232)]
assert sum(end - start + 1 for start, end in declaration_ranges) == 85
assert 'struct EncodedMappings' in '\n'.join(map_lines[80:96])
assert len(map_lines[80:96]) == 16
decoder_lines = map_source.splitlines()[132:233]
control = (BASE / 'map-support/controls.rs').read_text()
assert control.startswith('\n'.join(decoder_lines) + '\n')
# Keep execution distinct from inherited receipts, using reviewed verbatim
# decoder and reviewed finite controls, not a newly inferred implementation.
rlib = next(pathlib.Path(p) for p in maps if p.endswith('.rlib'))
deps = rlib.parent
receipts = {}
for name in ['controls', 'private_encoder', 'get_mappings', 'serialize_trait']:
    original = BASE / 'map-support' / (name + '.rs')
    local = HERE / (name + '.rs')
    local.write_bytes(original.read_bytes())
    cmd = ['rustc', '--edition=2021', str(local), '-L', 'dependency=' + str(deps), '--extern', 'sourcemap=' + str(rlib), '-o', str(HERE / name)]
    if name == 'serialize_trait':
        cmd += ['--extern', 'serde=' + str(deps / 'libserde-5f77724b6c1d8dcc.rlib')]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    (HERE / (name + '.stdout')).write_text(result.stdout)
    (HERE / (name + '.stderr')).write_text(result.stderr)
    assert (result.returncode == 0) == (name == 'controls')
    if name != 'controls':
        expected_error = {'private_encoder': 'E0603', 'get_mappings': 'E0599', 'serialize_trait': 'E0277'}[name]
        assert expected_error in result.stderr
    receipts[name] = {'command': cmd, 'exit': result.returncode, 'source_sha256': sha(local)}
    if name == 'controls':
        run = subprocess.run([str(HERE / name)], capture_output=True, text=True, timeout=10)
        (HERE / 'controls.run.stdout').write_text(run.stdout)
        (HERE / 'controls.run.stderr').write_text(run.stderr)
        assert run.returncode == 0
        receipts[name]['run_exit'] = run.returncode
    (HERE / name).unlink(missing_ok=True)
checks['counts'] = {'docs_public_views': 13, 'docs_public_body_lines': 39, 'docs_private_bridge_lines': 5, 'docs_target_total': 44, 'docs_net_reduction': 0, 'map_extraction_gross_target': 16, 'map_extraction_net_reduction': 0, 'map_public_decoder_declaration_lines': 85, 'map_public_decoder_net_reduction': 0}
checks['replays'] = receipts
checks['evidence_logs'] = {str(p.relative_to(ROOT)): sha(p) for p in [BASE / 'docs-support/existing-tests.stdout', BASE / 'docs-support/existing-tests.stderr', BASE / 'docs-support/cli-docs-tests.stderr', BASE / 'docs-support/root-cli-tests.log', BASE / 'producer-refresh/integrated-checks.json']}
(HERE / 'verification.json').write_text(json.dumps(checks, indent=2) + '\n')
print(json.dumps({key: {'count': len(checks[key]), 'matching': sum(p['match'] for p in checks[key].values())} for key in ['docs', 'map', 'matching_frozen_owner_inputs']}))
print('Finite standalone controls PASS; expected API rejections E0603/E0599/E0277 verified; production reduction 0 per bounded packet.')
