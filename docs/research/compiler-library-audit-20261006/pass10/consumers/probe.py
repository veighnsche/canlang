"""Direct final-binary qualification; authored expectations, no Cargo test harness."""
from pathlib import Path
import sys,json,hashlib,subprocess
root=Path('/Users/vince/Projects/canlang'); temp=Path('/private/tmp/canlang-pass10-consumers'); out=root/'docs/research/compiler-library-audit-20261006/pass10/consumers'; binary=Path(sys.argv[1]); cat=root/'packages/values/dist/catalog.json'; results=[]
def run(name,args,input=None,expected=0):
 p=subprocess.run([str(binary),*args],input=input,capture_output=True,timeout=30,cwd=temp)
 for suffix,value in [('stdout',p.stdout),('stderr',p.stderr)]: (out/f'{name}.{suffix}').write_bytes(value)
 if input is not None:(out/f'{name}.stdin').write_bytes(input)
 results.append({'name':name,'argv':[str(binary),*args],'exit':p.returncode,'expectedExit':expected,'stdoutSha256':hashlib.sha256(p.stdout).hexdigest(),'stderrSha256':hashlib.sha256(p.stderr).hexdigest()})
 assert p.returncode==expected,(name,p.returncode,p.stderr.decode(errors='replace')); return p
for command in ['check','lint','fmt']:
 args=[command]; args+=['--format=json','--catalog',str(cat)] if command!='fmt' else [];args+=[str(temp/'bad.can')]
 p=run('cli-'+command,args,expected=10);assert not p.stderr;assert p.stdout.count(b'\n')==1
 a=json.loads(p.stdout);assert list(a)==['tool','tool_version','language_version','schema_version','sources','complete','diagnostics','omitted'];assert a['tool']=='can' and a['schema_version']==1 and a['complete'] is True and a['omitted']==0
 assert a['sources']==[{'id':0,'path':str(temp/'bad.can'),'sha256':'a1187edf8f43ac74fc1c3d6458e4b0a95d5fc8b0502ea9cac650a854930c4da0'}]
 d=a['diagnostics'];assert len(d)==1 and d[0]['code']=='E1204' and d[0]['message']=='package is missing Given/When/Then';assert d[0]['primary']=={'file':0,'start':0,'end':3};assert (temp/'bad.can').read_text()=='app Broken\n'
p=run('artifact',['compile','--format=json','--catalog',str(cat),str(temp/'wire.can')]); assert not p.stderr and p.stdout.count(b'\n')==1;(temp/'artifact.json').write_bytes(p.stdout)
init=b'{"jsonrpc":"2.0","id":99,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}'
def frame(x):return b'Content-Length: '+str(len(x)).encode()+b'\r\n\r\n'+x
def parseframes(x):
 a=[]
 while x:
  head,x=x.split(b'\r\n\r\n',1);assert head.startswith(b'Content-Length: ');n=int(head.split(b': ')[1]);assert len(x)>=n;a.append(json.loads(x[:n]));x=x[n:]
 return a
cases=[('utf8',b'\xff',-32700,None),('syntax',b'{',-32700,None),('duplicate',b'{"jsonrpc":"2.0","id":3,"id":4,"method":"initialize"}',-32600,None),('fractional-id',b'{"jsonrpc":"2.0","id":1.5,"method":"initialize"}',-32600,None),('wrong-version',b'{"jsonrpc":"1.0","id":3,"method":"initialize"}',-32600,3)]
for name,body,code,id in cases:
 p=run('lsp-'+name,['lsp'],frame(body)+frame(init));a=parseframes(p.stdout);assert len(a)==2;assert a[0]['error']['code']==code and a[0]['id']==id and 'result' not in a[0];assert a[1]['id']==99 and 'result' in a[1]
for id in [b'-0',b'1.0',b'1e0',b'2147483647']:
 p=run('lsp-id-'+id.decode(),['lsp'],frame(init.replace(b'99',id)));assert p.stdout.split(b'\r\n\r\n',1)[1].startswith(b'{"jsonrpc":"2.0","id":'+id+b',');assert 'result' in parseframes(p.stdout)[0]
p=run('lsp-shutdown',['lsp'],frame(init)+frame(b'{"jsonrpc":"2.0","method":"initialized","params":{}}')+frame(b'{"jsonrpc":"2.0","id":2,"method":"shutdown"}')+frame(b'{"jsonrpc":"2.0","method":"exit"}'));a=parseframes(p.stdout);assert len(a)==2 and a[1]=={'jsonrpc':'2.0','id':2,'result':None}
run('lsp-early-exit',['lsp'],frame(b'{"jsonrpc":"2.0","method":"exit"}'),expected=1)
for name,data in [('eof',b''),('torn',b'Content-Length: 100\r\n\r\n{')]:assert not run('lsp-'+name,['lsp'],data).stdout
# Unchanged original owner closure; reject honestly rather than patch or project.
p=subprocess.run([str(binary),'compile','--format=json','--catalog',str(cat),str(root/'draft/CanDo.can'),str(root/'draft/shared/Locations.can'),str(root/'draft/shared/Employees.can')],capture_output=True,timeout=30,cwd=root)
assert p.returncode==10 and not p.stderr
a=json.loads(p.stdout);assert a['complete'] is True and a['omitted']==0;assert [(d['code'],d['primary']) for d in a['diagnostics']]==[('E3001',{'file':0,'start':6159,'end':6164}),('E3010',{'file':2,'start':1336,'end':1362}),('E3010',{'file':2,'start':1477,'end':1503})]
(out/'original-app.stdout').write_bytes(p.stdout);(out/'original-app.stderr').write_bytes(p.stderr);results.append({'name':'unchanged-original-CanDo','exit':p.returncode,'diagnostics':json.loads(p.stdout) if p.stdout else None})
(out/'process-results.json').write_text(json.dumps({'binary':str(binary),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'results':results},indent=2)+'\n')
print(json.dumps({'processProbes':len(results),'originalExit':p.returncode}))
