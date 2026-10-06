#!/usr/bin/env python3
"""Planning artifacts only: no source execution, imports, builds or network."""
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]

def main():
    inventory=json.loads((HERE/'inventory.json').read_text())
    tree=json.loads((HERE/'target-tree.json').read_text())
    catalog=json.loads((HERE/'tasks.json').read_text())
    requirements=json.loads((HERE/'requirements.json').read_text())
    documentation=json.loads((HERE/'documentation-review.json').read_text()) if (HERE/'documentation-review.json').exists() else {}
    retired_audit=documentation.get('execution',{}).get('completed_editor_audit',{})
    archived_sources={r['path']:r for r in retired_audit.get('files',[])}
    archive_bytes={}
    def archived_bytes(path):
        if path not in archive_bytes:
            archive_bytes[path]=subprocess.check_output(['git','show',retired_audit['revision']+':'+path],cwd=ROOT)
        return archive_bytes[path]
    relocations={r['source']:r['target'] for r in documentation.get('root_locations',[]) if r.get('execution_status')=='applied locally'}
    topic_consolidation=documentation.get('execution',{}).get('topic_consolidation',{})
    source_locations={**relocations,**{r['source']:r['target'] for r in topic_consolidation.get('sources',[])}}
    def current_source(path):
        # Captured source identities and hashes remain at their historical scope.
        # Only executed moves resolve to a current path; proposed consolidation does not.
        return ROOT/source_locations.get(path,path)
    errors=[];warnings=[]
    expected={r['path'] for r in inventory['rows']+inventory['added_inputs']+inventory['draft']['rows']} - {'draft'}
    allocations=tree['input_allocations'];mapped={a['source'] for a in allocations}
    if expected!=mapped:errors.append({'input_coverage':{'missing':sorted(expected-mapped),'extra':sorted(mapped-expected)}})
    if len(mapped)!=len(allocations):errors.append('duplicate source allocation')
    leaves=[r['path'] for r in tree['target_leaves']];leafset=set(leaves)
    if len(leafset)!=len(leaves):errors.append('duplicate final leaf')
    cases=collections.defaultdict(list)
    for path in leaves:cases[path.casefold()].append(path)
    if any(len(x)>1 for x in cases.values()):errors.append({'case_collisions':[v for v in cases.values() if len(v)>1]})
    dirs={str(parent) for p in leaves for parent in Path(p).parents if str(parent)!='.'}
    if leafset & dirs:errors.append({'file_directory_collisions':sorted(leafset&dirs)})
    rust=[]
    for p in leaves:
        if p.endswith('/mod.rs'):
            alternative=p[:-len('/mod.rs')]+'.rs'
            if alternative in leafset:rust.append([p,alternative])
    if rust:errors.append({'rust_module_roots':rust})
    for a in allocations:
        for p in a['targets']:
            if p not in leafset:errors.append({'unallocated_successor':a['source'],'target':p})
    tasks=catalog['tasks'];ids={t['id'] for t in tasks}
    if len(ids)!=len(tasks):errors.append('duplicate task IDs')
    ports=[t for t in tasks if t['namespace']=='ports']
    if (len(ports),sum(t['required'] for t in ports),sum(not t['required'] for t in ports))!=(230,220,10):errors.append('port duty counts differ from exact original scope')
    originals={t['id'] for file in (ROOT/'docs/research/package-subsystem-ports-20261006/implementation-plans').glob('*.tasks.json') for t in json.loads(file.read_text())['tasks']}
    if originals!={t['id'] for t in ports}:errors.append('missing or extra original port IDs')
    if len([t for t in tasks if t['namespace']=='challenge'])!=41:errors.append('challenge mapping incomplete')
    if len([t for t in tasks if t['namespace']=='description'])!=8:errors.append('description mapping incomplete')
    rank={id:i for i,id in enumerate(catalog['topological_order_all_conditional_edges'])}
    for t in tasks:
        for dep in t.get('depends_on',[])+[d for c in t.get('conditional_dependencies',[]) for d in c['depends_on']]:
            if dep not in rank or rank[dep]>=rank[t['id']]:errors.append({'bad_dependency_order':[dep,t['id']]})
        if t['disposition']!='DEFERRED':
            for p in t['target_writes']:
                if p not in leafset:errors.append({'missing_task_target':t['id'],'path':p})
    for d in requirements['duties']:
        if d['disposition'] in ('REQUIRED','ACCEPTED-CONDITIONAL') and not d['task_ids']:errors.append({'unmapped_required_duty':d['id']})
        for task in d['task_ids']:
            if task not in ids:errors.append({'unknown_duty_task':d['id'],'task':task})
        for p in d['target_paths']:
            if p.endswith('/'):continue
            a=next((a for a in allocations if a['source']==p),None)
            for q in a['targets'] if a else [p]:
                if d['disposition']!='DEFERRED' and q not in leafset:errors.append({'missing_duty_target':d['id'],'path':q})
    checked_links=0
    for file in list(HERE.rglob('*.md'))+[ROOT/'docs/ideal-filetree-plan.md']:
        text=file.read_text()
        for number,line in enumerate(text.splitlines(),1):
            if line.rstrip()!=line and not line.endswith('  '):errors.append({'markdown_trailing_whitespace':str(file.relative_to(ROOT)),'line':number})
        stripped=re.sub(r'```[\s\S]*?```','',text)
        for raw in re.findall(r'(?<!!)\[[^\]]+\]\(([^)]+)\)',stripped):
            target=raw.split('#',1)[0].strip('<>')
            if not target or re.match(r'^[a-z][a-z0-9+.-]*:',target,re.I):continue
            target=re.sub(r':\d+$','',unquote(target))
            dest=Path(target) if target.startswith('/') else file.parent/target
            checked_links+=1
            if not dest.exists():errors.append({'missing_link':str(file.relative_to(ROOT)),'target':target})
    json_files=[]
    for file in HERE.rglob('*.json'):
        try:json.loads(file.read_text());json_files.append(str(file.relative_to(ROOT)))
        except ValueError:errors.append({'invalid_json':str(file.relative_to(ROOT))})
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    drift=[]
    for r in inventory['rows']:
        if r['kind']!='blob':continue
        p=current_source(r['path'])
        if p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()!=r.get('working_overlay',{}).get('sha256',r['sha256']):drift.append(r['path'])
    for r in inventory['added_inputs']+inventory['draft']['rows']:
        p=current_source(r['path'])
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=r['sha256']:drift.append(r['path'])
    for r in inventory['contracts']:
        p=current_source(r['path'])
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=r['working_sha256']:drift.append(r['path'])
    if documentation:
        root_markdown=sorted(p.name for p in ROOT.glob('*.md'))
        if relocations and root_markdown!=['AGENTS.md','README.md']:errors.append({'unexpected_root_markdown':root_markdown})
        for p,sha in documentation.get('execution',{}).get('protected_markdown_hashes',{}).items():
            if p in archived_sources:
                try:
                    if hashlib.sha256(archived_bytes(p)).hexdigest()!=sha:errors.append({'protected_archive_document_changed':p})
                except subprocess.CalledProcessError:errors.append({'protected_archive_document_unavailable':p})
            elif not (ROOT/p).is_file() or hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=sha:errors.append({'protected_document_changed':p})
        if retired_audit:
            if (ROOT/retired_audit['root']).exists():errors.append('retired editor audit remains in working tree')
            try:
                paths=subprocess.check_output(['git','ls-tree','-r','--name-only',retired_audit['revision'],'--',retired_audit['root']],cwd=ROOT,text=True).splitlines()
                if set(paths)!=set(archived_sources):errors.append('editor archive recovery inventory differs from pinned Git tree')
                for p,r in archived_sources.items():
                    b=archived_bytes(p)
                    if len(b)!=r['bytes'] or hashlib.sha256(b).hexdigest()!=r['sha256']:errors.append({'editor_archive_bytes_changed':p})
                    a=next((a for a in allocations if a['source']==p),None)
                    if not a or a['targets']!=['docs/ideal-filetree-plan/finished-product/documentation-review.json']:errors.append({'editor_archive_allocation_missing':p})
            except subprocess.CalledProcessError:errors.append('editor archive Git revision unavailable')
        for source,target in relocations.items():
            a=next((a for a in allocations if a['source']==source),None)
            if not a or a['targets']!=[target] or not (ROOT/target).is_file() or (ROOT/source).exists():errors.append({'documentation_cutover_incomplete':source,'target':target})
        for r in topic_consolidation.get('sources',[]):
            p=ROOT/r['target'];marker='<a id="'+r['source_anchor']+'"></a>'
            a=next((a for a in allocations if a['source']==r['source']),None)
            if not a or a['targets']!=[r['target']] or not p.is_file():
                errors.append({'topic_allocation_incomplete':r['source']});continue
            text=p.read_text()
            if text.count(marker)!=1:
                errors.append({'topic_source_anchor_missing_or_duplicate':r['source']});continue
            body=text.split(marker,1)[1].split('<a id="source-',1)[0].strip()
            body='\n'.join(body.splitlines()[1:]).strip()
            if hashlib.sha256(body.encode()).hexdigest()!=r['preserved_body_sha256']:errors.append({'topic_preserved_source_body_changed':r['source']})
            if r['source']!=r['target'] and (ROOT/r['source']).exists():errors.append({'topic_predecessor_not_retired':r['source']})
        for p,sha in topic_consolidation.get('raw_json_sha256',{}).items():
            if not (ROOT/p).is_file() or hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=sha:errors.append({'topic_raw_evidence_changed':p})
    # Main planning entry is deliberately updated after source capture; bookkeeping needs no recursive delta.
    drift=[p for p in drift if p!='docs/ideal-filetree-plan.md']
    if head!=inventory['source_pin'] or drift:warnings.append({'moving_source_requires_refresh':{'observed_head':head,'pin':inventory['source_pin'],'working_drift':drift}})
    app_ledgers=[];apps=[];shared=[]
    for p in sorted((HERE/'reviews').glob('apps-*.json')):
        d=json.loads(p.read_text());app_ledgers.append(str(p.relative_to(ROOT)))
        items=d if isinstance(d,list) else d.get('apps',d.get('app_records',[]))
        for r in items:
            name=r.get('app',r.get('name',r.get('id','')));apps.append(name)
        shared+=d.get('shared',d.get('shared_sources',[])) if isinstance(d,dict) else []
    if not app_ledgers:warnings.append('Full original app intent sweep pending')
    normalize=lambda name:name[3:] if name.startswith('Can') else name
    names=[normalize(name) for name in apps]
    expected_apps={Path(r['path']).stem[3:] for r in inventory['draft']['rows'] if r['path'].startswith('draft/Can') and r['path'].endswith('.can')}
    if set(names)!=expected_apps or len(names)!=len(set(names)):errors.append({'app_intent_coverage':{'missing':sorted(expected_apps-set(names)),'extra':sorted(set(names)-expected_apps),'duplicates':len(names)-len(set(names))}})
    if len(shared)!=3:errors.append('shared canonical source review incomplete')
    mismatched_pins=[]
    navigation_only_pins=[]
    migrated_references={r['current_path']:r for r in documentation.get('execution',{}).get('reference_updates',[])}
    def recorded_navigation_only(path,sha):
        r=migrated_references.get(path)
        p=ROOT/path
        if not r or not p.is_file() or r['before_sha256']!=sha or hashlib.sha256(p.read_bytes()).hexdigest()!=r['after_sha256']:return False
        original=p.read_bytes()
        # Validate the exact inverse URL-only edit against the original byte pin;
        # substantive draft changes must still fail, and old review hashes stay intact.
        prefix=b'https://github.com/veighnsche/canlang/blob/main/'
        for row in topic_consolidation.get('sources',[]):
            if row['source']!=row['target']:
                original=original.replace(prefix+row['target'].encode()+b'#'+row['source_anchor'].encode(),prefix+row['source'].encode())
        for source,target in relocations.items():original=original.replace(prefix+target.encode(),prefix+source.encode())
        return hashlib.sha256(original).hexdigest()==sha
    def inspect_pins(value):
        if isinstance(value,dict):
            path=value.get('path',value.get('source'));sha=value.get('sha256')
            # Only original draft bytes are current app intent pins. Historical
            # parent-source pins and inspected review revisions keep their scope.
            if isinstance(path,str) and path.startswith('draft/') and sha and (ROOT/path).is_file() and hashlib.sha256((ROOT/path).read_bytes()).hexdigest()!=sha:
                if recorded_navigation_only(path,sha):navigation_only_pins.append(path)
                else:mismatched_pins.append(path)
            for child in value.values():inspect_pins(child)
        elif isinstance(value,list):
            for child in value:inspect_pins(child)
    for file in (HERE/'reviews').glob('*.json'):inspect_pins(json.loads(file.read_text()))
    if mismatched_pins:errors.append({'review_source_hash_drift':sorted(set(mismatched_pins))})
    if navigation_only_pins:warnings.append({'navigation_only_review_source_drift':sorted(set(navigation_only_pins)),'scope':'Exact inverse URL repair matches original draft pins; historical review hashes unchanged, no renewed semantic or runtime proof.'})
    result={'schema_version':1,'errors':errors,'warnings':warnings,'checks':{'input_allocations':len(allocations),'target_leaves':len(leaves),
       'all_port_tasks':230,'required_port_tasks':220,'conditional_deferred_port_tasks':10,'all_task_dag_items':len(tasks),
       'markdown_links':checked_links,'json_artifacts':len(json_files),'rust_module_collisions':len(rust),'one_defining_owner_per_target':all(bool(t['owner']) for t in tree['target_leaves']),
       'app_intent_ledgers':app_ledgers,'app_records':len(apps),'shared_records':len(shared),'review_source_hash_drift':sorted(set(mismatched_pins)),
       'navigation_only_review_source_drift':sorted(set(navigation_only_pins)),
       'documentation_root_cutover':len(relocations),'documentation_topic_consolidation_executed':bool(topic_consolidation),
       'documentation_topic_source_blocks':len(topic_consolidation.get('sources',[])),
       'documentation_editor_archive_files':len(archived_sources),
       'documentation_editor_archive_markdown':sum(p.endswith('.md') for p in archived_sources),
       'documentation_editor_archive_recovery_verified':bool(retired_audit) and not any('archive' in str(e) for e in errors),
       'documentation_markdown_reduction':topic_consolidation.get('net_markdown_reduction',0)+sum(p.endswith('.md') for p in archived_sources)},
       'completion_dimensions':{'source_coverage':'Path/catalog accountability complete at source pin; every parent/added/nested path and accumulated checkpoint delta catalogued and mixed internals indexed. Semantic reads scope-pinned in primary/app reviews; exhaustive test-body/control-path review remains FP.SOURCE-CLOSURE, so complete checkpoint does not advance.',
         'workflow_tracing':'Requirements-first lifecycle/authority/failure/termination records across 12 capabilities and full original app intent sweep; installed/executed workflow proofs remain implementation gates.',
         'independent_challenge':'Four primary views with independent challengers; material corpus/CSV/poll/export/identity/upgrade corrections joined; per-app challenge/reconciliation stated at actual scope.',
         'exact_target_allocation':'Every catalogued input has selected retained/successor leaves, one defining owner and cutover gate; all port IDs and required product joins mapped; provisional ABI/fixture/packaging conditions explicit.'},
       'checkpoint_advanced':False,'product_tests_builds_installs_executed':False,'limitations':['Installed skill support/checker absent; own planning checks are not a replacement semantic audit','Directory fixture/ABI output naming and unsettled identity transaction mechanism must freeze before dependent implementation','Conditional adoption/performance/supported hosts unresolved pending actual parity/installed measurements','Historical tests/status/CI transcripts not rerun; source inspection does not establish qualification'],
       'artifacts_sha256':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(HERE.rglob('*')) if p.is_file() and p.name!='verification.json' and '__pycache__' not in str(p)}}
    (HERE/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'errors':errors,'warnings':warnings,'checks':result['checks']}))
    return 1 if errors else 0

if __name__=='__main__':raise SystemExit(main())
