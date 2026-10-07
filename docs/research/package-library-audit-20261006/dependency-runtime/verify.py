"""Read-only identity/consistency checks for this finite audit; no product execution."""
import collections
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
load = lambda p: json.loads((HERE / p).read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
checks = []

def check(name, condition, detail=None):
    checks.append({'check': name, 'passed': bool(condition), 'detail': detail})

def rows(name):
    return [json.loads(s) for s in (HERE / name).read_text().splitlines() if s.strip()]

source_index = load('sources.json')
source_errors = []
git_errors = []
for x in source_index['records']:
    p = pathlib.Path(x['path'])
    p = p if p.is_absolute() else ROOT / p
    if not p.is_file() or sha(p) != x['sha256'] or p.stat().st_size != x['bytes']:
        source_errors.append(x['path'])
    if x['category'] in ('workspace-source', 'historical', 'current-generated') and not pathlib.Path(x['path']).is_absolute():
        r = subprocess.run(['git', 'show', source_index['freeze'] + ':' + x['path']], cwd=ROOT, capture_output=True)
        if r.returncode or hashlib.sha256(r.stdout).hexdigest() != x['sha256']:
            git_errors.append(x['path'])
check('186 indexed current file/asset identities', len(source_index['records']) == 186 and not source_errors, source_errors)
check('tracked source/generated/historical identities at source freeze', not git_errors, git_errors)
check('no source paths misclassify dist/dependencies', all(('/dist/' not in x['path'] and 'node_modules/' not in x['path']) or x['category'] not in ('workspace-source','current-generated') for x in source_index['records']))

matrix = rows('execution-matrix.jsonl')
risks = rows('upgrade-risks.jsonl')
check('49 unique matrix IDs and explicit evidence stages', len(matrix) == 49 and len({r['id'] for r in matrix}) == 49 and all(r.get('evidence_stage') for r in matrix))
check('13 unique risks preserve planning gate', len(risks) == 13 and len({r['id'] for r in risks}) == 13 and all(r['implementation_authorized'] is False for r in risks))
anchor_errors = []
anchor_count = 0
packets = {n:load('packets/' + n + '.json') for n in ('cloudflare','values-work','browser-interfaces')}
cloud_sources = packets['cloudflare']['sources']
identity = packets['browser-interfaces']
identity_sources = {}
for sid,path,category,size,digest in identity['sources']:
    for alias,prefix in identity['path_prefixes'].items():
        if path.startswith(alias + '/'):
            path = prefix + path[len(alias)+1:]
            break
    identity_sources[sid] = path

def bounds(sid, line, end, paths):
    global anchor_count
    if sid not in paths:
        anchor_errors.append([sid,line,'unknown source'])
        return
    path = paths[sid]
    if isinstance(path,dict): path = path['path']
    p = pathlib.Path(path)
    p = p if p.is_absolute() else ROOT / p
    count = len(p.read_text().splitlines())
    anchor_count += 1
    if not 1 <= line <= end <= count: anchor_errors.append([sid,line,end,count])

def walk_cloud(x):
    if isinstance(x,dict):
        for k,v in x.items():
            if k == 'anchors' and isinstance(v,list):
                for a in v:
                    if isinstance(a,list) and len(a)>=2 and isinstance(a[1],int): bounds(a[0],a[1],a[1],cloud_sources)
            else: walk_cloud(v)
    elif isinstance(x,list):
        for v in x: walk_cloud(v)
walk_cloud(packets['cloudflare'])

def walk_identity(x):
    if isinstance(x,dict):
        for k,v in x.items():
            if k in ('anchors','evidence') and isinstance(v,list):
                for a in v:
                    if not isinstance(a,str): continue
                    m=re.fullmatch(r'([^:]+):(\d+)(?:-(\d+))?',a)
                    if m: bounds(m[1],int(m[2]),int(m[3] or m[2]),identity_sources)
            else: walk_identity(v)
    elif isinstance(x,list):
        for v in x: walk_identity(v)
walk_identity(identity)
# Values/Work packet's compact package:line groups have a documented packages/ prefix.
for r in packets['values-work']['execution_matrix']:
    for group in r.get('anchors','').split(';'):
        m=re.match(r'\s*([^:]+):([0-9,\-]+)',group)
        if not m: continue
        p=m[1] if m[1].startswith(('packages/','scripts/','implementation/','docs/')) else 'packages/'+m[1]
        for n in m[2].split(','):
            q=n.split('-'); bounds(p,int(q[0]),int(q[-1]),{p:p})
check('source/primary-library anchor bounds', not anchor_errors, {'positions':anchor_count,'errors':anchor_errors})
references={r['id'] for r in matrix}
references.update(r['id'] for r in packets['cloudflare']['upgrade_risks'])
references.update(r['id'] for r in identity['upgrade_risks'])
references.update(r['id'] for r in packets['values-work']['delivery_corrections'])
check('consolidated risk evidence references exist', all(a in references or a=='dependency-inventory.json' for r in risks for a in r['evidence_refs']))
inv=load('dependency-inventory.json')
check('all13 owners and lock-stage limit',len(inv['packages'])==13 and inv['bun_lock']['entries']==298 and inv['bun_lock']['distinct_names']==270 and len(inv['bun_lock']['duplicate_versions'])==7 and len(inv['cargo_locks'])==4)
packed=load('packed-inventory.json')
check('13 tarball hashes and safe member inventory',len(packed['packages'])==13 and all(r['expected_sha256']==r['actual_sha256'] and not r['unsafe_members'] for r in packed['packages']))
check('3 source manifest deltas retained',sum(not r['source_manifest_matches'] for r in packed['packages'])==3)
cold=load('cold-receipts.json');assets=load('asset-receipts.json')
check('probe script byte identity',sha(HERE/'cold-probe.mjs')==cold['probe_sha256'] and sha(HERE/'asset-probe.mjs')==assets['probe_sha256'])
roots=[r for r in cold['cases'] if r['mode']=='import' and r['specifier'] in {p['package'] for p in inv['packages']}]
check('25 scoped cases10/13 partial fixture roots',len(cold['cases'])==25 and len(roots)==13 and sum(r['status']=='loaded' for r in roots)==10 and all(r['code']=='ERR_MODULE_NOT_FOUND' for r in roots if r['status']!='loaded'))
check('negative checkout read guard',any(r['mode']=='repo-denied' and r['code']=='ERR_ACCESS_DENIED' for r in cold['cases']))
check('both raw Wasm one-vector cases',sum(r['mode']=='wasm' and r['abi']==1 and r['response']=={'ok':True,'value':{'t':'bigint','v':'3'}} for r in cold['cases'])==2)
check('3 gather cases/refusals are separate',len(assets['cases'])==3 and assets['cases'][0]['status']=='gathered' and [r['status'] for r in assets['cases'][1:]]==['refused','refused'])
scope=load('scope.json')
check('scope retains implementation/acceptance/policy gates',scope['implementation_authorized'] is False and scope['canonical_task_status_changes'] is False and scope['accepted_policy_changes'] is False and scope['package_changes'] is False)
for p in HERE.rglob('*.md'):
    for dest in re.findall(r'\]\(([^)]+)\)',p.read_text()):
        if ':' in dest or dest.startswith('#'): continue
        target=(p.parent/dest.split('#')[0]).resolve()
        check('local link '+dest,target.exists())
print(json.dumps({'passed':all(c['passed'] for c in checks),'checks':checks,'limits':'Metadata/source identity and finite receipt consistency; no build/install/runtime re-execution or whole product acceptance.'},indent=2))
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
