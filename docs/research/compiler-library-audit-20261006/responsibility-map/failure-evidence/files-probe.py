#!/usr/bin/env python3
"""Bounded native file/metadata audit. Mutates only disposable scratch inputs."""
import json,os,pathlib,re,shutil,tempfile,stat
from run import HERE,ROOT,invoke,save,digest
BIN=ROOT/'compiler/target/debug/can';CAT=ROOT/'packages/values/dist/catalog.json'
INPUT='app F   \nGiven\nWhen\nThen';OUTPUT='app F\nGiven\nWhen\nThen\n'
commands=[];cases=[];observations=[]
def call(name,args,cwd=ROOT,env=None,stdin=None):
 d,r=invoke('files-'+name,args,cwd=cwd,env=env,stdin=stdin,timeout=30);commands.append(r);save('files-execution.json',{'commands':commands,'binary_sha256':digest(BIN),'scope':'native debug temp-only filesystem/build consumers; incomplete until observations complete'});return d

def state(p):
 m=p.lstat();result={'mode':oct(stat.S_IMODE(m.st_mode)),'inode':m.st_ino,'kind':'symlink' if p.is_symlink() else 'directory' if p.is_dir() else 'regular'}
 if p.is_file():result['sha256']=digest(p)
 if p.is_symlink():result['link']=os.readlink(p)
 return result

def record(i,expected,obs):cases.append({'id':i,'expected':expected});observations.append({'id':i,**obs});save('files-cases.json',{'input':INPUT,'formatted':OUTPUT,'cases':cases});save('files-observations.json',{'scope':'actual native CLI and copied-unmodified build.rs consumer; no ACL/owner/crash durability claim','observations':observations})

def fmt(p,name):return call(name,[BIN,'fmt',p])
def docs(p,name,cwd):
 env=os.environ.copy();env['CAN_PLATFORM_BIN']=str(cwd/'platform');return call(name,[BIN,'docs','--catalog',CAT,'--out',p,cwd/'input.can'],cwd,env)

