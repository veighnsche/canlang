#!/usr/bin/env python3
"""Additional fresh stage witnesses and corpus projection; does not rerun passed suites."""
import collections
import hashlib
import json
import pathlib
import subprocess
import tempfile
from run import HERE, ROOT, digest, invoke

def main():
    prior = json.loads((HERE / 'execution.json').read_text())
    for pin in prior['probe_libraries']:
        assert digest(pathlib.Path(pin['path'])) == pin['sha256'], pin
    lib, serde = [p['path'] for p in prior['probe_libraries']]
    receipts, extra, corpus = [], [], []
    with tempfile.TemporaryDirectory(prefix='can-step7-extra-') as scratch:
        scratch = pathlib.Path(scratch)
        exe = scratch / 'probe'
        done, rec = invoke('extra-compile-probe', ['rustc', '--edition=2024', str(HERE / 'probe.rs'),
            '--extern', 'canlang_compiler=' + lib, '--extern', 'serde_json=' + serde,
            '-L', 'dependency=' + str(ROOT / 'compiler/target/debug/deps'), '-o', str(exe)])
        receipts.append(rec)
        assert done.returncode == 0, rec
        for case in json.loads((HERE / 'extra-cases.json').read_text()):
            source = scratch / (case['id'] + '.can')
            source.write_text(case['source'])
            done, rec = invoke('extra-' + case['id'], [str(exe), str(source),
                str(ROOT / 'packages/values/dist/catalog.json'), str(ROOT)])
            receipts.append(rec)
            extra.append({'id': case['id'], 'process_exit': done.returncode,
                'source_sha256': digest(source), 'observation': rec['stdout']})
            if case.get('cli'):
                for command in ['check', 'compile']:
                    done, rec = invoke('cli-' + command + '-' + case['id'],
                        [str(ROOT / 'compiler/target/debug/can'), command, '--format=json',
                         '--catalog', str(ROOT / 'packages/values/dist/catalog.json'), str(source)])
                    receipts.append(rec)
        for source in sorted(list((ROOT / 'examples').rglob('*.can')) + list((ROOT / 'draft').rglob('*.can'))):
            done = subprocess.run([str(exe), str(source), str(ROOT / 'packages/values/dist/catalog.json'),
                str(ROOT)], cwd=ROOT, capture_output=True)
            row = {'path': str(source.relative_to(ROOT)), 'source_sha256': digest(source),
                'argv': [str(exe), str(source), str(ROOT / 'packages/values/dist/catalog.json'), str(ROOT)],
                'exit': done.returncode, 'stdout_sha256': hashlib.sha256(done.stdout).hexdigest(),
                'stdout_bytes': len(done.stdout), 'stderr': done.stderr.decode(errors='replace')}
            if done.returncode == 0:
                observed = json.loads(done.stdout)
                row.update({k: observed[k] for k in ['byte_admission', 'coverage', 'parse_codes',
                    'modules', 'effect_table_counts']})
                row['syntax_kind_counts'] = dict(collections.Counter(n['kind'] for n in observed['nodes']))
                row['analysis'] = observed['analysis']
                e = observed['emission']
                row['emission'] = e if isinstance(e, str) else {k: e[k] for k in ['codes', 'diagnostics']}
                if isinstance(e, dict):
                    row['emission']['artifact_counts'] = {key: len(e['artifact'][key]) for key in
                        ['modules', 'models', 'callables', 'operations', 'pages', 'migrations', 'tests']}
            else:
                row['stdout_on_failure'] = done.stdout.decode(errors='replace')
            corpus.append(row)
    done, rec = invoke('syntax-inline-tests', ['cargo', 'test', '--locked', '--offline',
        '--manifest-path', 'compiler/Cargo.toml', '--lib', 'syntax::', '--', '--nocapture'])
    receipts.append(rec)
    (HERE / 'extra-observations.json').write_text(json.dumps(extra, indent=2) + '\n')
    (HERE / 'corpus-observations.json').write_text(json.dumps({'scope':
        'Projection of fresh public parse/check/clean-result emission. Complete artifacts/JS are not retained for corpus; process exits, input and raw stdout hashes plus diagnostic/state projection are preserved. No corpus JS executed.',
        'files': corpus}, ensure_ascii=False, indent=2) + '\n')
    (HERE / 'extra-execution.json').write_text(json.dumps({'commands': receipts,
        'observer_sha256': digest(HERE / 'probe.rs'), 'case_manifest_sha256': digest(HERE / 'extra-cases.json'),
        'source_compiler_sha256': digest(ROOT / 'compiler/target/debug/can'),
        'prior_libraries_checked_equal': prior['probe_libraries']}, indent=2) + '\n')
    print(json.dumps({'extra_cases': len(extra), 'corpus_files': len(corpus),
        'corpus_process_failures': [c['path'] for c in corpus if c['exit'] != 0],
        'inline_suite_exit': done.returncode}))

if __name__ == '__main__':
    main()
