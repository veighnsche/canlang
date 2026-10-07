"""Read frozen Git metadata/blobs only. No package execution or file mutation."""
import argparse
import collections
import hashlib
import io
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
PIN = '449563a30e33c312fcc0e47750bba4a24cb84f4c'


def inventory(pin=PIN):
    raw = subprocess.check_output(
        ['git', 'ls-tree', '-r', '-l', '-z', pin, '--', 'packages',
         'implementation/rust-port-orchestration/runs'], cwd=ROOT)
    rows = []
    for record in raw.split(b'\0'):
        if not record:
            continue
        meta, name = record.split(b'\t', 1)
        mode, kind, oid, size = meta.decode().split()
        name = name.decode()
        if kind != 'blob' or any('/' + x + '/' in name for x in
                                 ('dist', 'target', 'node_modules', '.turbo')):
            continue
        if name.startswith('implementation/rust-port-orchestration/runs/'):
            tags = ['orchestration-record']
        else:
            parts = pathlib.PurePosixPath(name).parts
            leaf = parts[-1]
            tags = []
            if any(p in ('test', 'tests', '__tests__') for p in parts) or re.search(r'\.(test|spec)\.', leaf):
                tags.append('package-test-or-fixture')
            if 'conformance' in parts:
                tags.append('conformance')
            if any(w in leaf.lower() for w in ('corpus', 'golden', 'oracle', 'generated')) or 'generated' in parts:
                tags.append('generated-oracle-name-candidate')
            if name == 'packages/values/src/currency-data.ts':
                tags.append('runtime-generated-currency-catalog')
        if tags:
            rows.append({'path': name, 'git_blob': oid, 'bytes': int(size), 'tags': tags})
    data = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
                                   input=('\n'.join(r['git_blob'] for r in rows) + '\n').encode())
    stream = io.BytesIO(data)
    groups, arrays, sections = collections.defaultdict(list), collections.defaultdict(list), []
    for row in rows:
        header = stream.readline().decode().split()
        assert header[0] == row['git_blob'] and header[1] == 'blob'
        body = stream.read(int(header[2]))
        assert stream.read(1) == b'\n'
        row['sha256'] = hashlib.sha256(body).hexdigest()
        groups[row['sha256']].append(row)
        if not row['path'].endswith('.json'):
            continue
        try:
            parsed = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(parsed, dict):
            continue
        for key, value in parsed.items():
            if not isinstance(value, list):
                continue
            encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
            section = {'path': row['path'], 'field': key, 'length': len(value),
                       'canonical_json_sha256': hashlib.sha256(encoded).hexdigest()}
            arrays[section['canonical_json_sha256']].append(section)
            sections.append(section)
    duplicates = [{'sha256': h, 'bytes': xs[0]['bytes'],
                   'redundant_bytes': (len(xs) - 1) * xs[0]['bytes'],
                   'paths': [x['path'] for x in xs]}
                  for h, xs in groups.items() if len(xs) > 1]
    repeated = [{'canonical_json_sha256': h, 'length': xs[0]['length'], 'sections': xs}
                for h, xs in arrays.items() if len(xs) > 1 and xs[0]['length'] >= 8]
    summary = {'selected_files': len(rows), 'selected_bytes': sum(r['bytes'] for r in rows),
               'exact_duplicate_groups': len(duplicates),
               'exact_duplicate_files': sum(len(x['paths']) for x in duplicates),
               'exact_redundant_bytes': sum(x['redundant_bytes'] for x in duplicates),
               'by_primary_class': dict(collections.Counter(r['tags'][0] for r in rows)),
               'json_array_sections': len(sections), 'substantive_repeated_json_arrays': len(repeated)}
    return {'pin': pin, 'summary': summary,
            'top20_files': sorted(rows, key=lambda r: r['bytes'], reverse=True)[:20],
            'exact_duplicate_groups': duplicates, 'repeated_json_arrays': repeated,
            'large_array_sections': sorted(sections, key=lambda r: r['length'], reverse=True)[:20],
            'records_canonical_json_sha256': hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest(),
            'records': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pin', default=PIN)
    parser.add_argument('--full', action='store_true', help='Include reproducible full file records.')
    args = parser.parse_args()
    result = inventory(args.pin)
    if not args.full:
        result.pop('records')
    print(json.dumps(result, indent=2))
