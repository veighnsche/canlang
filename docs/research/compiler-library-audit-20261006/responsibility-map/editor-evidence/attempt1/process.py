#!/usr/bin/env python3
"""Bounded actual framed-server sessions; independent expected outcomes in verify.py."""
import json,os,pathlib,select,subprocess,tempfile,time
from run import HERE,ROOT,save,digest,invoke
BIN=ROOT/'compiler/target/debug/can'
GOOD='app T\nGiven\n Item {title:text}\nWhen\nThen\n'
BAD='app T\nGiven\n Item {title:text="\\q"}\nWhen\nThen\n'
LOWER='app T\nGiven\nWhen\n scenario s(value:text) read=true -> text by=members\n  do return lower(value)\nThen\n'
def req(i,m,p=None):return {'jsonrpc':'2.0','id':i,'method':m,'params':p}
def note(m,p=None):return {'jsonrpc':'2.0','method':m,'params':p}
def open_doc(u,v,s):return note('textDocument/didOpen',{'textDocument':{'uri':u,'languageId':'can','version':v,'text':s}})
def change(u,v,s):return note('textDocument/didChange',{'textDocument':{'uri':u,'version':v},'contentChanges':[{'text':s}]})
def init():return [req(1,'initialize',{'processId':None,'rootUri':None,'capabilities':{}}),note('initialized',{})]
def end():return [req(99,'shutdown'),note('exit')]
def frame(m):
 b=json.dumps(m,ensure_ascii=False,separators=(',',':')).encode();return b'Content-Length: '+str(len(b)).encode()+b'\r\n\r\n'+b
def decode(raw):
 frames=[]
 while raw:
  h,b=raw.split(b'\r\n\r\n',1);n=int(next(x.split(b':',1)[1] for x in h.split(b'\r\n') if x.lower().startswith(b'content-length:')))
  assert len(b)>=n;frames.append(json.loads(b[:n]));raw=b[n:]
 return frames
class Session:
 def __init__(self,name,cwd,env):
  self.name=name;self.argv=[str(BIN),'lsp'];self.cwd=cwd;self.env=env;self.start=time.time();self.child=subprocess.Popen(self.argv,cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE);self.input=b'';self.output=b'';self.buffer=b'';self.frames=[]
 def send(self,m):
  b=frame(m);self.input+=b;self.child.stdin.write(b);self.child.stdin.flush()
 def request(self,m):
  self.send(m);deadline=time.monotonic()+8
  while True:
   if b'\r\n\r\n' in self.buffer:
    h,b=self.buffer.split(b'\r\n\r\n',1);n=int(next(x.split(b':',1)[1] for x in h.split(b'\r\n') if x.lower().startswith(b'content-length:')))
    if len(b)>=n:
     x=json.loads(b[:n]);self.frames.append(x);self.buffer=b[n:]
     if x.get('id')==m['id']:return x
     continue
   remaining=deadline-time.monotonic();assert remaining>0,'session response deadline'
   assert select.select([self.child.stdout],[],[],remaining)[0],'session response timeout'
   chunk=os.read(self.child.stdout.fileno(),65536);assert chunk,'unexpected server EOF';self.output+=chunk;self.buffer+=chunk
 def finish(self):
  self.request(req(99,'shutdown'));self.send(note('exit'));self.child.stdin.close();self.child.wait(timeout=8)
  rest=self.child.stdout.read();self.output+=rest;self.buffer+=rest
  if self.buffer:self.frames+=decode(self.buffer)
  err=self.child.stderr.read()
  for stream,data in [('stdin',self.input),('stdout',self.output),('stderr',err)]:(HERE/(self.name+'.'+stream)).write_bytes(data)
  return {'name':self.name,'argv':self.argv,'cwd':str(self.cwd),'exit':self.child.returncode,'elapsed_seconds':round(time.time()-self.start,4),'environment_overrides':{'CAN_CATALOG':self.env.get('CAN_CATALOG')},**{s:self.name+'.'+s for s in ['stdin','stdout','stderr']},**{s+'_sha256':digest(HERE/(self.name+'.'+s)) for s in ['stdin','stdout','stderr']}}
