#!/usr/bin/env python3
"""Finite real CLI/native-pipe controls. Watchdog is observer policy only."""
import hashlib,json,os,signal,subprocess,time,resource
from pathlib import Path
ROOT=Path('/Users/vince/Projects/canlang')
OUT=ROOT/'implementation/compiler-completion/renderer-failure-qualification'
BIN=Path('/private/tmp/can-compiler-0134ebb0-page-handoff/can')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=ROOT/'implementation/compiler-completion/integration-after-bindings/after-decimal-materialization/before-compiler-inputs.json'
pins=json.loads(manifest.read_text())
identity={p:sha(ROOT/p) for p in ('compiler/src/cli.rs','compiler/src/main.rs')}
assert all(identity[p]==pins[p] for p in identity)
assert sha(BIN)=='b2608559e9af0e934a0727faad1d31aee43528cb87a9359f3576a6d8b3db3a7e'
source=OUT/'input.can'
source.write_text('app Demo\nGiven\n Gadget {title:text desc="'+'x'*262144+'"}\n policy Gadget read=members\nWhen\nThen\n')
bad=OUT/'invalid.can';bad.write_text('app Demo\nGiven\n invalid syntax !!!\n')
rows=[]
def alive(pid):
 try:os.kill(pid,0);return True
 except ProcessLookupError:return False

def execute(name,args,env=None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,reader_fds=(),preexec_fn=None):
 command=[str(BIN),*args]
 started=time.monotonic()
 proc=subprocess.Popen(command,env=env,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=preexec_fn)
 for fd in reader_fds:os.close(fd)
 timedout=False;cleanup='none'
 try:out,err=proc.communicate(timeout=10)
 except subprocess.TimeoutExpired:
  timedout=True;os.killpg(proc.pid,signal.SIGKILL);out,err=proc.communicate();cleanup='observer killed group and reaped CLI'
 out=out or b'';err=err or b''
 (OUT/(name+'.stdout')).write_bytes(out);(OUT/(name+'.stderr')).write_bytes(err)
 row={'case':name,'command':command,'environment_override':{'CAN_PLATFORM_BIN':env['CAN_PLATFORM_BIN']} if env else {},'cli_pid':proc.pid,'exit':proc.returncode,'seconds':time.monotonic()-started,'watchdog_seconds':10,'timed_out':timedout,'observer_cleanup':cleanup,'stdout_bytes':len(out),'stdout_sha256':hashlib.sha256(out).hexdigest(),'stderr_bytes':len(err),'stderr_sha256':hashlib.sha256(err).hexdigest(),'stderr':err.decode(errors='replace'),'cli_reaped':proc.poll() is not None}
 rows.append(row)
 assert not timedout,row
 return row,out,err
r,_,_=execute('source-check',['check',str(source)]);assert r['exit']==0
base='#!/usr/bin/env python3\nimport os,sys,time,json,signal\n'
# Original finite handoff/duplex case bodies retained; every child also records its PID.
cases={
 'success':('data=json.load(sys.stdin)\nassert "Gadget" in str(data)\nprint("# Reference")\n',0,'# Reference\n'),
 'nonzero':('sys.stdin.read()\nsys.stderr.write("renderer-control")\nsys.exit(3)\n',2,'exit 3'),
 'signal':('sys.stdin.read()\nos.kill(os.getpid(), signal.SIGTERM)\n',2,'killed by signal'),
 'invalid-utf8':('sys.stdin.read()\nsys.stdout.buffer.write(b"\\xff")\n',2,'non-UTF8'),
 'empty':('sys.stdin.read()\n',2,'produced no output'),
 'duplex':('sys.stdout.write("x"*262144)\nsys.stdout.flush()\nsys.stderr.write("startup-note"*32768)\nsys.stderr.flush()\nsys.stdin.read()\nprint("# Reference")\n',0,'# Reference\n'),
 'closed-input':('os.close(0)\ntime.sleep(15)\n',2,'failed to pipe the reference model'),
 'nonzero-after-duplex':('sys.stdout.write("x"*393216)\nsys.stdout.flush()\nsys.stderr.write("b"*393216+"END-DETAIL")\nsys.stderr.flush()\nsys.stdin.read()\nsys.exit(7)\n',2,'END-DETAIL'),
 'closed-input-after-duplex':('sys.stdout.write("x"*393216)\nsys.stdout.flush()\nsys.stderr.write("b"*393216)\nsys.stderr.flush()\nos.close(0)\ntime.sleep(15)\n',2,'failed to pipe the reference model'),
}
for name,(body,code,expected) in cases.items():
 pidfile=OUT/(name+'.pid');pidfile.unlink(missing_ok=True)
 helper=OUT/('renderer-'+name+'.py');helper.write_text(base+f'open({str(pidfile)!r},"w").write(str(os.getpid()))\n'+body);helper.chmod(0o700)
 env={**os.environ,'CAN_PLATFORM_BIN':str(helper)}
 r,out,err=execute(name,['docs',str(source)],env)
 pid=int(pidfile.read_text());r['renderer_pid']=pid;r['renderer_alive_after_cli_exit']=alive(pid)
 if r['renderer_alive_after_cli_exit']:os.kill(pid,signal.SIGKILL);r['observer_cleanup']='killed residual child'
 assert not r['renderer_alive_after_cli_exit'],r
 assert r['exit']==code and expected in (out if code==0 else err).decode(errors='replace'),r
 if code:assert not out and b'E7004' in err
 if name=='success':assert out==b'# Reference\n' and not err
 if name=='duplex':assert out==b'x'*262144+b'# Reference\n' and not err
 if name=='nonzero-after-duplex':assert b'exit 7' in err and b'...' in err and len(err)<2300
