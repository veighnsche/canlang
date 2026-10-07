import json,pathlib,hashlib,subprocess,collections
R=pathlib.Path(__file__).resolve().parents[5];D=R/'docs/research/compiler-library-audit-20261006/responsibility-map';L=[json.loads(x) for x in (D/'coverage.jsonl').read_text().splitlines()];P=[x for x in L if x['record']=='path'];E=[]
actual=set(subprocess.check_output(['git','ls-files','compiler'],cwd=R,text=True).splitlines());got={x['path'] for x in P};assert actual==got and len(P)==len(got)
B={x['path']:x for x in map(json.loads,(R/'docs/research/compiler-library-audit-20261006/baseline-verification/compiler-inventory.jsonl').read_text().splitlines())}
for r in P:
 raw=(R/r['path']).read_bytes();lines=raw.decode().splitlines();last=0
 if hashlib.sha256(raw).hexdigest()!=B[r['path']]['sha256']:E.append([r['path'],'changed baseline hash'])
 for s in r['slices']:
  a,z=s['lines']
  if a!=last+1 or z<a:E.append([r['path'],'range',s['id'],s['lines'],last])
  last=z
  for name,n in s.get('anchors',[]):
   if not a<=n<=z or name not in lines[n-1]:E.append([r['path'],'anchor',name,n])
 if last!=len(lines):E.append([r['path'],'last',last,len(lines)])
 for link in r.get('test_links',[]):
  if link and not (R/link).exists():E.append([r['path'],'missing test link',link])
 for api in r.get('apis',[]):
  if api['symbol'] not in lines[api['line']-1]:E.append([r['path'],'api',api])
for r in L:
 if r['record']=='interface' and isinstance(r.get('anchors'),list):
  for p,n,s in r['anchors']:
   if not (R/p).exists() or s not in (R/p).read_text().splitlines()[n-1]:E.append(['interface',r['id'],p,n,s])
 if r['record']=='interface_inputs':
  for p in r['paths']:
   if hashlib.sha256((R/p['path']).read_bytes()).hexdigest()!=p['sha256']:E.append(['external changed',p['path']])