def main():
 receipts=[];obs=[];cases=[];env=os.environ.copy();env['CAN_CATALOG']=str(ROOT/'packages/values/dist/catalog.json')
 u='untitled:Step11-é😀';at={'textDocument':{'uri':u},'position':{'line':2,'character':1}}
 messages=[req(0,'textDocument/hover',at)]+init()+[open_doc(u,1,BAD),change(u,2,GOOD),note('textDocument/didChange',{'textDocument':{'uri':u,'version':3},'contentChanges':[{'range':{'start':{'line':0,'character':0},'end':{'line':0,'character':0}},'text':'x'}]}),note('textDocument/didSave',{'textDocument':{'uri':u}}),req(3,'textDocument/hover',at),note('textDocument/didClose',{'textDocument':{'uri':u}}),req(4,'textDocument/hover',at),req(5,'shutdown'),req(6,'textDocument/hover',at),note('exit')]
 sessions=[('lifecycle',messages,b'',0),('cancel-sync',init()+[open_doc(u,1,GOOD),note('$/cancelRequest',{'id':2}),req(2,'textDocument/hover',at),note('$/cancelRequest',{'id':2})]+end(),b'',0),('invalid-version-robustness',init()+[open_doc(u,5,BAD),change(u,6,GOOD),change(u,5,BAD),change(u,5,GOOD)]+end(),b'',0),('reopen',init()+[open_doc(u,1,BAD),note('textDocument/didClose',{'textDocument':{'uri':u}}),req(2,'unknown/barrier'),open_doc(u,1,GOOD)]+end(),b'',0),('early-exit',[note('exit')],b'',1),('clean-disconnect',init()+[open_doc(u,1,GOOD)],b'',0),('torn-header',init(),b'Content-Length: ',0),('torn-body',init(),b'Content-Length: 50\r\n\r\n{"jsonrpc":',0)]
 for name,msgs,tail,expected_exit in sessions:
  data=b''.join(frame(m) for m in msgs)+tail;d,r=invoke(name,[BIN,'lsp'],env=env,stdin=data,timeout=15);r['environment_overrides']={'CAN_CATALOG':env['CAN_CATALOG']};receipts.append(r)
  frames=decode(d.stdout);cases.append({'id':name,'messages':msgs,'trailing_bytes_hex':tail.hex(),'expected_exit':expected_exit,'scope':'invalid-client robustness' if name=='invalid-version-robustness' else 'actual framed lifecycle'});obs.append({'id':name,'exit':d.returncode,'frames':frames,'raw':r['stdout']})
 with tempfile.TemporaryDirectory(prefix='can-step11-roots-') as temp:
  temp=pathlib.Path(temp);a=temp/'root-a';b=temp/'root-b';a.mkdir();b.mkdir();cat=json.loads((ROOT/'packages/values/dist/catalog.json').read_text());without=json.loads(json.dumps(cat));without['entries']=[e for e in without['entries'] if e['id']!='lower']
  ca=a/'can-catalog.json';cb=b/'can-catalog.json';ca.write_text(json.dumps(cat));cb.write_text(json.dumps(without));(HERE/'catalog-with-lower.json').write_bytes(ca.read_bytes());(HERE/'catalog-without-lower.json').write_bytes(cb.read_bytes());root_env=os.environ.copy();root_env.pop('CAN_CATALOG',None)
  s=Session('catalog-invalidation',a,root_env);s.request(req(1,'initialize',{'rootUri':a.as_uri(),'workspaceFolders':[{'uri':a.as_uri(),'name':'a'},{'uri':b.as_uri(),'name':'b'}],'capabilities':{}}));s.send(note('initialized',{}));ua=(a/'a.can').as_uri();ub=(b/'b.can').as_uri();s.send(open_doc(ua,1,LOWER));s.send(open_doc(ub,1,LOWER));s.request(req(2,'unknown/barrier'))
  cb_before=digest(cb);ca.write_bytes(cb.read_bytes());s.send(note('workspace/didChangeWatchedFiles',{'changes':[{'uri':ca.as_uri(),'type':2}]}));s.send(note('workspace/didChangeConfiguration',{'settings':{}}));s.send(note('workspace/didChangeWorkspaceFolders',{'event':{'added':[],'removed':[{'uri':a.as_uri(),'name':'a'}]}}));s.send(change(ua,2,LOWER));s.request(req(3,'unknown/barrier'));receipts.append(s.finish());obs.append({'id':'catalog-invalidation','frames':s.frames,'root_a_initial_catalog':digest(HERE/'catalog-with-lower.json'),'root_b_catalog':cb_before,'root_a_mutated_catalog':digest(ca),'scope':'one process selects cwd catalog; notifications ignored; same text rechecked against captured old catalog'})
  s=Session('catalog-restart',a,root_env);s.request(req(1,'initialize',{'capabilities':{}}));s.send(note('initialized',{}));s.send(open_doc(ua,3,LOWER));s.request(req(2,'unknown/barrier'));receipts.append(s.finish());obs.append({'id':'catalog-restart','frames':s.frames,'scope':'fresh process loads mutated cwd catalog'})
  pa=a/'p.can';app=a/'app.can';ps='package p\nGiven\n export M {a:int}\n policy M read=members\nWhen\nThen\n';aps='app T uses=[p]\nuse p {M}\nGiven\nWhen\n scenario read(item:M) read=true -> int by=members\n  do return item.a\nThen\n';pa.write_text(ps);app.write_text(aps)
  d,r=invoke('cross-file-cli-check',[BIN,'check','--format=json','--catalog',ROOT/'packages/values/dist/catalog.json',pa,app]);receipts.append(r);cli=json.loads(d.stdout);cases.append({'id':'cross-file','package_source':ps,'app_source':aps,'expected':'CLI joint source set resolves import; current single-document LSP does not','catalog_sha256':digest(ROOT/'packages/values/dist/catalog.json')});obs.append({'id':'cross-file-cli-check','exit':d.returncode,'codes':[d['code'] for d in cli['diagnostics']]})
  s=Session('cross-file-server',ROOT,env);s.request(req(1,'initialize',{'capabilities':{}}));s.send(note('initialized',{}));s.send(open_doc(pa.as_uri(),1,ps));s.send(open_doc(app.as_uri(),1,aps));s.request(req(2,'unknown/barrier'));response=s.request(req(3,'textDocument/definition',{'textDocument':{'uri':app.as_uri()},'position':{'line':4,'character':20}}));receipts.append(s.finish());obs.append({'id':'cross-file-server','frames':s.frames,'definition':response,'scope':'both documents open, each Snapshot checks own source only'})
 save('process-cases.json',cases);save('process-observations.json',obs);save('process-execution.json',{'commands':receipts,'binary':{'path':'compiler/target/debug/can','sha256':digest(BIN)},'scope':'actual framed processes, controlled valid catalog changes and CLI contrast; no extension GUI'})
 print(json.dumps({'sessions':len(receipts),'observations':len(obs),'cross_file_cli_exit':next(x for x in obs if x['id']=='cross-file-cli-check')['exit']}))
if __name__=='__main__':main()
