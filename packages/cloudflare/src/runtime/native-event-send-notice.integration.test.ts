/** A private due Work source carries its original typed event row into a guarded SEND. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { bindScenarioReceiptFrameworkProducer, invoke as invokeState, observeScenarioReceiptIntrinsic, type ScenarioReceiptFrameworkProducer } from '@canlang/state/invocation';
import { isGeneratedOperationDef } from '@canlang/state/invocation/registry';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity,sha256HexText } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, createWorkerDispatchJoinPort, driveDispatchIntentWithPreclaim,
  invokeDueScheduleCanonical, loadCanonicalDescriptors, loadDispatchSystemProducers, withDispatchJoinPort } from './invoke.js';
import { assembleModules } from './modules.js';
import { assembleDispatchCommands, buildInvoker } from '../worker/assembly.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/agreements-notice-transport-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

it('runs the original notice Rule with the due event Term and its owner parent',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-event-notice-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js',import.meta.url).href,
        uiUrl: import.meta.resolve('@canlang/ui') });
      assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'), 'the original handler Rule is emitted');

      const ready = { active: true, executed: true, snapshot: 'Signed lease', terminated: false,
        expired: false, suppressed: false, revision: '1', changeRow: false,
        tamperLocale: false, expected: 0 };
      for (const testCase of [
        { ...ready, name: 'current', expected: 1 },
        { ...ready, name: 'stale revision', revision: '2' },
        { ...ready, name: 'not executed', executed: false },
        { ...ready, name: 'no signed snapshot', snapshot: null },
        { ...ready, name: 'terminated', terminated: true },
        { ...ready, name: 'expired', expired: true },
        { ...ready, name: 'suppressed', suppressed: true },
        { ...ready, name: 'inactive parent', active: false },
        { ...ready, name: 'changed Term after scheduling', changeRow: true },
        { ...ready, name: 'mutated app locale', tamperLocale: true },
      ]) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'NoticeProbe', owner: team.team_id, ownerPackage: 'agreements' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'notice-state', fileStoreId: 'notice-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const agreementId = asId('agreement-1'), termId = asId('term-1');
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: asModel('agreements.Agreement'),
            row: { ...makeRow({ id: agreementId, data: { email: 'owner@example.test', active: testCase.active } }), parent: null } },
          { kind: 'insert', model: asModel('agreements.Term'),
            row: { ...makeRow({ id: termId, data: { executed: testCase.executed,
              snapshot: testCase.snapshot === null ? null : { title: testCase.snapshot },
              terminated: testCase.terminated, expired: testCase.expired,
              notice_suppressed: testCase.suppressed } }),
              parent: { model: asModel('agreements.Agreement'), id: agreementId } } },
        ] }));
        const due = { key: 'term-1', scope, occurrenceId: 'notice-1', event: 'agreements.Notice', at: now - 1 };
        const payload = { term: { id: termId, version: '1' }, revision: testCase.revision };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'agreements.notice',
          load: (model: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(model, id),
          query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
        const loaded = await loadCanonicalDescriptors(asm, artifact);
        assert.ok(loaded.valueTypes);
        const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
          artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
          operations: new Map(), scope, verify: async () => {} });
        assert.ok(opaque);
        const declaration = opaque.event(due.event);
        const identity = await resolveIdentity(identities, { team_id: team.team_id }, { clock });
        const stageWithOrigin = async (request: typeof due & { readonly payload: Record<string, unknown> }) => {
          const first = await workSchedulePutCommand.stage(request, stageContext);
          const row = first.writes?.find(write => write.kind === 'insert' && write.model === 'work.schedule' &&
            write.row.id === request.occurrenceId);
          assert.ok(row && row.kind === 'insert');
          const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
            model: asModel('work.schedule'), row: row.row, field: 'payload', scope,
            origin: { kind: 'event-input', occurrenceId: request.occurrenceId,
              sourceOccurrence: request.occurrenceId, declaration,
              lineage: { kind: 'schedule', key: request.key, replaces: row.row.data['replaces'] as null },
              target: { kind: 'schedule' } },
            projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId },
            value: request.payload, identity });
          return workSchedulePutCommand.stage({ ...request, filePayloadOrigin }, stageContext);
        };
        if (testCase.name === 'current') {
          const beforeUnproven = await store.readRevision();
          await assert.rejects(async () => {
            const unproven = await stageWithOrigin({ ...due, key: 'unproven', occurrenceId: 'unproven-1',
              payload: { ...payload, unproven: true } });
            await store.commit(makeBatch(await store.readRevision(), {
              writes: unproven.writes ?? [], schedules: unproven.schedules ?? [],
            }));
          }, 'an extra undeclared event field cannot be installed as a due Work payload');
          assert.equal(await store.readRevision(), beforeUnproven);
          assert.equal(await store.load(asModel('work.schedule'), asId('unproven-1')), null);
        }
        const scheduled = await stageWithOrigin({ ...due, payload });
        await store.commit(makeBatch(await store.readRevision(), {
          writes: scheduled.writes ?? [], schedules: scheduled.schedules ?? [],
        }));
        if (testCase.name === 'current') {
          const forged = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
            handler: 'agreements.notice', due: { ...due, occurrenceId: 'not-the-issued-head' },
            store, identities, now: () => now });
          assert.equal(forged.status, 'refused', 'an unissued Work occurrence cannot invoke the handler');
          assert.equal(probe.outboxAll().length, 0);
        }
        if (testCase.changeRow) {
          const current = await store.load(asModel('agreements.Term'), termId);
          assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('agreements.Term'), id: current.id, expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1),
              updated: now, data: { ...current.data, terminated: true } } }] }));
        }
        if (testCase.tamperLocale) {
          const callable = artifact.callables.find(entry => entry.id === 'agreements.notice');
          assert.ok(callable);
          const generated = await import(asm.moduleUrls[callable.module]!) as {
            readonly __canlangAppDefaultLocale: string;
            readonly appDefinition: { appDefaultLocale: string };
          };
          const original = generated.appDefinition.appDefaultLocale;
          assert.equal(generated.__canlangAppDefaultLocale, original);
          generated.appDefinition.appDefaultLocale = 'nl';
          try {
            await assert.rejects(invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
              handler: 'agreements.notice', due, store, identities, now: () => now }),
            /Due handler lacks its exact private invocation\/event\/scope declaration/);
            assert.equal(probe.outboxAll().length, 0);
            assert.equal(await store.load(asModel('work.occurrence'), asId(due.occurrenceId)), null);
          } finally { generated.appDefinition.appDefaultLocale = original; }
          continue;
        }
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'agreements.notice', due, store, identities, now: () => now });
        assert.equal(result.status, 'completed', `${testCase.name}: ${JSON.stringify(result)}`);
        assert.equal(probe.outboxAll().length, testCase.expected, `${testCase.name}: outbox`);
        if (testCase.name === 'current') {
          const request = probe.outboxAll()[0]?.arguments['arguments'] as Record<string, unknown> | undefined;
          assert.equal(request?.['subject'], 'Agreement notice deadline');
          assert.equal(request?.['body'], 'Signed lease');
        }
        const notices = await store.query({ model: asModel('agreements.NoticeDelivery'), authority: 'owner' });
        assert.equal(notices.length, testCase.expected, `${testCase.name}: saved NoticeDelivery`);
        assert.equal(notices[0] === undefined ? null : String(notices[0].data['revision']),
          testCase.expected ? testCase.revision : null);
        if (testCase.name === 'current') {
          const receipt = await store.load(asModel('work.occurrence'), asId(due.occurrenceId));
          assert.ok(receipt);
          await assert.rejects(store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('work.occurrence'), id: receipt.id, expectedVersion: receipt.version,
            row: { ...receipt, version: asVersion(receipt.version + 1), updated: now,
              data: { ...receipt.data, status: 'failed', code: 'forged', message: 'forged' } },
          }] })), /direct due result differs from its genuine terminal Work receipt/,
          'a retained direct-due origin cannot authorize a different terminal status');
          const schedule = await store.load(asModel('work.schedule'), asId(due.occurrenceId));
          assert.ok(schedule);
          await assert.rejects(store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: asModel('work.schedule'), id: schedule.id, expectedVersion: schedule.version,
            row: { ...schedule, version: asVersion(schedule.version + 1), updated: now,
              data: { ...schedule.data, payload: { ...payload, revision: '2' } } },
          }] })), /original scheduled event payload cannot change/,
          'a retained scheduled event header cannot authorize changed payload');
          assert.equal(probe.outboxAll().length, 1);
        }
      }
      // The same retained Work/Rule journey transports a complete typed Event,
      // including an optional second model and a business revision unrelated to
      // either model's physical row version.
      const typedSource=join(root,'compiler/tests/fixtures/typed-event-send-slots.can');
      const typedOutput=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,typedSource],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const typedArtifact=JSON.parse(typedOutput.stdout) as CompileArtifact;
      assert.deepEqual('diagnostics' in typedArtifact?typedArtifact.diagnostics:[],[]);
      const baseTypedAsm=await assembleModules({artifact:typedArtifact,sourcePath:typedSource},{workDir:join(directory,'typed-slots'),
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['published-null','swap-open','swap-null','swap-closed','stale-business','cancelled','revoked-recipient','unissued-head','wrong-slot','withheld-census','wrong-model','identity-race','parent-race','dispatch-stale','dispatch-revoked','dispatch-swap-closed'] as const) {
        const typedAsm=['wrong-slot','withheld-census','wrong-model'].includes(mode)
          ? await assembleModules({artifact:typedArtifact,sourcePath:typedSource},{workDir:join(directory,`typed-slots-${mode}`),
            stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')}) : baseTypedAsm;
        const now=Date.parse('2099-01-01T12:00:00Z'),clock=createFrozenClock(now);
        const identities=createMemoryIdentityStore({clock});
        const team=await identities.createTeam({timezone:'UTC'});
        const recipient=await identities.createUser({email:'typed-recipient@example.test',password_hash:'unused',email_verified:true});
        await identities.createMembership({team_id:team.team_id,user_id:recipient.user_id,is_owner:false,roles:[]});
        const scope={app:'TypedEventSlots',owner:team.team_id,ownerPackage:'roster'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'typed-event-state',fileStoreId:'typed-event-files',
          receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store,probe}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact:typedArtifact,asm:typedAsm,store,authority,scope,now:()=>now,
          verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:asModel('roster.Commitment'),row:{...makeRow({id:asId('commitment'),data:{revision:'7',active:mode!=='cancelled',conflict:false}}),parent:null}},
          {kind:'insert',model:asModel('roster.Duty'),row:{...makeRow({id:asId('duty'),data:{published:true}}),parent:{model:asModel('roster.Commitment'),id:asId('commitment')}}},
          {kind:'insert',model:asModel('roster.Swap'),row:{...makeRow({id:asId('swap'),data:{state:mode==='swap-closed'?'accepted':'open'}}),parent:null}},
        ]}));
        const due={key:'duty',scope,occurrenceId:'typed-notice',event:'roster.DutyNotice',at:now-1};
        const payload={duty:{id:'duty',version:'1'},recipient:{id:recipient.user_id},revision:mode==='stale-business'?'8':'7',
          kind:mode.startsWith('swap-')||mode==='dispatch-swap-closed'?'swap_request':mode==='cancelled'?'cancelled':'published',
          swap:mode==='swap-open'||mode==='swap-closed'||mode==='dispatch-swap-closed'?{id:'swap',version:'1'}:null};
        const loaded=await loadCanonicalDescriptors(typedAsm,typedArtifact);assert.ok(loaded.valueTypes);
        const opaque=await loadOpaqueFileStaging({store,inventoryOwner:scope.ownerPackage,artifact:typedArtifact,canonicalModels:loaded.models,
          valueTypes:loaded.valueTypes,operations:new Map(),scope,verify:async()=>{}});assert.ok(opaque);
        const sendRule=typedArtifact.callables.find(callable=>callable.kind==='rule' && callable.id.startsWith('roster.duty_notice.sendWhen.'));
        assert.ok(sendRule);
        const duty=await store.load(asModel('roster.Duty'),asId('duty'));assert.ok(duty);
        const lexical={eventField0:{...duty,parent:duty.parent??null,sourcePresence:{fields:Object.keys(duty.data)}},
          eventField1:payload.recipient,eventField2:payload.revision,eventField3:payload.kind,eventField4:null as unknown};
        const projection={kind:'inputs' as const,declarationId:`${sendRule.id}:send-inputs`,path:['inputs']};
        assert.deepEqual(opaque.occurrences(projection,lexical),[],'installed nullable SEND census keeps its canonical null codec');
        assert.deepEqual(opaque.occurrences(projection,{...lexical,eventField4:{id:'swap',version:'1'}}),[],
          'ordinary nullable ModelRef wire retains its existing installed census codec');
        assert.throws(()=>opaque.occurrences(projection,{...lexical,eventField4:{id:'swap',version:'1',unexpected:true}}),
          'nullable wrapper cannot bypass the original canonical ModelRef wire profile');
        assert.throws(()=>opaque.occurrences({...projection,declarationId:'foreign:send-inputs'},lexical),
          'lexical traversal still requires its exact installed original declaration');
        const declaration=opaque.event(due.event),identity=await resolveIdentity(identities,{team_id:team.team_id},{clock});
        const stageContext={actor:`schedule:${due.event}`,now,operation:'roster.duty_notice',
          load:(model:Parameters<typeof store.load>[0],id:Parameters<typeof store.load>[1])=>store.load(model,id),
          query:(spec:Parameters<typeof store.query>[0])=>store.query(spec)};
        const request={...due,payload};
        const first=await workSchedulePutCommand.stage(request,stageContext);
        const scheduledRow=first.writes?.find(write=>write.kind==='insert'&&write.model==='work.schedule');
        assert.ok(scheduledRow&&scheduledRow.kind==='insert');
        const origin=await opaque.prepare({expectedRevision:await store.readRevision(),model:asModel('work.schedule'),row:scheduledRow.row,
          field:'payload',scope,origin:{kind:'event-input',occurrenceId:due.occurrenceId,sourceOccurrence:due.occurrenceId,declaration,
            lineage:{kind:'schedule',key:due.key,replaces:scheduledRow.row.data['replaces'] as null},target:{kind:'schedule'}},
          projection:{kind:'inputs',path:[],declarationId:declaration.inputsDeclarationId},value:payload,identity});
        const scheduled=await workSchedulePutCommand.stage({...request,filePayloadOrigin:origin},stageContext);
        await store.commit(makeBatch(await store.readRevision(),{writes:scheduled.writes??[],schedules:scheduled.schedules??[]}));
        if(mode==='revoked-recipient') {
          const member=await identities.findMembership(team.team_id,recipient.user_id);assert.ok(member);
          await identities.removeMembership(member.membership_id);
        }
        let swapLoads=0,raced=false,memberRead=false;
        const membershipRead=identities.findMembership.bind(identities);
        identities.findMembership=async(teamId,userId)=>{
          const found=await membershipRead(teamId,userId);
          if(teamId===team.team_id && userId===recipient.user_id) {
            memberRead=true;
            if(found!==null && !raced && (mode==='identity-race'||mode==='parent-race')) {
              raced=true;
              if(mode==='identity-race') await identities.removeMembership(found.membership_id);
              else {
                const row=await originalLoad(asModel('roster.Commitment'),asId('commitment'));assert.ok(row);
                await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('roster.Commitment'),id:row.id,
                  expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),updated:now,data:{...row.data,revision:'8'}}}]}));
              }
            }
          }
          return found;
        };
        const originalLoad=store.load.bind(store),originalCohort=store.cohortLoad.bind(store);
        const afterRead=async(model:string,row:Awaited<ReturnType<typeof store.load>>)=>{
          if(model==='roster.Swap')swapLoads++;
          return row;
        };
        store.load=async(model,id)=>afterRead(model,await originalLoad(model,id));
        store.cohortLoad=async request=>afterRead(request.model,await originalCohort(request));
        if(mode==='wrong-slot'||mode==='withheld-census'||mode==='wrong-model') {
          const handler=typedArtifact.callables.find(callable=>callable.id==='roster.duty_notice' && callable.kind==='handler');assert.ok(handler);
          const generated=await import(typedAsm.moduleUrls[handler.module]!);
          const eventSource=generated.appDefinition.operations['roster.duty_notice'].sendGuards[0].eventSource;
          const original=eventSource.fields;
          eventSource.fields=original.map((field:Record<string,unknown>,index:number)=>index!==4?field:
            mode==='wrong-slot'?{...field,slot:'eventField0'}:mode==='wrong-model'?{...field,type:'roster.Duty?'}:{...field,modelFields:[]});
          try {
            await assert.rejects(invokeDueScheduleCanonical({asm:typedAsm,artifact:typedArtifact,app:scope.app,handler:'roster.duty_notice',due,store,identities,now:()=>now}),
              /Typed Event|Original SEND declaration inventory changed|original.*source|original.*declaration/);
          } finally {eventSource.fields=original;}
          assert.equal(probe.outboxAll().length,0,mode);
          assert.equal((await store.query({model:asModel('roster.Notice'),authority:'owner'})).length,0,mode);
          assert.equal(await store.load(asModel('work.occurrence'),asId(due.occurrenceId)),null,'forged slots never execute the original Work');
          continue;
        }
        let result:Awaited<ReturnType<typeof invokeDueScheduleCanonical>>|undefined;
        try {
          result=await invokeDueScheduleCanonical({asm:typedAsm,artifact:typedArtifact,app:scope.app,handler:'roster.duty_notice',
            due:mode==='unissued-head'?{...due,occurrenceId:'foreign-head'}:due,store,identities,now:()=>now});
        } catch(error) {
          if(mode!=='identity-race' && mode!=='parent-race') throw error;
          const failure=error as {readonly code?:unknown;readonly cause?:{readonly code?:unknown}};
          assert.ok(['forbidden','conflict'].includes(String(failure.code??failure.cause?.code)),
            'only the actual Identity/revision fence may refuse the raced handler');
        }
        if(mode==='identity-race'||mode==='parent-race') {
          assert.equal(memberRead && raced,true,'the race follows an actual recipient membership observation');
          assert.equal(probe.outboxAll().length,0,'source Identity/revision races stage no stale Mail');
          const notices=await store.query({model:asModel('roster.Notice'),authority:'owner'});
          assert.equal(notices.length,result?.status==='completed'?1:0,'a refused attempt has no partial Notice, a fresh retry may record a skipped Mail');
          continue;
        }
        assert.ok(result);
        if(mode==='unissued-head') {
          assert.equal(result.status,'refused');assert.equal(probe.outboxAll().length,0);
          assert.equal((await store.query({model:asModel('roster.Notice'),authority:'owner'})).length,0);continue;
        }
        assert.equal(result.status,'completed',mode+': '+JSON.stringify(result));
        const expected=['published-null','swap-open','cancelled','dispatch-stale','dispatch-revoked','dispatch-swap-closed'].includes(mode)?1:0;
        assert.equal(probe.outboxAll().length,expected,mode);
        const notices=await store.query({model:asModel('roster.Notice'),authority:'owner'});
        assert.equal(notices.length,1,mode);assert.equal(String(notices[0]!.data['revision']),payload.revision);
        if(payload.swap===null)assert.equal(swapLoads,0,'absent Model slot issues no Swap loads');
        await invokeDueScheduleCanonical({asm:typedAsm,artifact:typedArtifact,app:scope.app,handler:'roster.duty_notice',due,store,identities,now:()=>now});
        assert.equal(probe.outboxAll().length,expected,'actual Work replay stages no second SEND');
        assert.equal((await store.query({model:asModel('roster.Notice'),authority:'owner'})).length,1,'actual Work replay creates no second Notice');
        if(mode==='published-null'||mode==='swap-open'||mode.startsWith('dispatch-')) {
          const intent=probe.outboxAll()[0];assert.ok(intent);
          if(mode==='dispatch-revoked') {
            const member=await membershipRead(team.team_id,recipient.user_id);assert.ok(member);
            await identities.removeMembership(member.membership_id);
          } else if(mode==='dispatch-stale'||mode==='dispatch-swap-closed') {
            const model=mode==='dispatch-stale'?'roster.Commitment':'roster.Swap';
            const row=await store.load(asModel(model),asId(mode==='dispatch-stale'?'commitment':'swap'));assert.ok(row);
            await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel(model),id:row.id,
              expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),updated:now,
                data:{...row.data,...(mode==='dispatch-stale'?{revision:'8'}:{state:'accepted'})}}}]}));
          }
          const fences=await bindNativeEmailDispatchGuards({asm:typedAsm,artifact:typedArtifact,store,identities,scope,revalidateAuthority:async()=>true});
          const producers=await loadDispatchSystemProducers();
          const claim=createWorkDispatchClaimCommand((id,target)=>id===intent.intentId&&target===intent.target);
          const commands=assembleDispatchCommands({l3Commands:producers.l3Commands,
            workCommands:WORK_SYSTEM_COMMANDS.map(command=>command.name===claim.name?claim:command),stageCommands:WORK_DISPATCH_STAGE_COMMANDS});
          const joined=withDispatchJoinPort(store,await createWorkerDispatchJoinPort(store));
          let providerCalls=0;
          const dispatch=await driveDispatchIntentWithPreclaim({store:joined,intent,actor:'dispatch:roster.duty_notice',
            operation:'test.roster.duty_notice.dispatch',nowMs:()=>now+1000,nextClaimId:()=>`claim-${mode}`,maxClaimAgeMs:60000,
            claimOperationId:uuidv7(now+1000,1),recordOperationId:uuidv7(now+1000,2),
            evaluateGuard:()=>{throw new Error('original typed Event Rule was bypassed');},readStateSnapshot:()=>null,
            callProvider:async()=>{providerCalls++;return {kind:'delivered',result:null};},classifyFailure,fence:fences(intent)},
            (guard,allocator)=>{
              const guarded=createWorkDispatchClaimCommand((id,target)=>id===intent.intentId&&target===intent.target,guard,allocator);
              return producers.createSystemRegistry(commands.map(command=>command.name===claim.name?guarded:command));
            });
          assert.equal(dispatch.status,mode.startsWith('dispatch-')?'not-claimed':'recorded',mode+': '+JSON.stringify(dispatch));
          assert.equal(providerCalls,mode.startsWith('dispatch-')?0:1,'durable Rule rechecks current source and Identity before provider effects');
          if(dispatch.status==='not-claimed')assert.equal(dispatch.reason,'guard-false');
          assert.equal(probe.outboxAll().length,1,'dispatch does not stage a second original SEND');
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('reopens an exact legacy full-void File profile and rejects a changed original plan',
  { timeout: 120000 }, async () => {
    const legacySource = join(root, 'packages/cloudflare/test/fixtures/agreements-due-transport-probe.can');
    const directory = await mkdtemp(join(tmpdir(), 'can-legacy-void-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, legacySource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: legacySource }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js',import.meta.url).href,
        uiUrl: import.meta.resolve('@canlang/ui') });
      const handler = 'agreements.due';
      const callable = artifact.callables.find(entry => entry.id === handler);
      assert.ok(callable);
      const module = await import(asm.moduleUrls[callable.module]!);
      const operation = module.appDefinition.operations[handler].invocation;
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const privateLoaded = loaded.producers.registry.loadArtifactDescriptors(
        { ...artifact, operations: [operation] }, { by: () => 'owner' });
      const loadedDef = privateLoaded.registry.get(handler);
      assert.ok(loadedDef && 'descriptor' in loadedDef);
      const canonical = loadedDef.descriptor;
      assert.equal(canonical.result?.type, 'void');
      assert.deepEqual(canonical.result, operation.result);
      for (const altered of [false, true]) {
        const now = Date.now(), clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const scope = { app: 'DueProbe', owner: team.team_id, ownerPackage: 'agreements' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'due-state', fileStoreId: 'due-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        const legacyStore = { ...store, installFileReferenceInventory: async (
          input: Parameters<typeof store.installFileReferenceInventory>[0]) => {
          const request = structuredClone(input);
          const declaration = request.inventory.opaqueDeclarationSets?.[0]?.declarations.find(
            candidate => candidate.id === `${handler}:result`);
          assert.ok(declaration && declaration.profile.kind === 'void');
          const result = structuredClone(canonical.result) as Record<string, unknown>;
          if (altered) result['disclosure'] = {
            ...(result['disclosure'] as Record<string, unknown>), changedOriginalPlan: true };
          Object.assign(declaration, { profile: { kind: 'void', canonical: result,
            artifact: structuredClone(result) } });
          return store.installFileReferenceInventory(request);
        } };
        const installation = { artifact, asm, authority, scope, now: () => now,
          verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } };
        await installNativeFileInventory({ ...installation, store: legacyStore });
        const before = await store.readFileReferenceInventory(scope.ownerPackage);
        assert.ok(before);
        if (altered) {
          await assert.rejects(installNativeFileInventory({ ...installation, store }),
            /original installed declaration closure changed|storage declarations changed/);
        } else {
          await installNativeFileInventory({ ...installation, store });
          assert.deepEqual(await store.readFileReferenceInventory(scope.ownerPackage), before);
          assert.ok(loaded.valueTypes);
          const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
            artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
            operations: new Map([[handler, { canonical, artifact: operation }]]), scope,
            verify: async () => {} });
          assert.ok(opaque);
          assert.deepEqual(opaque.callable(handler).canonical.result, canonical.result);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });


it('executes Event audit formatting once in source order and retains genuine sent or skipped delivery',
  { timeout: 120000 }, async () => {
    const eventSource=join(root,'compiler/tests/fixtures/event-attendee-notice.can');
    const directory=await mkdtemp(join(tmpdir(),'can-attendee-notice-'));
    try {
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,eventSource],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:eventSource},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['confirmed','held','cancelled','stale','stale-missing-location','missing-location','location-race'] as const) {
        const now=Date.parse('2099-01-01T12:00:00Z'),clock=createFrozenClock(now);
        const identities=createMemoryIdentityStore({clock});
        const team=await identities.createTeam({timezone:'UTC'});
        const scope={app:'EventNoticeProbe',owner:team.team_id,ownerPackage:'events'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'event-state',fileStoreId:'event-files',
          receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store,probe}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        const backing={load:store.load.bind(store),cohortLoad:store.cohortLoad.bind(store),commit:store.commit.bind(store),readRevision:store.readRevision.bind(store)};
        let locationReads=0,failedNoticeCommits=0,raceAtCommit:(()=>Promise<void>)|undefined;
        Object.assign(store,{
          load:async(model:Parameters<typeof store.load>[0],id:Parameters<typeof store.load>[1])=>{if(model==='rent_catalog.Location')locationReads++;return backing.load(model,id);},
          cohortLoad:async(request:Parameters<typeof store.cohortLoad>[0])=>{if(request.model==='rent_catalog.Location')locationReads++;return backing.cohortLoad(request);},
          commit:async(batch:Parameters<typeof store.commit>[0])=>{const race=raceAtCommit;raceAtCommit=undefined;if(race!==undefined)await race();try{return await backing.commit(batch);}catch(error){if(batch.writes?.some(write=>write.model==='events.Notice'))failedNoticeCommits++;throw error;}}});
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const eventId=asId('event-1'),registrationId=asId('registration-1'),locationId=asId('location-1');
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          ...((mode==='missing-location' || mode==='stale-missing-location')?[]:[{kind:'insert' as const,model:asModel('rent_catalog.Location'),row:{...makeRow({id:locationId,data:{name:'Harbor'}}),parent:null}}]),
          {kind:'insert',model:asModel('events.Event'),row:{...makeRow({id:eventId,data:{name:'Workshop',location:{id:locationId},
            from:'2099-01-02T09:00:00.000Z',until:'2099-01-02T10:00:00.000Z',timezone:'UTC',revision:'1',cancelled:mode==='cancelled'}}),parent:null}},
          {kind:'insert',model:asModel('events.Registration'),row:{...makeRow({id:registrationId,data:{email:'guest@example.test',ticket:'TICKET-1',state:mode==='held'?'held':'confirmed'}}),parent:{model:asModel('events.Event'),id:eventId}}},
        ]}));
        const due={key:'event-notice',scope,occurrenceId:'event-notice-1',event:'events.AttendeeNotice',at:now-1};
        const payload={registration:{id:registrationId,version:'1'},kind:'confirmation',revision:mode.startsWith('stale')?'2':'1',body:'Use east entrance'};
        const stageContext={actor:`schedule:${due.event}`,now,operation:'events.attendee_notice',
          load:(model:Parameters<typeof store.load>[0],id:Parameters<typeof store.load>[1])=>store.load(model,id),query:(spec:Parameters<typeof store.query>[0])=>store.query(spec)};
        const loaded=await loadCanonicalDescriptors(asm,artifact); assert.ok(loaded.valueTypes);
        const opaque=await loadOpaqueFileStaging({store,inventoryOwner:scope.ownerPackage,artifact,canonicalModels:loaded.models,valueTypes:loaded.valueTypes,operations:new Map(),scope,verify:async()=>{}}); assert.ok(opaque);
        const declaration=opaque.event(due.event),identity=await resolveIdentity(identities,{team_id:team.team_id},{clock});
        const initial=await workSchedulePutCommand.stage({...due,payload},stageContext);
        const write=initial.writes?.find(w=>w.kind==='insert' && w.model==='work.schedule'); assert.ok(write && write.kind==='insert');
        const filePayloadOrigin=await opaque.prepare({expectedRevision:await store.readRevision(),model:asModel('work.schedule'),row:write.row,field:'payload',scope,
          origin:{kind:'event-input',occurrenceId:due.occurrenceId,sourceOccurrence:due.occurrenceId,declaration,lineage:{kind:'schedule',key:due.key,replaces:null},target:{kind:'schedule'}},
          projection:{kind:'inputs',path:[],declarationId:declaration.inputsDeclarationId},value:payload,identity});
        const scheduled=await workSchedulePutCommand.stage({...due,payload,filePayloadOrigin},stageContext);
        await store.commit(makeBatch(await store.readRevision(),{writes:scheduled.writes??[],schedules:scheduled.schedules??[]}));
        locationReads=0;
        if(mode==='location-race') {
          raceAtCommit=async()=>{const current=await backing.load(asModel('rent_catalog.Location'),locationId);assert.ok(current);
            await backing.commit(makeBatch(await backing.readRevision(),{writes:[{kind:'update',model:asModel('rent_catalog.Location'),id:locationId,expectedVersion:current.version,
              row:{...current,version:asVersion(current.version+1),data:{...current.data,name:'Changed'}}}]}));};
          const raced=await invokeDueScheduleCanonical({asm,artifact,app:scope.app,handler:'events.attendee_notice',due,store,identities,now:()=>now,deploymentBase:'https://example.test'});
          assert.equal(raced.status,'completed',JSON.stringify(raced));
          assert.equal(failedNoticeCommits,1,'the stale original Notice batch aborted before a fresh retry');
          const notices=await store.query({model:asModel('events.Notice'),authority:'owner'});
          assert.equal(notices.length,1);assert.match(String(notices[0]!.data['body']),/Workshop at Changed/);
          assert.equal(probe.outboxAll().length,1,'only the fresh retry publishes Mail');continue;
        }
        if(mode==='missing-location') {
          await assert.rejects(invokeDueScheduleCanonical({asm,artifact,app:scope.app,handler:'events.attendee_notice',due,store,identities,now:()=>now,deploymentBase:'https://example.test'}));
          assert.equal(probe.outboxAll().length,0); assert.equal((await store.query({model:asModel('events.Notice'),authority:'owner'})).length,0); continue;
        }
        const result=await invokeDueScheduleCanonical({asm,artifact,app:scope.app,handler:'events.attendee_notice',due,store,identities,now:()=>now,deploymentBase:'https://example.test'});
        assert.equal(result.status,mode.startsWith('stale')?'failed':'completed',mode+': '+JSON.stringify(result));
        if(mode.startsWith('stale'))assert.equal(locationReads,0,'false leading revision guard never reads Location');
        const notices=await store.query({model:asModel('events.Notice'),authority:'owner'});
        assert.equal(notices.length,mode.startsWith('stale')?0:1,mode);
        assert.equal(probe.outboxAll().length,mode==='confirmed'?1:0,mode);
        if(notices[0]) {assert.equal(notices[0].data['subject'],'Event ticket confirmed'); assert.match(String(notices[0].data['body']),/Workshop at Harbor/); assert.match(String(notices[0].data['body']),/https:\/\/example.test\/events/); assert.ok(notices[0].data['delivery'],'the real sent or skipped delivery remains stored');}
        const before=await store.readRevision();
        await invokeDueScheduleCanonical({asm,artifact,app:scope.app,handler:'events.attendee_notice',due,store,identities,now:()=>now,deploymentBase:'https://example.test'});
        assert.equal(await store.readRevision(),before,'terminal replay does not repeat Notice or SEND');
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });

it('refuses changed Event formatter traversal, revision guard, or ordinary business text sinks',
  {timeout:120000},async()=>{
    const sourcePath=join(root,'compiler/tests/fixtures/event-attendee-notice.can');
    const original=await readFile(sourcePath,'utf8');
    const directory=await mkdtemp(join(tmpdir(),'can-event-audit-mutants-'));
    try {
      for(const [name,before,after] of [
        ['header','require event.registration.parent.revision==event.revision','require event.registration.parent.revision>=event.revision'],
        ['traversal','notice_details(event.registration.parent.name,event.registration.parent.location.name,','notice_details(event.registration.parent.location.name,event.registration.parent.name,'],
        ['sink','subject,body,delivery} as notice','subject=event.body,body,delivery} as notice'],
      ] as const) {
        assert.equal(original.split(before).length,2,name+' has a unique owning source occurrence');
        const path=join(directory,name+'.can');await writeFile(path,original.replace(before,after));
        await assert.rejects(promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],
          {cwd:root,timeout:60000,maxBuffer:32*1024*1024}),error=>{
            const report=error as {code?:number;stdout?:string};
            assert.equal(report.code,10);assert.ok(JSON.parse(report.stdout??'{}').diagnostics.some((d:{code:string})=>d.code==='E6008'));
            return true;
          });
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });


it('observes original pre-change guards and atomically creates, sends, and routes Event changes',
  {timeout:300000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-event-change-guards-'));
    const timings: Array<{phase:string;ms:number}>=[];
    const timePhase=async<T>(phase:string,fn:()=>Promise<T>):Promise<T>=>{
      const start=Date.now();
      try{return await fn();}finally{timings.push({phase,ms:Date.now()-start});}
    };
    try {
      const original=await readFile(join(root,'compiler/tests/fixtures/event-change-retained.can'),'utf8');
      const guards=original.replace('  scenario change_schedule(','  export scenario check_change(').replace(') -> Change by=organizer',') -> int by=organizer');
      const body=guards.indexOf('   do\n',guards.indexOf('scenario check_change'));
      for(const profile of ['guards','created','retained','original'] as const){
      const create=original.split('\n').find(line=>line.startsWith('    create Change '))!.replace('account=retained?.account ?? actor','account=actor');
      const sourceText=profile==='original'?original.slice(0,original.lastIndexOf(' Then')).replace('  scenario change_schedule(','  export scenario check_change(')+'\n  scenario consume on=ApplyChange\n   do require true\n Then\n':profile==='guards'?guards.slice(0,body)+'   do\n    return 1\n Then\n':
        original.slice(0,original.indexOf('   do\n',original.indexOf('scenario change_schedule'))).replace('  scenario change_schedule(','  export scenario check_change(')+
        '   do\n'+(profile==='retained'?original.split('\n').find(line=>line.startsWith('    let retained='))!+'\n'+create.replace('account=actor','account=retained?.account ?? actor'):create)+'\n    set event {pending_change=change}\n'+(profile==='retained'?'    emit ApplyChange {change}':'    if resource==null\n     emit ApplyChange {change}\n    else\n     require false')+'\n    return change\n  scenario consume on=ApplyChange\n   do require true\n Then\n';
      const sourcePath=join(directory,profile+'.can');await writeFile(sourcePath,sourceText);
      const {stdout}=await timePhase('compile/'+profile,()=>promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,sourcePath],{cwd:root,timeout:60000,maxBuffer:32*1024*1024}));
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await timePhase('assemble/'+profile,()=>assembleModules({artifact,sourcePath},{workDir:join(directory,'assembly-'+profile),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')}));
      for(const mode of [...(['omitted','null','live','inactive','capacity','prefix-false'] as const),...(profile!=='guards'?['capacity-race'] as const:[]),...((profile==='retained'||profile==='original')?['retained','null-match','unmatched','missing-account','account-race','resource-race','domain-race','identity-race'] as const:[]),...(profile==='original'?['different-resource','stage-customer-mismatch','stage-not-confirmed','missing-venue-state','hidden-customer'] as const:[])]){
        const now=Date.parse('2099-01-01T12:00:00Z'),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
        const team=await identities.createTeam({timezone:'UTC'});
        const modeStart=Date.now();
        const actor=await identities.createUser({email:'event-guards@example.test',password_hash:'unused',email_verified:true});
        const authMembership=await identities.createMembership({team_id:team.team_id,user_id:actor.user_id,is_owner:false,roles:[{role:'events.organizer',granted_at:new Date(now).toISOString(),granted_by:actor.user_id},...(mode==='hidden-customer'?[]:[{role:'customer.customer_reader',granted_at:new Date(now).toISOString(),granted_by:actor.user_id}])]});
        const retainedActor=await identities.createUser({email:'prior-account@example.test',password_hash:'unused',email_verified:true});
        const token='event-guards-'+randomBytes(8).toString('hex');
        await identities.createSession({user_id:actor.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(now+3600000).toISOString()});
        const identity=await resolveIdentity(identities,{session_token:token},{clock});
        const {store,probe}=createTestMemoryStorage();
        const site=asId('site'),event=asId('event'),program=asId('program'),resource=asId('resource'),customer=asId('customer');
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:asModel('rent_catalog.Location'),row:{...makeRow({id:site,data:{name:'Site',currency:'EUR'}}),parent:null}},
          {kind:'insert',model:asModel('employee.Employee'),row:{...makeRow({id:asId('employee'),data:{user:{id:actor.user_id},active:mode!=='prefix-false',operator_wide:false,home:{id:site},locations:[]}}),parent:null}},
          {kind:'insert',model:asModel('events.Program'),row:{...makeRow({id:program,data:{name:'Program'}}),parent:null}},
          {kind:'insert',model:asModel('events.Event'),row:{...makeRow({id:event,data:{location:{id:site},timezone:'UTC',from:'2099-01-02T09:00:00.000Z',until:'2099-01-02T10:00:00.000Z',capacity:'10',price:{minor:'0',currency:'EUR'},sales_until:'2099-01-02T08:00:00.000Z',venue:['retained','null-match','missing-account','account-race','resource-race','domain-race','identity-race','different-resource','stage-customer-mismatch','stage-not-confirmed','missing-venue-state','hidden-customer'].includes(mode)?{id:'prior-change'}:null,pending_change:null,revision:'1',cancelled:false}}),parent:{model:asModel('events.Program'),id:program}}},
          {kind:'insert',model:asModel('rent_reservations.Resource'),row:{...makeRow({id:resource,data:{...(mode==='prefix-false'?{}:{active:mode!=='inactive'}),location:{id:site},party_limit:'10'}}),parent:null}},
          {kind:'insert',model:asModel('customer.Customer'),row:{...makeRow({id:customer,data:{active:true,locations:[{id:site}]}}),parent:null}},
          ...(mode==='stage-customer-mismatch'?[{kind:'insert' as const,model:asModel('customer.Customer'),row:{...makeRow({id:asId('other-customer'),data:{active:true,locations:[{id:site}]}}),parent:null}}]:[]),
          ...((profile==='retained'||profile==='original')?[{kind:'insert' as const,model:asModel('events.Change'),row:{...makeRow({id:asId('prior-change'),data:{source:'prior',base_revision:'1',location:{id:site},timezone:'UTC',from:'2099-01-02T09:00:00.000Z',until:'2099-01-02T10:00:00.000Z',capacity:'10',sales_until:'2099-01-02T08:00:00.000Z',reason:'Earlier',author:{id:actor.user_id},...(mode==='unmatched'?{}:{resource:mode==='null-match'?null:{id:mode==='different-resource'?'other-resource':resource}}),customer:{id:mode==='stage-customer-mismatch'?'other-customer':customer},...(mode==='missing-account'?{}:{account:{id:retainedActor.user_id}}),previous:null,state:'adopted',...(['missing-venue-state','different-resource','null-match'].includes(mode)?{}:{venue_state:mode==='stage-not-confirmed'?'pending':'confirmed'}),venue_revision:'1',hold_delivery:null,hold_status:null}}),parent:{model:asModel('events.Event'),id:event}}}]:[]),
          ...[0,1].map(index=>({kind:'insert' as const,model:asModel('events.Registration'),row:{...makeRow({id:asId('ticket-'+index),data:{checked_in:null,state:'confirmed',expires:'2099-01-03T12:00:00.000Z'}}),parent:{model:asModel('events.Event'),id:event}}})),
        ]}));
        let raced=false,raceCount=0;
        if(mode==='capacity-race'||mode==='account-race'||mode==='resource-race'||mode==='domain-race'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if((!raced||mode!=='capacity-race') && batch.writes.some(write=>write.kind==='insert'&&write.model==='events.Change')){
              raced=true;raceCount++;
              if(mode==='capacity-race')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('events.Registration'),row:{...makeRow({id:asId('racing-ticket'),data:{checked_in:null,state:'confirmed',expires:'2099-01-03T12:00:00.000Z'}}),parent:{model:asModel('events.Event'),id:event}}}]}));
              else {
                const prior=await store.load(asModel('events.Change'),asId('prior-change'));assert.ok(prior);
                const data={...prior.data,...(mode==='account-race'?{account:{id:actor.user_id}}:mode==='resource-race'?{resource:null}:{})};
                await commit(makeBatch(await store.readRevision(),{writes:mode==='domain-race'?
                  [{kind:'insert',model:asModel('events.Change'),row:{...prior,id:asId('another-change-'+raceCount),data:{...prior.data,source:'another-'+raceCount}}}]:
                  [{kind:'update',model:asModel('events.Change'),id:prior.id,expectedVersion:prior.version,row:{...prior,version:asVersion(prior.version+1),updated:now,data}}]}));
              }
            }
            return commit(batch);
          };
        }
        if(mode==='identity-race'){
          const query=store.query.bind(store);
          store.query=async spec=>{
            const rows=await query(spec);
            if(!raced&&spec.model==='events.Change'){raced=true;await identities.removeMembership(authMembership.membership_id);}
            return rows;
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const inputs={event:{id:event,version:'1'},location:{id:site,version:'1'},timezone:'UTC',from:'2099-01-03T09:00:00.000Z',until:'2099-01-03T10:00:00.000Z',capacity:mode==='capacity'?'1':mode==='capacity-race'?'2':'10',sales_until:'2099-01-03T08:00:00.000Z',reason:'Move event',
          ...(mode==='omitted'?{}:(mode==='null'||mode==='null-match'||mode==='capacity-race')?{resource:null,customer:null}:{resource:{id:resource,version:'1'},customer:{id:customer,version:'1'}})};
        const time=now.toString(16).padStart(12,'0'),random=randomBytes(10).toString('hex'),id=`${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
        const result=await invoker.invokeMutation({operation:'events.check_change',operation_id:id,inputs},identity);
        const success=mode==='omitted'||mode==='null'||profile!=='created'&&mode==='live'||(profile==='retained'||profile==='original')&&(mode==='retained'||mode==='null-match'||mode==='unmatched'||mode==='different-resource');
        if(success){assert.ok('result' in result,profile+'/'+mode+': '+JSON.stringify(result));assert.equal(result.result.status,'committed');if(profile==='guards')assert.equal(result.result.result,'1');}
        else {assert.ok('error' in result,profile+'/'+mode+': '+JSON.stringify(result));if(mode!=='missing-account'&&!['account-race','resource-race','domain-race','identity-race','missing-venue-state','hidden-customer'].includes(mode))assert.equal(result.error.code,'rule_failed',profile+'/'+mode+': '+JSON.stringify(result));}
        if(mode.endsWith('-race'))assert.equal(raced,true,'race occurs at original commit');
        if(profile!=='guards'){
          const changes=await store.query({model:asModel('events.Change'),authority:'owner'});
          const newChanges=changes.filter(row=>row.data['source']===id);
          assert.equal(newChanges.length,success?1:0,mode+': created row is atomic');
          const current=await store.load(asModel('events.Event'),event);assert.ok(current);
          const routes=await store.query({model:asModel('work.handler_occurrence'),authority:'owner'});
          const provider=profile==='original'&& !['omitted','null','null-match','capacity-race'].includes(mode);
          const emitted=success&&!provider;
          assert.equal(probe.outboxAll().length,success&&provider?1:0,mode+': provider intent is atomic');
          assert.equal(routes.filter(row=>row.data['handler']==='events.consume').length,emitted?1:0,mode+': exact event route shares commit');
          if(success){assert.deepEqual(current.data['pending_change'],{id:newChanges[0]!.id});assert.deepEqual(newChanges[0]!.data['account'],{id:mode==='retained'?retainedActor.user_id:actor.user_id});
            if(provider){
              const intent=probe.outboxAll()[0]!;
              assert.ok(intent.target.endsWith(mode==='retained'?'.RoomsV1.stage':'.RoomsV1.hold'),mode+': original provider branch');
              assert.deepEqual(intent.arguments['arguments'],{value:{source:id,revision:'1',resource,customer,account:{id:mode==='retained'?retainedActor.user_id:actor.user_id},from:inputs.from,until:inputs.until,quantity:'1',price:null,terms:null},...(mode==='retained'?{previous_source:'prior',previous_revision:'1'}:{})},mode+': exact authored provider payload');
              assert.equal(newChanges[0]!.data['hold_delivery'],intent.intentId);assert.equal(newChanges[0]!.data['hold_status'],'pending');
            }

            const replay=await invoker.invokeMutation({operation:'events.check_change',operation_id:id,inputs},identity);
            assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
            assert.equal(probe.outboxAll().length,provider?1:0,'replay queues no second provider intent');
            assert.equal((await store.query({model:asModel('events.Change'),authority:'owner'})).length,(profile==='retained'||profile==='original')?2:1);
            assert.equal((await store.query({model:asModel('work.handler_occurrence'),authority:'owner'})).filter(row=>row.data['handler']==='events.consume').length,emitted?1:0,'replay emits no second route');
          }else assert.equal(current.data['pending_change'],null,mode+': failed prefix or late Require publishes no link');
        }
        timings.push({phase:'case/'+profile+'/'+mode,ms:Date.now()-modeStart});
      }
      }
    }finally{
      const total=timings.reduce((sum,entry)=>sum+entry.ms,0);
      console.error(`[event-change-guards] ${timings.length} timed phases, ${total}ms counted`);
      for(const entry of [...timings].sort((a,b)=>b.ms-a.ms).slice(0,12))
        console.error(`[event-change-guards] ${entry.phase}: ${entry.ms}ms`);
      await rm(directory,{recursive:true,force:true});
    }
  });

it('executes original optional Customer helper guards with complete owner domains and commit fences',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-optional-customer-'));
    try{
      const sourcePath=join(root,'compiler/tests/fixtures/source-require-optional-customer.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,sourcePath],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath},{workDir:join(directory,'assembly'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const operation of ['events.check_register','rent_reservations.link_legacy']){
        for(const mode of ['omitted','null','owner','booker','administrator','delegated','wrong-account','wrong-location','inactive','unverified','hidden-contact','hidden-role','hidden-negative','free-hidden','venue-confirmed','venue-pending','venue-missing','prefix-false','capacity','domain-race','read-race','role-domain-race','role-read-race','identity-race','customer-inactive','customer-away','worker-inactive','without-finance','without-reservation-manager']){
          if(operation==='events.check_register'&&mode.startsWith('without-'))continue;
          if(operation.endsWith('link_legacy')&&['omitted','administrator','free-hidden','venue-confirmed','venue-pending','venue-missing','prefix-false','capacity'].includes(mode))continue;
          const now=Date.parse('2099-01-01T12:00:00Z'),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
          const team=await identities.createTeam({timezone:'UTC'});
          const actor=await identities.createUser({email:'helper-actor@example.test',password_hash:'unused',email_verified:true});
          const other=await identities.createUser({email:'helper-other@example.test',password_hash:'unused',email_verified:true});
          const membership=await identities.createMembership({team_id:team.team_id,user_id:actor.user_id,is_owner:false,roles:['events.organizer','rent_reservations.finance','rent_reservations.reservation_manager'].filter(role=>mode!=='without-finance'||role!=='rent_reservations.finance').filter(role=>mode!=='without-reservation-manager'||role!=='rent_reservations.reservation_manager').map(role=>({role,granted_at:new Date(now).toISOString(),granted_by:actor.user_id}))});
          const token='optional-customer-'+randomBytes(8).toString('hex');
          await identities.createSession({user_id:actor.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(now+3600000).toISOString()});
          const identity=await resolveIdentity(identities,{session_token:token},{clock});
          const {store}=createTestMemoryStorage();
          const site=asId('site'),customer=asId('customer'),event=asId('event'),entry=asId('entry');
          const company=['booker','administrator','wrong-location','inactive','hidden-role','hidden-negative','role-domain-race','role-read-race'].includes(mode);
          const account=['delegated','wrong-account','worker-inactive'].includes(mode)?other.user_id:actor.user_id;
          const matchingAccount=mode==='wrong-account'?actor.user_id:account;
          const row=(model:string,id:string,data:Record<string,unknown>,parent:{model:ReturnType<typeof asModel>;id:ReturnType<typeof asId>}|null=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
          await store.commit(makeBatch(await store.readRevision(),{writes:[
            row('rent_catalog.Location',site,{name:'Site',currency:'EUR'}),
            row('rent_catalog.Location','away',{name:'Away',currency:'EUR'}),
            row('employee.Employee','employee',{user:{id:actor.user_id},active:mode!=='worker-inactive',operator_wide:false,home:{id:site},locations:[]}),
            row('customer.Customer',customer,{name:'Customer',kind:company?'company':'individual',active:mode!=='customer-inactive',locations:mode==='customer-away'?[]:[{id:site}]}),
            row('customer.Contact','contact',{account:{id:matchingAccount},verified:mode!=='unverified',hidden:['hidden-contact','free-hidden'].includes(mode)}, {model:asModel('customer.Customer'),id:customer}),
            row('customer.CompanyRole','grant',{account:{id:company?matchingAccount:mode==='wrong-account'?actor.user_id:other.user_id},role:mode==='administrator'?'administrator':'booker',locations:[{id:mode==='wrong-location'?'away':site}],active:!['inactive','hidden-negative'].includes(mode),hidden:['hidden-role','hidden-negative','free-hidden'].includes(mode)}, {model:asModel('customer.Customer'),id:customer}),
            row('events.Venue','venue',mode==='venue-missing'?{}:{venue_state:mode==='venue-pending'?'pending':'confirmed'}),
            row('events.Program','program',{name:'Program'}),
            row('events.Event',event,{location:{id:site},published:mode!=='prefix-false',cancelled:false,sales_until:'2099-01-02T08:00:00.000Z',capacity:mode==='capacity'?'1':'10',venue:mode==='prefix-false'?{id:'unavailable-venue'}:mode.startsWith('venue-')?{id:'venue'}:null,price:{minor:['omitted','null','free-hidden'].includes(mode)?'0':'10',currency:'EUR'},checked:false},{model:asModel('events.Program'),id:asId('program')}),
            ...(mode==='capacity'?[row('events.Registration','existing-ticket',{state:'confirmed',expires:'2099-01-02T12:00:00.000Z'},{model:asModel('events.Event'),id:event})]:[]),
            row('rent_reservations.Resource','resource',{location:{id:site},active:true}),
            row('rent_reservations.LegacyBooking',entry,{location:{id:site},facts:{customer_source:'old',customer_external_id:'c',resource_source:'old',resource_external_id:'r'},customer:null,resource:null,account:null,mapping_reason:null}),
          ]}));
          let helperQueries=0,registrationQueries=0,raced=false,raceCount=0;
          const query=store.query.bind(store);
          store.query=async spec=>{
            const rows=await query(spec);
            if(spec.model==='events.Registration')registrationQueries++;
            if(spec.model==='customer.Contact'||spec.model==='customer.CompanyRole'){
              helperQueries++;
              if(mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}
            }
            return rows;
          };
          if(['domain-race','read-race','role-domain-race','role-read-race'].includes(mode)){
            const commit=store.commit.bind(store);
            store.commit=async batch=>{
              if(batch.writes.some(write=>(write.kind==='insert'&&write.model==='events.Registration')||(write.kind==='update'&&write.model==='rent_reservations.LegacyBooking'))&&(mode.endsWith('domain-race')||!raced)){
                raced=true;raceCount++;
                if(mode.endsWith('domain-race'))await commit(makeBatch(await store.readRevision(),{writes:[row(mode.startsWith('role-')?'customer.CompanyRole':'customer.Contact','racing-'+raceCount,mode.startsWith('role-')?{account:{id:other.user_id},role:'booker',locations:[{id:site}],active:false,hidden:true}:{account:{id:other.user_id},verified:false,hidden:false},{model:asModel('customer.Customer'),id:customer})]}));
                else{
                  const model=asModel(mode.startsWith('role-')?'customer.CompanyRole':'customer.Contact');
                  const contact=await store.load(model,asId(mode.startsWith('role-')?'grant':'contact'));assert.ok(contact);
                  await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:contact.id,expectedVersion:contact.version,row:{...contact,version:asVersion(contact.version+1),updated:now,data:{...contact.data,...(mode.startsWith('role-')?{active:false}:{verified:false})}}}]}));
                }
              }
              return commit(batch);
            };
          }
          const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
          const nullable=['omitted','null'].includes(mode);
          const optional=mode==='omitted'?{}:{customer:nullable?null:{id:customer,version:'1'},account:nullable?null:{id:account}};
          const inputs=operation==='events.check_register'?{event:{id:event,version:'1'},name:'Attendee',...optional,...(account!==actor.user_id?{email:'guest@example.test'}:{})}:{entry:{id:entry,version:'1'},customer:nullable?null:{id:customer,version:'1'},resource:nullable?null:{id:'resource',version:'1'},account:nullable?null:{id:account},reason:'Reviewed'};
          const time=now.toString(16).padStart(12,'0'),random=randomBytes(10).toString('hex'),operationId=`${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
          const result=await invoker.invokeMutation({operation,operation_id:operationId,inputs},identity);
          const success=['omitted','null','owner','booker','administrator','delegated','hidden-contact','hidden-role','free-hidden','venue-confirmed'].includes(mode)||(operation==='rent_reservations.link_legacy'&&mode==='customer-inactive');
          assert.equal('result' in result,success,operation+'/'+mode+': '+JSON.stringify(result));
          const stored=await store.load(asModel(operation==='events.check_register'?'events.Event':'rent_reservations.LegacyBooking'),operation==='events.check_register'?event:entry);assert.ok(stored);
          assert.equal(stored.version,operation==='events.check_register'?1:success?2:1,operation+'/'+mode+': business write remains atomic');
          if(operation==='events.check_register')assert.equal((await query({model:asModel('events.Registration'),authority:'owner'})).length,mode==='capacity'?1:success?1:0,mode+': registration create remains atomic');
          else if(success){assert.equal(stored.data['mapping_reason'],'Reviewed');assert.deepEqual(stored.data['account'],nullable?null:{id:account});assert.deepEqual(stored.data['customer'],nullable?null:{id:customer});assert.deepEqual(stored.data['resource'],nullable?null:{id:'resource'});}
          if(['omitted','null','capacity','free-hidden','venue-pending','venue-missing','prefix-false','customer-away','worker-inactive','without-finance','without-reservation-manager'].includes(mode)||(operation==='events.check_register'&&mode==='customer-inactive'))assert.equal(helperQueries,0,mode+': skipped helper domains remain unread');
          if(mode==='prefix-false')assert.equal(registrationQueries,0,'false original prefix avoids derived census and unavailable Venue');
          if(mode.endsWith('-race'))assert.equal(raced,true,mode+': race reached the checked domain');
          if(success){
            const replay=await invoker.invokeMutation({operation,operation_id:operationId,inputs},identity);
            assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
            assert.equal((await store.load(asModel(operation==='events.check_register'?'events.Event':'rent_reservations.LegacyBooking'),stored.id))?.version,operation==='events.check_register'?1:2,'replay repeats no business write');
            if(operation==='events.check_register')assert.equal((await query({model:asModel('events.Registration'),authority:'owner'})).length,1,'replay creates no second registration');
          }
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('executes the original register create, free notice and paid charge plus hold schedule atomically',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-register-tail-'));
    try{
      const sourcePath=join(root,'compiler/tests/fixtures/event-register-source.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,sourcePath],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath},{workDir:join(directory,'assembly'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['free','paid','delegated','full','unpublished','missing-description','missing-timezone','capacity-race','paid-capacity-race','identity-race']){
        const now=Date.parse('2099-01-01T12:00:00Z'),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
        const team=await identities.createTeam({timezone:'UTC'});
        const actor=await identities.createUser({email:'register@example.test',password_hash:'unused',email_verified:true});
        const other=await identities.createUser({email:'guest@example.test',password_hash:'unused',email_verified:true});
        const membership=await identities.createMembership({team_id:team.team_id,user_id:actor.user_id,is_owner:false,roles:[{role:'events.organizer',granted_at:new Date(now).toISOString(),granted_by:actor.user_id}]});
        const token='register-tail-'+randomBytes(8).toString('hex');
        await identities.createSession({user_id:actor.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(now+3600000).toISOString()});
        const identity=await resolveIdentity(identities,{session_token:token},{clock});
        const scope = { app: 'EventRegisterProbe', owner: team.team_id, ownerPackage: 'events' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: `register-state-${mode}`, fileStoreId: `register-files-${mode}`,
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const {store,probe}=createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const site=asId('site'),event=asId('event'),customer=asId('customer');
        const delegated=mode==='delegated'||mode==='identity-race',account=delegated?other.user_id:actor.user_id;
        const free=['free','full','unpublished','capacity-race'].includes(mode);
        const row=(model:string,id:string,data:Record<string,unknown>,parent:{model:ReturnType<typeof asModel>;id:ReturnType<typeof asId>}|null=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
        const capacityRegistration = (id: string) => row('events.Registration', id, {
          settlement_revision: '0', event_revision: '7', account: { id: actor.user_id }, location: { id: site },
          name: 'Existing attendee', email: 'existing@example.test', source: id, ticket: id,
          price: { minor: '0', currency: 'EUR' }, terms: 'Original terms', refund_before: '2099-01-02T12:00:00.000Z',
          refund_required: false, refund_state: 'none', collected: { minor: '0', currency: 'EUR' },
          refunded: { minor: '0', currency: 'EUR' }, collection_pending: false, refund_pending: false,
          fenced: false, fence_revision: '0', absent: false, expires: '2099-01-02T12:00:00.000Z',
          state: 'confirmed', payment: 'free',
        }, { model: asModel('events.Event'), id: event });
        const eventData:Record<string,unknown>={location:{id:site},name:'Original event',description:'Description',timezone:'Europe/Amsterdam',from:'2099-01-03T12:00:00.000Z',until:'2099-01-03T14:00:00.000Z',published:mode!=='unpublished',cancelled:false,sales_until:'2099-01-02T08:00:00.000Z',capacity:mode==='full'?'1':'10',venue:null,pending_change:null,revision:'7',terms:'Original terms',refund_before:'2099-01-02T12:00:00.000Z',organizer:{id:actor.user_id},price:{minor:free?'0':'1250',currency:'EUR'}};
        if(mode==='missing-description')delete eventData['name'];
        if(mode==='missing-timezone')delete eventData['timezone'];
        const beforeSeed = await store.readRevision();
        const seed = makeBatch(beforeSeed,{writes:[
          row('rent_catalog.Location',site,{name:'Site',currency:'EUR'}),
          row('employee.Employee','employee',{user:{id:actor.user_id},active:true,operator_wide:false,home:{id:site},locations:[]}),
          row('customer.Customer',customer,{name:'Customer',kind:'individual',active:true,locations:[{id:site}]}),
          row('customer.Contact','contact',{account:{id:account},verified:true,hidden:false},{model:asModel('customer.Customer'),id:customer}),
          row('events.Program','program',{name:'Program'}),
          row('events.Event',event,eventData,{model:asModel('events.Program'),id:asId('program')}),
          ...(mode==='full'?[capacityRegistration('existing')]:[]),
        ]});
        if (mode === 'missing-description' || mode === 'missing-timezone') {
          await assert.rejects(store.commit(seed), /required stored field absent/);
          assert.equal(await store.readRevision(), beforeSeed, mode + ': malformed source never enters storage');
          assert.equal(probe.outboxAll().length, 0);
          assert.equal((await store.query({ model: asModel('events.Registration'), authority: 'owner' })).length, 0);
          continue;
        }
        await store.commit(seed);
        let raced=false;
        const query=store.query.bind(store);
        store.query=async spec=>{const rows=await query(spec);if(mode==='identity-race'&&spec.model==='customer.Contact'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
        if(mode==='capacity-race'||mode==='paid-capacity-race'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{if(batch.writes.some(write=>write.kind==='insert'&&write.model==='events.Registration')){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[capacityRegistration('racing-'+randomBytes(4).toString('hex'))]}));}return commit(batch);};
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const time=now.toString(16).padStart(12,'0'),random=randomBytes(10).toString('hex'),operationId=`${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
        const inputs={event:{id:event,version:'1'},name:'Attendee',...(free?{}:{customer:{id:customer,version:'1'}}),...(delegated?{account:{id:account},email:'guest@example.test'}:{})};
        const result=await invoker.invokeMutation({operation:'events.check_register',operation_id:operationId,inputs},identity);
        const success=['free','paid','delegated'].includes(mode);
        assert.equal('result' in result,success,mode+': '+JSON.stringify(result));
        const registrations=(await query({model:asModel('events.Registration'),authority:'owner'})).filter(row=>row.data['source']===operationId);
        assert.equal(registrations.length,success?1:0,mode+': create is atomic');
        assert.equal(probe.outboxAll().length,success&&!free?1:0,mode+': provider intent is atomic');
        assert.equal((await query({model:asModel('work.schedule'),authority:'owner'})).length,success&&!free?1:0,mode+': hold schedule is atomic');
        const occurrences=await query({model:asModel('work.handler_occurrence'),authority:'owner'});
        assert.equal(occurrences.filter(row=>row.data['handler']==='events.observe_notice').length,success&&free?1:0,mode+': genuine free notice route');
        if(success){
          const registration=registrations[0];assert.ok(registration);
          assert.equal(registration.data['state'],free?'confirmed':'pending');assert.equal(registration.data['payment'],free?'free':'pending');
          assert.deepEqual(registration.data['account'],{id:account});assert.equal(registration.data['email'],delegated?'guest@example.test':'register@example.test');
          assert.equal(registration.data['ticket'],operationId);assert.equal(registration.data['event_revision'],'7');assert.equal(registration.data['terms'],'Original terms');
          assert.deepEqual(registration.data['collected'],{minor:'0',currency:'EUR'});assert.deepEqual(registration.data['refunded'],{minor:'0',currency:'EUR'});
          if(!free){
            const intent=probe.outboxAll()[0];assert.ok(intent);assert.equal(intent.target,'invoice.BillingV1.charge');
            assert.deepEqual(registration.data['delivery'],{id:intent.intentId,operation:'invoice.BillingV1.charge'});
            assert.deepEqual((intent.arguments['arguments'] as Record<string,unknown>)['value'],{source:operationId,customer,location:site,description:'Original event',amount:{minor:'1250',currency:'EUR'},terms:'Original terms',due:'2099-01-01',issuer:null,items:null,consent:null});
            const schedule=await probe.scheduleGet(['EventRegisterProbe','events',team.team_id,registration.id].map(encodeURIComponent).join('/'));assert.ok(schedule);assert.equal(schedule.at,now+15*60000);assert.equal(schedule.event,'events.HoldDue');
            assert.deepEqual(schedule.payload,{registration:{id:registration.id,version:'1'}});
            const receipt=await store.load(asModel('work.receipt'),asId(intent.intentId));assert.ok(receipt);assert.equal(receipt.data['status'],'pending');
            const schedules=await query({model:asModel('work.schedule'),authority:'owner'});assert.equal(schedules.length,1);assert.equal(schedules[0]?.data['key'],registration.id);
          }else assert.equal(registration.data['delivery'],null);
          const replay=await invoker.invokeMutation({operation:'events.check_register',operation_id:operationId,inputs},identity);
          assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
          assert.equal((await query({model:asModel('events.Registration'),authority:'owner'})).length,1);
          assert.equal(probe.outboxAll().length,free?0:1);
        }
        if(mode.endsWith('-race'))assert.equal(raced,true,mode+': race was exercised');
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });


it('resolves original event aliases only through the complete checked framework source',
  { timeout: 120000 }, async () => {
    const directory=await mkdtemp(join(tmpdir(),'can-event-alias-'));
    try {
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      const handler='agreements.notice',callable=artifact.callables.find(entry=>entry.id===handler);assert.ok(callable);
      const module=await import(asm.moduleUrls[callable.module]!);
      const original=module.appDefinition.operations[handler];
      const loaded=await loadCanonicalDescriptors(asm,artifact);
      const fresh=(operation=original.invocation)=>{
        const registry=loaded.producers.registry.loadArtifactDescriptors({...artifact,operations:[operation]},{by:()=> 'public'}).registry;
        const def=registry.get(handler);assert.ok(def && isGeneratedOperationDef(def));return {registry,def};
      };
      const {def:originalDef}=fresh(),plan=originalDef.descriptor.result?.disclosure;assert.ok(plan);
      const guards:NonNullable<ScenarioReceiptFrameworkProducer['sendGuards']>=original.sendGuards.map((guard:Record<string,unknown>)=>({
        rule:guard['rule'],source:plan.source,owner:handler,node:guard['node'],binding:guard['binding'],target:guard['target'],
        inputs:guard['inputs'],eventSource:guard['eventSource']}));
      assert.equal(guards.length,1);
      const producer:ScenarioReceiptFrameworkProducer={source:plan.source,app:'NoticeProbe',
        bindings:[{binding:guards[0]!.binding,from:'Mail',targets:[{source:guards[0]!.target,correlation:'value'}]}],sendGuards:guards,
        stage:async()=>{throw new Error('binding checks must never stage Work');},read:()=>null,evaluateGuard:async()=>false};
      bindScenarioReceiptFrameworkProducer(originalDef,producer);
      const clone=()=>[...structuredClone(producer.sendGuards!)];
      for(const mode of ['missing-source','wrong-source','wrong-model','wrong-revision','conflicting-events','wrong-alias-model'] as const){
        const operation=structuredClone(original.invocation);
        if(mode==='wrong-alias-model'){
          let changed=0;
          for(const returned of operation.result.disclosure.returns)for(const dep of returned.intrinsics??[])if(dep.parameter==='eventTerm'){
            dep.model='agreements.Agreement';changed++;
          }
          assert.ok(changed);
        }
        const {def}=fresh(operation),selected=clone(),guard=selected[0]!;
        if(mode==='missing-source')Reflect.deleteProperty(guard,'eventSource');
        if(mode==='wrong-source')Object.assign(guard,{source:{...plan.source,sha256:'0'.repeat(64)}});
        if(mode==='wrong-model')Object.assign(guard.eventSource!.modelField,{model:'agreements.Agreement'});
        if(mode==='wrong-revision')Object.assign(guard.eventSource!.revisionField,{name:'term'});
        if(mode==='conflicting-events'){
          const second=structuredClone(guard),node={start:guard.node.start+1,end:guard.node.end+1};
          Object.assign(second,{rule:guard.rule+'-other',node});Object.assign(second.eventSource!,{event:'agreements.Other',predicate:node});selected.push(second);
        }
        assert.throws(()=>bindScenarioReceiptFrameworkProducer(def,{...producer,sendGuards:selected}),/Saved scenario:/,mode);
      }
      const now=Date.now(),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
      const identity=await resolveIdentity(identities,{}, {clock});
      const {store,probe}=createTestMemoryStorage();
      await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('agreements.Term'),row:{
        ...makeRow({id:asId('term-1'),data:{executed:true,snapshot:{title:'Signed'},terminated:false,expired:false,notice_suppressed:false}}),
        parent:{model:asModel('agreements.Agreement'),id:asId('agreement-1')}}}]}));
      const unresolved=fresh();let reached=false;
      await assert.rejects(invokeState({registry:unresolved.registry,app:'NoticeProbe',source:'schedule',store,memberships:identities,clock,
        identity,kind:'trusted',trustedSource:'schedule:agreements.Notice',
        envelope:{operation:handler,operation_id:uuidv7(now),inputs:{term:{id:'term-1',version:'1'},revision:'1'}},
        execute:async()=>{reached=true;throw new Error('unresolved alias reached execution');}}),/resolved checked framework producer/);
      assert.equal(reached,false);assert.equal(probe.outboxAll().length,0);
      // A resolved alias is still no Work admission: plain trusted context
      // cannot supply an event intrinsic, and its rejection is replayed.
      const resolved=fresh();bindScenarioReceiptFrameworkProducer(resolved.def,producer);
      for(const [index,parameter] of ['eventRevision','eventTerm'].entries()){
        const dependency=resolved.def.descriptor.result!.disclosure!.returns.flatMap(returned=>returned.intrinsics??[]).find(dep=>(dep.kind==='admitted-input'||dep.kind==='admitted-reference-version')&&dep.parameter===parameter);assert.ok(dependency && dependency.kind!=='operation-id');
        const envelope={operation:handler,operation_id:uuidv7(now,index+1),inputs:{term:{id:'term-1',version:'1'},revision:'1'}};
        let attempts=0;
        const denied=()=>invokeState({registry:resolved.registry,app:'NoticeProbe',source:'schedule',store,memberships:identities,clock,
          identity,kind:'trusted',trustedSource:'schedule:agreements.Notice',envelope,execute:async call=>{
            attempts++;await observeScenarioReceiptIntrinsic(call,store,dependency.kind==='admitted-input'
              ?{dependencyId:dependency.id,kind:'admitted-input',wire:'1'}
              :{dependencyId:dependency.id,kind:'admitted-reference-version',wire:'1',reference:call.recordRefs[0]!});
            throw new Error('forged Work admission reached intrinsic');}});
        await assert.rejects(denied(),/original due Work source/);await assert.rejects(denied(),/original due Work source/);
        assert.equal(attempts,1,parameter);assert.equal(probe.outboxAll().length,0);
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });
