import json,pathlib,hashlib,urllib.parse
repo=pathlib.Path('/Users/vince/Projects/canlang');base=repo/'implementation/capability-roadmap-20261008';out=base/'verified-context-repair-review-receipts';after=base/'verified-context-repair';before=base/'verified-context-execution-before'
h=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest();checks=[]
def check(name,passed,detail=None):checks.append(dict(name=name,passed=bool(passed),detail=detail))
r=json.loads((out/'runtime-results.json').read_text());artifact=json.loads((before/'artifact.json').read_text())
for run in r['runs']:
 for module in artifact['modules']:
  f=pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(run['assembly']['moduleUrls'][module['path']]).path));actual=f.read_text()
  raw=actual.replace(pathlib.Path(run['root']+'/packages/cloudflare/dist/runtime/stdlib.js').as_uri(),'@canlang/stdlib').replace(pathlib.Path(run['root']+'/packages/ui/dist/src/index.js').as_uri(),'@canlang/ui')
  raw=raw.removesuffix('//# sourceMappingURL='+module['path']+'.map\n')
  check(run['label']+' assembler unchanged handler body',raw==module['js'],dict(staged_sha256=h(f),raw_sha256=hashlib.sha256(module['js'].encode()).hexdigest(),staged_path=str(f)))
a=json.loads((after/'runtime-results.json').read_text());byname={o['name']:o for o in a['observations']}
expected={'actorId':a['user_id'],'teamId':a['team']['team_id'],'teamTimezone':a['team']['timezone'],'operationSource':'mcp','nowEquals':True}
for suffix,wanted in expected.items():
 o=byname['actual repaired '+suffix];check('author raw exact '+suffix,o['outcome']['result']['status']=='committed' and o['outcome']['result']['result']==wanted,dict(expected=wanted,actual=o['outcome']))
o=byname['actual repaired operationId'];check('author raw envelope operation identity',o['outcome']['result']['result']==o['envelope']['operation_id'] and o['outcome']['result']['result']!=o['envelope']['operation'])
for name in ['anonymous member denial preserved','wrong selected team member denial preserved','ambient input spoof refusal preserved','fresh current membership removal denial preserved']:
 o=byname[name];check('author raw full unchanged '+name,o['before']==o['after'],o['outcome'])
t=json.loads((after/'retry-control.json').read_text());attempts=t['commitAttempts'];retry=t['retried'];competitor=t['competitor']
check('author raw actual fence revisions/errors',len(attempts)==2 and attempts[0]['expectedRevision']==10 and attempts[0]['error']['real_FenceConflictError'] is True and attempts[0]['error']['message']=='Fence conflict: expected revision 10, actual 11' and attempts[1]['expectedRevision']==11 and attempts[1]['commit']['revision']==12)
check('author raw admitted time/results',all(x['result'] is True and x['createdAt']==a['now'] for x in attempts) and t['hostClockSamples']==[a['now']])
check('author raw competitor independently committed',competitor['outcome']['result']['status']=='committed' and competitor['outcome']['result']['result'] is True and competitor['after']['revision']==11)
check('author raw exact receipt cardinality',sum(x['receipt'] is not None and x['identity']['operationId']==retry['envelope']['operation_id'] for x in retry['after']['receipts'])==1 and sum(x['receipt'] is not None and x['identity']['operationId']==competitor['envelope']['operation_id'] for x in retry['after']['receipts'])==1)
p=json.loads((after/'candidate-source-output-pins.json').read_text())
for rel,v in p['sources'].items():check('final live/private source unchanged '+rel,h(repo/rel)==v['after'] and h(pathlib.Path(a['root'])/rel)==v['private_copy'])
pins=json.loads((out/'independent-pins.json').read_text())
for label,d in [('before',before),('after',after)]:check('final frozen manifest unchanged '+label,h(d/'final-pins.json')==pins['packet_manifest_hashes'][label])
report={'status':'passed' if all(x['passed'] for x in checks) else 'failed','checks':checks,'count':len(checks)};(out/'raw-audit.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'count':len(checks),'failed':[x for x in checks if not x['passed']]}))
