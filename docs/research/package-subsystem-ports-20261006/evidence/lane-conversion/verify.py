import json,re,itertools,hashlib,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[5]
base=root/'docs/research/package-subsystem-ports-20261006'
p=base/'implementation-plans'
data=[]
for f in sorted(p.glob('*.tasks.json')):
 d=json.loads(f.read_text()); d['_file']=f.name; data.append(d)
nodes={};errors=[]
for d in data:
 for t in d['tasks']:
  if t['id'] in nodes:errors.append('duplicate '+t['id'])
  nodes[t['id']]={**t,'plan':d['plan'],'lane_key':d['plan']+'/'+t['lane']}
for id,t in nodes.items():
 for dep in t['depends_on']:
  if dep not in nodes:errors.append('unknown dependency '+id+' -> '+dep)
 for branch in t.get('conditional_dependencies',[]):
  for dep in branch['depends_on']:
   if dep not in nodes:errors.append('unknown conditional '+id+' -> '+dep)
 for w in t['writes']:
  if w.startswith('/') or '..' in Path(w).parts:errors.append('unsafe write '+id+' '+w)
  if not (w.startswith('packages/') or w.startswith('docs/') or w in ['package.json','bun.lock']):errors.append('out of scope '+id+' '+w)
  if any(x.lower()=='rust' for x in Path(w).parts[:-1]):errors.append('language folder '+id+' '+w)
seen=set();active=set();order=[]
def visit(id):
 if id in seen:return
 if id in active:raise ValueError('cycle '+id)
 active.add(id)
 t=nodes[id]
 for dep in t['depends_on']+[v for x in t.get('conditional_dependencies',[]) for v in x['depends_on']]:
  if dep in nodes:visit(dep)
 active.remove(id);seen.add(id);order.append(id)
try:
 for id in nodes:visit(id)
except ValueError as ex:errors.append(str(ex))
anc={}
def ancestors(id):
 if id in anc:return anc[id]
 vals=set(nodes[id]['depends_on'])
 for dep in list(vals):
  if dep in nodes:vals.update(ancestors(dep))
 anc[id]=vals;return vals
if not errors:
 for id in nodes:ancestors(id)
collisions=[];serialized=[]
def overlap(a,b):
 return a==b or (a.endswith('/') and b.startswith(a)) or (b.endswith('/') and a.startswith(b))
for a,b in itertools.combinations(nodes.values(),2):
 common=[(x,y) for x in a['writes'] for y in b['writes'] if overlap(x,y)]
 if common:
  ordered=a['id'] in anc.get(b['id'],set()) or b['id'] in anc.get(a['id'],set())
  exclusive=a['lane_key']==b['lane_key']
  record={'a':a['id'],'b':b['id'],'writes':common,'ordered':ordered,'exclusive_lane':exclusive}
  if ordered or exclusive:serialized.append(record)
  else:collisions.append(record)
