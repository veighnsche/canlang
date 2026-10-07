import datetime, hashlib, json, resource, subprocess, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PINS = json.loads((HERE / 'pins.json').read_text())
results = []
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def no_core(): resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
def run(name, command):
    start = time.monotonic()
    p = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=120, preexec_fn=no_core)
    row = {'name': name, 'command': command, 'exit_code': p.returncode, 'seconds': round(time.monotonic() - start, 3)}
    for channel in ['stdout', 'stderr']:
        path = HERE / (name + '.' + channel)
        path.write_bytes(getattr(p, channel))
        row[channel] = {'path': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size}
    results.append(row)
    return p

receipt = {'recorded_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'scope': '28 tiny public fragment offset-equivariance/refusal controls per native profile, seeded diagnostics, empty MAX, E1008 catalog output; no large source/count or unrelated API claim',
           'source_pins_before': PINS['source_sha256'], 'selected_rlibs': PINS['selected_rlibs'],
           'observer_sha256': sha(HERE / 'probe.rs'), 'runner_sha256': sha(Path(__file__)),
           'rustc': subprocess.check_output(['rustc', '--version', '--verbose'], cwd=ROOT, text=True)}
assert all(sha(ROOT / p) == h for p, h in PINS['source_sha256'].items())
with tempfile.TemporaryDirectory(prefix='can-fragment-independent-') as temp:
    for profile in ['debug', 'release']:
        lib = Path(PINS['selected_rlibs'][profile]['path'])
        assert sha(lib) == PINS['selected_rlibs'][profile]['sha256']
        exe = str(Path(temp) / profile)
        command = ['rustc', '--edition=2024', str(HERE / 'probe.rs'), '--extern', 'canlang_compiler=' + str(lib), '-L', 'dependency=' + str(lib.parent), '-o', exe]
        if profile == 'release': command += ['-C', 'opt-level=z', '-C', 'overflow-checks=off', '-C', 'debug-assertions=off', '-C', 'lto=fat', '-C', 'codegen-units=1']
        p = run(profile + '-observer-build', command)
        if p.returncode: break
        receipt[profile + '_observer_sha256'] = sha(Path(exe))
        p = run(profile + '-observer-controls', [exe])
        if p.returncode: break
receipt['source_pins_after'] = {p: sha(ROOT / p) for p in PINS['source_sha256']}
receipt['sources_stable_during_execution'] = receipt['source_pins_before'] == receipt['source_pins_after']
receipt['results'] = results
(HERE / 'qualification.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'sources_stable': receipt['sources_stable_during_execution'], 'exits': {r['name']: r['exit_code'] for r in results}}))
raise SystemExit(0 if all(r['exit_code'] == 0 for r in results) and len(results) == 4 else 1)
