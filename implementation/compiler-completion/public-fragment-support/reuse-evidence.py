"""Reuse root's actual current tests, verifying all frozen root input hashes."""
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent
BASE = ROOT/'implementation/compiler-completion/integration-after-bindings/after-bdd-ui'
pinpath = BASE/'before-inputs-admission-temporal.json'
pins = json.loads(pinpath.read_text())
changes = [p for p, digest in pins.items() if hashlib.sha256((ROOT/p).read_bytes()).hexdigest() != digest]
assert not changes, changes
logpath = BASE/'full-suite-admission-temporal.log'
log = logpath.read_text()
sections = []
artifacts = {}
for name, count in [('typed_descriptors',6), ('typed_fixes',4), ('typed_fixes_cli',1)]:
    marker = '     Running tests/' + name + '.rs '
    start = log.index(marker)
    end = log.find('     Running ', start+len(marker))
    block = log[start:end if end >= 0 else len(log)]
    assert f'test result: ok. {count} passed; 0 failed' in block
    artifact = re.search(r'\((compiler/target/[^)]+)\)', block).group(1)
    artifacts[artifact] = hashlib.sha256((ROOT/artifact).read_bytes()).hexdigest()
    sections.append(block)
artifacts['compiler/target/debug/can'] = hashlib.sha256((ROOT/'compiler/target/debug/can').read_bytes()).hexdigest()
excerpt = ''.join(sections)
(OUT/'root-test-excerpt.log').write_text(excerpt)
receipt = dict(mode='reuse of root execution; no new build/suite/harness',
               frozen_input_receipt=str(pinpath.relative_to(ROOT)),
               frozen_input_receipt_sha256=hashlib.sha256(pinpath.read_bytes()).hexdigest(),
               root_input_count=len(pins), all_root_inputs_match=True,
               source_log=str(logpath.relative_to(ROOT)),
               excerpt_sha256=hashlib.sha256(excerpt.encode()).hexdigest(),
               current_artifact_sha256=artifacts,
               tests={'typed_descriptors':6,'typed_fixes':4,'typed_fixes_cli':1},
               boundaries='Actual Rust public serializer controls and actual lint CLI typed envelope; no whole artifact runtime/UI/external-client qualification.')
(OUT/'root-test-reuse.json').write_text(json.dumps(receipt, indent=2)+'\n')
print(json.dumps(receipt, indent=2))
