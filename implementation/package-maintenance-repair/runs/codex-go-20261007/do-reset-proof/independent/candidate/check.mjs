import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root=process.cwd();
const mf=new Miniflare({modules:true,modulesRoot:root,scriptPath:root+'/test/storage/do-test-worker.js',modulesRules:[{type:'ESModule',include:['**/*.js']}],compatibilityDate:'2025-01-01',durableObjects:{TEST_DO:{className:'TestDO',useSQLite:true,unsafePreventEviction:true}}});
const result={runtime:{node:process.version,execPath:process.execPath,argv:process.argv},events:[],disposed:false};
async function post(path,body){const res=await mf.dispatchFetch('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await res.json();assert.equal(data.ok,true,JSON.stringify(data));result.events.push({path,body,data});return data;}
async function call(method,...args){return (await post('/call',{method,args})).value;}
try {
 await post('/reset',{});
 const sample=(id,error,revision,at)=>({expectedRevision:revision,migrationId:id,leg:'staging',priorPhase:'staging',stagedCursor:null,publishCursor:null,error,at});
 assert.deepEqual(await call('recordMigrationFailure',sample('audit-A','one',0,111)),{revision:1});
 assert.deepEqual(await call('recordMigrationFailure',sample('audit-B','two',1,222)),{revision:2});
 const a=await call('readMigrationFailure','audit-A'),b=await call('readMigrationFailure','audit-B');
 assert.deepEqual(await call('discardStagedRows',{expectedRevision:2,migrationId:'audit-A'}),{revision:3});
 assert.deepEqual(await call('readMigrationFailure','audit-A'),a);
 assert.deepEqual(await call('readMigrationFailure','audit-B'),b);
 await post('/reset',{});
 assert.equal(await call('readRevision'),0);
 const count=(await post('/exec',{sql:'SELECT COUNT(*) AS n FROM migration_failures'})).rows;
 result.postResetFailures=count;
 assert.deepEqual(count,[{n:0}],'fixture reset must clear every retained migration-failure audit');
 assert.equal(await call('readMigrationFailure','audit-A'),null);
 assert.equal(await call('readMigrationFailure','audit-B'),null);
 assert.deepEqual(await call('recordMigrationFailure',sample('audit-B','replacement',0,333)),{revision:1});
 const replacement=await call('readMigrationFailure','audit-B');
 assert.equal(replacement.error,'replacement');assert.equal(replacement.at,333);assert.equal(replacement.revision,1);
 await post('/reset',{});assert.equal(await call('readMigrationFailure','audit-B'),null);
 result.passed=true;
} finally { await mf.dispose();result.disposed=true;fs.writeFileSync(root+'/result.json',JSON.stringify(result,null,2)+'\n'); }
