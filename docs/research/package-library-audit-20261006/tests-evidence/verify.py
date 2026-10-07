"""Read-only audit consistency checks; no product tests, builds or runtime."""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys

sys.dont_write_bytecode = True
from inventory import inventory

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
load = lambda name: json.loads((HERE / name).read_text())
checks = []


def check(name, condition, detail=None):
    checks.append({'check': name, 'passed': bool(condition), 'detail': detail})


sources = load('sources.json')
by_path = {r['path']: r for r in sources['records']}
source_errors = []
for row in sources['records']:
    p = ROOT / row['path']
    if not p.is_file():
        source_errors.append([row['path'], 'missing'])
        continue
    body = p.read_bytes()
    if len(body) != row['bytes'] or hashlib.sha256(body).hexdigest() != row['sha256']:
        source_errors.append([row['path'], 'identity'])
check('187 unique indexed source/receipt identities', len(by_path) == len(sources['records']) == 187 and not source_errors, source_errors)
raw = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
                              input=''.join(sources['freeze'] + ':' + r['path'] + '\n' for r in sources['records']).encode())
stream = io.BytesIO(raw)
frozen_errors = []
for row in sources['records']:
    header = stream.readline().decode().split()
    if len(header) != 3 or header[1] != 'blob':
        frozen_errors.append([row['path'], 'missing frozen blob'])
        continue
    body = stream.read(int(header[2]))
    assert stream.read(1) == b'\n'
    if hashlib.sha256(body).hexdigest() != row['sha256'] or len(body) != row['bytes']:
        frozen_errors.append(row['path'])
check('indexed bytes correspond to immutable source freeze', not frozen_errors, frozen_errors)

claims = [json.loads(line) for line in (HERE / 'claims.jsonl').read_text().splitlines()]
claim_ids = {x['id'] for x in claims}
check('42 unique challenges preserve source/proposal limits', len(claim_ids) == len(claims) == 42 and all(x['original_ids'] and x['opposing_evidence'] and x['witness_executed_this_audit'] is False and x['implementation_authorized'] is False and x['acceptance_changed'] is False for x in claims))
counter = load('counter-review.json')
check('opposing review covers all29 Values/Work+State/Identity claim IDs', len(counter['reviewed_claim_ids']) == 29 and set(counter['reviewed_claim_ids']) == {i for i in claim_ids if i.startswith(('TEW', 'TEI'))})
anchor_errors, anchor_count = [], 0
for group in [x['anchors'] for x in claims] + [x['anchors'] for x in counter['reviews']]:
    for anchor in group:
        anchor_count += 1
        if anchor['path'] not in by_path:
            anchor_errors.append([anchor, 'unknown path'])
            continue
        lines = len((ROOT / anchor['path']).read_bytes().splitlines())
        if not 1 <= anchor['line'] <= anchor['end_line'] <= lines:
            anchor_errors.append([anchor, lines])
check('primary source anchor bounds', not anchor_errors, {'positions': anchor_count, 'errors': anchor_errors})
check('five opposing qualifications applied and delivery scope narrowed', all('root_qualification' in next(x for x in claims if x['id'] == i) for i in ('TEW01','TEW04','TEW06','TEI10','TEI11')) and 'root_narrowing' in next(x for x in claims if x['id']=='TE01'))

plan = load('focused-verification.json')
tasks = plan['tasks']
ids = [t['id'] for t in tasks]
check('17 finite verification groups cover all42 challenges', len(ids)==len(set(ids))==17 and {r for t in tasks for r in t['claim_refs']} == claim_ids)
check('dependency references exist and precede dependent group', all(d in ids and ids.index(d) < ids.index(t['id']) for t in tasks for d in t['depends_on']))
required = ('producer','actual_consumer','independent_oracle','negative_witnesses','readiness_gate','observable_acceptance','acceptance_limit')
check('every proposed group has independent chain, counterexample and finite limit', all(all(t.get(k) for k in required) and t['execution_authorized'] is False for t in tasks))
check('economical model/effort recheck at every finite dispatch', all(t['economical_model']['model'] in ('Sol','Luna') and t['economical_model']['reasoning'] in ('medium','high') and t['economical_model']['reason'] and t['economical_model']['recheck_at_dispatch'] is True for t in tasks))
cleanup = load('cleanup.json')
check('10 gated cleanup groups reference valid claims', len(cleanup['items']) == 10 and len({r['id'] for r in cleanup['items']})==10 and all(r['retention_gate'] and all(i in claim_ids for i in r['claim_refs']) for r in cleanup['items']) and cleanup['implementation_authorized'] is False)

expected = load('inventory-summary.json')
actual = inventory(sources['freeze'])
check('frozen mechanical inventory reproducible including ordered record digest', all(actual[k] == expected[k] for k in ('pin','summary','top20_files','exact_duplicate_groups','repeated_json_arrays','large_array_sections','records_canonical_json_sha256')))
check('metadata selection is packages/orchestration only', all(r['path'].startswith(('packages/','implementation/rust-port-orchestration/runs/')) and not any('/'+x+'/' in r['path'] for x in ('dist','target','node_modules','.turbo')) for r in actual['records']))
check('770 exact duplicate bytes and6 repeated top-level JSON arrays remain distinct', actual['summary']['exact_redundant_bytes']==770 and actual['summary']['substantive_repeated_json_arrays']==6)
v = json.loads((ROOT/'packages/values/conformance/numeric-text.json').read_text())
w = json.loads((ROOT/'packages/work-kernel/conformance/fixtures/numeric-text.json').read_text())
projection = expected['numeric_primitive_projection']
project = lambda data: [{k: row[k] for k in projection['fields']} for row in data['numbers']]
vp, wp = project(v), project(w)
check('10213 ordered numeric primitive rows equal;131/72 caller rows separate', vp==wp and len(vp)==10213 and len(v['callers'])==131 and len(w['callers'])==72 and hashlib.sha256(json.dumps(vp, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()==projection['sha256'])
scope = load('scope.json')
check('all13 package owners, implementation/runtime/policy/checkpoint deferred', len(scope['packages'])==13 and all(scope[k] is False for k in ('implementation_authorized','product_execution','dependency_installation','package_changes','canonical_task_status_changes','accepted_policy_changes','merge_or_filetree_checkpoint_advance')))
link_errors, link_count = [], 0
for path in HERE.glob('*.md'):
    for dest in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if dest.startswith(('http:', 'https:', '#')):
            continue
        link_count += 1
        dest = re.sub(r':\d+$', '', dest.split('#')[0])
        if not (path.parent/dest).resolve().exists():
            link_errors.append([path.name,dest])
check('local document/source links exist', not link_errors, {'links':link_count,'errors':link_errors})
result = {'passed': all(c['passed'] for c in checks), 'checks': checks,
          'limits': 'Source/Git/hash/JSON/anchor/dependency/document consistency only; no product tests, runtime, build, install, deployment or new acceptance.'}
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['passed'] else 1)
