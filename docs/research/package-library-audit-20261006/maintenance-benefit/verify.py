"""Read-only source/accounting checks; no package builds, tests or runtime."""
import hashlib
import io
import json
import pathlib
import re
import subprocess

HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[3]
AUDIT=HERE.parent
load=lambda p:json.loads((HERE/p).read_text())
rows=lambda p:[json.loads(s) for s in p.read_text().splitlines() if s.strip()]
checks=[]


def check(name, condition, detail=None):
    checks.append({'check':name,'passed':bool(condition),'detail':detail})


def blobs(ref, paths):
    raw=subprocess.check_output(['git','cat-file','--batch'],cwd=ROOT,
        input=''.join(ref+':'+p+'\n' for p in paths).encode())
    stream=io.BytesIO(raw);result={}
    for p in paths:
        h=stream.readline().decode().split()
        if len(h)!=3 or h[1]!='blob':
            raise ValueError('Missing pinned blob '+p)
        data=stream.read(int(h[2]));assert stream.read(1)==b'\n';result[p]=data
    return result


indexed=load('sources.json');pin=indexed['freeze'];records=rows(HERE/'assessments.jsonl')
paths=[s['path'] for s in indexed['records']];frozen=blobs(pin,paths);source_errors=[]
for s in indexed['records']:
    data=(ROOT/s['path']).read_bytes()
    if len(data)!=s['bytes'] or hashlib.sha256(data).hexdigest()!=s['sha256'] or data!=frozen[s['path']]:
        source_errors.append(s['path'])
check('129 unique current source identities match frozen blobs',len(paths)==len(set(paths))==129 and not source_errors,source_errors)
inputs=load('inputs.json');input_paths=[x['path'] for x in inputs['records']];captured=blobs(pin,input_paths)
check('15 prior audit/tool input identities',len(input_paths)==15 and all(hashlib.sha256((ROOT/x['path']).read_bytes()).hexdigest()==x['sha256'] and hashlib.sha256(captured[x['path']]).hexdigest()==x['sha256'] for x in inputs['records']))
libraries=rows(AUDIT/'library-fit/assessments.jsonl');duplicates=rows(AUDIT/'duplication-layers/candidates.jsonl')
check('76 assessments cover exactly27 families and49 duplicate records',len(records)==76 and len({r['id'] for r in records})==76 and {r['id'] for r in records}=={r['id'] for r in libraries}|{r['id'] for r in duplicates})
check('31 conditional duplication changes and18 retained boundaries',sum(r['disposition']!='retain' for r in duplicates)==31 and sum(r['disposition']=='retain' for r in duplicates)==18)
counter=load('counter-review.json');anchors=[a for r in records for a in r['source_ranges']]+[a for r in counter['largestEnvelopeChecks'] for a in r['anchors']]
anchor_errors=[]
for a in anchors:
    data=frozen[a['path']];lines=data.decode().splitlines(keepends=True)
    if not 1<=a['start']<=a['end']<=len(lines):
        anchor_errors.append([a['path'],'bounds']);continue
    body=''.join(lines[a['start']-1:a['end']]).encode()
    if hashlib.sha256(data).hexdigest()!=a['file_sha256'] or hashlib.sha256(body).hexdigest()!=a['slice_sha256'] or a['physical_lines']!=a['end']-a['start']+1 or a['nonblank_lines']!=sum(bool(s.strip()) for s in lines[a['start']-1:a['end']]):
        anchor_errors.append([a['path'],a['start'],'hash/count'])
check('all primary ranges and exact slice measurements',not anchor_errors,{'positions':len(anchors),'errors':anchor_errors})
corrected=[a for r in records for a in r['source_ranges'] if a['requested_range_correction']]
check('two EOF corrections explicitly retained',len(corrected)==2 and {a['path'] for a in corrected}=={'packages/values/src/schema.ts','packages/cloudflare/src/preparation/inputs.ts'})
check('future counts and benefits remain unmeasured',all(r['actual_future_implementation_lines'] is None and r['actual_future_declaration_lines'] is None and r['net_reduction_demonstrated_for_proposed_remedy'] is False and r['execution_authorized'] is False and r['accepted_policy_change'] is False for r in records))
check('replacement gate covers mixed replacement/correction portions',all(r['replacement_reduction_required']==r['classification'].startswith('replacement-only') for r in records) and all(r['replacement_reduction_required'] for r in records if r['id'] in ('calendar-zone','intl-exact-display')))
check('before/after vectors and qualifications exist for every record',all(r['before_vector'] and r['proposed_after_vector'] and r['qualification_cost_and_gates'] and r['reduction_verdict'] and r['retention_and_limits'] for r in records))

