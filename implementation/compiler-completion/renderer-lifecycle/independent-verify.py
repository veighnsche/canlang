"""Exact renderer-function probe; temporary consumers, no production writes."""
import hashlib,json,os,pathlib,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[3]
DEST=pathlib.Path(__file__).resolve().parent
source=(ROOT/'compiler/src/cli.rs').read_text()
original=subprocess.run(['git','show','HEAD:compiler/src/cli.rs'],cwd=ROOT,capture_output=True,text=True,check=True).stdout

def parts(text):
    result=text[text.index('#[derive(Debug, Clone)]\npub struct DispatchResult'):text.index('/// Analysis hook')]
    renderer=text[text.index('fn render_via_platform('):text.index('/// Locate the lane-7')]
    return result,renderer

def command(*args):
    return subprocess.run(args,text=True,capture_output=True,check=True)

def alive(pid):
    try: os.kill(pid,0);return True
    except ProcessLookupError:return False

results=[]
with tempfile.TemporaryDirectory(prefix='can-renderer-independent-') as tmp:
    tmp=pathlib.Path(tmp)
    for version,text in [('baseline',original),('current',source)]:
        result,renderer=parts(text)
        rust='mod exit { pub const OK:i32=0; pub const TOOL_FAILURE:i32=2; }\n'+result+renderer+'''\nfn main(){let args:Vec<String>=std::env::args().collect();let len=args[2].parse::<usize>().unwrap();match render_via_platform(&args[1],Some("nl"),&"x".repeat(len)){Ok(out)=>print!("{out}"),Err(err)=>{assert!(err.stdout.is_empty());assert!(!err.run_lsp);eprint!("{}",err.stderr);std::process::exit(err.code);}}}\n'''
        src=tmp/f'{version}.rs';src.write_text(rust);exe=tmp/version
        command('rustc','--edition=2024',str(src),'-o',str(exe))
        for case,body,size,code,contains in [
            ('closed-input-live-child',"printf '%s' $$ > '{pid}'\nexec 0<&-\nexec sleep 5\n",262144,2,'failed to pipe the reference model'),
            ('closed-input-partial-output',"printf '%s' $$ > '{pid}'\nprintf '# partial markdown\\n'\nexec 0<&-\nexec sleep 5\n",262144,2,'failed to pipe the reference model'),
            ('closed-input-already-exited',"printf '%s' $$ > '{pid}'\nexec 0<&-\nexit 3\n",262144,2,'failed to pipe the reference model'),
            ('success',"cat > /dev/null\nprintf '# Ref\\n'\n",128,0,''),
            ('nonzero',"cat > /dev/null\nprintf 'producer detail' >&2\nprintf '# partial\\n'\nexit 7\n",128,2,'failed (exit 7): producer detail'),
            ('signal',"cat > /dev/null\nkill -TERM $$\n",128,2,'failed (killed by signal)'),
            ('invalid-utf8',"cat > /dev/null\nprintf '\\377\\376'\n",128,2,'wrote non-UTF8 output'),
            ('empty-output',"cat > /dev/null\n",128,2,'produced no output')]:
            pid_path=tmp/f'{version}-{case}.pid';stub=tmp/f'{version}-{case}.sh';stub.write_text('#!/bin/sh\n'+body.format(pid=pid_path));stub.chmod(0o755)
            start=time.monotonic();p=subprocess.run([str(exe),str(stub),str(size)],text=True,capture_output=True,timeout=10);elapsed=time.monotonic()-start
            assert p.returncode==code,(version,case,p)
            if code:assert p.stdout=='' and 'error[E7004]:' in p.stderr and contains in p.stderr,(version,case,p)
            else:assert p.stdout=='# Ref\n' and p.stderr=='',(version,case,p)
            child_alive=None
            if pid_path.exists():
                pid=int(pid_path.read_text());child_alive=alive(pid)
                if child_alive:os.kill(pid,9)
                if version=='current':assert not child_alive,(case,pid)
                elif case in ('closed-input-live-child','closed-input-partial-output'):assert child_alive,(case,pid)
            results.append({'version':version,'case':case,'exit_code':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'seconds':elapsed,'child_present_after_return':child_alive})
report={'source':'compiler/src/cli.rs','source_sha256':hashlib.sha256(source.encode()).hexdigest(),'renderer_and_tail_sha256':hashlib.sha256(parts(source)[1].encode()).hexdigest(),'baseline_renderer_and_tail_sha256':hashlib.sha256(parts(original)[1].encode()).hexdigest(),'verdict':'pass for narrow early stdin-write cleanup; broader FAIL-R05 remains unqualified','blocking_issues':[],'method':'Extracted byte-exact render_via_platform and stderr_tail plus actual DispatchResult definition/implementation; supplied only exit constants and a tiny calling main. Compiled both current and Git HEAD implementations with rustc. Compared current behavior with original for eight cases. Temporary fixtures deleted; live baseline orphan children killed after observation.','checks':results,'source_review':['Drop stdin before kill releases the owned write handle. kill targets the owned direct child; wait synchronously reaps it before returning. The original write error remains the E7004 detail and stdout remains empty.','Success and existing wait_with_output/nonzero/signal/UTF8/empty-output logic are unchanged.','New unit test forces a failed handoff with payload larger than a pipe buffer, records the same process PID with exec sleep, and checks absence with kill -0 after return. This catches both a still-running owned child and a Unix zombie.'],'limitations':['Exact-function harness is not the integrated compiler or actual can docs CLI; focused crate tests await coordinated stable build state.','Local macOS native subprocess behavior only; Windows and other hosts were not executed.','Timeout, bounded capture, blocked writes, descendant process-tree termination and wider FAIL-R05 duties remain unqualified. No timeout/capture policy is selected.','kill/wait errors are intentionally ignored to retain the original write diagnostic; this test does not inject OS cleanup failures.'],'rustc':command('rustc','--version').stdout.strip()}
(DEST/'independent-review.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'verdict':report['verdict'],'source_sha256':report['source_sha256'],'cases':len(results),'baseline_live_child_reproduced':True,'current_children_absent':True},indent=2))
