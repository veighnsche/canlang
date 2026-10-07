#!/usr/bin/env python3
"""Read retained evidence and current pins only; never rebuild or execute probes."""
import copy,hashlib,json,pathlib,re,subprocess
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[4]
def load(n):return json.loads((HERE/n).read_text())
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 errors=[];historical=[];counts={'input_pins':0,'commands':0,'raw_streams':0,'flat_sources':0,'catalog_mutations':0,'local_links':0}
 def require(ok,label):
  if not ok:errors.append(label)
 inputs=load('inputs.json')
 for pin in inputs['pins']:
  p=ROOT/pin['path'];counts['input_pins']+=1
  if not (p.is_file() and digest(p)==pin['sha256']):
   snapshot=subprocess.run(['git','show',inputs['head']+':'+pin['path']],cwd=ROOT,capture_output=True)
   require(snapshot.returncode==0 and hashlib.sha256(snapshot.stdout).hexdigest()==pin['sha256'],'historical input pin '+pin['path'])
   historical.append({'path':pin['path'],'audit_sha256':pin['sha256'],'current_sha256':digest(p) if p.is_file() else None,'scope':'Audit source snapshot only; concurrent repair/bookkeeping is outside retained execution'})
 require(subprocess.check_output(['git','rev-parse',inputs['head']+':compiler'],cwd=ROOT,text=True).strip()==inputs['compiler_tree'],'historical compiler tree')
 for n in ['build.json','resource-execution.json','files-execution.json']:
  for c in load(n)['commands']:
   counts['commands']+=1
   for s in ['stdout','stderr']:
    p=HERE/c[s];counts['raw_streams']+=1;require(p.is_file() and digest(p)==c[s+'_sha256'],'raw '+n+':'+c['name']+':'+s)
 base=ROOT/'packages/values/dist/catalog.json';cases=load('resource-cases.json')
 for c in cases:
  if 'source' in c:
   counts['flat_sources']+=1;p=HERE/c['source'];require(p.is_file() and digest(p)==c['sha256'] and p.stat().st_size==c['bytes'],'flat source '+c['id'])
  else:
   counts['catalog_mutations']+=1;require(digest(base)==c['base_catalog_sha256'],'catalog baseline '+c['id']);value=json.loads(base.read_text());entry=next(x for x in value['entries'] if x['id']==c['mutation']['id']);require(entry['kind']==c['mutation']['kind'],'catalog kind');entry['signature']=c['mutation']['signature'];data=json.dumps(value,separators=(',',':')).encode();require(hashlib.sha256(data).hexdigest()==c['catalog_sha256'] and len(data)==c['catalog_bytes'],'catalog reconstruction '+c['id'])
 obs=load('resource-observations.json');by={x['id']:x for x in obs}
 aborts=['source-flat-1024-compile','source-flat-2048-check','source-flat-2048-compile','source-flat-3000-check','source-flat-3000-compile']
 require(len(obs)==42 and len(by)==42,'resource observation IDs/count')
 for ident in aborts:require(by[ident]['exit']==-6 and not by[ident]['timed_out'] and 'stack overflow' in (HERE/(ident+'.stderr')).read_text(),'abort witness '+ident)
 for n in [64,256,512,1024,2048,3000]:
  o=by['source-flat-'+str(n)+'-parse'];require(o['exit']==0 and o['stdout_json']['coverage'] and o['stdout_json']['codes']==[],'parse control '+str(n))
 for n in [64,256,512]:
  for stage in ['check','compile']:require(by['source-flat-'+str(n)+'-'+stage]['exit']==0,'positive '+str(n)+stage)
 require(by['source-flat-1024-check']['exit']==0,'1024 check control')
 files=load('files-observations.json')['observations'];fb={x['id']:x for x in files};require(len(files)==21 and len(fb)==21,'file observations')
 require([x['id'] for x in load('files-cases.json')['cases']]==[x['id'] for x in files],'file case joins')
 require(bool(fb['ownership-tests']['body_skips']),'4750 skip retained')
 reg=load('registry.json');rows=[json.loads(s) for s in (HERE.parent/'coverage.jsonl').read_text().splitlines()];duties=[x for x in rows if x['record']=='failure_duty'];findings=[x for x in rows if x['record']=='failure_finding']
 require(len(duties)==44 and {x['id'] for x in duties}==set(reg['duties']),'44 ledger duty joins');require(len(findings)==7 and {x['id'] for x in findings}=={x['id'] for x in reg['packets']},'packet joins')
 for packet in reg['packets']:
  require(set(packet['duty_refs'])<=set(reg['duties']),'packet duties '+packet['id'])
  for name in packet['defining_writers']+packet['test_writers']:require((ROOT/name).is_file(),'packet file '+name)
 for name in ['failure.md','README.md']:
  p=HERE.parent/name
  for target in re.findall(r'\]\(([^)]+)\)',p.read_text()):
   if target.startswith(('http:','https:','#')):continue
   target=target.split('#')[0];counts['local_links']+=1;require((p.parent/target).exists() or (p.parent/target)==HERE/'validation.json','local link '+name+':'+target)
 receipt={'schema_version':1,'step':12,'scope':'Mechanical source/receipt/case/ledger/link validation; no behavior rerun or semantic certification','compiler_last_source_change':inputs['compiler_last_source_change'],'compiler_tree':inputs['compiler_tree'],'counts':counts,'historical_pins_with_live_drift':historical,'ledger_records':len(rows),'duties':len(duties),'packets':len(findings),'observed_stack_aborts':5,'file_harness_passes':17,'reported_ownership_body_skips':1,'ledger_sha256':digest(HERE.parent/'coverage.jsonl'),'errors':errors,'limits':['native debug retained receipts only','missing observer executable SHA remains','wall/core controls are not memory sandbox','no exact failing stage/release/otherhost/GUI/full application acceptance']}
 (HERE/'validation.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt));raise SystemExit(bool(errors))
if __name__=='__main__':main()
