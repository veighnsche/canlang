#!/usr/bin/env python3
"""Check integrated finite ledger, retained inputs/receipts, links and scope."""
import json,pathlib,re,subprocess
from run import HERE,ROOT,digest,save
from verify import main as verify

def main():
 verify()
 p=HERE.parent;ledger=p/'coverage.jsonl';rows=[json.loads(x)for x in ledger.read_text().splitlines()]
 old=subprocess.check_output(['git','show','64e09759:docs/research/compiler-library-audit-20261006/responsibility-map/coverage.jsonl'],cwd=ROOT,text=True);oldrows=[json.loads(x)for x in old.splitlines()]
 assert len(oldrows)==494 and len(rows)==537
 for a,b in zip(rows[:494],oldrows):
  if a['record']=='scope':
   c=dict(a);c.pop('editor_execution',None);c['status_defaults']=dict(c['status_defaults']);c['status_defaults'].pop('editor',None);assert c==b
  elif a['record']=='path':assert {k:v for k,v in a.items() if k not in ['editor_refs','editor_scope']}==b
  else:assert a==b
 ids=[(x['record'],x['id'])for x in rows if 'id'in x];assert len(ids)==len(set(ids))
 registry=json.loads((HERE/'registry.json').read_text());duties=registry['duties'];findings=registry['findings'];assert len(duties)==31 and len(findings)==9
 dids={x['id']for x in duties};fids={x['id']for x in findings};assert dids==set(registry['registry']['duties']);assert fids==set(registry['registry']['findings'])
 for x in findings:
  assert set(x['duty_refs'])<=dids
  for f in x['defining_writers']:assert (ROOT/f).is_file()
  for f in x['evidence_refs']:assert(p/f).is_file()
 for row in rows:
  if row['record']=='path':assert set(row.get('editor_refs',[]))<=dids
 for name in ['review-client.json','review-process.json','review-server.json','client.json','server-options.json','review-integration.json']:
  d=json.loads((HERE/name).read_text())
  for pin in d.get('pins',[]):
   if isinstance(pin,dict) and 'path'in pin and 'sha256'in pin:
    a=ROOT/pin['path'];a=a if a.is_file() else HERE/pin['path'];a=a if a.is_file() else pathlib.Path(pin['path']);assert a.is_file(),pin;assert digest(a)==pin['sha256'],pin
 links=0
 for f in [p/'editor.md',p/'README.md',p.parent/'README.md',p.parent/'compiler-correctness-simplicity-audit.md',ROOT/'docs/specification/DECISIONS.md']:
  text=f.read_text()
  # Audit new bounded report fully; changed shared docs links newly mentioning editor.
  for match in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',text):
   target=match[1]
   if target.startswith(('https:','http:','app:','codex:')):continue
   if f.name!='editor.md' and 'editor'not in target:continue
   dest=target.split('#')[0]
   assert (f.parent/dest).exists(),(f,target);links+=1
 last_source=subprocess.check_output(['git','log','-1','--format=%H','--','compiler'],cwd=ROOT,text=True).strip();assert last_source==json.loads((HERE/'inputs.json').read_text())['compiler_source_commit'];trees=subprocess.check_output(['git','rev-parse','1fd07722:compiler','HEAD:compiler',last_source+':compiler'],cwd=ROOT,text=True).splitlines();assert len(set(trees))==1
 assert subprocess.check_output(['git','diff','--name-only','64e09759','--','compiler','editors/vscode/src','editors/vscode/package.json','packages/values/dist/catalog.json'],cwd=ROOT,text=True)==''
 save('integration-validation.json',{'scope':'finite Step11 evidence/coverage integration, not product certification','ledger_rows_before':494,'ledger_rows_after':537,'prior_records_preserved_except_new_editor_navigation':True,'unique_duties':31,'proposed_packets':9,'checked_local_editor_links':links,'compiler_source_commit':last_source,'compiler_tree_snapshot_pin':'1fd07722090fe70228a6b661e3c6e136275ca84b','compiler_tree':trees[0],'compiler_editor_catalog_unchanged':True,'living_checkpoint_unchanged':'no merge; canonical plan unmodified','independent_review':['review-server.json','review-process.json','review-client.json'],'scope_gates_preserved':True})
 print(json.dumps({'ledger_rows':537,'duties':31,'packets':9,'editor_links':links}))
if __name__=='__main__':main()