def main():
 assert digest(BIN)==json.loads((HERE/'build.json').read_text())['binary']['sha256']
 for name,args in [('replacement-tests',['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml','--lib','cli::replacement_tests','--','--nocapture']),('ownership-tests',['cargo','test','--locked','--offline','--manifest-path','compiler/Cargo.toml','--test','file_ownership','--','--nocapture'])]:
  d=call(name,args);assert d.returncode==0;record(name,'existing native tests pass with exact body-skip classification',{'exit':d.returncode,'test_results':re.findall(r'test result:.*',d.stdout.decode()),'body_skips':re.findall(r'SKIP[^\n]*',d.stderr.decode())})
 with tempfile.TemporaryDirectory(prefix='can-step12-files-') as tmp:
  t=pathlib.Path(tmp);control=t/'control.can';control.write_text(OUTPUT)
  d=call('source-control',[BIN,'check','--format=json','--catalog',CAT,control]);assert d.returncode==0 and not json.loads(d.stdout)['diagnostics'];record('source-control','clean valid source before writer claims',{'exit':0,'diagnostics':[],'source_sha256':digest(control)})
  for mode in [0o600,0o640,0o4750]:
   for changed in [True,False]:
    name='fmt-'+oct(mode)[2:]+'-'+('changed' if changed else 'equal');p=t/(name+'.can');p.write_text(INPUT if changed else OUTPUT);p.chmod(mode);before=state(p)
    if stat.S_IMODE(p.stat().st_mode)!=mode:record(name,'fixture mode must be established before acceptance',{'status':'fixture-unqualified','requested_mode':oct(mode),'before':before});continue
    d=fmt(p,name);after=state(p);assert d.returncode==0 and p.read_text()==OUTPUT and after['mode']==before['mode'];assert changed or after['inode']==before['inode'];record(name,'capture established mode and equal-output inode preservation',{'exit':d.returncode,'before':before,'after':after,'changed':changed})
  for kind in ['symlink','hardlink']:
   target=t/(kind+'-target.can');target.write_text(INPUT);target.chmod(0o600);p=t/(kind+'-input.can');p.symlink_to(target.name) if kind=='symlink' else os.link(target,p);before=state(p);target_before=state(target);d=fmt(p,'fmt-'+kind);assert d.returncode==0 and p.read_text()==OUTPUT and target.read_text()==INPUT and state(target)==target_before;assert p.lstat().st_ino!=before['inode'];record('fmt-'+kind,'replace requested entry only; other name unchanged',{'exit':d.returncode,'before':before,'after':state(p),'target_before':target_before,'target_after':state(target)})
  first=t/'first.can';bad=t/'bad.can';first.write_text(INPUT);bad.write_text('app Bad\nGiven\n Item {title:\n');before=state(first);d=call('fmt-parse-before-write',[BIN,'fmt',first,bad]);assert d.returncode==10 and state(first)==before;record('fmt-parse-before-write','any parse failure leaves all inputs unchanged',{'exit':10,'first_unchanged':True,'diagnostics':json.loads(d.stdout)['diagnostics']})
  parent=t/'blocked';parent.mkdir();second=parent/'second.can';second.write_text(INPUT);first.write_text(INPUT);parent.chmod(0o500)
  try:
   d=call('fmt-partial-progress',[BIN,'fmt',first,second]);obs={'exit':d.returncode,'first_formatted':first.read_text()==OUTPUT,'second_unchanged':second.read_text()==INPUT,'stderr':d.stderr.decode()};assert d.returncode==2 and b'E7007' in d.stderr and obs['first_formatted'] and obs['second_unchanged'];record('fmt-partial-progress','later parent-write failure retains earlier completed operand',obs)
  finally:parent.chmod(0o700)
  source=t/'input.can';source.write_text(OUTPUT);producer=t/'platform';producer.write_text("#!/bin/sh\ncat >/dev/null\nprintf '# Reference\\n'\n");producer.chmod(0o700)
  for kind in ['missing','existing','equal','directory','missing-parent']:
   p=t/('reference-'+kind+'.md') if kind!='missing-parent' else t/'absent'/'reference.md'
   if kind in ['existing','equal']:p.write_text('old' if kind=='existing' else '# Reference\n');p.chmod(0o600)
   if kind=='directory':p.mkdir()
   before=state(p) if p.exists() else None;d=docs(p,'docs-'+kind,t);leaks=[x.name for x in t.rglob('.can-*')]
   if kind in ['directory','missing-parent']:assert d.returncode==2 and b'E7007' in d.stderr and (not p.exists() if kind=='missing-parent' else p.is_dir())
   else:assert d.returncode==0 and p.read_text()=='# Reference\n';assert kind=='missing' or state(p)['mode']==before['mode'];assert kind!='equal' or state(p)['inode']!=before['inode']
   assert not leaks;record('docs-'+kind,'successful replace or controlled E7007/no staging leak',{'exit':d.returncode,'before':before,'after':state(p) if p.exists() else None,'staging_leaks':leaks,'stderr':d.stderr.decode(),'producer':'explicit temp renderer stub; writer/interface only'})
  repo=t/'repo';repo.mkdir();crate=repo/'compiler';(crate/'src').mkdir(parents=True);(repo/'.gitignore').write_text('target/\n');(crate/'Cargo.toml').write_text('[package]\nname="can-build-metadata-probe"\nversion="0.0.0"\nedition="2024"\n');shutil.copyfile(ROOT/'compiler/build.rs',crate/'build.rs');(crate/'src/main.rs').write_text('fn main(){println!("{}",env!("CAN_BUILD_COMMIT"));}\n')
  git_env=os.environ.copy();git_env.update({'GIT_AUTHOR_NAME':'audit','GIT_AUTHOR_EMAIL':'audit@example.invalid','GIT_COMMITTER_NAME':'audit','GIT_COMMITTER_EMAIL':'audit@example.invalid'})
  def git(name,args,cwd=repo):
   d=call('git-'+name,['git',*args],cwd,git_env);assert d.returncode==0;return d.stdout.decode().strip()
  git('init',['init']);git('add',['add','.']);git('commit1',['commit','-m','fixture'])
  def build(name,cwd):
   expected=git(name+'-head',['rev-parse','--short','HEAD'],cwd.parent);d=call('build-'+name,['cargo','run','--offline','--verbose'],cwd);assert d.returncode==0;actual=d.stdout.decode().strip();assert actual==expected;return {'expected':expected,'actual':actual,'fresh_lines':[l for l in d.stderr.decode().splitlines() if 'Dirty ' in l or 'Fresh ' in l or 'Compiling ' in l]}
  ordinary1=build('ordinary-first',crate);git('commit2',['commit','--allow-empty','-m','second']);ordinary2=build('ordinary-second',crate);record('build-ordinary','new loose ref commit refreshes actual env consumer',{'first':ordinary1,'second':ordinary2,'build_script_sha256':digest(crate/'build.rs')})
  git('pack1',['pack-refs','--all','--prune']);packed1=build('packed-first',crate);packed2=build('packed-repeat',crate);git('commit3',['commit','--allow-empty','-m','third']);git('pack2',['pack-refs','--all','--prune']);packed3=build('packed-third',crate);record('build-packed','do not assume stale; missing watched loose file can force rebuild',{'first':packed1,'repeat':packed2,'new_commit':packed3})
  work=t/'work';git('worktree',['worktree','add','--detach',work,'HEAD']);wf=build('gitfile-first',work/'compiler');git('worktree-commit',['commit','--allow-empty','-m','worktree next'],work);ws=build('gitfile-second',work/'compiler');wr=build('gitfile-repeat',work/'compiler');record('build-gitfile','actual copied build script in gitfile layout refreshes or reveals bounded failure',{'first':wf,'second':ws,'repeat':wr,'gitfile':(work/'.git').read_text()})
 save('files-execution.json',{'commands':commands,'binary_sha256':digest(BIN),'catalog_sha256':digest(CAT),'script_sha256':digest(HERE/'files-probe.py'),'copied_build_script_sha256':digest(ROOT/'compiler/build.rs'),'scope':'completed native debug/temp-only file and minimal actual build.rs consumer probes; no policy/ACL/owner/crash durability/other-host acceptance'})
 print(json.dumps({'commands':len(commands),'cases':len(cases),'observations':len(observations)}))
if __name__=='__main__':main()