helper=OUT/'must-not-run.py';marker=OUT/'gating.marker';marker.unlink(missing_ok=True)
helper.write_text(base+f'open({str(marker)!r},"w").write("spawned")\n');helper.chmod(0o700)
r,out,err=execute('analysis-before-renderer',['docs',str(bad)],{**os.environ,'CAN_PLATFORM_BIN':str(helper)})
assert r['exit']==10 and not marker.exists();r['renderer_spawned']=False
r,out,err=execute('spawn-missing',['docs',str(source)],{**os.environ,'CAN_PLATFORM_BIN':str(OUT/'does-not-exist')})
assert r['exit']==2 and not out and b'E7004' in err
# Real descriptors exercise the installed CLI writer, not a Rust fake Write implementation.
for name,args,closed in [('stdout-epipe',['--help'],('stdout',)),('stderr-epipe',['not-a-command'],('stderr',)),('both-epipe',['not-a-command'],('stdout','stderr'))]:
 kw={};fds=[];writes=[]
 for stream in closed:
  read,write=os.pipe();os.close(read);kw[stream]=write;writes.append(write)
 try:r,out,err=execute(name,args,**kw)
 finally:
  for fd in writes:os.close(fd)
 r['native_sink']='pipe with no readers';assert r['exit']==(0 if name=='stdout-epipe' else 2),r
# Rust stdio ignores EBADF descriptors; record this actual carrier behavior separately.
fd=os.open(source,os.O_RDONLY)
try:r,out,err=execute('stdout-ebadf',['--help'],stdout=fd)
finally:os.close(fd)
r['native_sink']='read-only descriptor (EBADF)';assert r['exit']==0 and not err
# Kernel EFBIG is genuine non-BrokenPipe, using disposable regular-file sinks.
def filesize_guard():
 signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
 resource.setrlimit(resource.RLIMIT_FSIZE,(1,1))
for name,args,streams in [('stdout-efbig',['--help'],('stdout',)),('stderr-efbig',['not-a-command'],('stderr',)),('both-efbig',['--help'],('stdout','stderr'))]:
 kw={};fds=[];paths=[]
 for stream in streams:
  path=OUT/(name+'.'+stream+'.sink');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);kw[stream]=fd;fds.append(fd);paths.append(path)
 try:r,out,err=execute(name,args,preexec_fn=filesize_guard,**kw)
 finally:
  for fd in fds:os.close(fd)
 r['native_sink']='regular file, RLIMIT_FSIZE=1, SIGXFSZ ignored (EFBIG)';r['sink_bytes']={p.name:len(p.read_bytes()) for p in paths}
 assert r['exit']==2,r
 if name=='stdout-efbig':assert b'E7005' in err and b'failed printing to stdout' in err and b'panicked at' not in err
assert sha(BIN)=='b2608559e9af0e934a0727faad1d31aee43528cb87a9359f3576a6d8b3db3a7e'
assert identity=={p:sha(ROOT/p) for p in identity}
receipt={'verdict':'completed_bounded','binary':str(BIN),'binary_sha256':sha(BIN),'compiler_manifest':str(manifest),'compiler_manifest_sha256':sha(manifest),'source_pins':identity,'results':rows,'limits':['Finite native macOS CLI/helper and real descriptor controls only.','10-second observer watchdog and finite fixtures are not production timeout/capture policy.','Child absence is observed after CLI return; source child.wait provides the reap path. OS wait/read failure injection, thread failures and descendant pipe holders remain structural/unqualified.','Broader all-sink command inventory, other hosts, arbitrary blocked/flooding producers and resource policy remain open.','Source pins cover the unchanged renderer/main adapter, not compiler changes after the frozen build.']}
(OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'verdict':receipt['verdict'],'cases':len(rows),'renderer_pids_absent':9,'saved':str(OUT/'receipt.json')}))
