"""Replay actual CLI boundaries; also retain failure of the pre-repair oracle."""
from pathlib import Path
import hashlib, json, subprocess, difflib
ROOT = Path(__file__).resolve().parents[3]
PACKET = Path(__file__).resolve().parent
FIXTURES = ROOT / 'compiler/tests/fixtures/corpus-admission'

def write(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')

def invoke(command, fixture):
    result = subprocess.run([str(ROOT / 'compiler/target/debug/can'), command,
        '--format=json', '--catalog=' + str(ROOT / 'packages/values/dist/catalog.json'),
        str(fixture)], cwd=ROOT, capture_output=True, text=True, timeout=10)
    return {'exit':result.returncode, 'stdout':result.stdout, 'stderr':result.stderr}

failures = []
for name, before_name in [('local','local.final-fixture.compile.json'),
                         ('foreign','foreign.legal.compile.json'),
                         ('missing','missing.compile.json')]:
    raw = json.loads((PACKET / 'before' / before_name).read_text())
    try:
        assert raw['exit'] == 10, 'compile must refuse unsupported Corpus with exit 10'
        envelope = json.loads(raw['stdout'])
        assert envelope['diagnostics'][0]['code'] == 'E6008'
        assert 'artifact_version' not in envelope
    except AssertionError as error:
        failures.append({'fixture':name, 'oracle':'compile refuses unsupported Corpus',
                         'failure':str(error), 'actual_exit':raw['exit'],
                         'raw_record':'before/' + before_name})
write(PACKET / 'before' / 'failed-admission-oracles.json', failures)
assert len(failures) == 3

for fixture in sorted(FIXTURES.glob('*.can')):
    for command in ['check','compile']:
        raw = invoke(command, fixture)
        write(PACKET / 'after' / (fixture.stem + '.' + command + '.json'), raw)
        expected = 10 if fixture.stem == 'bare' or (
            command == 'compile' and fixture.stem in ['local','foreign','missing','judgment']) else 0
        assert raw['exit'] == expected, raw
        if command == 'compile' and fixture.stem in ['local','foreign','missing']:
            envelope = json.loads(raw['stdout'])
            assert envelope['diagnostics'][0]['code'] == 'E6008'
            assert 'artifact_version' not in envelope
            assert 'modules' not in envelope
        print(fixture.stem, command, raw['exit'])

files = sorted((ROOT / 'compiler/src').rglob('*.rs'))
for stage in ['before','after']:
    pins = {}
    for file in files:
        data = (PACKET / 'before/ir.rs').read_bytes() if stage == 'before' and file.name == 'ir.rs' and file.parent.name == 'codegen' else file.read_bytes()
        pins[str(file.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
    write(PACKET / stage / 'source-pins.json', {'count':len(pins), 'files':pins})
before = (PACKET / 'before/ir.rs').read_text()
after = (ROOT / 'compiler/src/codegen/ir.rs').read_text()
(PACKET / 'source.patch').write_text(''.join(difflib.unified_diff(before.splitlines(True),
    after.splitlines(True), fromfile='compiler/src/codegen/ir.rs.before', tofile='compiler/src/codegen/ir.rs')))
write(PACKET / 'after/pins.json', {'ir_sha256':hashlib.sha256(after.encode()).hexdigest(),
    'binary_sha256':hashlib.sha256((ROOT / 'compiler/target/debug/can').read_bytes()).hexdigest()})
