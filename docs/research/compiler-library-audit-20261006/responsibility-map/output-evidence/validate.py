#!/usr/bin/env python3
"""Read-only pin/receipt/ledger/link validation; semantic review remains separate."""
import json,pathlib,re,subprocess,hashlib
from run import HERE,ROOT,save,digest
def main():
 errors=[];pins=0;commands=0;superseded=[];links=0
 def require(ok,label):
  if not ok:errors.append(label)
 def pinwalk(x):
  nonlocal pins
  if isinstance(x,dict):
   if isinstance(x.get('path'),str) and x.get('sha256'):
    p=pathlib.Path(x['path']);p=p if p.is_absolute() else ROOT/p
    require(p.is_file(),'missing pin '+str(p))
    if p.is_file():
     pins+=1;actual=digest(p)
     if actual!=x['sha256'] and p.name=='DECISIONS.md' and 'bytes' in x:actual=hashlib.sha256(p.read_bytes()[:x['bytes']]).hexdigest()
     require(actual==x['sha256'],'pin mismatch '+str(p))
   for v in x.values():pinwalk(v)
  elif isinstance(x,list):
   for v in x:pinwalk(v)
 for name in ['../syntax-evidence/inputs.json','../syntax-evidence/runtime-inputs.json','inputs.json','support-inputs.json']:
  pinwalk(json.loads((HERE/name).read_text()))
 # Compiler tracked baseline and current production closure.
 inv=HERE.parent.parent/'baseline-verification/compiler-inventory.jsonl'
 for line in inv.read_text().splitlines():pinwalk(json.loads(line))
 diff=subprocess.check_output(['git','diff','1fd07722090fe70228a6b661e3c6e136275ca84b','--','compiler'],cwd=ROOT,text=True)
 require(not diff,'compiler differs from source baseline')
 for name in ['observer-execution.json','suites-execution.json','cli-execution.json','execution.json']:
  e=json.loads((HERE/name).read_text())
  for c in e['commands']:
   commands+=1
   for stream in ['stdout','stderr']:
    f=HERE/c[stream];require(f.is_file(),'missing capture '+str(f))
    if f.is_file() and digest(f)!=c[stream+'_sha256']:
     if name=='execution.json' and c['name'] in e.get('superseded_captures',[]):superseded.append({'collection':name,'name':c['name'],'stream':stream})
     else:errors.append('capture hash mismatch '+name+':'+c['name']+':'+stream)
  pinwalk(e.get('libraries',[]));pinwalk(e.get('binary',{}))
 cases=json.loads((HERE/'cases.json').read_text());obs=json.loads((HERE/'observations.json').read_text())
 require(len(cases)==61 and len({x['id'] for x in cases})==61,'finite case IDs')
 require([c['id'] for c in cases]==[o['id'] for o in obs],'case receipt joins')
 for c,o in zip(cases,obs):
  require(hashlib.sha256(c['source'].encode()).hexdigest()==c['source_sha256']==o['source_sha256'],'source case hash '+c['id'])
  if c.get('source_path'):require(digest(ROOT/c['source_path'])==c['source_sha256'],'corpus changed '+c['source_path'])
  require((HERE/o['observation']).is_file(),'case missing observation '+c['id'])
 out=json.loads((HERE/'outcome-verification.json').read_text());require(out['counts']=={'checks':377,'passes':367,'failures':10},'outcome arithmetic')
 require(sum(x['passed'] for x in out['native_suites'].values())==113 and sum(x['reported_skips'] for x in out['native_suites'].values())==1,'native counts/skip')
 rows=[json.loads(l) for l in (HERE.parent/'coverage.jsonl').read_text().splitlines()]
 old=[json.loads(l) for l in subprocess.check_output(['git','show','eb5ca8d:docs/research/compiler-library-audit-20261006/responsibility-map/coverage.jsonl'],cwd=ROOT,text=True).splitlines()]
 require(len(old)==451 and len(rows)==494,'ledger record counts')
 for before,after in zip(old,rows):require(before=={k:v for k,v in after.items() if k!='output_refs'},'prior ledger row drift '+str(before.get('id',before.get('path'))))
 ids=set();duties=[]
 for name in ['serialization','transforms','coordinates']:
  d=json.loads((HERE/(name+'.json')).read_text())
  for duty in d['finite_duties']:
   require(duty['id'] not in ids,'duplicate duty ID');ids.add(duty['id']);duties.append(duty)
   for decl in duty['defining_declarations']:
    for path in re.findall(r'(?:compiler|packages)/[A-Za-z0-9_./-]+\.rs|(?:compiler|packages)/[A-Za-z0-9_./-]+\.ts',decl):require((ROOT/path).is_file(),'missing defining file '+path)
 require(len(duties)==35,'duty count')
 reg=next(r for r in rows if r.get('id')=='OUT-REGISTRY');require(set(reg['duty_ids'])=={'OUT-'+id for id in ids},'registry duties')
 for f in [r for r in rows if r['record']=='output_finding']:require(set(f['duty_refs'])<=set(reg['duty_ids']),'finding duty join '+f['id'])
 # Actual source-map consumer independently reported its executed current-source pins.
 stderr=(HERE/'focused-suites.stderr').read_text()
 for line in stderr.splitlines():
  if line.startswith('{'):
   try:m=json.loads(line)
   except json.JSONDecodeError:continue
   if 'sourcePins' in m:
    for name,sha in m['sourcePins'].items():
     path='packages/testkit/src/reporting/report.ts' if name=='report.ts' else 'packages/cloudflare/src/runtime/'+name
     require(digest(ROOT/path)==sha,'executed map source drift '+path)
 # Local links in changed narrative files; no website validity or semantic certification implied.
 paths=[HERE.parent/'outputs.md',HERE.parent/'README.md',HERE.parent.parent/'compiler-correctness-simplicity-audit.md']
 for p in paths:
  for target in re.findall(r'\]\(([^)]+)\)',p.read_text()):
   if target.startswith(('https:','http:','#','app:')):continue
   target=target.split('#')[0];require((p.parent/target).exists(),'missing local link '+str(p)+':'+target);links+=1
 # Final reviewed source and evidence contents pinned at this receipt, not historical execution timestamps.
 files=[p for p in HERE.iterdir() if p.is_file()]
 receipt={'scope':'Mechanical input/receipt/source/ledger/link validation; independent semantic review separate','compiler_source_commit':'1fd07722090fe70228a6b661e3c6e136275ca84b','compiler_diff':diff,'ledger_records':len(rows),'output_duties':35,'findings':5,'pin_references_checked':pins,'captured_command_references':commands,'explicit_superseded_captures':superseded,'cases':len(cases),'selected_harness_passes':113,'reported_branch_skips':1,'later_outcomes':out['counts'],'local_markdown_links_checked':links,'ledger_sha256':digest(HERE.parent/'coverage.jsonl'),'errors':errors,'final_evidence_pins':[{'path':str(p.relative_to(ROOT)),'sha256':digest(p),'bytes':p.stat().st_size} for p in sorted(files)],'limits':['finite duties/sampled witnesses, not every source branch','superseded initial capture names explicit; final observers/suites separate','Markdown standards-derived meaning, no parser execution','native/installed-dist/current-source consumers, not rebuilt packages/release/GUI/other-host acceptance','historical skill validator bundle unavailable; local joined validation used']}
 (HERE.parent/'output-validation.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({k:v for k,v in receipt.items() if k not in ['final_evidence_pins','limits']}))
 raise SystemExit(bool(errors))
if __name__=='__main__':main()
