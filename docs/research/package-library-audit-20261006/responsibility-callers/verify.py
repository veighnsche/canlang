#!/usr/bin/env python3
"""Check the frozen responsibility map and optional regenerated caller index."""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--baseline-files', type=Path, required=True)
    args = parser.parse_args()
    facts = json.loads((HERE / 'verification.json').read_text())
    pin = facts['ref']
    index = json.loads(args.index.read_text())
    assert index['ref'] == pin
    assert hashlib.sha256(args.index.read_bytes()).hexdigest() == facts['index_sha256']
    rows = [json.loads(line) for line in (HERE / 'responsibilities.jsonl').read_text().splitlines()]
    ids = {row['id']: row for row in rows}
    assert len(rows) == len(ids) == facts['counts']['responsibilities']
    by = collections.defaultdict(list)
    locations = []
    for row in rows:
        assert row['owner'] and row['caller_status'] in facts['counts']['caller_statuses']
        for path in row['files']:
            assert path.split('/')[1] == row['owner']
            by[path].append(row)
        locations += row.get('callers', []) + row.get('evidence', [])
    coverage = list(csv.DictReader((HERE / 'file-coverage.tsv').open(), delimiter='\t'))
    assert {row['path'] for row in coverage} == set(by)
    baseline = {row['path']: row for row in csv.DictReader(args.baseline_files.open(), delimiter='\t') if row['snapshot'] == 'current'}
    candidates = {path for path, row in baseline.items() if row['file_category'] in {'implementation', 'generated', 'runtime-data', 'build-tooling', 'asset'}}
    assert candidates <= set(by)
    assert len(candidates) == facts['counts']['baseline_production_delivery_files']
    for row in coverage:
        assert len({item['owner'] for item in by[row['path']]}) == 1
        assert row['owner'] == by[row['path']][0]['owner']
        assert set(row['responsibility_ids'].split(',')) == {item['id'] for item in by[row['path']]}
        assert row['source_sha256'] == baseline[row['path']]['sha256']
    apis = list(csv.DictReader((HERE / 'public-apis.tsv').open(), delimiter='\t'))
    assert len(apis) == len({(row['owner'], row['export_key']) for row in apis}) == facts['counts']['package_export_keys']
    assert {(row['owner'], row['export_key']) for row in apis} == {(row['owner'].removeprefix('@canlang/'), row['key']) for row in index['api_targets']}
    for row in apis:
        assert row['direct_source_targets'] and set(row['direct_source_targets'].split(',')) <= set(by)
        assert set(row['direct_responsibility_ids'].split(',')) <= set(ids)
    paths = set(index['source_sha256']) | set(by) | {item['path'] for item in locations}
    git = lambda *opts: subprocess.check_output(['git', '-C', str(args.repo), *opts])
    tree = {}
    for item in git('ls-tree', '-r', '-z', pin).split(b'\0'):
        if item:
            meta, path = item.split(b'\t', 1)
            if path.decode() in paths:
                tree[path.decode()] = meta.decode().split()[2]
    assert paths <= set(tree), sorted(paths - set(tree))
    ordered = sorted(paths)
    raw = subprocess.run(['git', '-C', str(args.repo), 'cat-file', '--batch'], input=('\n'.join(tree[p] for p in ordered) + '\n').encode(), stdout=subprocess.PIPE, check=True).stdout
    blobs, offset = {}, 0
    for path in ordered:
        end = raw.index(b'\n', offset)
        oid, kind, length = raw[offset:end].decode().split()
        assert oid == tree[path] and kind == 'blob'
        offset = end + 1
        blobs[path] = raw[offset:offset + int(length)]
        offset += int(length) + 1
    for path, digest in index['source_sha256'].items():
        assert hashlib.sha256(blobs[path]).hexdigest() == digest
    for row in coverage:
        assert hashlib.sha256(blobs[row['path']]).hexdigest() == row['source_sha256']
    for item in locations:
        assert 1 <= item['line'] <= len(blobs[item['path']].decode().splitlines()), item
    assert not git('diff', '--name-only', pin, 'HEAD', '--', 'packages').strip(), 'Current package tree differs from frozen map; refresh is required.'
    assert not git('status', '--porcelain', '--untracked-files=all', '--', 'packages').strip(), 'Package overlay needs explicit review.'
    receipts = json.loads((HERE / 'prior-receipts.json').read_text())
    for item in receipts['raw_records']:
        assert hashlib.sha256((args.repo / item['path']).read_bytes()).hexdigest() == item['sha256']
    print(json.dumps({'ref': pin, 'responsibilities': len(rows), 'mapped_files': len(by), 'production_delivery_files': len(candidates), 'export_keys': len(apis), 'source_inputs_verified': len(index['source_sha256']), 'source_locations_verified': len(locations), 'package_tree_and_overlay_equal': True, 'fresh_product_execution': False}, sort_keys=True))


if __name__ == '__main__':
    main()
