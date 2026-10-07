#!/usr/bin/env python3
"""Static audit metadata only; no Can, SDK, library, Rust or test execution."""
import collections
import csv
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]

def read(n):
    return json.loads((HERE / n).read_text())

def digest(b):
    return hashlib.sha256(b).hexdigest()

def main():
    scope = read('scope.json')
    for k in ['execution_authorized', 'product_changes', 'package_runtime_execution',
              'canonical_task_status_changes', 'accepted_policy_changes']:
        assert scope[k] is False, k
    manifest = read('sources.json')
    assert scope['pin'] == manifest['pin']
    index = {s['path']: s for s in manifest['sources']}
    ext = {s['path']: s for s in manifest['external_sources']}
    assert len(index) == len(manifest['sources'])
    assert len(ext) == len(manifest['external_sources'])
    paths = sorted(index)
    result = subprocess.run(['git', 'cat-file', '--batch'], cwd=ROOT,
                            input=''.join(scope['pin'] + ':' + p + '\n' for p in paths).encode(),
                            capture_output=True, check=True).stdout
    cursor = 0
    for p in paths:
        end = result.index(b'\n', cursor)
        h = result[cursor:end].split()
        assert len(h) == 3 and h[1] == b'blob', (p, h)
        size = int(h[2]); start = end + 1
        b = result[start:start + size]
        assert result[start + size:start + size + 1] == b'\n'
        cursor = start + size + 1
        assert digest(b) == index[p]['sha256'], ('frozen SHA', p)
        assert digest((ROOT / p).read_bytes()) == index[p]['sha256'], ('current SHA', p)
        assert len(b.splitlines()) == index[p]['lines'], ('line count', p)
    assert cursor == len(result)
    for p, s in ext.items():
        b = (ROOT / p).read_bytes()
        assert digest(b) == s['sha256'], ('local dependency SHA', p)
        assert len(b.splitlines()) == s['lines'], p
        assert 'node_modules/' in p and s['kind'] == 'local-installed-primary-source'
    all_sources = {**index, **ext}
    anchor_count = 0
    def check_anchor(a):
        nonlocal anchor_count
        p = a['path']; line = a['line']; end = a.get('end', line)
        assert p in all_sources, ('missing indexed anchor', p)
        assert 1 <= line <= end <= all_sources[p]['lines'], (p, line, end)
        if a.get('match'):
            text = (ROOT / p).read_text().splitlines()
            assert any(a['match'] in s for s in text[line-1:end]), (p, line, a['match'])
        anchor_count += 1
    def convert(raw, packet):
        if isinstance(raw, str):
            return [{'path':m[1], 'line':int(m[2]), 'end':int(m[3] or m[2])}
                    for m in re.finditer(r'([^;\s]+):(\d+)(?:-(\d+))?', raw)]
        ans = []
        for a in raw:
            if isinstance(a, dict) and 'source' in a:
                s = packet['sources'][a['source']]
                p = s['path'] if isinstance(s, dict) else a['source']
                ans.extend({'path':p, 'line':n} for n in a['lines'])
            elif isinstance(a, dict):
                ans.append(a)
            else:
                key, line, *end = a; s = packet['sources'][key]
                ans.append({'path':s['path'] if isinstance(s, dict) else key,
                            'line':line, 'end':end[0] if end else line})
        return ans
    raw_packets = ['root.json', 'state-work.json', 'identity-files.json', 'services-delivery.json',
                   'review-root-grant.json', 'review-identity.json']
    for n in raw_packets:
        packet = read(n)
        for key, s in packet.get('sources', {}).items():
            p = key if isinstance(s, str) else s['path']
            expected = s if isinstance(s, str) else s['sha256']
            assert p in all_sources and all_sources[p]['sha256'] == expected, (n, p)
        def walk(x):
            if isinstance(x, dict):
                if 'anchors' in x:
                    for a in convert(x['anchors'], packet): check_anchor(a)
                for k, v in x.items():
                    if k != 'anchors': walk(v)
            elif isinstance(x, list):
                for i in x: walk(i)
        walk(packet)
    findings = [json.loads(l) for l in (HERE / 'findings.jsonl').read_text().splitlines()]
    enforcement = [json.loads(l) for l in (HERE / 'enforcement.jsonl').read_text().splitlines()]
    assert len({f['id'] for f in findings}) == len(findings)
    assert len({e['id'] for e in enforcement}) == len(enforcement)
    for item in findings + enforcement:
        assert item['anchors'], item['id']
        for a in item['anchors']: check_anchor(a)
    for f in findings:
        assert f['priority'] in ['P1', 'P2', 'P3']
        assert f['executed'] is False and f['implementation_authorized'] is False
        assert f['original_ids'] and f['stage']
    crosswalk = list(csv.DictReader((HERE / 'file-coverage.tsv').open(), delimiter='\t'))
    duties = list(csv.DictReader((HERE / 'duty-coverage.tsv').open(), delimiter='\t'))
    assert len(crosswalk) == 395 and len(duties) == 316
    assert len({r['path'] for r in crosswalk}) == 395 and len({r['id'] for r in duties}) == 316
    owners = sorted({r['owner'] for r in crosswalk})
    assert len(owners) == 13
    enforcement_ids = {e['id'] for e in enforcement}
    for row in crosswalk:
        assert row['path'] in index and row['sha256'] == index[row['path']]['sha256']
        assert set(filter(None, row['direct_enforcement_ids'].split(','))) <= enforcement_ids
    for row in duties:
        assert set(filter(None, row['contextual_owner_enforcement'].split(','))) <= enforcement_ids
    queue = read('fix-queue.json')['groups']
    find_ids = {f['id'] for f in findings}
    assert {id for q in queue for id in q['findings']} == find_ids
    assert len({q['id'] for q in queue}) == len(queue)
    for q in queue:
        assert q['implementation_authorized'] is False and q['original_references']
    # Crosswalk references: source location presence only, not new task IDs or readiness.
    refs = sorted({ref for f in findings for ref in f['original_ids']})
    ref_corpus = '\n'.join((ROOT / p).read_text(errors='replace') for p in paths
                           if p.startswith(('docs/', 'implementation/')))
    assert all(ref in ref_corpus for ref in refs), ('unknown task/rule refs', [r for r in refs if r not in ref_corpus])
    status = read('review-status.json')
    assert status['Astra']['status'] == 'explicit egress approval pending'
    assert status['Astra']['critical_acceptance'] is False
    assert read('review-reconciliation.json')['critical_review_accepted'] is False
    root_bytes = (HERE / 'root.json').read_bytes()
    assert read('review-root-grant.json')['root_packet_sha256'] == digest(root_bytes)
    # Online tag evidence is separate and cannot be verified as installed behavior here.
    assert json.loads((ROOT / 'packages/ui/package.json').read_text())['dependencies']['csv-parse'] == '7.0.3'
    assert json.loads((ROOT / 'packages/interfaces/package.json').read_text())['dependencies']['@modelcontextprotocol/sdk'] == '1.32.0'
    assert json.loads((ROOT / 'packages/interfaces/node_modules/@modelcontextprotocol/sdk/package.json').read_text())['version'] == '1.32.0'
    links = 0
    for p in [HERE / 'README.md', HERE / 'proposed-decisions.md']:
        for target in re.findall(r'\]\(([^)]+)\)', p.read_text()):
            if '://' in target or target.startswith('#'): continue
            target = target.split('#')[0]
            if target == 'verification.json':
                links += 1  # generated below after all checks, not a preexisting pass
                continue
            assert (p.parent / target).resolve().exists(), (p.name, target)
            links += 1
    # Exact arithmetic witness for packet consistency only; no package or provider invocation.
    text = '{"model":"m","state":{},"questions":{"q":{"type":"noul","instructions":"é"}}}'
    assert len(text) == 77 and len(text.encode('utf-8')) == 78
    result = {'status':'pass', 'scope':'metadata/source pin only', 'pin':scope['pin'],
              'current_head_at_check':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'frozen_current_equal_sources':len(index), 'local_installed_current_sources':len(ext),
              'validated_anchor_positions':anchor_count, 'enforcement_surfaces':len(enforcement),
              'candidate_findings':len(findings), 'priorities':dict(collections.Counter(f['priority'] for f in findings)),
              'file_crosswalk':len(crosswalk), 'duty_crosswalk':len(duties), 'owners':owners,
              'existing_task_rule_references':len(refs), 'local_links':links,
              'runtime_security_acceptance':False, 'Astra_review':'pending explicit egress approval',
              'package_runtime_execution':False, 'scenarios_executed':0,
              'limits':['Position/hash/reference validation does not prove every semantic inference or vulnerability.',
                        'Online CSV tag evidence checked separately; no installed/parser acceptance.',
                        'Compiler may advance HEAD; audited source hashes must stay equal to frozen pin.']}
    (HERE / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))

if __name__ == '__main__': main()
