#!/usr/bin/env python3
"""Capture bounded native audit commands, including timeout/signal failures."""
import pathlib,hashlib,json,subprocess,time,resource,types,sys
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parents[4]
def digest(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def save(n,v):(HERE/n).write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
def child_limits():resource.setrlimit(resource.RLIMIT_CORE,(0,0))
def invoke(name,argv,cwd=ROOT,env=None,stdin=None,timeout=20):
 start=time.monotonic();timed=False
 try:d=subprocess.run([str(x)for x in argv],cwd=cwd,env=env,input=stdin,capture_output=True,timeout=timeout,preexec_fn=child_limits)
 except subprocess.TimeoutExpired as e:
  timed=True;d=types.SimpleNamespace(returncode=None,stdout=e.stdout or b'',stderr=e.stderr or b'')
 r={'name':name,'argv':[str(x)for x in argv],'cwd':str(cwd),'exit':d.returncode,'signal':-d.returncode if d.returncode is not None and d.returncode<0 else None,'timed_out':timed,'timeout_seconds':timeout,'elapsed_seconds':round(time.monotonic()-start,5),'core_dumps':'disabled in audit children; no system-wide change'}
 for k in ['stdout','stderr']:
  f=name+'.'+k;(HERE/f).write_bytes(getattr(d,k));r[k]=f;r[k+'_sha256']=digest(HERE/f)
 if stdin is not None:f=name+'.stdin';(HERE/f).write_bytes(stdin);r['stdin']=f;r['stdin_sha256']=digest(HERE/f)
 return d,r

def build():
 rs=[]
 for n,args in [('rustc-version',['rustc','-Vv']),('cargo-version',['cargo','-V'])]:d,r=invoke(n,args);rs.append(r);assert d.returncode==0
 d,r=invoke('fresh-build',['cargo','build','--locked','--offline','--manifest-path','compiler/Cargo.toml','--lib','--bin','can','--message-format=json'],timeout=90);rs.append(r);assert d.returncode==0
 a=[json.loads(x)for x in d.stdout.splitlines()if x.startswith(b'{')]
 libs=[next(f for x in a if x.get('reason')=='compiler-artifact'and x['target']['name']==n for f in x['filenames']if f.endswith('.rlib'))for n in ['canlang_compiler','serde_json']]
 save('build.json',{'commands':rs,'libraries':[{'path':x,'sha256':digest(x)}for x in libs],'binary':{'path':'compiler/target/debug/can','sha256':digest(ROOT/'compiler/target/debug/can')},'profile':'native debug, locked/offline fresh build, no release/footprint claim'})
 print('Fresh native artifacts captured.')
if __name__=='__main__':build()
