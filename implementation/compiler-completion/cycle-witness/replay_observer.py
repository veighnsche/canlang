#!/usr/bin/env python3
"""Run the retained real-compiler observer in finite fresh processes."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('target_debug', type=Path)
parser.add_argument('label')
parser.add_argument('--processes', type=int, default=24)
args = parser.parse_args()
ev = Path(__file__).resolve().parent
exe = Path('/private/tmp') / f'canlang-cycle-witness-probe-{args.label}'
command = ['rustc', '--edition=2024', str(ev/'compiler_probe.rs'), '--extern',
           f'canlang_compiler={args.target_debug}/libcanlang_compiler.rlib', '-L',
           f'dependency={args.target_debug}/deps', '-o', str(exe)]
result = subprocess.run(command, capture_output=True, text=True)
(ev/f'{args.label}-probe-build.stdout').write_text(result.stdout)
(ev/f'{args.label}-probe-build.stderr').write_text(result.stderr)
if result.returncode:
    raise SystemExit(result.returncode)
runs = []
for i in range(args.processes):
    result = subprocess.run([str(exe)], capture_output=True, text=True)
    (ev/f'{args.label}-process-{i+1:02}.stdout').write_text(result.stdout)
    (ev/f'{args.label}-process-{i+1:02}.stderr').write_text(result.stderr)
    cases = {}
    current = ''
    for line in result.stdout.splitlines():
        if line.startswith('CASE '):
            current = line[5:]
            cases[current] = []
        else:
            cases[current].append(line)
    runs.append({'process': i+1, 'exit': result.returncode, 'cases': cases})
summary = {name: sorted({tuple(run['cases'][name]) for run in runs})
           for name in runs[0]['cases']}
(ev/f'{args.label}-reproduction.json').write_text(json.dumps({
    'build_command': command, 'exe_sha256': hashlib.sha256(exe.read_bytes()).hexdigest(),
    'runs': runs, 'distinct_diagnostics': summary,
}, indent=2)+'\n')
print(json.dumps({name: len(sets) for name, sets in summary.items()}))
