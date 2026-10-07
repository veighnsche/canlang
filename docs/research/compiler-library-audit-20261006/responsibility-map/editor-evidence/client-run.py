#!/usr/bin/env python3
import pathlib,tempfile,shutil,json,os
from run import HERE,ROOT,invoke,save,digest

def main():
 receipts=[];tsc=ROOT/'node_modules/.bun/typescript@5.9.3/node_modules/typescript/lib/tsc.js'
 d,r=invoke('typescript-version',['node',tsc,'--version']);receipts.append(r);assert d.returncode==0
 with tempfile.TemporaryDirectory(prefix='can-step11-client-') as t:
  t=pathlib.Path(t);(t/'empty').mkdir();(t/'test').mkdir();shutil.copyfile(ROOT/'editors/vscode/test/server-startup.cjs',t/'test/server-startup.cjs')
  d,r=invoke('compile-client',['node',tsc,'--strict','--target','es2022','--module','commonjs','--lib','es2022','--typeRoots',t/'empty','--outDir',t/'out','--rootDir',ROOT/'editors/vscode/src',ROOT/'editors/vscode/src/extension.ts',ROOT/'editors/vscode/src/client.ts']);receipts.append(r);assert d.returncode==0
  compiled=[{'name':p.name,'sha256':digest(p),'bytes':p.stat().st_size} for p in sorted((t/'out').glob('*.js'))]
  d,r=invoke('client-startup',['node',t/'test/server-startup.cjs']);receipts.append(r);assert d.returncode==0
  env=os.environ.copy();env['CAN_CATALOG']=str(ROOT/'packages/values/dist/catalog.json')
  d,r=invoke('actual-client',['node',HERE/'client-probe.cjs',t/'out',ROOT/'compiler/target/debug/can',ROOT,HERE],env=env,timeout=35);r['environment_overrides']={'CAN_CATALOG':env['CAN_CATALOG']};receipts.append(r)
  save('client-execution.json',{'commands':receipts,'typescript_package':{'path':str(tsc.parent.parent/'package.json'),'sha256':digest(tsc.parent.parent/'package.json')},'compiled':compiled,'binary_sha256':digest(ROOT/'compiler/target/debug/can'),'exit':d.returncode,'source_policy':'original TS compiled to temporary output, test copied unchanged; no editor source/output modification'})
  assert d.returncode==0
 print('Client seam qualified at actual module/real-server/strict-host-stand-in scope.')
if __name__=='__main__':main()