historical=load('historical-before-after.json');summary=json.loads((AUDIT/'production-baseline/summary.json').read_text());current=summary['snapshots']['current'];original=summary['snapshots']['original']
raw=subprocess.check_output(['git','ls-tree','-r','-z',pin,'--','packages'],cwd=ROOT);package_paths=[]
for item in raw.split(b'\0'):
    if item:
        meta,p=item.split(b'\t',1);assert meta.decode().split()[1]=='blob';package_paths.append(p.decode())
package_blobs=blobs(pin,package_paths);digest=hashlib.sha256()
for p in package_paths:digest.update(p.encode()+b'\0'+package_blobs[p])
check('entire844-file package tree equals verified measured-current baseline',len(package_paths)==844 and digest.hexdigest()==current['package_tree_sha256']==historical['package_tree_sha256'])
root_bytes=blobs(pin,['package.json','bun.lock'])
check('root package/lock identities equal measured-current baseline',all(hashlib.sha256(b).hexdigest()==current['root_input_hashes'][p] for p,b in root_bytes.items()))
check('13 owner before/after counts and historical total deltas reconcile',len(historical['owners'])==13 and all(r['before_implementation']==original['packages'][r['owner']]['implementation_lines'] and r['after_implementation']==current['packages'][r['owner']]['implementation_lines'] and r['before_definitions']==original['packages'][r['owner']]['definition_lines'] and r['after_definitions']==current['packages'][r['owner']]['definition_lines'] for r in historical['owners']) and sum(r['after_implementation']-r['before_implementation'] for r in historical['owners'])==113 and sum(r['after_definitions']-r['before_definitions'] for r in historical['owners'])==83 and sum(r['runtime_delta'] for r in historical['owners'])==196)
local_errors=[]
for name in ('numeric_formatter_function','string_quoting_function'):
    m=historical['local_historical_changes'][name]
    for label in ('original','current'):
        x=m[label];data=blobs(x['ref'],[x['path']])[x['path']];lo,hi=x['range'];lines=data.decode().splitlines();n=x.get('physical_nonblank_lines',x.get('physical_lines'))
        expected=sum(bool(s.strip()) for s in lines[lo-1:hi]) if 'physical_nonblank_lines' in x else hi-lo+1
        if not 1<=lo<=hi<=len(lines) or hashlib.sha256(data).hexdigest()!=x['sha256'] or n!=expected:local_errors.append([name,label])
check('old/new formatter and quote body measurements independently matched',not local_errors,local_errors)
branch=load('branch-coverage.json');branch_records=rows(AUDIT/'adapter-branches/branches.jsonl');branch_ids={r['id'] for r in branch_records};assessed={r['id'] for r in records}
check('480 branch groups crosswalk27 family assessments with unknown after counts',branch['source_groups']==len(branch_ids)==480 and len(branch['families'])==27 and all(r['assessment_id'] in assessed and r['after_count'] is None and set(r['branch_ids'])<=branch_ids for r in branch['families']))
budgets=load('separate-budgets.json')
check('69 existing overlay groups retain no production credit/authorization',len(budgets['groups'])==len({r['id'] for r in budgets['groups']})==69 and all(r['production_reduction_credit']==0 and r['execution_authorized'] is False and r['budget_status'] for r in budgets['groups']))
check('four capability boundaries remain separately unallocated',len(budgets['capability_packets'])==4 and all(r['growth_budget'] is None and r['budget_status'] and r['guard'] for r in budgets['capability_packets']))
envelopes={'DR01':212,'DR02':62,'DR03':198,'DR04':104,'DR09':89}
check('opposing gross-envelope checks match assessment and preserve net gate',all(next(r for r in records if r['id']==i)['gross_duplicate_body_envelope_physical_lines']==v and next(r for r in counter['largestEnvelopeChecks'] if r['recordID']==i)['measuredEnvelopePhysicalLines']==v for i,v in envelopes.items()))
scope=load('scope.json')
check('Sol medium delegation and planning-only scope retained',len(scope['economical_delegation'])==4 and all(x['model']=='gpt-6.1-sol' and x['reasoning']=='medium' for x in scope['economical_delegation']) and all(scope[k] is False for k in ('execution_authorized','product_tests_or_runtime','package_changes','canonical_task_status_changes','accepted_new_policy_or_mechanism','merge_or_checkpoint_advance')))
errors=[];link_count=0
for p in HERE.glob('*.md'):
    for dest in re.findall(r'\]\(([^)]+)\)',p.read_text()):
        if dest.startswith(('http:', 'https:', '#')):continue
        link_count+=1;dest=re.sub(r':\d+$','',dest.split('#')[0])
        if not (p.parent/dest).resolve().exists():errors.append([p.name,dest])
check('local document links exist',not errors,{'links':link_count,'errors':errors})
result={'passed':all(c['passed'] for c in checks),'checks':checks,'limits':'Source, frozen Git, role-aware historical baseline, hash/range/count/coverage and proposal consistency only. No production implementation, future reduction, product runtime/tests, build, install or acceptance.'}
print(json.dumps(result,indent=2))
raise SystemExit(0 if result['passed'] else 1)
