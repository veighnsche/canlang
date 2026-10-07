#!/usr/bin/env python3
"""Verify audit coverage/hashes; do not install or execute product code."""
import argparse
import base64
import collections
import csv
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--external', action='store_true')
    args = parser.parse_args()
    repo = args.repo.resolve()
    git = lambda *opts: subprocess.check_output(['git', '-C', str(repo), *opts])
    facts = json.loads((HERE / 'verification.json').read_text())
    pin = facts['ref']
    records = list(map(json.loads, (HERE / 'assessments.jsonl').read_text().splitlines()))
    assessments = {r['id']: r for r in records}
    assert len(assessments) == len(records) == facts['integration_count'] == 27
    contracts_path = repo / 'docs/research/package-library-audit-20261006/required-behavior/contracts.jsonl'
    assert sha(contracts_path.read_bytes()) == facts['contract_basis']['working_contract_sha256']
    contracts = {r['id']: r for r in map(json.loads, contracts_path.read_text().splitlines())}
    duties_path = repo / 'docs/research/package-library-audit-20261006/responsibility-callers/responsibilities.jsonl'
    duties = {r['id'] for r in map(json.loads, duties_path.read_text().splitlines())}
    finding_ids = {f'LIB-{i:02}' for i in range(1, 26)}
    crosswalk = list(csv.DictReader((HERE / 'finding-crosswalk.tsv').open(), delimiter='\t'))
    assert len(crosswalk) == len(finding_ids) == facts['historical_finding_count']
    assert {r['finding_id'] for r in crosswalk} == finding_ids
    sources = json.loads((HERE / 'source-index.json').read_text())
    assert sources['ref'] == pin
    indexed = {s['path']: s for s in sources['repository_inputs']}
    assert len(indexed) == facts['repository_input_count']
    for path, source in indexed.items():
        raw = git('show', pin + ':' + path)
        assert source['ref'] == pin and sha(raw) == source['sha256'], path
        assert len(raw) == source['bytes']
        assert len(raw.decode().splitlines()) == source['lines']
        assert git('rev-parse', pin + ':' + path).decode().strip() == source['blob']
    upstream = json.loads((HERE / 'upstream-evidence.json').read_text())['items']
    upstream_ids = {u['id'] for u in upstream}
    assert len(upstream_ids) == len(upstream)
    for r in records:
        assert r['ref'] == pin and r['execution_authorized'] is False
        assert r['analysis_model'] == 'gpt-6.1-sol' and r['reasoning_effort'] == 'medium'
        assert r['contract_ids'] and set(r['contract_ids']) <= contracts.keys(), r['id']
        assert set(r['caller_responsibility_ids']) <= duties, r['id']
        assert set(r['finding_ids']) <= finding_ids
        assert set(r['evidence_ids']) <= upstream_ids, (r['id'], set(r['evidence_ids']) - upstream_ids)
        assert r['rationale'] and r['proposed_next_action'] and r['maintenance_limit']
        kinds = {a['kind'] for a in r['alternatives']}
        assert kinds == {'existing', 'library_with_minimum_wrapper', 'platform_primitive', 'retain_now'}
        for a in r['alternatives']:
            assert a['same_contract_ids'] == r['contract_ids']
            assert a['same_required_outcomes'] == r['required_outcomes']
            assert all(a[k] for k in ['fit', 'wrapper', 'initialization_hosts', 'maintenance_burden'])
        for ref in r['current_source_refs']:
            path, line = ref.rsplit(':', 1)
            assert path in indexed and 1 <= int(line) <= indexed[path]['lines'], ref
        for p in r['library_pins']:
            assert p['name'] and p['version'] and p['status'] and p['license']
            assert 'deps' in p
            for e in p.get('evidence', []):
                if isinstance(e, str):
                    assert e in upstream_ids, (r['id'], e)
        for u in r['unresolved_contracts']:
            if isinstance(u, dict):
                assert u['id'] in contracts
    for row in crosswalk:
        assert set(row['integration_ids'].split(',')) == {
            r['id'] for r in records if row['finding_id'] in r['finding_ids']
        }
    assert dict(sorted(collections.Counter(r['disposition_code'] for r in records).items())) == facts['disposition_counts']
    assert len({c for r in records for c in r['contract_ids']}) == facts['contract_count']
    review = json.loads((HERE / 'independent-review.json').read_text())
    reconciliation = json.loads((HERE / 'review-reconciliation.json').read_text())
    assert review['ref'] == reconciliation['ref'] == pin
    assert len(review['seam_reviews']) == 4
    assert {f['id'] for f in review['findings']} == set(reconciliation['findings'])
    assert reconciliation['review_complete'] and not reconciliation['policy_selection']
    assert not reconciliation['fresh_product_execution']
    for item in reconciliation['findings'].values():
        assert set(item['integrations']) <= assessments.keys()
    for f in review['findings']:
        for e in f['evidence']:
            if not e['path'].startswith('/'):
                assert e['path'] in indexed
                assert 1 <= e['lines'][0] <= e['lines'][-1] <= indexed[e['path']]['lines']
    assert 'LF/trailing' in contracts['AD-export-csv-bytes']['rule']
    assert any(e['citation_id'] == 'A1021' for e in contracts['AD-export-csv-bytes']['observed_evidence'])
    dependencies = json.loads((HERE / 'dependency-evidence.json').read_text())
    published = dependencies['published_packages']
    assert len(published) == facts['published_artifacts'] == 10
    lock = git('show', pin + ':bun.lock').decode()
    selected = 0
    for p in published:
        assert p['integrity_verified_against_download'] and p['no_install_or_scripts']
        assert p['integrity'].startswith('sha512-') and p['tarball_sha256']
        assert p['metadata_url'].startswith('https://registry.npmjs.org/')
        if p['status'].startswith('selected'):
            selected += 1
            assert p['lock_integrity_present'] and p['integrity'] in lock
        if args.external:
            tar = Path(p['package_root']).parent / 'package.tgz'
            if tar.is_file():
                raw = tar.read_bytes()
                assert sha(raw) == p['tarball_sha256'], str(tar)
                expected = base64.b64decode(p['integrity'][7:])
                assert hashlib.sha512(raw).digest() == expected, str(tar)
    assert selected == facts['selected_published_lock_inputs'] == 8
    external_verified, external_unavailable = 0, []
    assert len(sources['external_readonly_inputs']) == facts['external_readonly_input_count']
    if args.external:
        for s in sources['external_readonly_inputs']:
            path = Path(s['path'])
            if not path.is_file():
                external_unavailable.append(s['path'])
                continue
            raw = path.read_bytes()
            assert sha(raw) == s['sha256'] and len(raw) == s['bytes'], str(path)
            external_verified += 1
    for path, digest in facts['artifact_sha256'].items():
        assert sha((HERE / path).read_bytes()) == digest, path
    assert not facts['execution_authorized'] and not facts['fresh_product_execution']
    assert not facts['dependency_installation']
    assert git('rev-parse', pin + ':packages') == git('rev-parse', 'HEAD:packages'), 'Package tree changed; refresh assessment.'
    assert not git('status', '--porcelain', '--untracked-files=all', '--', 'packages').strip(), 'Package overlay changed; refresh assessment.'
    assert git('show', pin + ':bun.lock') == (repo / 'bun.lock').read_bytes()
    assert git('show', pin + ':package.json') == (repo / 'package.json').read_bytes()
    print(json.dumps({
        'ref': pin, 'integrations': len(records), 'historical_findings': len(finding_ids),
        'contracts': facts['contract_count'], 'repository_sources_verified': len(indexed),
        'external_readonly_sources_verified': external_verified,
        'external_readonly_sources_unavailable': external_unavailable,
        'published_artifacts_recorded': len(published), 'review_findings_reconciled': len(review['findings']),
        'current_package_tree_equal': True, 'execution_authorized': False,
        'fresh_product_execution': False, 'dependency_installation': False,
    }, sort_keys=True))


if __name__ == '__main__':
    main()
