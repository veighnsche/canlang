/** Minimal recovered TableTime constructor reproduction; Memory host scope. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommitBatch, CompileArtifact, MutationEnvelope } from '@canlang/contracts';
import { createGrantFixture, createTestDeps } from '@canlang/interfaces/testing';
import { resolveIdentity } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { distribution } from '@canlang/values/distribution';
import { decodeValue } from '@canlang/values';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';

const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const app='TableTime',calendar=asModel(`${app}.Calendar`),window=asModel(`${app}.Window`);

test('genuine compiled TableTime seed constructs a contained Window from its admitted Calendar',
  {timeout:120000},async()=>{
    const source=fileURLToPath(new URL('./fixtures/native-contained-create.can',import.meta.url));
    const compiler=join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
    const paths=[source,compiler,catalog],hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const hashes=await Promise.all(paths.map(async path=>hash(await readFile(path))));
    const dir=await mkdtemp(join(tmpdir(),'can-native-contained-create-'));
    try {
      const env={...process.env};delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,originalArtifact=JSON.stringify(artifact);
      assert.equal(artifact.artifact_version,1);
      assert.ok(artifact.sources.some(value=>resolve(value.path)===source&&value.sha256===hashes[0]));
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      const loaded=await loadCanonicalDescriptors(asm,artifact);
      assert.deepEqual(loaded.models.map(model=>model.name).sort(),[calendar,window]);
      assert.equal((loaded.containment.get(window) as {parent?:string}|undefined)?.parent,calendar);
      assert.deepEqual(loaded.secretFields.get(calendar),[]);assert.deepEqual(loaded.secretFields.get(window),[]);
      // Retain the recovered first setup: real fixture Identity grant resolved
      // through MCP, with its actual admitted instant and Memory State.
      const fixture=await createTestDeps(),grant=await createGrantFixture(fixture.identity);
      const identity=await resolveIdentity(fixture.identity.store,{mcp_grant_token:grant.token});
      assert.equal(identity.actor?.user_id,fixture.identity.userId);assert.equal(identity.team?.team_id,fixture.identity.teamId);
      const instant=Date.parse(identity.admitted_at);assert.ok(Number.isFinite(instant));
      let sequence=0;const nextId=()=>uuidv7(instant,++sequence);
      const {store,probe}=createTestMemoryStorage();
      const commits: CommitBatch[] = [], commit=store.commit;
      store.commit=async batch=>{const result=await commit.call(store,batch);commits.push(batch);return result;};
      const invoker=buildInvoker(artifact,asm,store,{appId:app,memberships:fixture.identity.store,now:()=>instant});
      const parentEnvelope={operation:`${calendar}.create`,operation_id:nextId(),inputs:{title:'Real admitted calendar'}};
      const parentResult=await invoker.invokeMutation(parentEnvelope,identity);
      assert.ok('result' in parentResult,JSON.stringify(parentResult));assert.equal(parentResult.result.status,'committed');
      const parents=await store.query({model:calendar,authority:'owner'});assert.equal(parents.length,1);
      const parent=parents[0]!;assert.equal(parent.id,parentEnvelope.operation_id);assert.equal(parent.version,1);
      assert.deepEqual(parent.data,{title:'Real admitted calendar'});assert.equal(parent.parent??null,null);
      const from=new Date(instant-60000).toISOString();
      const seed={operation:`${app}.seed`,operation_id:nextId(),inputs:{calendar:{id:parent.id,version:'1'},from,state:'closed'}};
      const receiptIdentity=(operation:string,operationId:string)=>({app,owner:fixture.identity.teamId,
        principal:fixture.identity.userId,operation:asOperation(operation),operationId:asOperationId(operationId)});
      const additionalReceipts: {operation:string;operationId:string}[]=[];
      const resources=async()=>{
        const rows=await Promise.all([calendar,window].map(model=>store.query({model,authority:'owner',archived:'include'})));
        return {revision:await store.readRevision(),rows,
          history:rows.flatMap((values,index)=>values.map(row=>probe.historyFor(index===0?calendar:window,row.id))),
          parentReceipt:await store.readReceipt(receiptIdentity(parentEnvelope.operation,parentEnvelope.operation_id)),
          seedReceipt:await store.readReceipt(receiptIdentity(seed.operation,seed.operation_id)),
          additionalReceipts:await Promise.all(additionalReceipts.map(value=>store.readReceipt(receiptIdentity(value.operation,value.operationId)))),
          outbox:probe.outboxAll(),schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100),
          membership:await fixture.identity.store.findMembership(fixture.identity.teamId,fixture.identity.userId)};
      };
      const before=await resources(),revision=await store.readRevision();
      const outcome=await invoker.invokeMutation(seed,identity);
      assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
      assert.equal(await store.readRevision(),revision+1);
      const children=await store.query({model:window,authority:'owner'});assert.equal(children.length,1);
      const child=children[0]!;assert.equal(child.version,1);
      assert.deepEqual(child.parent,{model:calendar,id:parent.id});
      assert.deepEqual(Object.keys(child.data).sort(),['available','from','rank','state','until']);
      assert.equal(Object.hasOwn(child.data,'parent'),false,'containment is framework metadata rather than business data');
      assert.equal(child.data.from,from);assert.equal(child.data.until,from);
      assert.deepEqual(decodeValue('datetime',child.data.from),decodeValue('datetime',from));
      assert.deepEqual(decodeValue('datetime',child.data.until),decodeValue('datetime',from));
      assert.equal(decodeValue('bool',child.data.available),true);
      assert.equal(decodeValue('int',child.data.rank),1n);assert.equal(child.data.state,'closed');
      assert.equal(child.created,instant);assert.equal(child.createdBy,fixture.identity.userId);
      assert.deepEqual(await store.load(calendar,parent.id),parent,'child creation preserves admitted parent version and fields');
      const history=probe.historyFor(window,child.id);assert.equal(history.length,1);
      assert.equal(history[0]!.model,window);assert.equal(history[0]!.recordId,child.id);
      assert.equal(history[0]!.change,'create');assert.equal(history[0]!.version,1);
      assert.equal(history[0]!.actor,fixture.identity.userId);assert.equal(history[0]!.operation,seed.operation);
      assert.equal(history[0]!.operationId,seed.operation_id);assert.equal(history[0]!.before,null);
      assert.deepEqual(history[0]!.after,child.data);
      assert.deepEqual(history[0]!.auditProjection,{created:instant,createdBy:fixture.identity.userId,secretFields:[]});
      const committed=await resources();assert.ok(committed.seedReceipt);
      assert.deepEqual(committed.parentReceipt,before.parentReceipt);assert.deepEqual(committed.membership,before.membership);
      assert.deepEqual(committed.outbox,before.outbox);assert.deepEqual(committed.schedules,before.schedules);
      // The recovered void source has no saved-result association. Its receipt
      // remains durable, while replay content is withheld without reexecuting.
      const replay=await invoker.invokeMutation(seed,identity);assert.ok('error' in replay,JSON.stringify(replay));
      assert.equal(replay.error.code,'validation');
      assert.match(replay.error.message,/Saved scenario has no supported execution association/);
      assert.deepEqual(await resources(),committed,'saved seed replay has no effects');

      // This distinct supplementary authored scenario does not change the
      // recovered seed: its own staged parent update must precede its child.
      const supplementary:MutationEnvelope={operation:`${app}.update_parent_then_seed`,operation_id:nextId(),
        inputs:{calendar:{id:parent.id,version:'1'},from,state:'open'}};
      additionalReceipts.push({operation:supplementary.operation,operationId:supplementary.operation_id});
      const beforeSupplementary=await resources();
      const staged=await invoker.invokeMutation(supplementary,identity);
      assert.ok('result' in staged,JSON.stringify(staged));assert.equal(staged.result.status,'committed');
      const stagedParent=await store.load(calendar,parent.id);assert.ok(stagedParent);
      assert.equal(stagedParent.version,2);assert.deepEqual(stagedParent.data,{title:'Supplementary staged parent'});
      const stagedChildren=await store.query({model:window,authority:'owner'});assert.equal(stagedChildren.length,2);
      const added=stagedChildren.filter(row=>row.id!==child.id);assert.equal(added.length,1);
      const stagedChild=added[0]!;
      assert.deepEqual(stagedChild.parent,{model:calendar,id:parent.id});
      assert.deepEqual(stagedChild.data,{from,until:from,state:'open',available:false,rank:'2'});
      assert.equal(Object.hasOwn(stagedChild.data,'parent'),false);
      assert.deepEqual(await store.load(window,child.id),child);
      const stagedBatch=commits.at(-1)!;
      assert.deepEqual(stagedBatch.history.map(entry=>[entry.model,entry.recordId,entry.change,entry.version]),
        [[calendar,parent.id,'update',2],[window,stagedChild.id,'create',1]]);
      assert.deepEqual(stagedBatch.history[0]!.before,parent.data);
      assert.deepEqual(stagedBatch.history[0]!.after,stagedParent.data);
      assert.deepEqual(stagedBatch.history[1]!.after,stagedChild.data);
      for(const entry of stagedBatch.history){assert.equal(entry.operation,supplementary.operation);assert.equal(entry.operationId,supplementary.operation_id);}
      const afterSupplementary=await resources();
      assert.equal(afterSupplementary.revision,beforeSupplementary.revision+1);
      const supplementaryReceipt=afterSupplementary.additionalReceipts[0];assert.ok(supplementaryReceipt);
      assert.equal(supplementaryReceipt.outcome.status,'committed');
      assert.equal(supplementaryReceipt.committedRevision,afterSupplementary.revision);
      assert.deepEqual(afterSupplementary.parentReceipt,beforeSupplementary.parentReceipt);
      assert.deepEqual(afterSupplementary.seedReceipt,beforeSupplementary.seedReceipt);
      assert.deepEqual(afterSupplementary.membership,beforeSupplementary.membership);
      assert.deepEqual(afterSupplementary.outbox,beforeSupplementary.outbox);assert.deepEqual(afterSupplementary.schedules,beforeSupplementary.schedules);
      const supplementaryReplay=await invoker.invokeMutation(supplementary,identity);assert.ok('error' in supplementaryReplay,JSON.stringify(supplementaryReplay));
      assert.equal(supplementaryReplay.error.code,'validation');assert.deepEqual(await resources(),afterSupplementary);
      const refuseSeed=async(label:string,reference:{id:string;version:string})=>{
        const envelope:MutationEnvelope={operation:seed.operation,operation_id:nextId(),inputs:{calendar:reference,from,state:'closed'}};
        additionalReceipts.push({operation:envelope.operation,operationId:envelope.operation_id});
        const beforeRefusal=await resources(),beforeCommits=commits.length;
        const refused=await invoker.invokeMutation(envelope,identity);assert.ok('error' in refused,`${label}: ${JSON.stringify(refused)}`);
        const afterRefusal=await resources();
        assert.deepEqual(afterRefusal.rows,beforeRefusal.rows,label);assert.deepEqual(afterRefusal.history,beforeRefusal.history,label);
        assert.deepEqual(afterRefusal.outbox,beforeRefusal.outbox,label);assert.deepEqual(afterRefusal.schedules,beforeRefusal.schedules,label);
        assert.deepEqual(afterRefusal.membership,beforeRefusal.membership,label);
        assert.deepEqual(afterRefusal.parentReceipt,beforeRefusal.parentReceipt);assert.deepEqual(afterRefusal.seedReceipt,beforeRefusal.seedReceipt);
        assert.deepEqual(afterRefusal.additionalReceipts.slice(0,-1),beforeRefusal.additionalReceipts.slice(0,-1));
        const receipt=afterRefusal.additionalReceipts.at(-1);
        if(receipt!==null&&receipt!==undefined){
          assert.equal(receipt.outcome.status,'rejected');assert.ok(receipt.outcome.status==='rejected');
          assert.equal(receipt.outcome.code,refused.error.code);assert.equal(afterRefusal.revision,beforeRefusal.revision+1);
          assert.equal(commits.length,beforeCommits+1);
          const rejection=commits.at(-1)!;assert.deepEqual(rejection.writes,[]);assert.deepEqual(rejection.history,[]);assert.deepEqual(rejection.outbox,[]);
        }else{assert.equal(afterRefusal.revision,beforeRefusal.revision);assert.equal(commits.length,beforeCommits);}
      };
      await refuseSeed('stale admitted Calendar',{id:parent.id,version:'1'});
      await refuseSeed('missing Calendar',{id:nextId(),version:'1'});
      await refuseSeed('existing Window cannot satisfy Calendar input',{id:child.id,version:'1'});
      const read=await invoker.invokeRead({operation:`${window}.read`,inputs:{}},identity);
      assert.ok('result' in read,JSON.stringify(read));
      assert.ok(typeof read.result==='object'&&read.result!==null&&'records' in read.result);
      assert.equal((read.result.records as readonly unknown[]).length,2);
      const member=await fixture.identity.store.findMembership(fixture.identity.teamId,fixture.identity.userId);assert.ok(member);
      await fixture.identity.store.removeMembership(member.membership_id);
      const revoked=await resources();
      const denied=await invoker.invokeRead({operation:`${window}.read`,inputs:{}},identity);
      assert.ok('result' in denied,JSON.stringify(denied));
      assert.ok(typeof denied.result==='object'&&denied.result!==null&&'records' in denied.result);
      assert.deepEqual(denied.result.records,[],'current membership gates the contained model read');
      assert.deepEqual(await resources(),revoked);
      await refuseSeed('current membership revoked',{id:parent.id,version:'2'});
      await fixture.identity.store.reactivateMembership(member.membership_id,{is_owner:member.is_owner,roles:member.roles});
      const archive:MutationEnvelope={operation:`${calendar}.delete`,operation_id:nextId(),inputs:{record:{id:parent.id,version:'2'}}};
      additionalReceipts.push({operation:archive.operation,operationId:archive.operation_id});
      const archived=await invoker.invokeMutation(archive,identity);assert.ok('result' in archived,JSON.stringify(archived));
      assert.equal(archived.result.status,'committed');
      const archivedParent=await store.load(calendar,parent.id);assert.ok(archivedParent);assert.notEqual(archivedParent.archivedAt,null);
      await refuseSeed('archived Calendar cannot receive original seed',{id:parent.id,version:String(archivedParent.version)});
      assert.equal(JSON.stringify(artifact),originalArtifact);
      assert.deepEqual(await Promise.all(paths.map(async path=>hash(await readFile(path)))),hashes);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
