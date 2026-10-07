#!/usr/bin/env python3
import json,os,pathlib,tempfile
from run import HERE,ROOT,invoke,digest,save
def main():
 receipts=[];cases=[];out=[];binary=ROOT/'compiler/target/debug/can';catalog=ROOT/'packages/values/dist/catalog.json'
 with tempfile.TemporaryDirectory(prefix='can-step10-cli-') as t:
  t=pathlib.Path(t)
  for name in ['class','await','default','c','value']:
   id='identifier-'+name;s='app Shop\nGiven\nWhen\n scenario echo('+name+':text) read=true -> text by=members\n  do\n   return '+name+'\nThen\n';p=t/(id+'.can');p.write_text(s);cases.append({'id':id,'source':s,'source_sha256':digest(p),'expected':'legal Can contextual/ordinary binding produces parseable JS'})
   for command in ['check','compile']:
    d,r=invoke(id+'-'+command,[binary,command,'--format=json','--catalog',catalog,p]);receipts.append(r);x=json.loads(d.stdout);o={'id':id,'command':command,'exit':d.returncode,'codes':[d['code'] for d in x.get('diagnostics',[])],'raw':r['stdout']}
    if command=='compile' and x.get('modules'):
     checks=[]
     for i,m in enumerate(x['modules']):
      mod=t/(id+'-'+str(i)+'.mjs');mod.write_text(m['js']);(HERE/(id+'-'+str(i)+'.mjs')).write_text(m['js'])
      n,nr=invoke(id+'-node-'+str(i),['node','--check',mod]);receipts.append(nr);checks.append({'module':m['path'],'exit':n.returncode,'raw':nr['stderr']})
     o['js_checks']=checks
    out.append(o)
  # Exact source spelling enters real compiler -> fixed platform -> public renderer.
  for id,value in [('docs-backtick','a`b'),('docs-pipe','a|b'),('docs-backslash','a\\b')]:
   s='app Shop\nGiven\n Gadget { title:text='+json.dumps(value)+' }\nWhen\nThen\n';p=t/(id+'.can');p.write_text(s);cases.append({'id':id,'source':s,'source_sha256':digest(p),'expected':'default literal remains one exact code span/table cell'})
   env=os.environ.copy();env['CAN_PLATFORM_BIN']=str(ROOT/'packages/cloudflare/dist/cli/platform.js')
   d,r=invoke(id,[binary,'docs','--format=json','--catalog',catalog,p],env=env);r['environment_overrides']={'CAN_PLATFORM_BIN':env['CAN_PLATFORM_BIN']};receipts.append(r)
   out.append({'id':id,'exit':d.returncode,'raw':r['stdout'],'default_table_rows':[l for l in d.stdout.decode().splitlines() if l.startswith('| `title`')]})
  # Formatter writes: exact independent expected text, check-mode no write, no-op inode.
  s='app T\nGiven\n Item { title : text }\nWhen\nThen\n';p=t/'format.can';p.write_text(s);cases.append({'id':'cli-fmt','source':s,'expected':'app T\nGiven\n Item { title:text }\nWhen\nThen\n'})
  before=p.stat();d,r=invoke('fmt-check-before',[binary,'fmt','--check',p]);receipts.append(r);out.append({'id':'fmt-check-before','exit':d.returncode,'unchanged':p.read_text()==s})
  d,r=invoke('fmt-write',[binary,'fmt',p]);receipts.append(r);after=p.read_text();out.append({'id':'fmt-write','exit':d.returncode,'exact_expected':after==cases[-1]['expected']})
  inode=p.stat().st_ino;d,r=invoke('fmt-noop',[binary,'fmt',p]);receipts.append(r);out.append({'id':'fmt-noop','exit':d.returncode,'bytes_unchanged':p.read_text()==after,'inode_unchanged':inode==p.stat().st_ino})
  p.write_text(s);bad=t/'malformed.can';bad.write_text('app T\nGiven\n Item { title:text="\\q" }\nWhen\nThen\n')
  d,r=invoke('fmt-multiple-malformed',[binary,'fmt',p,bad]);receipts.append(r);out.append({'id':'fmt-multiple-malformed','exit':d.returncode,'first_operand_unchanged':p.read_text()==s})
  c=next(c for c in json.loads((HERE/'cases.json').read_text()) if c['id']=='fix-safe-access');p=t/'lint.can';p.write_text(c['source']);inode=p.stat().st_ino
  d,r=invoke('lint-fix-report',[binary,'lint','--fix','--format=json','--catalog',catalog,p]);receipts.append(r);x=json.loads(d.stdout);out.append({'id':'lint-fix-report','exit':d.returncode,'bytes_unchanged':p.read_text()==c['source'],'inode_unchanged':inode==p.stat().st_ino,'fixes_reported':len(x.get('fixes',[]))})
 save('cli-cases.json',cases);save('cli-observations.json',out);save('cli-execution.json',{'commands':receipts,'binary':{'path':str(binary.relative_to(ROOT)),'sha256':digest(binary)},'host':'native macOS arm64 only','scope':'real CLI plus Node syntax checks; no reserved-name module execution; Markdown meaning derived from official specs, no Markdown parser executed'})
 print(json.dumps(out,indent=2))
if __name__=='__main__':main()
