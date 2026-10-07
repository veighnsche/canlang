#!/usr/bin/env python3
"""Exit-checked final unknown-commit release build for Pass10 evidence."""
import hashlib, json, os, pathlib, shutil, subprocess, time
repo = pathlib.Path('/Users/vince/Projects/canlang')
source = pathlib.Path('/private/tmp/canlang-pass10-profile/sources/final/compiler/Cargo.toml')
target = pathlib.Path('/private/tmp/canlang-pass5-profile/current-native-target')
out = pathlib.Path('/private/tmp/canlang-pass10-profile/artifacts/native/final-can')
log = pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass10/profile/logs/native-final-exitchecked.log')
command = ['cargo', 'build', '--release', '--manifest-path', str(source), '--target-dir', str(target), '--offline', '--locked']
env = dict(os.environ, CARGO_HOME='/private/tmp/canlang-pass5-profile/cargo-home', CARGO_BUILD_JOBS='1', CARGO_INCREMENTAL='0')
start = time.perf_counter()
run = subprocess.run(command, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
elapsed = time.perf_counter() - start
log.write_text(run.stdout)
if run.returncode != 0:
    raise SystemExit(f'Cargo release build failed with exit {run.returncode}; see {log}')
shutil.copy2(target/'release/can', out)
def check(args, output_path):
    p = subprocess.run([str(out), *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output_path.write_text(p.stdout)
    if p.returncode != 0:
        raise SystemExit(f'{args} failed with exit {p.returncode}')
    return p.returncode
version = pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass10/profile/logs/native-final-version.txt')
help_out = pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass10/profile/logs/native-final-help.txt')
check(['--version'], version)
check(['--help'], help_out)
b = out.read_bytes()
result = {'command': command, 'env': {'CARGO_HOME': env['CARGO_HOME'], 'CARGO_BUILD_JOBS': 1, 'CARGO_INCREMENTAL': 0}, 'cargo_exit': run.returncode, 'elapsed_seconds': elapsed, 'artifact': str(out), 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest(), 'version': version.read_text().strip(), 'version_exit': 0, 'help_exit': 0}
pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass10/profile/native-final-retry-results.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result, indent=2))
