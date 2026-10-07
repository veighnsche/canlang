import ast,re,subprocess,difflib,hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parents[5];base='309644a6881909d8dba32560bc6711f67e00a7ab';source='1fd07722090fe70228a6b661e3c6e136275ca84b'
tree=ast.parse(Path(__file__).with_name('count.py').read_text());ns={}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.Import,ast.ImportFrom))],type_ignores=[]),'counterfunctions','exec'),ns)
oldpaths=subprocess.check_output(['git','ls-tree','-r','--name-only',base,'--','compiler/src'],cwd=root,text=True).splitlines()
newpaths=subprocess.check_output(['git','ls-files','compiler/src'],cwd=root,text=True).splitlines()
def profile(text):
 lines=text.splitlines(keepends=True);spans=ns['test_spans'](text);pos=0;prod=[]
 for line in lines:
  prod.append(not any(a<=pos<b for a,b in spans));pos+=len(line)
 return lines,prod
records=[]
for p in sorted({p for p in oldpaths+newpaths if p.endswith('.rs')}):
 old=subprocess.check_output(['git','show',base+':'+p],cwd=root,text=True) if p in oldpaths else ''
 new=(root/p).read_text() if p in newpaths else ''
 ol,op=profile(old);nl,np=profile(new);added=removed=0
 for tag,a,b,c,d in difflib.SequenceMatcher(None,ol,nl,autojunk=False).get_opcodes():
  if tag == 'equal':
   for oi,ni in zip(range(a,b),range(c,d)):
    if op[oi] and not np[ni]: removed+=1
    if np[ni] and not op[oi]: added+=1
  if tag in ('delete','replace'):removed+=sum(op[a:b])
  if tag in ('insert','replace'):added+=sum(np[c:d])
 records.append({'path':p,'before_production_lines':sum(op),'after_production_lines':sum(np),'gross_removed':removed,'gross_added':added,'net':added-removed,'sha256_before':hashlib.sha256(old.encode()).hexdigest(),'sha256_after':hashlib.sha256(new.encode()).hexdigest()})
r={'scope':'Whole compiler/src physical production code; source1fd differs from original by utility programme plus prior correctness/other-owner changes, not solely library adapters. No Step6 implementation change. File-change counts do not attribute mixed file duties to integrations.','baseline_git':base,'source_git':source,'method':'stdlib difflib.SequenceMatcher autojunk=false on full physical lines; count removed/added lines only if production at respective snapshot; exact cfg(test) item spans masked. Same-text aligned lines changing production/test classification count as addition/removal; moves count as remove/add, not simplification. Comments and blanks retained.','before_production_lines':sum(x['before_production_lines'] for x in records),'after_production_lines':sum(x['after_production_lines'] for x in records),'gross_removed':sum(x['gross_removed'] for x in records),'gross_added':sum(x['gross_added'] for x in records),'records':records}
r['net']=r['gross_added']-r['gross_removed'];assert r['after_production_lines']-r['before_production_lines']==r['net'];assert(r['before_production_lines'],r['after_production_lines'],r['net'])==(69119,69255,136)
Path(__file__).with_name('production-delta-replay.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({k:v for k,v in r.items() if k!='records'},indent=2))
