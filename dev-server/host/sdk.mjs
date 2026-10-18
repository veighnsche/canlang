// Direct SDK/defining-library methods. Development plans and assertions live in Rust.
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {readFileSync,openSync,fstatSync,writeSync,closeSync,constants} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
const bootstrapRequire=createRequire(process.env.CAN_INSTALL_ROOT?join(process.env.CAN_INSTALL_ROOT,'package.json'):process.env.CAN_TOOL_ROOT?join(process.env.CAN_TOOL_ROOT,'lib/package.json'):import.meta.url);
function owner(entry){let path=dirname(entry);for(;;){try{const m=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));if(typeof m.name==='string'&&typeof m.version==='string')return path;}catch{}const parent=dirname(path);if(parent===path)throw Error('SDK package owner missing');path=parent;}}
const cf=owner(bootstrapRequire.resolve('@canlang/cloudflare/worker/main'));
const require=createRequire(join(cf,'package.json'));
const sdk=specifier=>import(pathToFileURL(require.resolve(specifier)).href);
const module=path=>import(pathToFileURL(join(cf,'dist',path)).href);
export const COMMANDS=['node.resolve','runtime.constants','metadata.parse','mf.create','mf.dispose','mf.scheduled','d1.query','r2.put','r2.get','r2.delete','identity.ensureSchema','identity.createTeam','identity.createUser','identity.createMembership','identity.findUserByEmail','identity.findTeamById','identity.setMemberRole','identity.hashPassword','identity.csrf','identity.resolve','state.ensureSchema','state.ownerScoped','state.hashInputs','semantic.activate','semantic.appDefinition','bundle.build','bundle.assert','testkit.load','testkit.row','testkit.stage','testkit.report','testkit.dispose','browser.executable','browser.launch','browser.newContext','browser.newPage','browser.goto','browser.request','browser.cookies','browser.locator','browser.submit','browser.title','browser.close'];
function binary(value){
  if(typeof value==='string')return Buffer.from(value,'base64');
  const bytes=Array.isArray(value)?value:value?.type==='Buffer'?value.data:undefined;
  if(!Array.isArray(bytes)||bytes.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('SDK binary argument invalid');
  return Buffer.from(bytes);
}
function wire(value){return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item instanceof Uint8Array?{type:'Buffer',data:[...item]}:item));}
async function boundedBody(request,limit){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1024*1024)throw Error('invalid SDK body bound');
  if(request.body===null)return Buffer.alloc(0);
  const reader=request.body.getReader(),chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();return null;}chunks.push(value);}return Buffer.concat(chunks,length);}
  finally{reader.releaseLock();}
}
function appendPrivate(path,text){
  const fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  try{const info=fstatSync(fd);if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)!==0)throw Error('SDK sink ownership refused');const bytes=Buffer.from(text);let offset=0;while(offset<bytes.length){const size=writeSync(fd,bytes,offset,bytes.length-offset);if(size===0)throw Error('SDK sink write made no progress');offset+=size;}}
  finally{closeSync(fd);}
}

