#!/usr/bin/env python3
import pathlib,json,tempfile,os,copy
from run import HERE,ROOT,invoke,save,digest
BIN=ROOT/'compiler/target/debug/can'
GOOD='app T\nGiven\nWhen\n scenario s() read=true -> int by=members\n  do return 1\nThen\n'
BASE=ROOT/'packages/values/dist/catalog.json'
def main():
 receipts=[];cases=[];obs=[];build=json.loads((HERE/'build.json').read_text());libs=build['libraries'];env=os.environ.copy();env['CAN_CATALOG']=str(BASE)
 with tempfile.TemporaryDirectory(prefix='can-failure-probe-')as t:
  t=pathlib.Path(t);exe=t/'probe';d,r=invoke('compile-probe',['rustc','--edition=2024',HERE/'probe.rs','--extern','canlang_compiler='+libs[0]['path'],'--extern','serde_json='+libs[1]['path'],'-L','dependency='+str(ROOT/'compiler/target/debug/deps'),'-o',exe],timeout=60);receipts.append(r);assert d.returncode==0
  def call(name,args,kind,expected=None):
   d,r=invoke(name,args,env=env,timeout=12);r['environment_overrides']={'CAN_CATALOG':env['CAN_CATALOG']};receipts.append(r);o={'id':name,'kind':kind,'exit':d.returncode,'signal':r['signal'],'timed_out':r['timed_out'],'seconds':r['elapsed_seconds'],'stdout_json':None}
   if d.returncode==0:
    try:o['stdout_json']=json.loads(d.stdout)
    except (json.JSONDecodeError,UnicodeDecodeError):pass
   obs.append(o)
   if expected is not None:assert d.returncode==expected,name
   return d,o
  call('framing',[exe,'framing'],'public BufRead count/read-buffer observer',0)
  for n in [63,64,65,66]:call('json-depth-'+str(n),[exe,'json-depth',n],'bounded parser admission',0)
  for n in [1000,100000]:call('json-width-'+str(n),[exe,'json-width',n],'finite wide shallow JSON',0)
  call('json-forged-num',[exe,'json-invalid-num'],'deliberately forged public carrier; not source grammar',0)
  for n in [64,256,1024]:call('json-constructed-'+str(n),[exe,'json-constructed-depth',n],'valid public constructed carrier beyond parser admission')
  source=t/'input.can';source.write_text(GOOD);call('source-control-check',[BIN,'check','--format=json','--catalog',BASE,source],'clean source baseline',0);call('source-control-compile',[BIN,'compile','--catalog',BASE,source],'clean actual compiler output',0)
  for n in [64,256,512,1024,2048,3000]:
   text=GOOD.replace('return 1','return '+'+'.join(['1']*n));name='source-flat-'+str(n);source.write_text(text);(HERE/(name+'.can')).write_text(text);cases.append({'id':name,'bytes':len(text.encode()),'source':name+'.can','sha256':digest(HERE/(name+'.can')),'scope':'legal left-associative int chain; independent parse/check/compile stage outcomes; no expression nesting assumption'})
   call(name+'-parse',[exe,'parse-source',source],'public parse including normal tree drop',0)
   for stage in ['check','compile']:
    args=[BIN,stage,'--catalog',BASE,source]
    if stage=='check':args.insert(2,'--format=json')
    call(name+'-'+stage,args,'actual compiler '+stage)
  original=json.loads(BASE.read_text());entry=next(x for x in original['entries']if x['id']=='lower');assert entry['kind']=='builtin'
  source.write_text(GOOD)
  for kind,levels in [('nested',[32,64,128,256,512,1024]),('postfix',[64,256,1024])]:
   for n in levels:
    c=copy.deepcopy(original);e=next(x for x in c['entries']if x['id']=='lower');shape='C<'*n+'text'+'>'*n if kind=='nested'else'text'+'[]'*n;e['signature']='lower(value:'+shape+')->text';name='catalog-'+kind+'-'+str(n);catalog=t/(name+'.json');data=json.dumps(c,separators=(',',':')).encode();catalog.write_bytes(data)
    # Save compact mutation rather than repeated whole owner catalogs; input baseline hash pins reconstruction.
    cases.append({'id':name,'base_catalog_sha256':digest(BASE),'mutation':{'id':'lower','kind':'builtin','signature':e['signature']},'catalog_bytes':len(data),'catalog_sha256':digest(catalog),'json_outer_depth_scope':'signature is a string; JSON depth is unaffected'})
    d,o=call(name,[BIN,'check','--format=json','--catalog',catalog,source],'actual eager builtin catalog admission')
  forced=env.copy();forced['CAN_INTERNAL_TEST_PANIC']='1';d,r=invoke('binary-forced-unwind',[BIN,'--version'],env=forced);r['environment_overrides']={'CAN_INTERNAL_TEST_PANIC':'1','CAN_CATALOG':env['CAN_CATALOG']};receipts.append(r);obs.append({'id':'binary-forced-unwind','exit':d.returncode,'expected':'2/E7005 deliberate test hook; not naturally source-triggered panic'});assert d.returncode==2 and b'E7005'in d.stderr
  malformed=t/'invalid.can';malformed.write_bytes(b'\xff');d,o=call('invalid-source-utf8',[BIN,'check','--format=json','--catalog',BASE,malformed],'source IO UTF8 rejection',2)
 save('resource-cases.json',cases);save('resource-observations.json',obs);save('resource-execution.json',{'commands':receipts,'binary_sha256':digest(BIN),'baseline_catalog_sha256':digest(BASE),'limits':'Fixtures bounded to small source/catalog strings,2MiB header/100000 JSON values;12s child wall timeout and core disabled. No heap/RSS/output sandbox or exhaustion benchmark.'})
 print(json.dumps({'commands':len(receipts),'observations':len(obs),'nonzero':[{'id':x['id'],'exit':x['exit'],'signal':x.get('signal'),'timeout':x.get('timed_out')}for x in obs if x['exit']!=0]}))
if __name__=='__main__':main()
