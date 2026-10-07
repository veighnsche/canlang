#!/usr/bin/env python3
"""Verify audit structure and pinned inputs only; never execute package code."""
import argparse, collections, hashlib, json, subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',default='.');p.add_argument('--external',action='store_true');a=p.parse_args()
repo=Path(a.repo).resolve();root=repo/'docs/research/package-library-audit-20261006/adapter-branches'
def data(n):return json.loads((root/n).read_text())
def lines(n):return [json.loads(l) for l in (root/n).read_text().splitlines() if l.strip()]
index=data('source-index.json');pin=index['source_pin'];bs=lines('branches.jsonl');ids={x['id'] for x in bs};errors=[]
if len(ids)!=len(bs):errors.append('duplicate branch IDs')
contracts={x['id'] for x in map(json.loads,(repo/'docs/research/package-library-audit-20261006/required-behavior/contracts.jsonl').read_text().splitlines())}
source_lengths={};inputs_checked=0;external_checked=0;unavailable=[];package_drift=[]
for x in index['inputs']:
 path=x['path']
 if path.startswith('/'):
  if not a.external:continue
  f=Path(path)
  if not f.exists():unavailable.append(path);continue
  raw=f.read_bytes();external_checked+=1
 else:
  try:raw=subprocess.check_output(['git','show',pin+':'+path],cwd=repo,stderr=subprocess.DEVNULL)
  except subprocess.CalledProcessError:errors.append('missing pinned input '+path);continue
  inputs_checked+=1
  source_lengths[path]=len(raw.decode('utf-8').splitlines())
  if path.startswith('packages/') and (not (repo/path).exists() or hashlib.sha256((repo/path).read_bytes()).hexdigest()!=x['sha256']):package_drift.append(path)
 if hashlib.sha256(raw).hexdigest()!=x['sha256']:errors.append('input hash drift '+path)
for b in bs:
 if b.get('classification') not in {'can_policy','public_contract','temporary_compatibility','library_compensation','transport_host_boundary','redundant_mechanism','unresolved'}:errors.append('unknown classification '+b['id'])
 if b.get('disposition') not in {'retain','simplify','consolidate','eliminate'}:errors.append('unknown disposition '+b['id'])
 if b.get('execution_authorized') is not False:errors.append('incorrect execution flag '+b['id'])
 for key in ['why','conditions','classification','disposition','removal_risk']:
  if not b.get(key):errors.append('missing '+key+' '+b['id'])
 if b['path'] not in source_lengths:errors.append('branch source not hashed '+b['id'])
 elif not (1<=b['start_line']<=b['end_line']<=source_lengths[b['path']]):errors.append('invalid branch range '+b['id'])
 for c in b.get('contract_ids',[]):
  if c not in contracts:errors.append('unknown contract '+c+' '+b['id'])
 if b['disposition']!='retain' and not b.get('preconditions'):errors.append('candidate missing prerequisite '+b['id'])
scope=data('scope.json');functions=scope['functions_and_explicit_slices']
for f in functions:
 if not f.get('branch_ids') or not set(f['branch_ids'])<=ids:errors.append('unlinked scope '+str(f))
for b in bs:
 if not any(s['path']==b['path'] and s['start_line']<=b['start_line'] and s['end_line']>=b['end_line'] and b['id'] in s['branch_ids'] for s in functions):errors.append('branch outside linked scope '+b['id'])
ss=lines('syntax-sites.jsonl')
if len({s['id'] for s in ss})!=len(ss):errors.append('duplicate selected syntax occurrence')
for s in ss:
 if not s['explaining_branch_ids'] or not set(s['explaining_branch_ids'])<=ids:errors.append('unlinked selected syntax '+s['id'])
rows=(root/'integration-crosswalk.tsv').read_text().splitlines()[1:]
assess={x['id'] for x in map(json.loads,(repo/'docs/research/package-library-audit-20261006/library-fit/assessments.jsonl').read_text().splitlines())}
rowids=[]
for row in rows:
 fields=row.split('\t');rowids.append(fields[0]);linked=fields[2].split(',')
 if not linked or not set(linked)<=ids:errors.append('unlinked integration '+fields[0])
if set(rowids)!=assess or len(rowids)!=27:errors.append('integration coverage mismatch')
summary=data('summary.json')
if summary['branch_groups']!=len(bs) or summary['scopes']!=len(functions) or summary['selected_ts_syntax_occurrences']!=len(ss):errors.append('summary counts mismatch')
result=dict(kind='audit structure/pinned hash check; no runtime acceptance',source_pin=pin,branch_groups=len(bs),scopes=len(functions),selected_ts_syntax_occurrences=len(ss),integration_slices=len(rows),repository_inputs_checked=inputs_checked,external_inputs_checked=external_checked,external_unavailable=unavailable,current_package_drift=package_drift,errors=errors,execution_authorized=False)
print(json.dumps(result,indent=2))
raise SystemExit(1 if errors or package_drift else 0)
