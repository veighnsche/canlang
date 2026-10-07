#!/usr/bin/env python3
"""Check planning records and frozen source references; never run product code."""
import collections
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]

def load(path):
    return json.loads(path.read_text())

def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

def main():
    checks = []
    def check(name, condition):
        checks.append({'check': name, 'passed': bool(condition)})

    queue = load(HERE / 'queue.json')
    coverage = load(HERE / 'coverage.json')
    owners = load(HERE / 'owner-conflicts.json')
    pins = load(HERE / 'source-hashes.json')
    ledger = load(ROOT / 'implementation/remaining-work/tasks.json')['tasks']
    canonical = {t['id']: t for t in ledger}
    packets = {p['id']: p for p in queue['packets']}
    check('48 unique finite packet labels; no canonical task creation', len(packets) == len(queue['packets']) == 48)
    check('planning only and all packet execution disabled', not queue['execution_authorized'] and all(not p['execution_authorized'] for p in packets.values()))
    check('ready/blocked/deferred counts match records', dict(collections.Counter(p['status'] for p in packets.values())) == queue['counts'])
    check('all packet existing IDs resolve exactly', all(i in canonical for p in packets.values() for i in p['existing_task_ids']))
    check('original packet statuses and prerequisites preserved', all(r['status_snapshot'] == canonical[r['id']]['status'] and r['depends_on_preserved'] == canonical[r['id']]['depends_on'] and r['original_acceptance_preserved'] for p in packets.values() for r in p['canonical_task_references']))
    check('all 333 original identities accounted once', len(coverage['canonical_tasks']) == 333 and {r['id'] for r in coverage['canonical_tasks']} == set(canonical))
    check('original full ledger statuses and prerequisites preserved', all(r['status_preserved'] == canonical[r['id']]['status'] and r['depends_on_preserved'] == canonical[r['id']]['depends_on'] for r in coverage['canonical_tasks']))
    ideal = load(ROOT / 'docs/ideal-filetree-plan/finished-product/tasks.json')['tasks']
    ideal_ids = {t['namespace'] + ':' + t['id'] for t in ideal}
    check('323 ideal DAG identities remain present in canonical universe', len(ideal_ids) == 323 and ideal_ids <= set(canonical))
    duties = load(ROOT / 'docs/ideal-filetree-plan/finished-product/requirements.json')['duties']
    check('114 duties accounted once', len(coverage['finished_product_duties']) == 114 and {r['id'] for r in coverage['finished_product_duties']} == {r['id'] for r in duties})
    by_source = {t['source_id']: t['id'] for t in ledger}
    dc = {r['id']: r for r in coverage['finished_product_duties']}
    check('duty disposition and original ID crosswalk preserved', all(dc[d['id']]['original_disposition'] == d['disposition'] and dc[d['id']]['existing_task_ids'] == [by_source[i] for i in d.get('task_ids', [])] for d in duties))
    audit = ROOT / 'docs/research/package-library-audit-20261006'
    responsibilities = jsonl(audit / 'responsibility-callers/responsibilities.jsonl')
    contracts = jsonl(audit / 'required-behavior/contracts.jsonl')
    dispositions = jsonl(audit / 'integration-dispositions/dispositions.jsonl')
    check('316 responsibilities accounted once', len(coverage['responsibilities']) == 316 and {r['id'] for r in coverage['responsibilities']} == {r['id'] for r in responsibilities})
    check('400 behavior contracts accounted once', len(coverage['behavior_contracts']) == 400 and {r['id'] for r in coverage['behavior_contracts']} == {r['id'] for r in contracts})
    check('76 dispositions accounted without unallocated proposal', len(coverage['dispositions']) == 76 and {r['id'] for r in coverage['dispositions']} == {r['id'] for r in dispositions} and all(r['disposition'] != 'unallocated-proposal' for r in coverage['dispositions']))
    check('DR08 aliases DC-01, no second obligation', coverage['aliases'] == [{'alias': 'DR08', 'target': 'DC-01', 'meaning': 'one candidate, not two obligations'}])
    check('69 overlay groups routed, not added as canonical tasks', len(coverage['audit_groups']) == 69 and all(g['packet_refs'] or g['external_components'] for g in coverage['audit_groups']))
    expected_raw = []
    for rel in ['data-protocol/witnesses.jsonl', 'control-lifecycle/resources.jsonl', 'security-limits/findings.jsonl', 'security-limits/enforcement.jsonl', 'tests-evidence/claims.jsonl', 'dependency-runtime/execution-matrix.jsonl']:
        expected_raw.extend((str((audit / rel).relative_to(ROOT)), r['id']) for r in jsonl(audit / rel))
    check('308 raw records accounted once by namespace/source', len(coverage['raw_records']) == len(expected_raw) == 308 and {(r['source'], r['id']) for r in coverage['raw_records']} == set(expected_raw))
    check('one primary remedy for every security finding', all(r['primary_remedy_packet'] in packets for r in coverage['raw_records'] if r['source'].endswith('security-limits/findings.jsonl')))
    check('existing file and read-only input paths resolve', all((ROOT / f).is_file() for p in packets.values() for f in p['existing_files'] + p.get('read_only_consumer_inputs', [])))
    check('new file allocations are proposals, not already implemented APIs', all(not (ROOT / f).exists() for p in packets.values() for f in p['new_files_proposal_only']))
    check('frozen input/source hashes still match', all((ROOT / f['path']).is_file() and hashlib.sha256((ROOT / f['path']).read_bytes()).hexdigest() == f['sha256'] for f in pins['files']))
    check('dependency references resolve', all(d in packets for p in packets.values() for d in p['depends_on_packets'] + p['acceptance_dependencies']))
    positions = {i: n for n, i in enumerate(queue['topological_order'])}
    check('topological order is complete and acyclic', set(positions) == set(packets) and all(positions[d] < positions[p['id']] for p in packets.values() for d in p['depends_on_packets']))
    check('all conflicts are exact files/current successor IDs', all((ROOT / r['file']).is_file() or any(r['file'] in p['new_files_proposal_only'] for p in packets.values()) for r in owners['exact_file_conflicts']) and all(i in packets for r in owners['exact_file_conflicts'] for i in r['packet_refs']))
    check('no live owner ACK claimed', owners['acknowledgments_claimed'] is False and all('proposed' in p['owner_lease']['state'] for p in packets.values()))
    check('no fabricated future production reductions', all(p['expected_production_reduction']['readable_lines'] is None and p['expected_production_reduction']['total_implementation_and_declarations'] is None for p in packets.values()))
    check('replacement strict reduction and independent correctness budget explicit', 'Strictly reduce both' in queue['common_gates']['replacement_only'] and 'Separate scope/budget' in queue['common_gates']['correctness'])
    check('security approval/HOLD/compiler boundaries explicit', 'approval-pending' in queue['common_gates']['security'] and 'HOLD' in queue['common_gates']['native_preparation'] and 'compiler' in queue['common_gates']['ownership'])
    result = {'mode': 'planning metadata/source validation only; no product build/test/runtime', 'base': queue['base'], 'checks': checks, 'passed': sum(c['passed'] for c in checks), 'total': len(checks)}
    (HERE / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'total': result['total'], 'failed': [c['check'] for c in checks if not c['passed']]}))
    return 0 if result['passed'] == result['total'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
