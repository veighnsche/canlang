from pathlib import Path
import subprocess,json,hashlib
s=Path('/private/tmp/canlang-roadmap-f1-db57c379'); o=Path(__file__).resolve().parent
binary='/private/tmp/canlang-f1-metadata-target/debug/can'; cat=s/'packages/values/dist/catalog.json'
groups={'CanCreative':[s/'draft/CanCreative.can',s/'draft/CanChat.can',*sorted((s/'draft/shared').glob('*.can'))],'CanChat':[s/'draft/CanChat.can',*sorted((s/'draft/shared').glob('*.can'))],'CanApprove':[s/'draft/CanApprove.can',*sorted((s/'draft/shared').glob('*.can'))],'shared':sorted((s/'draft/shared').glob('*.can')),'bounded':[o/'Bounded.can']}
r=[]
for name,files in groups.items():
 for command in ['check','compile']:
  args=[binary,command,'--format=json','--catalog',str(cat),*map(str,files)]
  p=subprocess.run(args,cwd=s,capture_output=True)
  (o/'artifacts'/f'{name}-{command}.json').write_bytes(p.stdout);(o/'logs'/f'{name}-{command}.stderr').write_bytes(p.stderr)
  try:
   data=json.loads(p.stdout); ds=data.get('diagnostics',[])
   summary={'errors':len(ds),'first':ds[:1]}
  except Exception: summary={'parse':'not-json'}
  r.append({'name':name,'command':args,'exit':p.returncode,'summary':summary,'sources':{str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in files}})
(o/'compiler-results.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps([{k:x[k] for k in ['name','exit','summary']} for x in r],indent=2))
