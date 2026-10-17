#!/usr/bin/env python3
"""Capture a read-only boundary check against the current checkout."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import re


def protected_hashes(root):
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    result = {}
    prefixes = ('packages/', 'compiler/', 'tools/', '.github/', 'editors/')
    roots = {'package.json', 'bun.lock', 'tsconfig.base.json', 'tsconfig.check.json',
             'vitest.config.ts', 'playwright.config.ts'}
    for name in paths:
        if not (name.startswith(prefixes) or name in roots):
            continue
        path = root / name
        if path.is_file():
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def diagnostics(stdout, stderr):
    items = []
    for block in re.split(r'(?m)^\s*x ', stderr)[1:]:
        site = re.search(r'\[(/[^\n]+):(\d+):(\d+)\]', block)
        heading = block[:site.start()] if site else block.splitlines()[0]
        message = ' '.join(line.strip().lstrip('|').strip() for line in heading.splitlines()
                           if line.strip() and not line.lstrip().startswith(','))
        kind = ('undeclared-package' if message.startswith('cannot import package ')
                else 'outside-package' if message.endswith('leaves the package')
                else 'other')
        items.append({'message': message, 'kind': kind,
                      'path': site.group(1) if site else None,
                      'line': int(site.group(2)) if site else None,
                      'column': int(site.group(3)) if site else None})
    total = re.search(r'Checked (\d+) files in (\d+) packages, (\d+) issues found', stdout)
    summary = {'parsed_diagnostics': len(items),
               'counts': dict(Counter(item['kind'] for item in items)),
               'scope': 'Workspace tests included; root tooling, non-workspace editor, native source '
                        'and unsupported loading forms excluded from complete coverage.'}
    if total:
        summary.update(dict(zip(['reported_checked_files', 'reported_packages', 'reported_issues'],
                                map(int, total.groups()))))
        if summary['reported_issues'] != len(items):
            raise ValueError('Diagnostic parsing does not match the CLI issue total.')
    return {'summary': summary, 'diagnostics': items}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--turbo', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, required=True)
    args = parser.parse_args()
    out = Path(__file__).resolve().parent / 'repository'
    out.mkdir(parents=True, exist_ok=True)
    args.scratch.mkdir(parents=True, exist_ok=True)
    config = args.scratch / 'turbo.json'
    config.write_text(json.dumps({'tasks': {}}) + '\n')
    (out / 'turbo.json').write_text(config.read_text())
    before = protected_hashes(args.root)
    command = [str(args.turbo), '--skip-infer', '--no-update-notifier', '--no-color',
               '--root-turbo-json', str(config), 'boundaries']
    env = os.environ.copy()
    env['TURBO_TELEMETRY_DISABLED'] = '1'
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=args.root, env=env,
                                capture_output=True, text=True, timeout=55)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
        timed_out = False
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or b''
        stderr = error.stderr or b''
        stdout = stdout.decode(errors='replace') if isinstance(stdout, bytes) else stdout
        stderr = stderr.decode(errors='replace') if isinstance(stderr, bytes) else stderr
        code, timed_out = None, True
    after = protected_hashes(args.root)
    changed = sorted(name for name in before.keys() | after.keys()
                     if before.get(name) != after.get(name))
    (out / 'stdout.txt').write_text(stdout)
    (out / 'stderr.txt').write_text(stderr)
    parsed = diagnostics(stdout, stderr)
    (out / 'diagnostics.json').write_text(json.dumps(parsed, indent=2) + '\n')
    (out / 'protected-source-hashes.json').write_text(json.dumps(before, indent=2) + '\n')
    record = {'command': command, 'cwd': str(args.root), 'exit_code': code,
              'timed_out': timed_out, 'elapsed_seconds': round(time.monotonic() - started, 3),
              'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.root,
                                             text=True).strip(),
              'protected_files': len(before), 'changed_protected_files': changed,
              'stdout_bytes': len(stdout.encode()), 'stderr_bytes': len(stderr.encode()),
              'diagnostics': parsed['summary'],
              'scope': 'Native flags off; package-boundary diagnostics only; no task/build execution'}
    (out / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))
    if changed:
        raise SystemExit('Protected source changed during the probe; investigate before reporting.')


if __name__ == '__main__':
    main()
