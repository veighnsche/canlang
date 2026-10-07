#!/usr/bin/env python3
"""Verify audit records and frozen bytes; never execute package implementation."""
import argparse, collections, hashlib, json, pathlib, subprocess, sys

p=argparse.ArgumentParser()
p.add_argument('--repo',default='.')
p.add_argument('--external',action='store_true')
p.add_argument('--write',action='store_true')
p.add_argument('--screen-recheck',help='Optional syntax-only screen output to compare')
a=p.parse_args()
repo=pathlib.Path(a.repo).resolve()
root=pathlib.Path(__file__).resolve().parent
scope=json.loads((root/'scope.json').read_text())
pin=scope['source_checkpoint']
index=json.loads((root/'source-index.json').read_text())
records=[json.loads(s) for s in (root/'candidates.jsonl').read_text().splitlines() if s]
errors=[];cache={};drift=[];external_skipped=[]
counts=collections.Counter()
for entry in index:
 path=entry['path']
 if entry.get('external'):
  if not a.external:
   external_skipped.append(path);continue
  f=pathlib.Path(path)
  if not f.exists():errors.append('missing external input: '+path);continue
  data=f.read_bytes();counts['external_inputs']+=1
 else:
  r=subprocess.run(['git','show',pin+':'+path],cwd=repo,capture_output=True)
  if r.returncode:errors.append('missing frozen input: '+path);continue
  data=r.stdout;counts['repository_inputs']+=1
  try:cache[path]=data.decode('utf8').splitlines()
  except UnicodeDecodeError:
   cache[path]=[];counts['binary_inventory_inputs']+=1
  current=repo/path
  if not current.exists() or current.read_bytes()!=data:drift.append(path)
 if hashlib.sha256(data).hexdigest()!=entry['sha256']:errors.append('hash mismatch: '+path)
 if len(data.splitlines())!=entry['lines']:errors.append('line count mismatch: '+path)
ids=[c['id'] for c in records]
if len(ids)!=len(set(ids)):errors.append('duplicate candidate IDs')
for c in records:
 if c['execution_authorized'] is not False:errors.append('execution authorized: '+c['id'])
 for key in ['title','disposition','caller_evidence','complexity','change_gates','negative_witnesses','public_obligations']:
  if not c.get(key):errors.append('missing '+key+': '+c['id'])
 if c['disposition'] not in ['retain','delete','simplify','consolidate']:errors.append('invalid disposition: '+c['id'])
 for site in c['source_sites']+c['peer_sites']+c.get('caller_anchors',[]):
  path=site['path'];start=site['start'];end=site['end']
  if path not in cache or not 1<=start<=end<=len(cache[path]):errors.append('invalid range '+c['id']+': '+str(site))
  else:
   counts['candidate_and_caller_ranges']+=1
   if site.get('source') and site['source'].strip()!=cache[path][start-1].strip():errors.append('caller source mismatch '+c['id']+': '+str(site))
seed=json.loads((root/'screen.json').read_text())
for group in seed['duplicates']:
 if not group.get('candidate_ids') or not set(group['candidate_ids']).issubset(ids):errors.append('unmapped duplicate seed: '+group['hash'])
 for site in group['sites']:
  path=site['path']
  if path not in cache or not 1<=site['start']<=site['end']<=len(cache[path]):errors.append('invalid screen range: '+str(site))
  else:counts['screen_ranges']+=1
screen_reproduced=None
if a.screen_recheck:
 recheck=json.loads(pathlib.Path(a.screen_recheck).read_text())
 recorded=[{k:v for k,v in g.items() if k!='candidate_ids'} for g in seed['duplicates']]
 screen_reproduced=(recheck['pin']==pin and recheck['typescript_version']==seed['typescript_version'] and recheck['duplicates']==recorded and len(recheck['sources'])==seed['typescript_files_screened'] and len(recheck['forwarders'])==seed['forwarder_count'])
 if not screen_reproduced:errors.append('syntax screen reproduction mismatch')
package_drift=[p for p in drift if p.startswith('packages/')]
if package_drift:errors.append('package source drift: '+str(package_drift))
summary=json.loads((root/'summary.json').read_text())
if summary['candidate_count']!=len(records):errors.append('candidate count mismatch')
if summary['dispositions']!=dict(collections.Counter(c['disposition'] for c in records)):errors.append('disposition count mismatch')
if scope['execution_authorized'] is not False:errors.append('scope authorizes execution')
result={'source_checkpoint':pin,'checks':dict(counts),'candidate_count':len(records),'dispositions':dict(collections.Counter(c['disposition'] for c in records)),'duplicate_seed_groups':len(seed['duplicates']),'forwarding_syntax_seeds':seed['forwarder_count'],'syntax_screen_reproduced':screen_reproduced,'package_inputs_equal_current':not package_drift,'non_package_input_drift':drift,'external_skipped':external_skipped,'errors':errors,'product_execution':False,'builds_tests_installs_runtime_probes':False,'execution_authorized':False}
if a.write:(root/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
sys.exit(bool(errors))