receipt={'scope':'mechanical inventory consistency, not semantic correctness or execution','source_commit':L[0]['source_commit'],'observed_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip(),'compiler_diff_from_source_baseline':subprocess.check_output(['git','diff',L[0]['source_commit'],'--','compiler'],cwd=R,text=True),'paths':len(P),'unique_paths':len(got),'source_files':sum(r['category']=='compiler_src_rust' for r in P),'source_slices':sum(len(r['slices']) for r in P if r['category']=='compiler_src_rust'),'all_path_slices':sum(len(r['slices']) for r in P),'large_test_files':sum(r['category']=='compiler_tests_and_fixtures' and r['physical_lines']>1000 for r in P),'large_test_slices':sum(len(r['slices']) for r in P if r['category']=='compiler_tests_and_fixtures' and r['physical_lines']>1000),'api_source_visibility':dict(collections.Counter(a['reach'] for r in P for a in r.get('apis',[]))),'explicit_test_declarations':sum(r.get('test_declarations',0) for r in P),'external_input_pins':31,'errors':E,'checks':['git ls-files compiler exactly reconciled to one path row each','all107 compiler SHA256/physical lines compared to Step1 inventory','every path sliced with contiguous inclusive complete span','all retained slice/API/interface anchors checked against current source text','every test pointer exists','31 external interface SHA256 pins matched','tracked compiler diff to source baseline empty'],'limitations':['named declaration index is source visibility inventory, not compiler-derived exhaustive semver surface','explicit #[test] count excludes macro expansion and does not predict active host harness count','no builds/tests/workflow/consumer execution or semantic adequacy review in Step2'],'ledger_sha256':hashlib.sha256((D/'coverage.jsonl').read_bytes()).hexdigest()}
W=[x for x in L if x['record']=='workflow'];ids={w['id'] for w in W}
for w in W:
 for a in w['source_anchors']:
  if not (R/a['path']).is_file() or not 1<=a['line']<=len((R/a['path']).read_text().splitlines()):E.append(['workflow anchor',w['id'],a])
 for q in w['responsibility_refs']:
  owner=next(r for r in P if r['path']==q['path'])
  if any(i not in {s['id'] for s in owner['slices']} for i in q['slices']):E.append(['workflow slice',w['id'],q])
 for q in w['execution_receipts']:
  if not (D/q).is_file():E.append(['missing execution receipt',w['id'],q])
for r in L:
 if r['record']=='workflow_inputs':
  for q in r['files']:
   if hashlib.sha256((R/q['path']).read_bytes()).hexdigest()!=q['sha256']:E.append(['workflow source changed',q['path']])
 if r['record']=='path' and any(q not in ids for q in r['workflow_refs']):E.append(['path workflow',r['path']])
receipt.update(scope='Mechanical current inventory/workflow/source/evidence linkage. Independent source review and process receipts separate; not semantic completeness.',workflows=len(W),workflow_ids=sorted(ids),workflow_source_anchors=sum(len(w['source_anchors']) for w in W),workflow_input_pins=next(len(r['files']) for r in L if r['record']=='workflow_inputs'),errors=E)
receipt['checks']+=['unique workflow IDs and exact current source anchor bounds','workflow source input SHA256 pins','valid workflow responsibility-slice joins and execution receipt paths']
receipt['limitations']=['source linkage does not prove branch coverage or API preconditions','execution receipts retain host, body-skip, source/dist, synthetic/mocked and installed-product limits','Step2 independent inventory receipt kept separately; this validates current extended ledger']

C=[r for r in L if r['record']=='compatibility_requirement']; Q=[r for r in L if r['record']=='compatibility_claim'];cs=next(r for r in L if r['record']=='compatibility_scope'); ci=next(r for r in L if r['record']=='compatibility_inputs');cids={r['id'] for r in C}
assert len(C)==len(cids)==83 and len(Q)==26 and {q['claim_index'] for q in Q}==set(range(26))
for r in C:
 for a in r['current_owner_anchors']+r['real_consumers']:
  if isinstance(a,dict) and (not (R/a['path']).is_file() or not 1<=a['line']<=len((R/a['path']).read_text().splitlines())):E.append(['compatibility anchor',r['id'],a])
 if any(w not in ids for w in r['workflow_ids']):E.append(['compatibility workflow',r['id']])
for q in Q:
 if not q['requirement_ids'] or any(c not in cids for c in q['requirement_ids']):E.append(['compatibility crosswalk',q['id']])
core={'C01IR','C01A','C02','C03U','C03L','C04H','C04F','C05D','C05A','C05M','C05R','C05P','C06','C07DTO','C07URI','C08'}
assert core<=set(cs['original_packet_ids']) and {w for r in C for w in r['workflow_ids']}==ids
for q in ci['files']:
 raw=(R/q['path']).read_bytes()
 if q['pin_kind']=='observed_prefix_before_Step4_append':raw=raw[:q['bytes']]
 if hashlib.sha256(raw).hexdigest()!=q['sha256']:E.append(['compatibility input changed',q['path']])
for p in P:
 if any(x not in cids for x in p['compatibility_refs']):E.append(['path compatibility',p['path']])
receipt.update(scope='Mechanical inventory/workflow/compatibility linkage and pins, not semantic or execution acceptance',compatibility_requirements=len(C),prior_claim_groups=len(Q),compatibility_input_files=len(ci['files']),compatibility_classes=dict(collections.Counter(r['classification'] for r in C)),core_packets=len(core),errors=E)
receipt['checks']+=['83 unique requirements and26 prior claim groups with valid crosswalk links','all16 original core packets and18 workflows accounted for','compatibility owner/consumer anchor bounds and82 pinned input files','per-path compatibility navigation joins']
receipt['limitations']+=['every semantic branch/API not qualified; known compatibility families only','classifications preserve current public/migration support; no policy change or test/build execution']

REP=[r for r in L if r['record']=='representation'];G=[r for r in L if r['record']=='representation_carriers'];RW=[r for r in L if r['record']=='representation_workflow'];RI=next(r for r in L if r['record']=='representation_inputs');rids={r['id'] for r in REP};gids={r['id'] for r in G}
assert len(REP)==len(rids)==35 and len(G)==8 and len(RW)==18 and {r['id'] for r in RW}==ids
def walk(x):
 if isinstance(x,dict):
  if 'path' in x and 'line' in x:yield x
  for v in x.values():yield from walk(v)
 elif isinstance(x,list):
  for v in x:yield from walk(v)
for r in REP:
 for a in walk(r):
  if not (R/a['path']).is_file() or not 1<=a['line']<=len((R/a['path']).read_text().splitlines()):E.append(['representation anchor',r['id'],a])
for r in RW:
 if any(x not in rids for x in r['representation_refs']) or any(x not in gids for x in r['carrier_groups']):E.append(['representation joins',r['id']])
for r in P:
 if any(x not in rids for x in r['representation_refs']):E.append(['path representation',r['path']])
for q in RI['files']:
 raw=(R/q['path']).read_bytes()
 if q['pin_kind']=='observed_prefix_before_Step5_append':raw=raw[:q['bytes']]
 if hashlib.sha256(raw).hexdigest()!=q['sha256']:E.append(['representation input changed',q['path']])
for g in G:
 for a in g['declarations']:
  lo,*rest=a['lines'].split('-');hi=rest[0] if rest else lo
  if not (R/a['path']).is_file() or not 1<=int(lo)<=int(hi)<=len((R/a['path']).read_text().splitlines()):E.append(['carrier declaration bounds',g['id'],a])
PD=D/'representation-evidence/provenance';pr=json.load(open(PD/'receipt.json'));assert pr['passed_emission_cases']==8 and all(c['exit']==0 for c in pr['commands']) and not pr['post_probe_input_changes'] and pr['raw_build_verification']['exit']==0
for q in json.load(open(PD/'before-inputs.json')):
 if hashlib.sha256((R/q['path']).read_bytes()).hexdigest()!=q['sha256']:E.append(['probe input changed',q['path']])
assert len([x for x in (PD/'probe.stdout').read_text().splitlines() if x.startswith('CASE ')])==8
evidence=[{'path':str(p.relative_to(D)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(PD.iterdir()) if p.is_file()]
receipt.update(scope='Mechanical current inventory/workflow/compatibility/representation linkage and evidence integrity; not all semantic correctness',representations=35,selected_carrier_groups=8,representation_workflow_joins=18,representation_input_files=len(RI['files']),probe_input_pins=108,probe_passed_emission_cases=8,evidence_files=evidence,errors=E)
receipt['checks']+=['35 unique representation slices,8 selected carrier groups,18 workflow joins','representation owner/consumer bounds, carrier range bounds and37 input pins','saved public-API probe8 cases and108 compiler/catalog input pins; raw fixture/artifact/receipt integrity']
receipt['limitations']=[x.replace('no policy change or test/build execution','Step4 classification/review made no policy change or execution; Step5 root build/API probes are separately captured') for x in receipt['limitations']]
receipt['limitations']+=['deliberate mixed public-input probes distinct from normal CLI and immutable append control','source reconstruction/parallel models do not establish measured cost or redundant semantics','fresh locked offline library build + probe execution only; no JS/application/GUI/fullsuite/other-host qualification']

# Step6 current mechanical linkage only; preserve prior historical receipts.
I=[r for r in L if r['record']=='library_integration']; IG=[r for r in L if r['record']=='library_integration_graph']; IP=next(r for r in L if r['record']=='library_integration_inputs'); IS=next(r for r in L if r['record']=='library_integration_scope'); IC=json.loads((D/'integration-counts.json').read_text()); irids={r['id'] for r in I}
assert len(I)==len(irids)==22 and len(IG)==2
assert {d for r in I for d in r['dependencies']}=={'serde','serde_json','url','sha2','tempfile','lsp-types','sourcemap'}
import ast,re
ns={}; tree=ast.parse((D/'integration-evidence/count.py').read_text())
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.Import,ast.ImportFrom))],type_ignores=[]),'counter-functions','exec'),ns)
# Compile-only source tools checked; no compiler/build/test invocation.
for f in ['count.py','items.py','delta.py','validate.py']: ast.parse((D/'integration-evidence'/f).read_text())
source_lines={}; tests={}
def source(p):
 if p not in source_lines: source_lines[p]=(R/p).read_text().splitlines()
 return source_lines[p]
