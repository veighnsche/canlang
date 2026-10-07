#!/usr/bin/env python3
"""Independent outcome checks; observations are not their own acceptance oracle."""
import json,pathlib,re,hashlib
from run import HERE,save
def main():
 checks=[]
 def check(label,ok,classification='qualification'):checks.append({'contract':label,'pass':bool(ok),'classification':classification})
 cases=json.loads((HERE/'cases.json').read_text());obs=json.loads((HERE/'observations.json').read_text())
 check('61 unique case identities with exact receipt join',len(cases)==61 and len({c['id'] for c in cases})==61 and [c['id'] for c in cases]==[o['id'] for o in obs])
 for o in obs:
  for a in o['assertions']:check(o['id']+': '+a['contract'],a['pass'])
 coord=json.loads((HERE/'coordinates.stdout').read_text())
 # Independently authored byte and UTF16 vectors, including inside-scalar and CRLF offsets.
 fwd=[(0,0),(0,0),(0,1),(0,1),(0,1),(0,1),(0,3),(0,4),(0,4),(1,0),(1,0),(1,1),(1,1),(1,1),(1,1),(1,3),(1,4),(1,4),(1,4)]
 human=[(1,i) for i in range(1,9)]+[(1,8)]+[(2,i) for i in range(1,9)]+[(2,8),(2,8)]
 bytepos=[(0,0),(0,0),(0,2),(0,2),(0,2),(0,2),(0,6),(0,7),(0,7),(1,0),(1,0),(1,2),(1,2),(1,2),(1,2),(1,6),(1,7),(1,7),(1,7)]
 for b,o in enumerate(coord['forward']):
  check('coordinate byte '+str(b),tuple(o['utf16'])==fwd[b] and tuple(o['human'])==human[b] and tuple(o['byte_lsp'])==bytepos[b])
 inverse=[[0,2,2,6,7,7,7,7],[9,11,11,15,16,16,16,16],[None]*8,[None]*8]
 for o in coord['inverse']:check('inverse '+str((o['line'],o['character'])),o['byte']==inverse[o['line']][o['character']])
 d=json.loads((HERE/'diagnostics.stdout').read_text());ab=json.loads(d['ab']);ba=json.loads(d['ba']);
 check('same diagnostic key/severity but different tags has insertion-independent bytes',d['ab']==d['ba'],'public-API documented determinism defect; no CLI producer shown')
 check('diagnostic tie isolation',all(x['severity']=='error' for x in ab['diagnostics']+ba['diagnostics']) and [x['tags'] for x in ab['diagnostics']]==[['a'],['b']] and [x['tags'] for x in ba['diagnostics']]==[['b'],['a']])
 cli=json.loads((HERE/'cli-observations.json').read_text())
 for o in cli:
  if o['id'].startswith('identifier-'):
   check(o['id']+' '+o['command']+' accepts legal source',o['exit']==0 and not o['codes'])
   if 'js_checks' in o:check(o['id']+' emitted module syntax',all(x['exit']==0 for x in o['js_checks']),'compiler binding hygiene defect' if o['id']!='identifier-value' else 'qualification control')
  elif o['id'].startswith('docs-'):
   check(o['id']+' actual renderer success',o['exit']==0 and len(o['default_table_rows'])==1)
  elif o['id']=='fmt-check-before':check('fmt check refuses changes without writing',o['exit']==10 and o['unchanged'])
  elif o['id']=='fmt-write':check('fmt exact independent expected layout',o['exit']==0 and o['exact_expected'])
  elif o['id']=='fmt-noop':check('fmt noop exact bytes/inode',o['exit']==0 and o['bytes_unchanged'] and o['inode_unchanged'])
  elif o['id']=='fmt-multiple-malformed':check('malformed later operand prevents earlier rewrite',o['exit']==10 and o['first_operand_unchanged'])
  elif o['id']=='lint-fix-report':check('CLI fix reports without source write',o['exit']==0 and o['bytes_unchanged'] and o['inode_unchanged'] and o['fixes_reported']==1)
 f=json.loads((HERE/'case-fix-comments.stdout').read_text());s=f['result']['text']
 check('fix preserves unrelated model and entire sibling operation bytes',' ## unrelated declaration\n Other {value:int=7}\n' in s and ' ## keep following declaration\n scenario keep(task:Todo)->text by=members\n  do return task.title\nThen\n' in s)
 check('attached explanatory comment preservation', '## keep explanatory comment' in s,'observed deletion; preservation contract gate, not demonstrated semantic defect')
 # Markdown tests qualify literal output plus standards-derived interpretation, not execution of a parser.
 back=next(o for o in cli if o['id']=='docs-backtick')['default_table_rows'][0]
 pipe=next(o for o in cli if o['id']=='docs-pipe')['default_table_rows'][0]
 slash=next(o for o in cli if o['id']=='docs-backslash')['default_table_rows'][0]
 check('code span escapes embedded backtick by delimiter choice', 'a\\`b' not in back,'downstream package Markdown defect: CommonMark 6.1')
 check('table pipe remains one cell',pipe.count('|')==8,'downstream package Markdown defect: GFM 4.10')
 check('code span retains authored default backslash spelling', 'a'+'\\'*4+'b' not in slash,'downstream package Markdown defect: CommonMark 6.1 literal backslashes')
 totals={}
 for r in json.loads((HERE/'suites-execution.json').read_text())['commands']:
  text=(HERE/r['stdout']).read_text();err=(HERE/r['stderr']).read_text();rows=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored',text)
  totals[r['name']]={'passed':sum(int(a) for a,b,c in rows),'failed':sum(int(b) for a,b,c in rows),'ignored':sum(int(c) for a,b,c in rows),'reported_skips':len(re.findall(r'\bSKIP\b',text+err)),'exit':r['exit']}
  check('native suite '+r['name'],r['exit']==0 and rows and totals[r['name']]['reported_skips']==0)
 save('outcome-verification.json',{'checks':checks,'counts':{'checks':len(checks),'passes':sum(x['pass'] for x in checks),'failures':sum(not x['pass'] for x in checks)},'native_suites':totals,'limits':['recursive topology/decoded token preservation is not universal semantic/runtime preservation','honest current-hash precondition for lint driver; IDE computes actual hash','Markdown interpretation uses official standards, no Markdown parser executed','native macOS arm64 only; no release/application/other-host qualification']})
 print(json.dumps({'checks':len(checks),'failures':[x['contract'] for x in checks if not x['pass']],'native_passes':sum(x['passed'] for x in totals.values())}))
if __name__=='__main__':main()
