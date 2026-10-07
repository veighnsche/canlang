#!/usr/bin/env python3
"""Audit metadata/source checks; standalone platform references, no Can execution."""
import collections
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]


def read(name):
    return json.loads((HERE / name).read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    scope = read('scope.json')
    manifest = read('sources.json')
    pin = scope['pin']
    assert manifest['pin'] == pin
    assert scope['execution_authorized'] is False
    assert scope['package_runtime_execution'] is False
    witnesses = [json.loads(line) for line in (HERE / 'witnesses.jsonl').read_text().splitlines()]
    ids = {w['id'] for w in witnesses}
    assert len(witnesses) == len(ids) == scope['witness_count'] == 32
    index = {s['path']: s for s in manifest['sources']}
    assert len(index) == len(manifest['sources'])
    lines = {}
    for path, source in index.items():
        frozen = subprocess.run(['git', 'show', pin + ':' + path], cwd=ROOT,
                                capture_output=True, check=True).stdout
        current = (ROOT / path).read_bytes()
        assert digest(frozen) == source['sha256'], ('frozen drift', path)
        assert digest(current) == source['sha256'], ('current drift', path)
        if not path.endswith('.wasm'):
            lines[path] = len(frozen.decode('utf-8').splitlines())
    anchors = 0
    for witness in witnesses:
        assert witness['evidence_kind'] == 'source-derived-unexecuted'
        assert witness['required_fix_or_preservation']
        assert witness['anchors']
        packet = read(witness['source_packet'])
        candidates = packet.get('witnesses', packet.get('records', []))
        assert any(w['id'] == witness['id'] for w in candidates)
        for anchor in witness['anchors']:
            assert anchor['path'] in index
            assert 1 <= anchor['line'] <= anchor.get('end', anchor['line']) <= lines[anchor['path']]
            anchors += 1
    for name in ['values.json', 'identity-privacy.json', 'work-delivery.json']:
        packet = read(name)
        source_ids = packet.get('sources', packet.get('evidence_sources', {}))
        for control in packet.get('controls', []):
            for anchor in control.get('anchors', []):
                path = anchor.get('path') or source_ids[anchor['source']]['path']
                assert path in index
                assert 1 <= anchor['line'] <= anchor.get('end', anchor['line']) <= lines[path]
                anchors += 1
    reviews = read('reviews.json')
    review_cases = 0
    for review in reviews['packets']:
        assert review.get('ref', review.get('pin', review.get('frozen_pin'))) == pin
        for path, sha in review.get('source_hashes', {}).items():
            assert index[path]['sha256'] == sha
        for case in review.get('records', review.get('reviews', [])):
            review_cases += 1
            for anchor in case.get('anchors', []):
                assert anchor['path'] in index
                assert 1 <= anchor['line'] <= anchor.get('end', anchor['line']) <= lines[anchor['path']]
                anchors += 1
    queue = read('fix-queue.json')['units']
    qids = {q['id'] for q in queue}
    assert len(qids) == len(queue)
    visited = set()
    for q in queue:
        assert set(q['witnesses']) <= ids
        assert set(q['depends_on']) <= visited
        assert q['action'] and q['gate']
        visited.add(q['id'])
    assert len((HERE / 'coverage.tsv').read_text().splitlines()) == 11
    for path in [HERE / 'README.md', HERE.parent / 'README.md']:
        for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
            if '://' in target or target.startswith('#'):
                continue
            assert (path.parent / target.split('#', 1)[0]).exists(), ('broken link', target)
    script = (HERE / 'reference-witnesses.mjs').read_text()
    assert re.findall(r"^import .*from '([^']+)';", script, re.M) == ['node:assert/strict']
    result = subprocess.run(['node', str(HERE / 'reference-witnesses.mjs')], cwd=ROOT,
                            capture_output=True, text=True, check=True)
    observed = json.loads(result.stdout)
    saved = read('reference-output.json')
    assert observed['kind'] == 'platform-reference-only'
    assert observed['packageCodeExecuted'] is observed['endToEndAcceptance'] is False
    assert observed['entries'] == saved['entries']
    assert len(observed['entries']) == scope['reference_fact_count'] == 8
    checks = {
        'status': 'passed', 'pin': pin,
        'observed_head': subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT,
                                        capture_output=True, text=True, check=True).stdout.strip(),
        'unique_frozen_and_current_equal_sources': len(index),
        'validated_anchor_occurrences': anchors,
        'source_derived_unexecuted_witnesses': len(witnesses),
        'classifications': dict(collections.Counter(w['classification'] for w in witnesses)),
        'independent_source_challenge_cases': review_cases,
        'proposed_dependency_ordered_queue_units': len(queue),
        'standalone_platform_reference_facts': len(observed['entries']),
        'reference_node': observed['node'],
        'package_execution': False, 'new_consumer_acceptance': False,
        'limits': scope['limits'],
    }
    (HERE / 'verification.json').write_text(json.dumps(checks, indent=2) + '\n')
    print(json.dumps(checks))


if __name__ == '__main__':
    main()
