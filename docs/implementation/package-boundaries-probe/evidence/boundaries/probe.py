#!/usr/bin/env python3
"""Isolated, registry-free Turbo boundary fixtures. Prepare first; run only with verified CLI flags."""
import argparse, json, pathlib, shutil, subprocess, os
SCRATCH=pathlib.Path('/private/tmp/canlang-turbo-probe-20261006.89738Q/boundaries')
EVIDENCE=pathlib.Path(__file__).resolve().parent
CASES=[
 ('allowed-root',True,'src/index.ts',"import { value } from '@probe/b'; console.log(value);"),
 ('undeclared-root',False,'src/index.ts',"import { value } from '@probe/b'; console.log(value);"),
 ('sibling-source-declared',True,'src/index.ts',"import { value } from '../../b/src/index.ts'; console.log(value);"),
 ('sibling-source-undeclared',False,'src/index.ts',"import { value } from '../../b/src/index.ts'; console.log(value);"),
 ('sibling-dist-declared',True,'src/index.ts',"import { value } from '../../b/dist/index.js'; console.log(value);"),
 ('unexported-subpath',True,'src/index.ts',"import { secret } from '@probe/b/private'; console.log(secret);"),
 ('alias-source-declared',True,'src/index.ts',"import { value } from '@alias/b'; console.log(value);"),
 ('alias-source-undeclared',False,'src/index.ts',"import { value } from '@alias/b'; console.log(value);"),
 ('type-only-import-undeclared',False,'src/index.ts',"import type { Shape } from '@probe/b'; export type T = Shape;"),
 ('type-only-export-undeclared',False,'src/index.ts',"export type { Shape } from '@probe/b';"),
 ('type-query-undeclared',False,'src/index.ts',"export type T = import('@probe/b').Shape;"),
 ('reexport-undeclared',False,'src/index.ts',"export { value } from '@probe/b';"),
 ('reexport-sibling',True,'src/index.ts',"export { value } from '../../b/src/index.ts';"),
 ('dynamic-literal-undeclared',False,'src/index.ts',"export const load = () => import('@probe/b');"),
 ('dynamic-constant-undeclared',False,'src/index.ts',"const producer = '@probe/b'; export const load = () => import(producer);"),
 ('dynamic-concat-sibling',False,'src/index.ts',"const producer = '../../b/' + 'src/index.ts'; export const load = () => import(producer);"),
 ('dynamic-computed-sibling',False,'src/index.ts',"export const load = (name: string) => import(`../../b/src/${name}.ts`);"),
 ('fs-read-sibling',False,'src/index.ts',"import { readFileSync } from 'node:fs'; export const read = () => readFileSync(new URL('../../b/src/index.ts', import.meta.url), 'utf8');"),
 ('url-sibling',False,'src/index.ts',"export const producer = new URL('../../b/dist/index.js', import.meta.url);"),
 ('fs-read-local-control',False,'src/index.ts',"import { readFileSync } from 'node:fs'; export const read = () => readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');"),
 ('test-undeclared',False,'test/boundary.test.ts',"import { value } from '@probe/b'; console.log(value);"),
 ('test-sibling',True,'test/boundary.test.ts',"import { value } from '../../b/src/index.ts'; console.log(value);"),
 ('root-tool-undeclared',False,'ROOT:scripts/tool.ts',"import { value } from '@probe/b'; console.log(value);"),
 ('root-tool-sibling',False,'ROOT:scripts/tool.ts',"import { value } from '../packages/b/src/index.ts'; console.log(value);"),
]
def write(p,v):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,indent=2)+'\n' if isinstance(v,dict) else v+'\n')
def prepare():
 for name,dep,filename,source in CASES:
  root=SCRATCH/name;root.mkdir(parents=True,exist_ok=True)
  write(root/'package.json',{'name':'boundary-probe','private':True,'packageManager':'bun@1.4.2','workspaces':['packages/*']})
  write(root/'turbo.json',{'tasks':{}})
  a={'name':'@probe/a','version':'1.0.0','type':'module','private':True}
  if dep:a['dependencies']={'@probe/b':'workspace:*'}
  write(root/'packages/a/package.json',a)
  write(root/'packages/b/package.json',{'name':'@probe/b','version':'1.0.0','type':'module','private':True,'exports':{'.':'./src/index.ts'}})
  write(root/'packages/b/src/index.ts','export const value = 1; export interface Shape { value: number }')
  write(root/'packages/b/src/private.ts','export const secret = 2;')
  write(root/'packages/b/private.ts','export const secret = 2;')
  write(root/'packages/b/dist/index.js','export const value = 1;')
  write(root/'packages/a/tsconfig.json',{'compilerOptions':{'target':'ES2022','module':'ESNext','moduleResolution':'Bundler','baseUrl':'.','paths':{'@alias/b':['../b/src/index.ts']},'allowImportingTsExtensions':True,'noEmit':True},'include':['src','test']})
  write(root/(filename[5:] if filename.startswith('ROOT:') else 'packages/a/'+filename),source)
  write(root/'packages/a/src/fixture.txt','fixture')
  target=EVIDENCE/'fixtures'/name
  if target.exists():shutil.rmtree(target)
  shutil.copytree(root,target,ignore=shutil.ignore_patterns('node_modules','bun.lock','.turbo'))
 write(EVIDENCE/'cases.json',{'cases':[{'name':n,'dependency':d,'file':f,'source':s} for n,d,f,s in CASES]})
def execute(command):
 env={**os.environ,'TURBO_TELEMETRY_DISABLED':'1','BUN_INSTALL_CACHE_DIR':str(SCRATCH/'bun-cache'),'XDG_CACHE_HOME':str(SCRATCH/'xdg-cache')}
 for name,*_ in CASES:
  root=SCRATCH/name;out=EVIDENCE/'results'/name;out.mkdir(parents=True,exist_ok=True)
  install=subprocess.run(['/Users/vince/.bun/bin/bun','install','--ignore-scripts'],cwd=root,env=env,capture_output=True,text=True)
  write(out/'install.json',{'argv':['bun','install','--ignore-scripts'],'exit_code':install.returncode,'stdout':install.stdout,'stderr':install.stderr})
  result=subprocess.run(command,cwd=root,env=env,capture_output=True,text=True)
  write(out/'boundary.json',{'argv':command,'cwd':str(root),'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr})
  print(name,result.returncode,flush=True)
 for name in ['allowed-root','unexported-subpath']:
  argv=['/Users/vince/.bun/bin/bun','run','packages/a/src/index.ts']
  result=subprocess.run(argv,cwd=SCRATCH/name,env=env,capture_output=True,text=True)
  write(EVIDENCE/'results'/name/'runtime.json',{'argv':argv,'cwd':str(SCRATCH/name),'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr})
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--run',nargs=argparse.REMAINDER);a=p.parse_args()
 if a.run:execute(a.run)
 else:prepare();print(f'Prepared {len(CASES)} fixtures')