for d in data:
 name='README.md' if d['plan']=='shared' else d['plan']+'.md'
 md=(p/name).read_text()
 ids=re.findall(r'\[ \] \*\*([ACPVW]\d+(?:\.[\w-]+)?)\b',md)
 expected=[t['id'] for t in d['tasks']]
 if len(ids)!=len(set(ids)):errors.append('duplicate markdown checkbox '+name)
 if set(ids)!=set(expected):errors.append('checkbox mismatch '+name+' '+str(set(ids)^set(expected)))
 if '[x]' in md or '[X]' in md:errors.append('checked task '+name)
 matches=list(re.finditer(r'\[ \] \*\*([ACPVW]\d+(?:\.[\w-]+)?)\b',md))
 task_map={t['id']:t for t in d['tasks']}
 for index,match in enumerate(matches):
  block=md[match.start():matches[index+1].start() if index+1<len(matches) else len(md)]
  dependency_text=None
  for line in block.splitlines():
   if 'Gate after:' in line:dependency_text=line.split('Gate after:',1)[1].split(';',1)[0];break
   if 'Start after:' in line:dependency_text=line.split('Start after:',1)[1].split('Parent:',1)[0];break
   if 'Start:' in line:dependency_text=line.split('Start:',1)[1];break
  if dependency_text is None:
   header=block.splitlines()[0]
   if 'start after ' in header:dependency_text=header.split('start after ',1)[1]
   elif '; after ' in header:dependency_text=header.split('; after ',1)[1]
  if dependency_text is None:errors.append('missing Markdown dependencies '+match[1])
  elif set(re.findall(r'`([ACPVW]\d+(?:\.[\w-]+)?)`',dependency_text))!=set(task_map[match[1]]['depends_on']):errors.append('Markdown dependency mismatch '+match[1])
 if len(re.findall(r'^```',md,re.M))%2:errors.append('unclosed fence '+name)
 for line,txt in enumerate(md.splitlines(),1):
  if txt.rstrip()!=txt:errors.append('trailing whitespace '+name+':'+str(line))
 for path in re.findall(r'\]\(([^)]+)\)',md):
  if not re.match(r'(?:https?:|#|codex:)',path):
   target=(p/path.split('#')[0])
   if not target.exists():errors.append('broken local link '+name+' '+path)
 lanes={x['id']:x for x in d['lanes']}
 for t in d['tasks']:
  if t['lane'] not in lanes:errors.append('missing lane '+t['id']);continue
  owns=lanes[t['lane']]['owns']
  for w in t['writes']:
   if not any(w==x or (x.endswith('/') and w.startswith(x)) for x in owns):errors.append('write outside lane '+t['id']+' '+w)
# The final report below is the only emitted summary.
# Store a complete, resource-aware plan; simulation batches are illustrative, not durations.
plans=[{k:v for k,v in d.items() if k!='_file'} for d in data]
required={id for id,t in nodes.items() if t['required']}
port_optional={id for id,t in nodes.items() if not t['required'] and not id.startswith('W09')}
def selected_deps(t,conditions):
 ds=list(t['depends_on'])
 if conditions:ds += [d for b in t.get('conditional_dependencies',[]) for d in b['depends_on']]
 return set(ds)
def schedule(selected,conditions):
 dep={id:selected_deps(nodes[id],conditions) for id in selected}
 for id,ds in dep.items():
  if ds-selected:raise ValueError('selected profile misses '+id+' '+str(ds-selected))
 children={id:set() for id in selected}
 for id,ds in dep.items():
  for x in ds:children[x].add(id)
 rank={}
 def height(id):
  if id not in rank:rank[id]=1+max([height(x) for x in children[id]] or [0])
  return rank[id]
 for id in selected:height(id)
 done=set();batches=[]
 while done!=selected:
  ready=sorted([id for id in selected-done if dep[id]<=done],key=lambda id:(-rank[id],-len(children[id]),id))
  if not ready:raise ValueError('dispatch stuck')
  lanes=set();chosen=[];writes=[];worker=0;coordinator=0
  for id in ready:
   t=nodes[id];coord=t['kind']=='gate' or t['lane_key']=='shared/C-coordination'
   if (coord and coordinator>=1) or (not coord and worker>=3):continue
   if t['lane_key'] in lanes:continue
   if any(overlap(a,b) for a in t['writes'] for b in writes):continue
   lanes.add(t['lane_key']);writes+=t['writes'];chosen.append(id)
   if coord:coordinator+=1
   else:worker+=1
  if not chosen:raise ValueError('resource dispatch stuck')
  for a,b in itertools.combinations(chosen,2):
   assert not any(overlap(x,y) for x in nodes[a]['writes'] for y in nodes[b]['writes'])
  batches.append({'ready_count':len(ready),'implementation':[id for id in chosen if not (nodes[id]['kind']=='gate' or nodes[id]['lane_key']=='shared/C-coordination')],'coordinator':[id for id in chosen if nodes[id]['kind']=='gate' or nodes[id]['lane_key']=='shared/C-coordination']})
  done.update(chosen)
 return batches