export async function createApi(registry){
  const {Miniflare}=await sdk('miniflare');
  const identity=await sdk('@canlang/identity'),state=await sdk('@canlang/state/storage/d1');
  const router=await sdk('@canlang/state/storage/owner-router'),work=await sdk('@canlang/work/recovery');
  const migration=await sdk('@canlang/state/migration/activate'),replay=await sdk('@canlang/state/invocation/replay');
  const contracts=await sdk('@canlang/contracts'),stamp=await module('release/stamp.js');
  const {buildOwnedDeployBundleWithAssets}=await module('deploy/owned-bundle.js');
  const bundle=await module('deploy/bundle.js'),activation=await module('deploy/activate.js');
  const installed=await module('deploy/installed.js'),assembly=await module('runtime/modules.js');
  const {parse}=await sdk('acorn');
  const {allocate,find,dispose,tracked}=registry;
  const resource=(parent,p)=>find(parent,p.handle,'mf');
  const database=async(parent,p)=>resource(parent,p).value.getD1Database(p.binding,p.workerName);
  const store=async(parent,p)=>identity.createD1IdentityStore(await database(parent,p));
  const browsers=await import('./browser.mjs');
  return async function api(command,p,parent,signal){
    signal.throwIfAborted();
    switch(command){
      case 'node.resolve':{
        const resolveOne=request=>{
          const selected=request.from?createRequire(join(request.from,'package.json')):require;
          try{return {path:selected.resolve(request.specifier),absent:false};}
          catch(error){if(error.code==='MODULE_NOT_FOUND'&&error.message.split('\n',1)[0]===`Cannot find module '${request.specifier}'`)return {absent:true};throw error;}
        };
        if(p.requests===undefined)return resolveOne(p);
        if(!Array.isArray(p.requests)||p.requests.length>512)throw Error('invalid resolver batch');
        return {results:p.requests.map(request=>{try{return resolveOne(request);}catch(error){return {error:{code:String(error.code??'RESOLVE_FAILED').slice(0,128),message:String(error.message).slice(0,4096)}};}})};
      }
      case 'runtime.constants':return {releaseVersion:stamp.RELEASE_VERSION,contractsVersion:contracts.CONTRACTS_VERSION,nodePath:process.execPath,hostPath:fileURLToPath(new URL('./entry.mjs',import.meta.url))};
      case 'metadata.parse':return wire(parse(p.source,{ecmaVersion:'latest',sourceType:'module'}));
      case 'mf.create':{
        const entry=allocate(parent,p.handle,'mf');entry.workerName=p.workerName;entry.secret=p.secret;
        const options=structuredClone(p.options);
        for(const worker of options.workers??[])for(const item of Array.isArray(worker.modules)?worker.modules:[])if(item.type==='CompiledWasm')item.contents=binary(item.contents);
        if(p.analytics){
          const target=options.workers.find(w=>w.name===p.analytics.worker);if(!target)throw Error('analytics SDK worker missing');
          target.serviceBindings??={};
          target.serviceBindings.CAN_ANALYTICS_SINK=async request=>{
            try{
              const dataset=request.headers.get('x-dataset'),worker=request.headers.get('x-worker');
              if(!p.analytics.datasets.includes(dataset)||!p.analytics.workers.includes(worker))return new Response(null,{status:403});
              const length=Number(request.headers.get('content-length')??0);if(length>p.analytics.maxBodyBytes)return new Response(null,{status:413});
              const bytes=await boundedBody(request,p.analytics.maxBodyBytes);if(bytes===null)return new Response(null,{status:413});
              const {point}=JSON.parse(bytes);const path=p.analytics.sinkPaths[dataset];
              appendPrivate(path,JSON.stringify({dataset,workerName:worker,timestamp:new Date().toISOString(),point})+'\n');
              return new Response(null,{status:204});
            }catch(error){entry.analyticsError??=error;return new Response(null,{status:500});}
          };
        }
        entry.value=new Miniflare(options);
        try{const ready=await entry.value.ready;return {handle:p.handle,backend:{origin:ready.origin,header:'x-can-local-dispatch',secret:p.secret,urlHeader:'x-can-local-url'}};}
        catch(error){entry.startupError=error;throw error;}
      }
      case 'mf.dispose':await dispose(resource(parent,p));return {released:true};
      case 'mf.scheduled':{const entry=resource(parent,p);return tracked(entry,async()=>{const worker=await entry.value.getWorker(p.workerName);return worker.scheduled({scheduledTime:new Date(p.scheduledTime??Date.now()),cron:p.cron});});}
      case 'd1.query':{const db=await database(parent,p);const statement=db.prepare(p.sql).bind(...(p.params??[]));if(!['all','first','run','raw'].includes(p.mode))throw Error('unknown D1 API method');return statement[p.mode]();}
      case 'r2.put':{const bucket=await resource(parent,p).value.getR2Bucket(p.binding,p.workerName);await bucket.put(p.key,p.bytes===undefined?p.value:binary(p.bytes));return null;}
      case 'r2.get':{const bucket=await resource(parent,p).value.getR2Bucket(p.binding,p.workerName),value=await bucket.get(p.key);return value===null?null:p.bytes===true?{bytes:wire(new Uint8Array(await value.arrayBuffer()))}:value.text();}
      case 'r2.delete':{const bucket=await resource(parent,p).value.getR2Bucket(p.binding,p.workerName);await bucket.delete(p.key);return null;}
      case 'identity.hashPassword':return identity.hashPassword(p.password);
      case 'identity.csrf':{const token=identity.parseSessionCookie(p.cookie);if(token===null)throw Error('session cookie is unavailable');return {csrf:await identity.deriveCsrfToken(token)};}
      case 'identity.ensureSchema':await identity.ensureIdentitySchema(await database(parent,p));return null;
      case 'identity.createTeam':return (await store(parent,p)).createTeam(p.input);
      case 'identity.createUser':return (await store(parent,p)).createUser(p.input);
      case 'identity.createMembership':return (await store(parent,p)).createMembership(p.input);
      case 'identity.findUserByEmail':return (await store(parent,p)).findUserByEmail(p.input?.email??p.email);
      case 'identity.findTeamById':return (await store(parent,p)).findTeamById(p.input?.teamId??p.input?.team_id??p.teamId??p.team_id);
      case 'identity.setMemberRole':return identity.setMemberRole(await store(parent,p),p.input.request,p.input.authority);
      case 'identity.resolve':{const token=identity.parseSessionCookie(p.cookie);if(token===null)throw Error('session cookie is unavailable');return identity.resolveIdentity(await store(parent,p),{session_token:token});}
      case 'state.ensureSchema':await state.ensureSchema(await database(parent,p));return null;
      case 'state.ownerScoped':{const db=await database(parent,p);const port=router.createD1OwnerRouter({resolveBinding:requested=>requested.app===p.app&&requested.owner===p.owner?{app:p.app,owner:p.owner,db,initializeFresh:p.initializeFresh}:null});await port.ownerScopedStoragePort({app:p.app,owner:p.owner});return null;}
      case 'state.hashInputs':return {hash:await replay.hashInputs(p.inputs)};
      case 'semantic.activate':{
        const artifact=JSON.parse(p.artifactJson),db=await database(parent,p);
        const capability=installed.probeInstalledRuntime({},p.installed);
        return activation.activate({artifact,descriptor:p.descriptor,environment:p.environment,installed:capability,store:state.createD1Storage(db),inventory:{...p.inventory,handlerContractFor:()=>null},gates:{buildWorkInventory:work.buildWorkInventory,checkActivationInventory:migration.checkActivationInventory}});
      }
      case 'semantic.appDefinition':{
        if(typeof p.workDir!=='string')throw Error('native assembly directory required');
        const artifact=JSON.parse(p.artifactJson),assembled=await assembly.assembleModules({artifact,sourcePath:p.sourcePath},{workDir:p.workDir,stdlibUrl:pathToFileURL(join(cf,'dist/runtime/stdlib.js')).href});
        const entry=await assembly.importVerifiedAssemblyModule(assembled,artifact.modules[0].path,artifact),definition=entry.appDefinition;
        return {policy:{roles:definition?.policy?.roles??[]},packages:Object.fromEntries(Object.entries(definition?.packages??{}).map(([name,value])=>[name,{roles:Object.fromEntries(Object.entries(value.roles??{}).map(([short,role])=>[short,{id:role.id}]))}]))};
      }
      case 'bundle.build':{
        const artifact=JSON.parse(p.artifactJson);
        const built=await buildOwnedDeployBundleWithAssets(artifact,{verdict:p.verdict,assets:p.assets,esbuildBinaryPath:p.esbuildBinaryPath,signal});
        return wire({bundle:built,generatedResources:bundle.generatedStyleResources(artifact)});
      }
      case 'bundle.assert':bundle.assertWorkerdLoadable(p.modules);bundle.assertLinksResolve(p.modules,p.binaryKeys);return null;
      case 'testkit.load':{
        const entry=allocate(parent,p.suite,'suite');const kit=await module('runtime/example-bindings.js');
        entry.value=await kit.loadExampleBindings({...p.input,artifactBytes:binary(p.input.artifactBytes)},p.moduleIndex);return entry.value.metadata;
      }
      case 'testkit.row':{
        const suite=find(parent,p.suite,'suite'),runtime=find(parent,p.handle,'mf');
        return tracked(suite,()=>suite.value.row(p.row,{getD1Database:binding=>runtime.value.getD1Database(binding,runtime.workerName)},p.resources));
      }
      case 'testkit.stage':{
        const runtime=find(parent,p.handle,'mf'),kit=await module('runtime/example-bindings.js');
        return kit.stageClosureFixtures({...p.input,artifactBytes:binary(p.input.artifactBytes)},{getD1Database:binding=>runtime.value.getD1Database(binding,runtime.workerName)},p.databases);
      }
      case 'testkit.report':return (await module('runtime/example-bindings.js')).buildExampleReport(p.applicationRoot,p.artifactDigest,p.sourceRevision,p.cases);
      case 'testkit.dispose':await dispose(find(parent,p.suite,'suite'));return {released:true};
      default:if(command.startsWith('browser.'))return browsers.call(command,p,parent,signal,{...registry,require});throw Error('unknown fixed SDK call');
    }
  };
}
