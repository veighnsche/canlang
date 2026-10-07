#!/usr/bin/env python3
"""Regenerate read-only TS import/call candidates from pinned tracked blobs."""
import argparse
import hashlib
import json
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
PIN = '851352d5225f0d707246eba7da81482087566994'
SCOPES = ['packages', 'scripts', 'tests', 'tools', '.github', 'examples', 'output', 'package.json']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument('--ref', default=PIN)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    git = lambda *options: subprocess.check_output(['git', '-C', str(args.repo), *options])
    ref = git('rev-parse', args.ref + '^{commit}').decode().strip()
    rows = [x.split(b'\t', 1) for x in git('ls-tree', '-r', '-z', ref, '--', *SCOPES).split(b'\0') if x]
    selected = [(p.decode(), meta.decode().split()[2]) for meta, p in rows
                if p.decode().endswith(('.ts', '.mts', '.js', '.mjs', '.cjs', '/package.json', '/tsconfig.json')) or p == b'package.json']
    raw = subprocess.run(['git', '-C', str(args.repo), 'cat-file', '--batch'],
                         input=('\n'.join(oid for _, oid in selected) + '\n').encode(),
                         stdout=subprocess.PIPE, check=True).stdout
    blobs, offset = {}, 0
    for name, oid in selected:
        end = raw.index(b'\n', offset)
        returned, kind, length = raw[offset:end].decode().split()
        assert returned == oid and kind == 'blob'
        offset = end + 1
        blobs[name] = raw[offset:offset + int(length)]
        offset += int(length) + 1
    packages = []
    for name, blob in blobs.items():
        if name.startswith('packages/') and name.count('/') == 2 and name.endswith('/package.json'):
            data = json.loads(blob)
            directory = name.rsplit('/', 1)[0]
            packages.append({'name':data['name'], 'directory':directory, 'exports':data.get('exports', {}),
                             'imports':data.get('imports', {}), 'bin':data.get('bin', {}),
                             'config_text':blobs[directory + '/tsconfig.json'].decode()})
    packet = {'files':[{'path':name,'text':blob.decode()} for name,blob in blobs.items() if not name.endswith('.json')],
              'known_paths':[p.decode() for _,p in rows],
              'packages':packages}
    result = json.loads(subprocess.run(['node', str(HERE / 'index-callers.cjs')], cwd=args.repo,
                                      input=json.dumps(packet).encode(), stdout=subprocess.PIPE, check=True).stdout)
    if result['typescript'] != '5.9.3': raise ValueError('Require baseline TypeScript 5.9.3')
    result.update({'ref':ref,'scopes':SCOPES,'source_sha256':{name:hashlib.sha256(blob).hexdigest() for name,blob in blobs.items()}})
    args.out.write_text(json.dumps(result,sort_keys=True,separators=(',', ':')) + '\n')
    print(json.dumps({'ref':ref,'files':len(packet['files']),'edges':len(result['edges']),'uses':len(result['uses']),'dynamic':len(result['dynamic']),'out':str(args.out)}))


if __name__ == '__main__': main()