profiles={'declared-required-scope':schedule(required,False),'accepted-port-branches':schedule(required|port_optional,True)}
manifest={'schema_version':1,'package_source_checkpoint':data[0]['source_checkpoint'],'implementation_status':'proposed; all boxes unchecked','dispatch_policy':{'implementation_workers':3,'coordinator_workers':1,'one_active_task_per_lane':True,'exclusive_file_reservation':True,'priority':'longest remaining dependency chain, then downstream fanout, then ID','wave_numbers_are_barriers':False,'timing_claim':'Dispatch batches assume equal completions only to check legal readiness/resource allocation; they are not elapsed time or an optimal makespan.'},'conditional_profiles':{'declared-required-scope':'HTTP/MCP/forms/mixed-asset branches declined or deferred with explicit outcome records; no adoption claim for them.','accepted-port-branches':'All bounded port branches accepted; enforces their extra prerequisite proofs. W09 scheduler remains a separate optional project.'},'plans':plans,'task_count':len(nodes),'required_task_count':len(required),'optional_task_count':len(nodes)-len(required),'parent_completion_gates':{'exact-values':[f'A{x:02d}' for x in range(1,12)],'input-validation':[f'V{x:02d}' for x in range(1,13)],'work-transitions':[f'W{x:02d}' for x in range(1,9)],'artifact-preparation':[f'P{x:02d}' for x in range(1,12)]},'topological_order_with_all_conditional_edges':order,'illustrative_resource_valid_dispatch':profiles,'write_serialization':serialized}
(p/'execution-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
errors=[x for x in errors if x!='broken local link README.md execution-manifest.json']
for id in required:
 for dep in nodes[id]['depends_on']:
  if dep not in required:errors.append('required unconditionally depends optional '+id+' '+dep)
for group in manifest['parent_completion_gates'].values():
 for id in group:
  if id not in nodes or nodes[id]['kind']!='gate':errors.append('missing original parent '+id)
previous=json.loads((base/'evidence/implementation-plans/verification.json').read_text())
source_checks={w:hashlib.sha256((root/w).read_bytes()).hexdigest() for w in previous['source_hashes']}
source_mismatches=[w for w,v in source_checks.items() if v!=previous['source_hashes'][w]]
if source_mismatches:errors.append('source hashes changed '+str(source_mismatches))
original=json.loads((base/'evidence/lane-conversion/before.json').read_text())
preservation={}
for filename,v in original['documents'].items():
 old=v['text'];new=(p/filename).read_text();section=v['task_section']
 if filename=='README.md':continue
 pos=old.index(section);prefix=old[:pos];suffix=old[pos+len(section):]
 preservation[filename]={'original_non_task_prefix_preserved':new.startswith(prefix),'original_non_task_suffix_preserved':new.endswith(suffix)}
 # Explicit reviewed ownership refinements and one source-path correction are allowed.
 normalized=new
 changes=[]
 if filename=='exact-values.md':
  replacements={
   'aggregates/{mod,numeric,integer,decimal,money}.rs':'aggregates/{mod,numeric}.rs',
   'tests/{integer_vectors,rounding_vectors,decimal_vectors,money_vectors,temporal_vectors,aggregate_vectors}.rs':'tests/{numeric_vectors,temporal_vectors,aggregate_vectors}.rs',
   'A03.1, completed by A03.foundation, owns':'A03 owns',
   'A03.foundation exposes workspace/representations/failures before independent algorithm work; A03–A06 native tasks consume C01–C03 readiness through their explicit leaf dependencies. C04.ready must pass before A07 actual Worker binding integration.':'A03–A06 can proceed natively after C01–C03; C04 must pass before A07 Worker integration.',
   'scripts listed in the checklist':'scripts listed in the task table'}
  for a,b in replacements.items():
   if a in normalized:changes.append({'new':a,'previous':b});normalized=normalized.replace(a,b)
 if filename=='work-transitions.md':
  replacements={
   '`packages/cloudflare/src/runtime/t24b-dispatch-execution.test.ts` and `t24b-dispatch-durable.test.ts`':'`packages/cloudflare/src/runtime/t24b-dispatch{,-durable}.test.ts`',
   'prepared.ts                        # integrator composition of lane modules':'prepared.ts                        # consolidated TS comparator'}
  for a,b in replacements.items():
   if a in normalized:changes.append({'new':a,'previous':b});normalized=normalized.replace(a,b)
  lines=['    rows.ts                            # rows lane','    retry.ts','    every.ts','    lifecycle.ts                       # policy lane','    receipt.ts','    recovery.ts','    linkage.ts                         # receipts/recovery/linkage lane','    retry.test.ts','    every.test.ts','    lifecycle.test.ts','    receipt.test.ts','    recovery.test.ts','    linkage.test.ts']
  for line in lines:
   if line+'\n' in normalized:changes.append({'new':line,'previous':'no separate lane file'});normalized=normalized.replace(line+'\n','')
 preservation[filename]['reviewed_nonsemantic_refinements']=changes
 preservation[filename]['all_other_non_task_contracts_preserved']=normalized.startswith(prefix) and normalized.endswith(suffix)
 if not preservation[filename]['all_other_non_task_contracts_preserved']:errors.append('unreviewed non-task contract changed '+filename)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
changed=subprocess.check_output(['git','diff','--name-only',original['source_checkpoint']+'..'+head],cwd=root,text=True).splitlines()
if any(w.startswith('packages/') for w in changed):errors.append('new package commit needs source refresh')
status=subprocess.check_output(['git','status','--short','--','packages/','compiler/','package.json','bun.lock'],cwd=root,text=True)
if status:errors.append('production working tree changes '+status)
check=subprocess.run(['git','diff','--check'],cwd=root,capture_output=True,text=True)
if check.returncode:errors.append('git diff check '+check.stdout+check.stderr)
# Validate links now that the generated combined manifest exists.
links=0
for d in data:
 filename='README.md' if d['plan']=='shared' else d['plan']+'.md'
 for path in re.findall(r'\]\(([^)]+)\)',(p/filename).read_text()):
  if not re.match(r'(?:https?:|#|codex:)',path):
   links+=1
   if not (p/path.split('#')[0]).exists():errors.append('broken link '+filename+' '+path)
report={'date':'2026-10-06','source_checkpoint':original['source_checkpoint'],'observed_head':head,'concurrent_committed_files':changed,'package_source_hashes_checked':len(source_checks),'source_hash_mismatches':source_mismatches,'task_count':len(nodes),'required_task_count':len(required),'optional_task_count':len(nodes)-len(required),'by_plan':{d['plan']:{'tasks':len(d['tasks']),'required':sum(t['required'] for t in d['tasks']),'lanes':len(d['lanes'])} for d in data},'original_parent_gates_preserved':42,'all_checkboxes_unchecked':True,'graph_acyclic_including_all_conditional_edges':len(order)==len(nodes),'local_links_checked':links,'ordered_or_exclusively_owned_overlapping_write_pairs':len(serialized),'unordered_cross_lane_write_conflicts':collisions,'non_task_contract_preservation':preservation,'resource_valid_dispatch_profiles':{name:len(v) for name,v in profiles.items()},'production_source_edits':False,'implementation_tests_or_benchmarks_run':False,'documents':{str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(p.glob('*')) if f.is_file()},'issues':errors+[str(v) for v in collisions]}
(base/'evidence/lane-conversion/verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['task_count','required_task_count','optional_task_count','by_plan','original_parent_gates_preserved','local_links_checked','source_hash_mismatches','non_task_contract_preservation','issues']},indent=2))
if report['issues']:raise SystemExit(1)
