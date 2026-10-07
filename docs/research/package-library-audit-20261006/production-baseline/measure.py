#!/usr/bin/env python3
"""Read immutable Git blobs and emit compact package source accounting. No builds."""
import argparse
import bisect
import collections
import csv
import difflib
import hashlib
import json
import pathlib
import re
import subprocess
import tomllib

ORIGINAL = '309644a6881909d8dba32560bc6711f67e00a7ab'
CURRENT = '8f33aa5e29d25bf3ea4d6035c7b2e3ddc0427854'
HERE = pathlib.Path(__file__).resolve().parent
SOURCE = {'.ts', '.mts', '.js', '.mjs', '.cjs', '.rs', '.can'}
RUNTIME = {'implementation', 'definitions'}
RAW_STRING = re.compile(r'(?:br|cr|r)(#*)"')
CHAR_LITERAL = re.compile(r"'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'")


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def read_tree(repo, ref):
    entries = []
    for entry in git(repo, 'ls-tree', '-r', '-z', ref, '--', 'packages').split(b'\0'):
        if entry:
            meta, path = entry.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            if kind != 'blob':
                raise ValueError(f'Unhandled non-blob {path!r}')
            entries.append((path.decode(), oid, mode))
    # communicate reads the pipe concurrently: no per-file processes or pipe deadlock.
    raw = subprocess.run(['git', '-C', str(repo), 'cat-file', '--batch'],
                         input=('\n'.join(x[1] for x in entries) + '\n').encode(),
                         stdout=subprocess.PIPE, check=True).stdout
    blobs, pos = {}, 0
    for path, oid, mode in entries:
        end = raw.index(b'\n', pos)
        returned, kind, size = raw[pos:end].decode().split()
        assert returned == oid and kind == 'blob'
        pos = end + 1
        blob = raw[pos:pos + int(size)]
        assert raw[pos + int(size):pos + int(size) + 1] == b'\n'
        pos += int(size) + 1
        blobs[path] = (oid, mode, blob)
    assert pos == len(raw)
    return blobs


def rust_code(text):
    """Mask strings/comments without moving offsets, including nested comments/raw strings."""
    result = list(text)
    i = 0
    while i < len(text):
        start = i
        if text.startswith('//', i):
            end = text.find('\n', i)
            i = len(text) if end < 0 else end
        elif text.startswith('/*', i):
            i, depth = i + 2, 1
            while depth and i < len(text):
                if text.startswith('/*', i): depth, i = depth + 1, i + 2
                elif text.startswith('*/', i): depth, i = depth - 1, i + 2
                else: i += 1
            if depth: raise ValueError('Unclosed Rust block comment')
        else:
            raw = RAW_STRING.match(text, i)
            if raw:
                closing = '"' + raw[1]
                end = text.find(closing, raw.end())
                if end < 0: raise ValueError('Unclosed Rust raw string')
                i = end + len(closing)
            elif text[i] == '"':
                i += 1
                while i < len(text):
                    if text[i] == '\\': i += 2
                    elif text[i] == '"': i += 1; break
                    else: i += 1
            else:
                char = CHAR_LITERAL.match(text, i)
                if char: i = char.end()
                else: i += 1; continue
        for offset in range(start, i):
            if result[offset] != '\n': result[offset] = ' '
    return ''.join(result)


def rust_tests(text):
    code = rust_code(text)
    starts = [0] + [i + 1 for i, char in enumerate(text) if char == '\n']
    ranges = []
    for match in re.finditer(r'#\[\s*(?:cfg\(\s*test\s*\)|test)\s*\]', code):
        first = bisect.bisect_right(starts, match.start())
        if any(lo <= first <= hi for lo, hi in ranges): continue
        # Skip additional attributes; then consume a module/function/const item, not the next item.
        pos = match.end()
        while True:
            attr = re.match(r'\s*#\[[^\]]*\]', code[pos:])
            if not attr: break
            pos += len(attr[0])
        item = re.search(r'[;{]', code[pos:])
        if not item: raise ValueError('Missing Rust test item')
        end = pos + item.end()
        if item[0] == '{':
            depth = 1
            while depth and end < len(code):
                if code[end] == '{': depth += 1
                elif code[end] == '}': depth -= 1
                end += 1
            if depth: raise ValueError('Unclosed Rust test item')
        ranges.append((first, bisect.bisect_right(starts, end - 1)))
    return code, ranges


