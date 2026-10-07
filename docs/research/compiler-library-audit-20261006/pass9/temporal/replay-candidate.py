from pathlib import Path
import json, os, shutil, subprocess
here = Path(__file__).resolve().parent
scratch = Path('/private/tmp/canlang-pass9-temporal-candidate')
(scratch / 'src').mkdir(parents=True, exist_ok=True)
shutil.copy(here / 'candidate-Cargo.toml', scratch / 'Cargo.toml')
shutil.copy(here / 'candidate-Cargo.lock', scratch / 'Cargo.lock')
shutil.copy(here / 'candidate.rs', scratch / 'src/main.rs')
env = dict(os.environ, CARGO_TARGET_DIR='/private/tmp/canlang-pass5-profile/current-native-target', CARGO_BUILD_JOBS='1', CARGO_INCREMENTAL='0')
subprocess.run(['cargo', 'build', '--offline', '--locked', '--manifest-path', str(scratch / 'Cargo.toml')], env=env, check=True)
vectors = json.loads((here / 'vectors.json').read_text())
inputs = ''.join(f"{v['id']}\t{v['kind']}\t{v['text'].encode().hex()}\n" for v in vectors)
result = subprocess.run([env['CARGO_TARGET_DIR'] + '/debug/canlang-pass9-temporal-candidate'], input=inputs, text=True, capture_output=True, check=True)
(here / 'candidate-outcomes.txt').write_text(result.stdout)
lines = result.stdout.splitlines()
assert len(lines) == len(vectors)
for vector, line in zip(vectors, lines):
    adapted = line.split('\t')[-1]
    assert adapted.startswith('Ok(') == vector['expected'], line
    if vector['expected_ms'] is not None:
        assert adapted == f"Ok({vector['expected_ms']})", line
print('43 candidate adapter outcomes match fixed expectations; primitive outcomes saved separately in each line.')
