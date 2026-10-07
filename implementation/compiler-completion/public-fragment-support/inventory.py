"""Read-only scoped public support inventory; never builds or changes compiler inputs."""
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent
owners = ['JsNominalLeaf', 'JsNominalResult', 'JsDeliveryDescriptor', 'JsMcpField',
          'JsServerInit', 'JsFieldDefault', 'JsOperationField', 'JsOperation',
          'JsModelFieldType', 'JsModelField', 'JsModel']
targets = []
for path, names in [('compiler/src/codegen/js.rs', owners),
                    ('compiler/src/lint/driver.rs', [])]:
    text = (ROOT / path).read_text()
    starts = [(name + '::to_json', re.search(r'impl ' + name + r' \{.*?    pub fn to_json', text, re.S).end() - len('    pub fn to_json')) for name in names]
    free = ['models_json'] if names else ['fix_to_json', 'fixes_to_json', 'rejected_to_json']
    starts += [(name, re.search(r'pub fn ' + name + r'\(', text).start()) for name in free]
    for name, start in starts:
        body = text.index('{', start)
        depth, end = 1, body + 1
        while depth:
            depth += (text[end] == '{') - (text[end] == '}')
            end += 1
        first, last = text.count('\n', 0, start) + 1, text.count('\n', 0, end) + 1
        targets.append(dict(name=name, path=path, first=first, last=last,
                            inclusive_body_lines=last-first+1,
                            text=text[start:end]))
assert sum(t['inclusive_body_lines'] for t in targets[:12]) == 41
assert sum(t['inclusive_body_lines'] for t in targets[12:]) == 9
# Superset search captures all method syntax candidates, imports/free calls, and owning types.
# Method candidates in docs/foundation/reference tests are other owners, retained for challenge.
patterns = r'\.to_json\s*\(|\b(?:models_json|operations_json|fix_to_json|fixes_to_json|rejected_to_json)\b|\b(?:' + '|'.join(owners) + r')\b'
search = subprocess.run(['rg', '-n', patterns, 'compiler', '--glob', '*.rs', '--glob', '!target/**'], cwd=ROOT, text=True, capture_output=True)
assert search.returncode == 0
(OUT / 'caller-search.txt').write_text(search.stdout)
paths = ['compiler/src/lib.rs', 'compiler/src/codegen/mod.rs', 'compiler/src/codegen/js.rs',
         'compiler/src/codegen/artifact.rs', 'compiler/src/lint/mod.rs', 'compiler/src/lint/driver.rs',
         'compiler/src/cli.rs', 'compiler/src/json.rs', 'compiler/Cargo.toml', 'compiler/Cargo.lock',
         'compiler/tests/typed_descriptors.rs', 'compiler/tests/typed_fixes.rs',
         'compiler/tests/typed_fixes_cli.rs', 'compiler/tests/codegen.rs', 'compiler/tests/b3_s4.rs',
         'packages/contracts/src/artifact.ts', 'packages/cloudflare/src/runtime/artifact.ts',
         'docs/research/compiler-library-audit-20261006/responsibility-map/integrations.md',
         'docs/research/compiler-library-audit-20261006/responsibility-map/output-evidence/serialization-notes.md',
         'docs/research/compiler-library-audit-20261006/responsibility-map/output-evidence/suites-execution.json',
         'implementation/compiler-completion/docs-support/README.md',
         'implementation/compiler-completion/map-support/decision.md']
pins = {p: dict(sha256=hashlib.sha256((ROOT/p).read_bytes()).hexdigest(), bytes=(ROOT/p).stat().st_size) for p in paths}
# Complete compiler source/test/manifests pins make current scope explicit without relabelling old audit.
compiler_inputs = sorted(set((ROOT/'compiler/src').rglob('*.rs')) | set((ROOT/'compiler/tests').rglob('*.rs')) | {ROOT/'compiler/Cargo.toml', ROOT/'compiler/Cargo.lock'})
allpins = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in compiler_inputs}
result = dict(packet='integration:public-descriptor-fix-fragments', disposition='retain',
              acceptance='submitted for independent root review', production_added=0, production_deleted=0,
              net_production_deleted=0, public_entrypoints_retired=0, targets=targets,
              source_pins=pins, compiler_inputs=allpins, compiler_input_count=len(allpins),
              caller_search_sha256=hashlib.sha256(search.stdout.encode()).hexdigest(),
              execution='No cargo build or suite; inventory only. Historical output evidence remains historical.')
(OUT/'inventory.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps({'target_count': len(targets), 'js_body_lines':41, 'fix_body_lines':9,
                  'compiler_input_count':len(allpins), 'disposition':'retain', 'net_production_deleted':0}))