def category(path, blob, rules, label):
    if path in rules.get('file_categories', {}): return rules['file_categories'][path]
    if path in rules.get('snapshot_categories', {}).get(label, {}): return rules['snapshot_categories'][label][path]
    parts = pathlib.PurePosixPath(path).parts
    suffix = pathlib.PurePosixPath(path).suffix
    if suffix == '.md': return 'documentation'
    if '/bindings/generated/' in path or path in rules['generated_data']:
        return 'generated'
    if any(part in {'test', 'tests', 'conformance', 'fixtures', 'examples', 'testing'} for part in parts) or re.search(r'\.(?:test|spec)\.', path):
        return 'test-code' if suffix in SOURCE else 'fixture-data'
    if 'scripts' in parts: return 'build-tooling'
    if path.endswith(('.d.ts', '.d.mts')): return 'definitions'
    if suffix in SOURCE: return 'implementation'
    if suffix in {'.css', '.wasm', '.png', '.svg'}: return 'asset'
    if suffix in {'.json', '.toml', '.lock'} or pathlib.PurePosixPath(path).name == '.gitignore': return 'metadata'
    raise ValueError(f'Unclassified path: {path}')


def snapshot(repo, label, ref, rules):
    blobs = read_tree(repo, ref)
    inputs = [{'path': p, 'text': b.decode()} for p, (_, _, b) in blobs.items()
              if pathlib.PurePosixPath(p).suffix in {'.ts', '.mts', '.js', '.mjs'}]
    parsed = json.loads(subprocess.run(['node', str(HERE / 'ts-inventory.cjs')],
                                     cwd=repo, input=json.dumps(inputs).encode(),
                                     stdout=subprocess.PIPE, check=True).stdout)
    if parsed['typescript'] != '5.9.3': raise ValueError('Baseline requires TypeScript 5.9.3')
    ts = {x['path']: x for x in parsed['files']}
    rows, interfaces, manifests, ranges = [], [], [], []
    totals = collections.defaultdict(collections.Counter)
    packages = collections.defaultdict(collections.Counter)
    languages = collections.defaultdict(collections.Counter)
    for path, (oid, mode, blob) in blobs.items():
        kind = category(path, blob, rules, label)
        try: text = blob.decode('utf-8')
        except UnicodeDecodeError: text = None
        lines = text.split('\n') if text else []
        if lines and lines[-1] == '': lines.pop()
        roles = [kind] * len(lines)
        code = text
        if kind == 'implementation' and path.endswith('.rs'):
            code, test_ranges = rust_tests(text)
            for lo, hi in test_ranges:
                for i in range(lo - 1, hi): roles[i] = 'inline-rust-tests'
                ranges.append((label, path, lo, hi, 'inline-rust-tests'))
        if kind == 'implementation' and path in ts:
            for lo, hi in ts[path]['definitions']:
                for i in range(lo - 1, hi): roles[i] = 'definitions'
            if ts[path]['parse_errors']: raise ValueError(f'TS parse errors: {path}')
        for lo, hi, role, anchor in rules.get('classified_ranges', {}).get(path, []):
            if not lines[lo - 1].startswith(anchor): raise ValueError(f'Stale reviewed range: {path}:{lo}')
            if 'inline-rust-tests' in roles[lo - 1:hi]: raise ValueError('Classification overrides a test range')
            for i in range(lo - 1, hi): roles[i] = role
            ranges.append((label, path, lo, hi, role))
        counts = collections.Counter(roles)
        nonblank = collections.Counter(role for role, line in zip(roles, lines) if line.strip())
        # Byte accounting is exclusive too: inline tests are not charged to runtime source.
        if text is not None:
            for i, (role, line) in enumerate(zip(roles, lines)):
                totals[role]['bytes'] += len(line.encode()) + (i < len(lines) - 1 or blob.endswith(b'\n'))
        else:
            totals[kind]['bytes'] += len(blob)
        owner = path.split('/')[1]
        source_lines = sum(counts[k] for k in RUNTIME)
        rows.append((label, path, oid, hashlib.sha256(blob).hexdigest(), len(blob), len(lines),
                     sum(nonblank.values()), kind, source_lines, counts['implementation'],
                     counts['definitions'], counts['inline-rust-tests'],
                     rules.get('snapshot_stages', {}).get(label, {}).get(owner,
                         rules.get('stages', {}).get(owner, 'source-candidate')), mode))
        for role, number in counts.items():
            totals[role]['physical_lines'] += number
            totals[role]['nonblank_lines'] += nonblank[role]
            totals[role]['containing_files'] += 1
        totals[kind]['file_bytes'] += len(blob)
        totals[kind]['files'] += 1
        packages[owner]['files'] += 1
        packages[owner]['bytes'] += len(blob)
        packages[owner]['runtime_source_lines'] += source_lines
        packages[owner]['implementation_lines'] += counts['implementation']
        packages[owner]['definition_lines'] += counts['definitions']
        packages[owner]['inline_rust_test_lines'] += counts['inline-rust-tests']
        if pathlib.PurePosixPath(path).suffix in SOURCE:
            for role, number in counts.items():
                languages[pathlib.PurePosixPath(path).suffix][role] += number
        if path in ts and kind in RUNTIME:
            for first, node_kind, name, domain, target in ts[path]['exports']:
                interfaces.append((label, path, first, node_kind, name, domain, target))
        if path.endswith('.rs') and kind in RUNTIME:
            for first, line in enumerate(code.split('\n'), 1):
                if roles[first - 1:first] == ['inline-rust-tests']: continue
                match = re.search(r'\bpub(?:\(([^)]*)\))?\s+(?:(?:async|unsafe|extern\s+|const(?=\s+fn))\s+)*(fn|struct|enum|trait|type|const|static|mod|use)\s+([^\s{;(=]+)', line)
                if match: interfaces.append((label, path, first, 'Rust-' + match[2], match[3], 'restricted:' + match[1] if match[1] else 'pub-candidate', ''))
        if path.endswith('/package.json'):
            value = json.loads(blob)
            manifests.append({'snapshot': label, 'path': path, 'sha256': hashlib.sha256(blob).hexdigest(),
                              'name': value.get('name'), 'private': value.get('private', False),
                              **{key: value.get(key, {}) for key in ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'exports', 'imports', 'browser', 'bin']}})
        elif path.endswith('/Cargo.toml'):
            value = tomllib.loads(text)
            manifests.append({'snapshot': label, 'path': path, 'sha256': hashlib.sha256(blob).hexdigest(),
                              'cargo': value})
    package_tree = hashlib.sha256(b''.join(p.encode() + b'\0' + b for p, (_, _, b) in blobs.items())).hexdigest()
    summary = {'ref': ref, 'package_tree_sha256': package_tree, 'files': len(rows),
               'bytes': sum(x[4] for x in rows), 'physical_lines': sum(x[5] for x in rows),
               'categories': dict(sorted(totals.items())), 'packages': dict(sorted(packages.items())),
               'source_lines_by_language_and_role': dict(sorted(languages.items())),
               'typescript_parser': parsed['typescript'], 'interface_candidates': len(interfaces)}
    npm = [x for x in manifests if 'cargo' not in x]
    summary['manifest_summary'] = {
        'npm_packages': len(npm),
        'npm_export_subpaths': sum(len(x['exports']) for x in npm),
        'npm_internal_import_keys': sum(len(x['imports']) for x in npm),
        'npm_bins': sum(len(x['bin']) for x in npm),
        'external_runtime_npm_dependencies': {name: version for x in npm for name, version in x['dependencies'].items() if not name.startswith('@canlang/')},
        'cargo_manifests': sum('cargo' in x for x in manifests),
        'cargo_dependency_specs': {x['path']: x['cargo'].get('dependencies', {}) for x in manifests if 'cargo' in x}
    }
    # Root lock/manifests affect resolution but are outside the packages size denominator.
    summary['root_input_hashes'] = {p: hashlib.sha256(git(repo, 'show', ref + ':' + p)).hexdigest()
                                    for p in ['package.json', 'bun.lock']}
    return blobs, rows, interfaces, manifests, ranges, summary