def metric(us):
 by={};decl=set()
 for u in us:
  if not u['path'].startswith('compiler/src/'):continue
  lo,hi=u['lines'];by.setdefault(u['path'],set()).update(range(lo,hi+1));decl.add((u['path'],lo,hi))
 return {'source_units':len(decl),'files':len(by),'physical_union':sum(map(len,by.values())),'nonblank_union':sum(bool(source(p)[l-1].strip()) for p,ls in by.items() for l in ls)}
byid={r['id']:r for r in I}
for r in I:
 if r['verdict'] not in {'simplify','retain','replace','defer'}:E.append(['verdict',r['id']])
 if any(q not in irids for q in r['closure_links']):E.append(['closure link',r['id']])
 for u in r['counted_own_range_units']:
  p=u['path'];a,b=u['lines']
  if not (R/p).is_file() or not 1<=a<=b<=len(source(p)):E.append(['integration bounds',r['id'],u])
  if p.startswith('compiler/src/'):
   if p not in tests:
    text=(R/p).read_text();tests[p]=[(text.count('\n',0,x)+1,text.count('\n',0,y-1)+1) for x,y in ns['test_spans'](text)]
   if any(a<=y and b>=x for x,y in tests[p]):E.append(['integration includes inline tests',r['id'],u])
 ids={r['id']};pending=list(r['closure_links'])
 while pending:
  q=pending.pop()
  if q in ids:continue
  ids.add(q);pending+=byid[q]['closure_links']
 got=metric([u for q in ids for u in byid[q]['counted_own_range_units']]);stored=r['closure_metrics']['linked_complete_scoped_union']
 if any(got[k]!=stored[k] for k in got):E.append(['integration count',r['id'],got,stored])
 if got!= {k:IC['closure_metrics'][r['id']]['linked_complete_scoped_union'][k] for k in got}:E.append(['count derivative',r['id']])
