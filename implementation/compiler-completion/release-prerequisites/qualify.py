import pathlib,subprocess,json,os,time,hashlib
ROOT=pathlib.Path('/Users/vince/Projects/canlang');OUT=ROOT/'implementation/compiler-completion/release-prerequisites';TMP=pathlib.Path('/private/tmp/canlang-dep03-release-20261008');env=os.environ.copy();env.update(CARGO_HOME=str(TMP/'cargo-home'),CARGO_BUILD_JOBS='2',CARGO_INCREMENTAL='0'); results=[]
def run(name,args):
 start=time.monotonic();p=subprocess.run(args,cwd=TMP/'source/compiler',env=env,capture_output=True);(OUT/(name+'.stdout')).write_bytes(p.stdout);(OUT/(name+'.stderr')).write_bytes(p.stderr);results.append({'name':name,'command':args,'cwd':str(TMP/'source/compiler'),'exit':p.returncode,'seconds':time.monotonic()-start});(OUT/'commands.json').write_text(json.dumps({'environment':{'CARGO_HOME':env['CARGO_HOME'],'CARGO_BUILD_JOBS':'2','CARGO_INCREMENTAL':'0'},'results':results},indent=2)+'\n');return p
run('rustc',['rustc','+1.99.0','-Vv']);run('cargo',['cargo','+1.99.0','-V']);run('toolchains',['rustup','toolchain','list']);run('targets',['rustup','target','list','--installed','--toolchain','1.99.0'])
for target in ['aarch64-apple-darwin','x86_64-unknown-linux-gnu']:
 for kind in ['normal,build','features']:
  run('tree-'+target+'-'+kind.replace(',','-'),['cargo','+1.99.0','tree','--offline','--locked','--target',target,'--edges',kind,'--prefix','none','--format','{p} {f}'])
p=run('native-release',['cargo','+1.99.0','build','--release','--locked','--offline','--target-dir',str(TMP/'native-target')])
if p.returncode==0:
 bin=TMP/'native-target/release/can';data=bin.read_bytes();(OUT/'native-artifact.json').write_text(json.dumps({'path':str(bin),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'toolchain':'1.99.0','host':'aarch64-apple-darwin','source_pins':'source-pins.json'},indent=2)+'\n');run('native-version',[str(bin),'--version']);run('native-help',[str(bin),'--help'])
print(json.dumps(results,indent=2))
