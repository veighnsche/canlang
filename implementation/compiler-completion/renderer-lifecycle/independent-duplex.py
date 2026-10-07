"""Final exact-function duplex controls; no production writes or broad replay."""
import hashlib,json,os,pathlib,signal,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[3];DEST=pathlib.Path(__file__).resolve().parent
text=(ROOT/'compiler/src/cli.rs').read_text()
result=text[text.index('#[derive(Debug, Clone)]\npub struct DispatchResult'):text.index('/// Analysis hook')]
renderer=text[text.index('fn render_via_platform('):text.index('/// Locate the lane-7')]
rust='mod exit{pub const OK:i32=0;pub const TOOL_FAILURE:i32=2;}\n'+result+renderer+'''\nfn main(){let bin=std::env::args().nth(1).unwrap();match render_via_platform(&bin,None,&"x".repeat(262144)){Ok(out)=>print!("{out}"),Err(err)=>{assert!(err.stdout.is_empty());eprint!("{}",err.stderr);std::process::exit(err.code)}}}\n'''
checks=[]
with tempfile.TemporaryDirectory(prefix='can-final-duplex-review-') as tmp:
 p=pathlib.Path(tmp);src=p/'probe.rs';src.write_text(rust);exe=p/'probe';subprocess.run(['rustc','--edition=2024',str(src),'-o',str(exe)],check=True,capture_output=True)
 for mode in ['success','nonzero','closed-input-after-output']:
  marker=p/(mode+'.pid');stub=p/(mode+'.py')
  body='import os,sys,time\nopen('+repr(str(marker))+',"w").write(str(os.getpid()))\nsys.stdout.buffer.write(b"a"*393216);sys.stdout.flush()\nsys.stderr.buffer.write(b"b"*393216);sys.stderr.flush()\n'
  if mode=='closed-input-after-output':body+='os.close(0)\ntime.sleep(15)\n'
  else:body+='data=sys.stdin.buffer.read()\nassert data==b"x"*262144\n'
  if mode=='success':body+='sys.stdout.write("# Ref\\n")\n'
  if mode=='nonzero':body+='sys.stderr.write("END-DETAIL")\nsys.exit(7)\n'
  stub.write_text('#!/usr/bin/env python3\n'+body);stub.chmod(0o755)
  start=time.monotonic();proc=subprocess.Popen([str(exe),str(stub)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  try:out,err=proc.communicate(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.communicate();raise
  elapsed=time.monotonic()-start
  pid=int(marker.read_text())
  try:os.kill(pid,0);alive=True
  except ProcessLookupError:alive=False
  if alive:os.kill(pid,signal.SIGKILL)
  assert not alive,(mode,'owned renderer remained')
  if mode=='success':assert proc.returncode==0 and out==b'a'*393216+b'# Ref\n' and err==b''
  else:
   assert proc.returncode==2 and out==b'' and b'error[E7004]:' in err
   assert (b'failed (exit 7)' in err and err.endswith(b'END-DETAIL\n')) if mode=='nonzero' else b'failed to pipe the reference model' in err
  checks.append({'case':mode,'startup_stdout_bytes':393216,'startup_stderr_bytes':393216,'input_bytes':262144,'exit':proc.returncode,'stdout_bytes':len(out),'stdout_sha256':hashlib.sha256(out).hexdigest(),'stderr_bytes':len(err),'stderr_tail':err[-160:].decode(),'child_alive_after_return':alive,'seconds':elapsed})
report={'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'renderer_and_helpers_sha256':hashlib.sha256(renderer.encode()).hexdigest(),'exact_extracted_harness_sha256':hashlib.sha256(rust.encode()).hexdigest(),'checks':checks}
(DEST/'independent-duplex.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