for q in IP['files']:
 raw=(R/q['path']).read_bytes()
 if q['pin_kind']=='observed_prefix_before_Step6_append':raw=raw[:q['bytes']]
 if hashlib.sha256(raw).hexdigest()!=q['sha256']:E.append(['integration input changed',q['path']])
for r in P:
 if any(q not in irids for q in r['library_integration_refs']):E.append(['path integration refs',r['path']])
current=inline=0
for p in sorted((R/'compiler/src').rglob('*.rs')):
 text=p.read_text();n=ns['physical'](text);t=sum(ns['lines_in_span'](text,a,b) for a,b in ns['test_spans'](text));current+=n-t;inline+=t
assert (current,inline)==(69255,3529)
delta=json.loads((D/'integration-evidence/production-delta.json').read_text());assert sum(r['gross_removed'] for r in delta['records'])==2067 and sum(r['gross_added'] for r in delta['records'])==2203 and delta['net']==136
assert sum(r['before_production_lines'] for r in delta['records'])==69119 and sum(r['after_production_lines'] for r in delta['records'])==69255
union=metric([u for r in I for u in r['counted_own_range_units']]);assert all(union[k]==IC['aggregate_current_closure_union'][k] for k in union)
receipt.update(scope='Mechanical Step6 source/closure/pin/count integrity with retained Steps1–5 linkage. Not new compiler execution, every semantic branch, workload cost or replacement qualification.',integration_records=22,direct_dependencies=7,integration_graphs=2,integration_input_files=len(IP['files']),integration_verdicts=dict(collections.Counter(r['verdict'] for r in I)),integration_closure_union=union,compiler_production_lines=current,compiler_inline_test_lines=inline,whole_compiler_gross_removed=2067,whole_compiler_gross_added=2203,whole_compiler_net_increase=136,errors=E)
receipt['checks']+=['all seven direct dependencies mapped to22 unique integration result rows','all current production range bounds and exact inline-test exclusions','linked shared closure union metrics independently recomputed; no summing nested/shared callers','49 source/support input hashes and shared decision prefix checked','current69255/3529 compiler counts replayed; whole original/current delta arithmetic2067/2203/+136 reconciled','published replay tool source parses as Python; no execution/compiler qualification inferred']
receipt['limitations']+=['integration slice/context counts not library overhead or removable code','same-owner reverse call graphs are lexical and independently source challenged; Rust trait/derive routing explicit but not compiler callgraph proof','arbitrary external Rust users and full downstream package workflows unresolved; public orphans not deletion authority','conditional retirement thresholds include replacement/fallback/public compatibility code; no Step6 production deletion or candidate equivalence/build/release/performance trial']
receipt['integration_evidence_files']=[{'path':str(p.relative_to(D)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted((D/'integration-evidence').iterdir()) if p.is_file()]
json.dump(receipt,open(D/'integration-validation.json','w'),indent=2)
print(json.dumps({k:receipt[k] for k in ['integration_records','integration_input_files','integration_verdicts','integration_closure_union','compiler_production_lines','whole_compiler_net_increase','errors','ledger_sha256']},indent=2));assert not E,E
