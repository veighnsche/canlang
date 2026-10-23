/** Assemble the production-only subtree of the existing offline tools archive. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {chmodSync,copyFileSync,cpSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function assembleSodaRuntime({destination,node=process.execPath,nodeLicense}){
  assert.ok(!existsSync(destination),'Production runtime destination must be new');
  const cloudflare=join(root,'packages/cloudflare');
  const require=createRequire(join(cloudflare,'package.json'));
  const {buildSync}=require('esbuild');
  const workerdRoot=dirname(require.resolve('workerd/package.json'));
  const nativeRoot=dirname(createRequire(join(workerdRoot,'package.json')).resolve('@cloudflare/workerd-linux-64/package.json'));
  const command=join(destination,'lib/node_modules/@canlang/cloudflare/dist/cli/soda-runtime.js');
  const host=join(dirname(dirname(command)),'host');
  mkdirSync(dirname(command),{recursive:true});mkdirSync(host,{recursive:true});
  const output=buildSync({entryPoints:[join(cloudflare,'dist/cli/soda-runtime.js')],outfile:command,
    bundle:true,format:'esm',platform:'node',target:'node24',external:['workerd'],metafile:true,absWorkingDir:root,
    banner:{js:"import {createRequire as createRuntimeRequire} from 'node:module';const require=createRuntimeRequire(import.meta.url);"}});
  const inputs=Object.keys(output.metafile.inputs);
  for(const forbidden of ['/miniflare/','/wrangler/','/testkit/','/soda-build.js','/deploy/bundle.js','/compiler/'])
    assert.ok(!inputs.some(path=>path.includes(forbidden)),`Production command imported ${forbidden}`);
  writeFileSync(join(destination,'lib/node_modules/@canlang/cloudflare/package.json'),JSON.stringify({name:'@canlang/cloudflare',type:'module',version:json(join(cloudflare,'package.json')).version}));
  for(const name of ['soda-admin.worker.js','can-workerd-exec']){
    const source=join(cloudflare,'dist/host',name);assert.ok(existsSync(source),`Build host artifact ${name} first`);
    copyFileSync(source,join(host,name));chmodSync(join(host,name),name==='can-workerd-exec'?0o755:0o644);
  }
  for(const [source,name] of [[workerdRoot,'workerd'],[nativeRoot,'@cloudflare/workerd-linux-64']])
    cpSync(source,join(destination,'lib/node_modules',name),{recursive:true,dereference:true,filter:path=>!path.endsWith('/node_modules')});
  mkdirSync(join(destination,'libexec'),{recursive:true});copyFileSync(realpathSync(node),join(destination,'libexec/node'));chmodSync(join(destination,'libexec/node'),0o755);
  mkdirSync(join(destination,'bin'));
  writeFileSync(join(destination,'bin/can-soda'),'#!/bin/sh\nset -eu\nCAN_RUNTIME_ENTRY=$(readlink -f -- "$0")\nCAN_RUNTIME_ROOT=$(CDPATH= cd -- "$(dirname -- "$CAN_RUNTIME_ENTRY")/.." && pwd -P)\nexec "$CAN_RUNTIME_ROOT/libexec/node" "$CAN_RUNTIME_ROOT/lib/node_modules/@canlang/cloudflare/dist/cli/soda-runtime.js" "$@"\n',{mode:0o755});
  writeFileSync(join(destination,'bin/node'),'#!/bin/sh\nset -eu\nCAN_RUNTIME_ENTRY=$(readlink -f -- "$0")\nCAN_RUNTIME_ROOT=$(CDPATH= cd -- "$(dirname -- "$CAN_RUNTIME_ENTRY")/.." && pwd -P)\nexec "$CAN_RUNTIME_ROOT/libexec/node" "$@"\n',{mode:0o755});
  mkdirSync(join(destination,'licenses'));
  copyFileSync(join(root,'LICENSE'),join(destination,'licenses/Canlang-LICENSE'));
  copyFileSync(join(root,'scripts/distribution/licenses/workerd-LICENSE'),join(destination,'licenses/workerd-LICENSE'));
  copyFileSync(join(root,'scripts/distribution/licenses/Miniflare-D1-LICENSE'),join(destination,'licenses/Miniflare-D1-LICENSE'));
  writeFileSync(join(destination,'licenses/D1-NOTICE'),'D1 provider protocol and result adaptation derives from Miniflare.\nCopyright (c) Cloudflare, Inc. MIT License; see Miniflare-D1-LICENSE.\n');
  if(nodeLicense)copyFileSync(nodeLicense,join(destination,'licenses/Node-LICENSE'));
  const packages=new Map();
  for(const input of inputs){
    let owner=dirname(resolve(root,input));
    while(owner!==dirname(owner)&&!existsSync(join(owner,'package.json')))owner=dirname(owner);
    if(!existsSync(join(owner,'package.json')))continue;
    const pkg=json(join(owner,'package.json'));
    if(!pkg.name||packages.has(pkg.name))continue;
    const licenses=readdirSync(owner).filter(name=>/^(license|notice|copying)/i.test(name)&&statSync(join(owner,name)).isFile());
    const location=join(destination,'licenses/dependencies',pkg.name.replaceAll('/','__'));
    mkdirSync(location,{recursive:true});
    for(const name of licenses)copyFileSync(join(owner,name),join(location,name));
    if(pkg.name.startsWith('@canlang/')&&licenses.length===0)copyFileSync(join(root,'LICENSE'),join(location,'LICENSE'));
    packages.set(pkg.name,{name:pkg.name,version:pkg.version,license:pkg.license??'UNSPECIFIED'});
  }
  const files=[];
  const inventory=directory=>{chmodSync(directory,0o755);for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,item.name);if(item.isDirectory())inventory(path);else{assert.ok(item.isFile());chmodSync(path,statSync(path).mode&0o111?0o755:0o644);const bytes=readFileSync(path);files.push({path:relative(destination,path),sha256:sha256(bytes),bytes:bytes.length,mode:statSync(path).mode&0o777});}}};
  inventory(destination);
  const manifest={schema:'canlang.soda.runtime.v1',platform:'linux-x86_64',workerd:json(join(workerdRoot,'package.json')).version,
    command:'bin/can-soda',files,packages:[...packages.values(),{name:'workerd',license:'Apache-2.0'},{name:'Miniflare D1 adaptation',license:'MIT'}]};
  writeFileSync(join(destination,'runtime.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
  return manifest;
}
