#!/usr/bin/env python3
"""Capture exact native commands and fresh observations; independent contracts in cases.json."""
import hashlib
import json
import pathlib
import platform
import subprocess
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[4]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def invoke(name, argv, cwd=ROOT):
    start = time.time()
    done = subprocess.run(argv, cwd=cwd, capture_output=True)
    (HERE / (name + '.stdout')).write_bytes(done.stdout)
    (HERE / (name + '.stderr')).write_bytes(done.stderr)
    receipt = {'name': name, 'argv': [str(a) for a in argv], 'cwd': str(cwd),
        'exit': done.returncode, 'elapsed_seconds': round(time.time() - start, 3),
        'stdout': name + '.stdout', 'stderr': name + '.stderr',
        'stdout_sha256': hashlib.sha256(done.stdout).hexdigest(),
        'stderr_sha256': hashlib.sha256(done.stderr).hexdigest()}
    return done, receipt

def main():
    receipts = []
    for name, argv in [('rustc-version', ['rustc', '-Vv']), ('cargo-version', ['cargo', '-V']),
                       ('node-version', ['node', '--version'])]:
        done, rec = invoke(name, argv)
        receipts.append(rec)
        assert done.returncode == 0, rec
    done, rec = invoke('fresh-build', ['cargo', 'build', '--locked', '--offline',
        '--manifest-path', 'compiler/Cargo.toml', '--lib', '--bin', 'can', '--message-format=json'])
    receipts.append(rec)
    assert done.returncode == 0, rec
    artifacts = [json.loads(line) for line in done.stdout.splitlines() if line.startswith(b'{')]
    def rlib(name):
        return next(filename for a in artifacts if a.get('reason') == 'compiler-artifact'
            and a['target']['name'] == name for filename in a['filenames'] if filename.endswith('.rlib'))
    lib = rlib('canlang_compiler')
    serde = rlib('serde_json')
    with tempfile.TemporaryDirectory(prefix='can-step7-') as scratch:
        exe = pathlib.Path(scratch) / 'probe'
        done, rec = invoke('compile-probe', ['rustc', '--edition=2024', str(HERE / 'probe.rs'),
            '--extern', 'canlang_compiler=' + lib, '--extern', 'serde_json=' + serde,
            '-L', 'dependency=' + str(ROOT / 'compiler/target/debug/deps'), '-o', str(exe)])
        receipts.append(rec)
        if done.returncode:
            (HERE / 'execution.json').write_text(json.dumps({'commands': receipts}, indent=2) + '\n')
        assert done.returncode == 0, rec
        observations = []
        for case in json.loads((HERE / 'cases.json').read_text()):
            source = pathlib.Path(scratch) / (case['id'] + '.can')
            source.write_bytes(bytes.fromhex(case['bytes_hex']) if 'bytes_hex' in case else case['source'].encode())
            done, rec = invoke('case-' + case['id'], [str(exe), str(source),
                str(ROOT / 'packages/values/dist/catalog.json'), str(ROOT)])
            receipts.append(rec)
            observed = json.loads(done.stdout) if done.returncode == 0 else None
            assertions = []
            if observed is not None:
                if observed['byte_admission'] == 'accepted':
                    ds = observed['analysis']['diagnostics']
                    for contract in case.get('required_findings', []):
                        needle = contract['anchor'].encode()
                        source_bytes = case['source'].encode()
                        expected = -1
                        for _ in range(contract.get('occurrence', 1)):
                            expected = source_bytes.find(needle, expected + 1)
                            assert expected >= 0, contract
                        actual = [d for d in ds if d['code'] == contract['code'] and
                            d['primary']['start'] == expected and d['primary']['end'] == expected + len(contract['anchor'].encode())]
                        assertions.append({'contract': contract, 'pass': bool(actual)})
                    assertions.append({'contract': 'lossless-byte-coverage', 'pass': observed['coverage']})
                    if case.get('clean'):
                        assertions.append({'contract': 'parse-and-check-clean', 'pass': not observed['parse_codes'] and not ds})
                    if case.get('decoded') is not None:
                        assertions.append({'contract': 'independent-code-points', 'pass':
                            any(s['code_points'] == case['decoded'] for s in observed['decoded_strings'])})
                else:
                    assertions.append({'contract': 'strict-invalid-UTF8', 'pass': observed.get('code') == 'E1002'})
            observations.append({'id': case['id'], 'source_sha256': digest(source),
                'process_exit': done.returncode, 'assertions': assertions,
                'observation': 'case-' + case['id'] + '.stdout'})
        (HERE / 'observations.json').write_text(json.dumps(observations, indent=2) + '\n')
    done, rec = invoke('focused-suites', ['cargo', 'test', '--locked', '--offline',
        '--manifest-path', 'compiler/Cargo.toml', '--test', 'syntax', '--test', 'b4_parse',
        '--test', 'analysis', '--test', 'check', '--test', 'effects', '--test', 'codegen',
        '--test', 'format', '--test', 'string_payload_runtime', '--', '--nocapture'])
    receipts.append(rec)
    summary = {'host': platform.platform(), 'machine': platform.machine(),
        'commands': receipts, 'probe_libraries': [{'path': lib, 'sha256': digest(pathlib.Path(lib))},
            {'path': serde, 'sha256': digest(pathlib.Path(serde))}],
        'focused_suite_exit': done.returncode,
        'note': 'Harness passes and skips separately counted; probe mismatches are audit findings, not runner failures.'}
    (HERE / 'execution.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'cases': len(observations), 'mismatches': [o['id'] for o in observations
        if o['process_exit'] != 0 or any(not a['pass'] for a in o['assertions'])],
        'focused_suite_exit': done.returncode}))

if __name__ == '__main__':
    main()
