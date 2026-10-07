#!/usr/bin/env python3
"""Source/metadata checks only: no Can/SDK imports, runtimes or package tests."""
import collections
import csv
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]


def read(name):
    return json.loads((HERE / name).read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def frozen_blobs(pin, paths):
    # One read-only git process; parse binary lengths, not text line splitting.
    data = subprocess.run(['git', 'cat-file', '--batch'], cwd=ROOT,
                          input=''.join(pin + ':' + p + '\n' for p in paths).encode(),
                          capture_output=True, check=True).stdout
    cursor = 0
    result = {}
    for path in paths:
        end = data.index(b'\n', cursor)
        header = data[cursor:end].split()
        assert len(header) == 3 and header[1] == b'blob', (path, header)
        size = int(header[2])
        start = end + 1
        result[path] = data[start:start + size]
        assert data[start + size:start + size + 1] == b'\n'
        cursor = start + size + 1
    assert cursor == len(data)
    return result


def convert(anchor, sources):
    if isinstance(anchor, dict):
        return anchor
    if isinstance(anchor, str):
        key, line = anchor.rsplit(':', 1)
        return {'path': sources[key]['path'], 'line': int(line)}
    key, line, *end = anchor
    result = {'path': sources[key]['path'], 'line': line}
    if end:
        result['end'] = end[0]
    return result


def main():
    scope = read('scope.json')
    assert scope['execution_authorized'] is False
    assert scope['package_runtime_execution'] is False
    assert scope['product_changes'] is False
    assert scope['accepted_policy_changes'] is False
    manifest = read('sources.json')
    assert manifest['pin'] == scope['pin']
    sources = manifest['sources']
    index = {s['path']: s for s in sources}
    assert len(index) == len(sources)
    blobs = frozen_blobs(scope['pin'], list(index))
    for path, source in index.items():
        assert sha(blobs[path]) == source['sha256'], ('frozen drift', path)
        assert sha((ROOT / path).read_bytes()) == source['sha256'], ('current drift', path)
        assert len(blobs[path].splitlines()) == source['lines'], ('line count', path)
    external = manifest['external_sources']
    extindex = {s['path']: s for s in external}
    for source in external:
        data = (ROOT / source['path']).read_bytes()
        assert sha(data) == source['sha256'], ('local SDK drift', source['path'])
        assert len(data.splitlines()) == source['lines']
        assert source['kind'] == 'local-installed-primary-source'
    installed = ROOT / 'packages/interfaces/node_modules/@modelcontextprotocol/sdk/package.json'
    version = json.loads(installed.read_text())['version']
    assert version == read('sdk-evidence.json')['version']
    assert json.loads((ROOT / 'packages/interfaces/package.json').read_text())['dependencies']['@modelcontextprotocol/sdk'] == version

    anchors = 0

    def check_anchor(anchor, source_table=None):
        nonlocal anchors
        a = convert(anchor, source_table or {})
        p = a['path']
        s = index.get(p, extindex.get(p))
        assert s is not None, ('unindexed anchor', p)
        assert 1 <= a['line'] <= a.get('end', a['line']) <= s['lines'], a
        if a.get('match') is not None:
            assert a['match'] in (ROOT / p).read_text().splitlines()[a['line'] - 1], a
        anchors += 1

    resources = [json.loads(line) for line in (HERE / 'resources.jsonl').read_text().splitlines()]
    ids = {r['id'] for r in resources}
    assert len(ids) == len(resources) == scope['resource_family_count'] == 93
    for resource in resources:
        for key in ['owner', 'files', 'anchors', 'lifecycle', 'restart_rule', 'invariants',
                    'failure_scenarios', 'stage', 'source_packet', 'invariant_interpretation']:
            assert resource.get(key), (resource['id'], key)
        assert resource['evidence_kind'] == 'source-derived-unexecuted'
        packet = read(resource['source_packet'])
        assert any(r['id'] == resource['id'] for r in packet['resources'])
        assert set(resource['files']) <= set(index)
        for anchor in resource['anchors']:
            check_anchor(anchor)
    assert sum(len(r['invariants']) for r in resources) == scope['invariant_count'] == 119
    assert sum(len(r['failure_scenarios']) for r in resources) == scope['scenario_count'] == 140
    # Validate raw packet and independent-review anchors, including source-key aliases.
    review_index = read('reviews.json')
    cases = 0
    names = ['state-work.json', 'identity-files.json', 'services-delivery.json', 'root-review.json'] + review_index['packets']
    for name in names:
        packet = read(name)
        table = packet['sources']
        for source in table.values():
            assert index[source['path']]['sha256'] == source['sha256'], (name, source)

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key == 'anchors' and isinstance(item, list):
                        for anchor in item:
                            check_anchor(anchor, table)
                    else:
                        walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)
        walk(packet)
        if name in review_index['packets']:
            cases += len(packet.get('findings', packet.get('reviews', [])))
    assert cases == review_index['case_count'] == 15
    final_review = read(review_index['final_consistency_review'])
    assert final_review['status'] == 'no concrete corrections found'
    assert final_review['findings'] == []
    for record in final_review['sources'].values():
        path = pathlib.Path(record['path'])
        assert path.parent == HERE and sha(path.read_bytes()) == record['sha256'], ('final review drift', str(path))
    for claim in read('sdk-evidence.json')['claims']:
        check_anchor(claim)
    files = list(csv.DictReader((HERE / 'file-coverage.tsv').open(), delimiter='\t'))
    duties = list(csv.DictReader((HERE / 'duty-coverage.tsv').open(), delimiter='\t'))
    assert len(files) == len({r['path'] for r in files}) == scope['file_crosswalk_count'] == 395
    assert len(duties) == len({r['id'] for r in duties}) == scope['duty_crosswalk_count'] == 316
    assert sorted({r['owner'] for r in files}) == scope['owners']
    assert len(scope['owners']) == 13
    for f in files:
        assert f['sha256'] == index[f['path']]['sha256']
        refs = f['direct_resource_ids'].split(',') if f['direct_resource_ids'] else []
        if f['classified_signal_family']:
            refs.append(f['classified_signal_family'])
        assert set(refs) <= ids
        assert f['signal_disposition'] and f['coverage_limit']
        if f['lexical_screened'] == 'true':
            assert refs, f['path']
    for d in duties:
        assert d['caller_status'] and d['limit']
        for field in ['direct_resource_ids', 'owner_family_ids']:
            assert set(filter(None, d[field].split(','))) <= ids
    screen = read('resource-screen.json')
    assert len(screen['files']) == scope['lexical_screen_file_count'] == 142
    assert {x['path'] for x in screen['files']} == {f['path'] for f in files if f['lexical_screened'] == 'true'}
    for row in screen['files']:
        text = blobs[row['path']].decode().splitlines()
        for match in row['matches']:
            assert 1 <= match['line'] <= len(text)
            assert any(token in text[match['line'] - 1] for token in match['tokens'])
    seen = set()
    queue = read('fix-queue.json')['units']
    for unit in queue:
        assert unit['id'] not in seen
        assert set(unit['resources']) <= ids
        assert set(unit['depends_on']) <= seen
        assert unit['implementation_authorized'] is False
        assert unit['action'] and unit['acceptance_gate']
        seen.add(unit['id'])
    assert len(queue) == 12
    links = 0
    for md in [HERE / 'README.md', HERE / 'inventory.md', HERE / 'proposed-decisions.md', HERE.parent / 'README.md']:
        for target in re.findall(r'\]\(([^)]+)\)', md.read_text()):
            if '://' in target or target.startswith('#'):
                continue
            # The verification output is created only after these checks pass.
            expected_output = md.parent == HERE and target == 'verification.json'
            assert expected_output or (md.parent / target.split('#', 1)[0]).exists(), (md.name, target)
            links += 1
    result = {'status': 'passed', 'pin': scope['pin'],
              'observed_head': subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
              'frozen_and_current_equal_repository_sources': len(sources),
              'separately_verified_local_sdk_sources': len(external),
              'validated_anchor_occurrences': anchors,
              'resource_families': len(resources), 'invariant_statements': scope['invariant_count'],
              'unexecuted_scenario_groups': scope['scenario_count'],
              'file_crosswalk': len(files), 'duty_crosswalk': len(duties),
              'package_owners': len(scope['owners']), 'lexical_signal_files_reconciled': len(screen['files']),
              'independent_challenge_cases': cases, 'final_consistency_documents': len(final_review['sources']), 'proposed_queue_groups': len(queue),
              'local_links': links, 'package_execution': False, 'new_runtime_acceptance': False,
              'product_or_canonical_status_changes': False, 'limits': scope['limits']}
    (HERE / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
