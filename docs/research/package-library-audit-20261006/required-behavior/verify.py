#!/usr/bin/env python3
"""Verify the frozen behavior audit; do not execute or qualify product code."""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
CLASSES = {
    'product_requirement', 'public_contract', 'persisted_protocol',
    'deliberate_security_policy', 'implementation_accident', 'unresolved_assumption',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    args = parser.parse_args()
    git = lambda *opts: subprocess.check_output(['git', '-C', str(args.repo), *opts])
    facts = json.loads((HERE / 'verification.json').read_text())
    pin = facts['ref']
    sources = json.loads((HERE / 'source-index.json').read_text())
    assert sources['ref'] == pin
    indexed = {item['path']: item for item in sources['inputs']}
    assert len(indexed) == len(sources['inputs']) == facts['frozen_source_inputs']
    tree = {}
    for item in git('ls-tree', '-r', '-z', pin).split(b'\0'):
        if item:
            meta, path = item.split(b'\t', 1)
            if path.decode() in indexed:
                tree[path.decode()] = meta.decode().split()[2]
    assert set(tree) == set(indexed)
    ordered = sorted(tree)
    raw = subprocess.run(
        ['git', '-C', str(args.repo), 'cat-file', '--batch'],
        input=('\n'.join(tree[p] for p in ordered) + '\n').encode(),
        stdout=subprocess.PIPE, check=True,
    ).stdout
    blobs, offset = {}, 0
    for path in ordered:
        end = raw.index(b'\n', offset)
        oid, kind, length = raw[offset:end].decode().split()
        assert oid == tree[path] == indexed[path]['blob'] and kind == 'blob'
        offset = end + 1
        blobs[path] = raw[offset:offset + int(length)]
        offset += int(length) + 1
        assert sha(blobs[path]) == indexed[path]['sha256']
        assert len(blobs[path]) == indexed[path]['bytes']
    duty_path = 'docs/research/package-library-audit-20261006/responsibility-callers/responsibilities.jsonl'
    duties = {row['id']: row for row in map(json.loads, blobs[duty_path].decode().splitlines())}
    records = list(map(json.loads, (HERE / 'contracts.jsonl').read_text().splitlines()))
    rules = {row['id']: row for row in records}
    assert len(records) == len(rules) == facts['classification_records']
    assert dict(sorted(collections.Counter(row['classification'] for row in records).items())) == facts['primary_classification_counts']
    crosswalk = list(csv.DictReader((HERE / 'responsibility-contracts.tsv').open(), delimiter='\t'))
    assert len(crosswalk) == len(duties) == facts['responsibilities']
    assert {row['responsibility_id'] for row in crosswalk} == set(duties)
    assert len({row['owner'] for row in crosswalk}) == facts['owners']
    for row in crosswalk:
        did = row['responsibility_id']
        assert row['owner'] == duties[did]['owner']
        assert row['caller_status'] == duties[did]['caller_status']
        ids = set(filter(None, row['contract_ids'].split(',')))
        assert ids == {r['id'] for r in records if did in r['responsibility_ids']}
        assert row['disposition'], did
    assert sorted(row['responsibility_id'] for row in crosswalk if not row['contract_ids']) == facts['no_extra_product_rule_responsibilities']
    anchors = list(csv.DictReader((HERE / 'authority-index.tsv').open(), delimiter='\t'))
    citations = {row['citation_id']: row for row in anchors}
    assert len(anchors) == len(citations) == facts['unique_citations']
    cited = collections.defaultdict(set)
    roles = collections.defaultdict(set)
    occurrences = 0
    for row in records:
        assert row['classification'] in CLASSES
        assert set(row['additional_classes']) <= CLASSES
        assert set(row['responsibility_ids']) <= set(duties)
        assert row['affected_owners'] == sorted({duties[d]['owner'] for d in row['responsibility_ids']})
        assert row['disposition'] and row['mechanism_freedom']
        assert row['migration']['status'] == 'planning only; no migration authorized or executed'
        for group in ['authority', 'observed_evidence']:
            if group == 'authority':
                assert row[group], (row['id'], group)
            elif not row[group]:
                assert row['no_secondary_observation_reason'], row['id']
            for item in row[group]:
                anchor = citations[item['citation_id']]
                assert item['path'] == anchor['path'] and item['line'] == int(anchor['line'])
                lines = blobs[item['path']].decode().splitlines()
                assert 1 <= item['line'] <= len(lines)
                line = lines[item['line'] - 1]
                assert line.strip() and sha(line.encode()) == anchor['line_sha256']
                if group == 'authority':
                    assert item['stage'] and item['authority_role']
                else:
                    assert item['evidence_role']
                cited[item['citation_id']].add(row['id'])
                roles[item['citation_id']].add(group)
                occurrences += 1
    assert occurrences == facts['citation_occurrences']
    assert set(cited) == set(citations)
    for cid, anchor in citations.items():
        assert cited[cid] == set(anchor['contract_ids'].split(','))
        assert roles[cid] == set(anchor['roles'].split(','))
    review = json.loads((HERE / 'independent-security-review.json').read_text())
    assert review['ref'] == pin and review['reviewed_rules']
    assert facts['security_review']['completed'] is True
    assert len(review['reviewed_rules']) == facts['security_review']['rule_groups']
    assert len(review['findings']) == facts['security_review']['findings']
    security_anchors = list(csv.DictReader((HERE / 'security-citations.tsv').open(), delimiter='\t'))
    security_cited = collections.defaultdict(set)
    security_roles = collections.defaultdict(set)
    security_count = 0
    def check_security_location(rid, role, path, line):
        nonlocal security_count
        lines = blobs[path].decode().splitlines()
        assert 1 <= line <= len(lines) and lines[line - 1].strip()
        security_cited[(path, line)].add(rid)
        security_roles[(path, line)].add(role)
        security_count += 1
    for rule in review['reviewed_rules']:
        for group in ['authority', 'observed_source_evidence']:
            for item in rule[group]:
                check_security_location(rule['id'], group, item['path'], item['line'])
    for finding in review['findings']:
        for value in finding['evidence']:
            path, line = value.rsplit(':', 1)
            check_security_location(finding['id'], 'finding_evidence', path, int(line))
    assert len(security_anchors) == len(security_cited) == facts['security_review']['unique_source_anchors']
    assert security_count == facts['security_review']['citation_occurrences']
    assert len({path for path, line in security_cited}) == facts['security_review']['source_paths']
    for anchor in security_anchors:
        path, line = anchor['path'], int(anchor['line'])
        assert sha(blobs[path].decode().splitlines()[line - 1].encode()) == anchor['line_sha256']
        assert security_cited[(path, line)] == set(anchor['review_ids'].split(','))
        assert security_roles[(path, line)] == set(anchor['roles'].split(','))
    reconciliation = json.loads((HERE / 'security-reconciliation.json').read_text())
    assert reconciliation['ref'] == pin and reconciliation['review_complete']
    assert set(reconciliation['findings_to_records']) == {f['id'] for f in review['findings']}
    for fid, ids in reconciliation['findings_to_records'].items():
        assert ids and set(ids) <= set(rules)
        for rid in ids:
            assert fid in rules[rid]['independent_security_findings']
    assert facts['execution_authorized'] is False and facts['fresh_product_execution'] is False
    assert not git('diff', '--name-only', pin, 'HEAD', '--', 'packages').strip(), 'Package tree changed; source refresh is needed.'
    assert not git('status', '--porcelain', '--untracked-files=all', '--', 'packages').strip(), 'Package overlay needs explicit review.'
    for path, digest in facts['artifact_sha256'].items():
        assert sha((HERE / path).read_bytes()) == digest, path
    changed_inputs = [path for path in ordered if not (args.repo / path).is_file() or sha((args.repo / path).read_bytes()) != indexed[path]['sha256']]
    print(json.dumps({
        'ref': pin, 'classification_records': len(records), 'responsibilities': len(duties),
        'owners': facts['owners'], 'unique_citations': len(anchors),
        'citation_occurrences': occurrences, 'source_inputs_verified': len(blobs),
        'independent_security_rules': len(review['reviewed_rules']),
        'current_package_tree_and_overlay_equal': True,
        'current_nonpackage_inputs_differing_from_pin': changed_inputs,
        'execution_authorized': False, 'fresh_product_execution': False,
    }, sort_keys=True))


if __name__ == '__main__':
    main()
