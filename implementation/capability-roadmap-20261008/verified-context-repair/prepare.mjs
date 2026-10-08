import assert from 'node:assert/strict';
import {cp,mkdir,copyFile,readdir,readlink,symlink,unlink,readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
const out=dirname(fileURLToPath(import.meta.url));
const repo='/Users/vince/Projects/canlang',foundation='/private/tmp/canlang-nullable-ref-after-db57c379';
const root=`/private/tmp/canlang-verified-context-after-${randomUUID()}`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=async p=>sha(await readFile(p));
const json=x=>JSON.stringify(x,null,2)+'\n';
const paths=['packages/cloudflare/src/runtime/context.ts','packages/cloudflare/src/runtime/invoke.ts','packages/cloudflare/src/runtime/verified-context.test.ts','packages/cloudflare/src/runtime/stdlib.ts'];
const links=[];const commands=[];
await mkdir(`${out}/logs`,{recursive:true});
await mkdir(root);
for(const name of ['packages','node_modules','tsconfig.base.json','package.json'])await cp(`${foundation}/${name}`,`${root}/${name}`,{recursive:true,verbatimSymlinks:true});
async function redirect(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const p=`${dir}/${entry.name}`;if(entry.isDirectory())await redirect(p);else if(entry.isSymbolicLink()){const before=await readlink(p);if(before.startsWith(foundation+'/')){const after=root+before.slice(foundation.length);await unlink(p);await symlink(after,p);links.push({path:p,before,after});}if(p.includes('/@canlang/'))assert.ok((await realpath(p)).startsWith(root+'/packages/'),p);}}}
await redirect(root);
const overlays={};for(const path of paths){await copyFile(`${repo}/${path}`,`${root}/${path}`);overlays[path]={source_sha256:await hash(`${repo}/${path}`),copied_sha256:await hash(`${root}/${path}`)};assert.equal(overlays[path].source_sha256,overlays[path].copied_sha256);}
const config={extends:`${root}/packages/cloudflare/tsconfig.json`,compilerOptions:{noEmitOnError:true,tsBuildInfoFile:`${root}/context.tsbuildinfo`,composite:false},include:['runtime/context.ts','runtime/invoke.ts','runtime/stdlib.ts','runtime/modules.ts','worker/assembly.ts','runtime/verified-context.test.ts'].map(p=>`${root}/packages/cloudflare/src/${p}`),exclude:[]};
await writeFile(`${out}/cloudflare-tsconfig.json`,json(config));
async function command(name,args){const executable=process.execPath;const started=Date.now(),result=spawnSync(executable,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});await writeFile(`${out}/logs/${name}.stdout`,result.stdout??'');await writeFile(`${out}/logs/${name}.stderr`,result.stderr??'');commands.push({name,argv:[executable,...args],cwd:root,timeout_ms:60000,elapsed_ms:Date.now()-started,exit_code:result.status,signal:result.signal,error:result.error?.message??null});await writeFile(`${out}/build-commands.json`,json(commands));assert.equal(result.status,0,name);}
const tool=`${root}/node_modules/typescript/bin/tsc`;
const metadata={root,foundation,overlays,links,node:{argv:process.argv,version:process.version,execPath:process.execPath,sha256:await hash(process.execPath)},typescript:{path:tool,realpath:await realpath(tool),sha256:await hash(tool)},qualification:'Only copied frozen nullable-after support graph plus exact current context/invoke/new test and accepted pure stdlib source overlay. Other snapshot source/output is not relabeled current.'};
await writeFile(`${out}/private-snapshot.json`,json(metadata));
await command('selected-build',[tool,'-p',`${out}/cloudflare-tsconfig.json`]);
await command('selected-typecheck',[tool,'-p',`${out}/cloudflare-tsconfig.json`,'--noEmit']);
await command('constructor-tests',['--test',`${root}/packages/cloudflare/dist/runtime/verified-context.test.js`]);
console.log(json({root,build:'passed',typecheck:'passed',constructor_tests:'see exact TAP',commands_released:true}));
