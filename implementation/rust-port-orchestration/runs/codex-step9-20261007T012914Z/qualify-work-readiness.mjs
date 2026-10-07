// Step9 installed work readiness witness. This certifies only existing public TS facts,
// never a nonexistent Rust/Wasm consumer. Mutable output stays outside checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync,readdirSync,cpSync,realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve,join } from 'node:path';
const repo=resolve(process.env.CAN_REPO ?? process.cwd());
const out=resolve(process.env.CAN_STEP9_WORK_OUT);
assert.ok(out.startsWith('/private/tmp/canlang-'),'explicit unique private root required');
mkdirSync(out,{recursive:true});
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const below=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?below(join(d,e.name)):[join(d,e.name)]);
const roots=['packages/contracts/src','packages/work-kernel/src','packages/work-kernel/bindings','packages/work-kernel/decisions','packages/work-kernel/rust','packages/work-kernel/conformance'];
const sourceFiles=[...roots.flatMap(d=>below(join(repo,d))),...['tsconfig.base.json','packages/contracts/package.json','packages/contracts/tsconfig.json','packages/work-kernel/package.json','packages/work-kernel/tsconfig.json','packages/work-kernel/Cargo.toml','packages/work-kernel/Cargo.lock','node_modules/typescript/package.json','node_modules/typescript/bin/tsc','node_modules/typescript/lib/_tsc.js'].map(p=>join(repo,p))];
const snap=()=>Object.fromEntries(sourceFiles.sort().map(p=>[p.slice(repo.length+1),sha(p)]));
const before=snap(),commands=[];
function command(exe,args,cwd,label){
 const start=new Date().toISOString(); const p=spawnSync(exe,args,{cwd,encoding:'utf8',env:{...process.env,npm_config_cache:join(out,'npm-cache')}});
 writeFileSync(join(out,label+'.log'),p.stdout+'\n'+p.stderr);
 commands.push({command:[exe,...args],cwd,start,end:new Date().toISOString(),exit:p.status,signal:p.signal,log:label+'.log'});
 writeFileSync(join(out,'commands.json'),JSON.stringify(commands,null,2)+'\n');
 assert.equal(p.status,0,label+'; raw log retained');
 assert.deepStrictEqual(snap(),before,label+' source stability');
 return p.stdout;
}
const stage=join(out,'packages');mkdirSync(stage);
for(const name of ['contracts','work-kernel']){
 const pkg=join(stage,name);mkdirSync(pkg);
 command(process.execPath,[join(repo,'node_modules/typescript/bin/tsc'),'-p',join(repo,'packages',name,'tsconfig.json'),'--outDir',join(pkg,'dist')],repo,name+'-emit');
 const manifest=JSON.parse(readFileSync(join(repo,'packages',name,'package.json'),'utf8'));
 delete manifest.scripts;delete manifest.devDependencies;
 if(name==='work-kernel')manifest.dependencies={'@canlang/contracts':'0.1.0'};
 writeFileSync(join(pkg,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 const packed=JSON.parse(command('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',out],pkg,name+'-pack'))[0];
 assert.ok(packed.files.some(x=>x.path=== (name==='contracts'?'dist/index.js':'dist/src/index.js')));
}
const consumer=join(out,'installed');mkdirSync(consumer);
writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'can-step9-work-consumer',private:true,type:'module'})+'\n');
command('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',join(out,'canlang-contracts-0.1.0.tgz'),join(out,'canlang-work-kernel-0.1.0.tgz')],consumer,'installed-install');
const probe=`
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const resolved=import.meta.resolve('@canlang/work-kernel');
assert.ok(realpathSync(fileURLToPath(resolved)).startsWith(process.cwd()+'/node_modules/'),'installed actual package, no source aliases');
const w=await import('@canlang/work-kernel'),d=await import('@canlang/work-kernel/distribution');
assert.equal(w.WORK_KERNEL_VERSION,'0.1.0');
assert.deepEqual(w.DECISION_PROFILES,['wt.rows/v0','wt.policy/v0','wt.receipts/v0']);
assert.equal(w.validateVersions({transport:'v0',profile:'wt.rows/v0'}),null);
assert.equal(w.validateVersions({transport:'future',profile:'foreign'}).code,'unknown-transport-version');
assert.equal(w.validateVersions({transport:'v0',profile:'foreign'}).code,'unknown-profile');
assert.equal(typeof w.validateCount,'function');
assert.equal(typeof w.validatePayloadRef,'function');
assert.equal(typeof d.distribution.modules.href,'string');
for(const key of ['bootstrapWasm','wasmBackend','selectBackend','kernelCall','readSupersessionRow']) assert.equal(Object.hasOwn(w,key),false,key+' is not a public Rust consumer');
for(const path of ['@canlang/work-kernel/bindings/loader','@canlang/work-kernel/backend']) await assert.rejects(import(path),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
console.log(JSON.stringify({node:process.version,resolved,public_exports:Object.keys(w),pass: true,rust_consumer:false,profile:'installed TS facts only; no W05/W06 Rust acceptance'}));
`;
writeFileSync(join(consumer,'probe.mjs'),probe);
const stdout=command(process.execPath,['probe.mjs'],consumer,'installed-probe');
const installedPins={};
for(const name of ['contracts','work-kernel']) {
 const original=join(stage,name,'dist'),actual=join(consumer,'node_modules/@canlang',name,'dist');
 for(const path of below(original)){const rel=path.slice(original.length+1);assert.equal(sha(path),sha(join(actual,rel)));installedPins[name+'/'+rel]=sha(path);}
}
const tarballs=Object.fromEntries(['canlang-contracts-0.1.0.tgz','canlang-work-kernel-0.1.0.tgz'].map(n=>[n,sha(join(out,n))]));
const receipt={scope:'Exact-source source-emitted installed work TS facts readiness ONLY',accepted_profile:'No new Rust backend consumer',private_manifest_normalization:{changes:['scripts and devDependencies removed','work contracts workspace:* resolved to 0.1.0'],limits:'Dist is exact source emit; installed manifest differs from source, so unchanged release-manifest qualification is excluded'},limits:['Native 315/93 accepted unchanged candidate reused separately','No W05 Wasm wrapper/glue/loader/backend selection','No W06 state/Cloudflare producer selects Rust','No W07 whole-flow measurement or W08 persisted swap rollback'],source_sha256:before,source_stable:true,installed_sha256:installedPins,tarballs,probe:JSON.parse(stdout.trim()),commands,private_root:out};
writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({pass:true,profile:receipt.scope,installed_files:Object.keys(installedPins).length,commands:commands.length}));