def write_tsv(out, name, header, rows):
    with (out / name).open('w', newline='') as stream:
        writer = csv.writer(stream, delimiter='\t', lineterminator='\n')
        writer.writerow(header)
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument('--original', default=ORIGINAL)
    parser.add_argument('--current', default=CURRENT)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    rules = json.loads((HERE / 'classifications.json').read_text())
    refs = {label: git(args.repo, 'rev-parse', ref + '^{commit}').decode().strip()
            for label, ref in [('original', args.original), ('current', args.current)]}
    snapshots = {label: snapshot(args.repo, label, ref, rules) for label, ref in refs.items()}
    args.out.mkdir(parents=True, exist_ok=True)
    write_tsv(args.out, 'files.tsv', ['snapshot', 'path', 'git_blob', 'sha256', 'bytes', 'physical_lines', 'nonblank_lines', 'file_category', 'runtime_source_lines', 'implementation_lines', 'definition_lines', 'inline_rust_test_lines', 'owner_stage', 'mode'], [row for x in snapshots.values() for row in x[1]])
    write_tsv(args.out, 'interfaces.tsv', ['snapshot', 'path', 'line', 'syntax_kind', 'name', 'visibility_or_domain', 'reexport_target'], [row for x in snapshots.values() for row in x[2]])
    write_tsv(args.out, 'classified-ranges.tsv', ['snapshot', 'path', 'first_line', 'last_line', 'category'], [row for x in snapshots.values() for row in x[4]])
    with (args.out / 'manifests.jsonl').open('w') as stream:
        for x in snapshots.values():
            for row in x[3]: stream.write(json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n')
    original, current = snapshots['original'][0], snapshots['current'][0]
    movements = []
    for move in rules['moved_implementations']:
        before = original[move['from']][2].decode().splitlines()
        after = current[move['to']][2].decode().splitlines()
        blocks = difflib.SequenceMatcher(None, before, after, autojunk=False).get_matching_blocks()
        preserved = sum(block.size for block in blocks)
        movements.append([move['from'], move['to'], len(before), len(after), preserved, 'implementation-transfer-with-retained-facade'])
    write_tsv(args.out, 'moves.tsv', ['original_path', 'current_path', 'original_lines', 'current_lines', 'identical_transferred_lines', 'kind'], movements)
    categories = sorted(set(snapshots['original'][5]['categories']) | set(snapshots['current'][5]['categories']))
    summary = {'schema': 1, 'scope': 'All committed packages/ blobs at two immutable refs; source accounting, not shipped/reachable proof',
               'snapshots': {label: value[5] for label, value in snapshots.items()},
               'delta_lines': {kind: snapshots['current'][5]['categories'].get(kind, {}).get('physical_lines', 0) - snapshots['original'][5]['categories'].get(kind, {}).get('physical_lines', 0) for kind in categories},
               'git_rename_detection': git(args.repo, 'diff', '--name-status', '-M', refs['original'], refs['current'], '--', 'packages').decode().splitlines(),
               'explicit_implementation_transfers': len(movements)}
    (args.out / 'summary.json').write_text(json.dumps(summary, sort_keys=True, indent=2) + '\n')
    assert sum(v.get('physical_lines', 0) for v in summary['snapshots']['current']['categories'].values()) == summary['snapshots']['current']['physical_lines']
    for value in summary['snapshots'].values():
        assert sum(v.get('bytes', 0) for v in value['categories'].values()) == value['bytes']
    print(json.dumps({'out': str(args.out), 'files': {k: v[5]['files'] for k, v in snapshots.items()}, 'delta_lines': summary['delta_lines']}, sort_keys=True))


if __name__ == '__main__':
    main()
