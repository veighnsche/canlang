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
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity,sha256HexText } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { installNativeFileInventory } from './file-inventory.js';
import { invokeDueScheduleCanonical, loadCanonicalDescriptors } from './invoke.js';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
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


it('observes original pre-change guards and atomically creates and emits with a formal named event',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-event-change-guards-'));
    try {
      const original=await readFile(join(root,'compiler/tests/fixtures/event-change-retained.can'),'utf8');
      const guards=original.replace('  scenario change_schedule(','  export scenario check_change(').replace(') -> Change by=organizer',') -> int by=organizer');
      const body=guards.indexOf('   do\n',guards.indexOf('scenario check_change'));
      for(const profile of ['guards','created'] as const){
      const create=original.split('\n').find(line=>line.startsWith('    create Change '))!.replace('account=retained?.account ?? actor','account=actor');
      const sourceText=profile==='guards'?guards.slice(0,body)+'   do\n    return 1\n Then\n':
        original.slice(0,original.indexOf('   do\n',original.indexOf('scenario change_schedule'))).replace('  scenario change_schedule(','  export scenario check_change(')+
        '   do\n'+create+'\n    set event {pending_change=change}\n    if resource==null\n     emit ApplyChange {change}\n    else\n     require false\n    return change\n  scenario consume on=ApplyChange\n   do require true\n Then\n';
      const sourcePath=join(directory,profile+'.can');await writeFile(sourcePath,sourceText);
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,sourcePath],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath},{workDir:join(directory,'assembly-'+profile),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of [...(['omitted','null','live','inactive','capacity','prefix-false'] as const),...(profile==='created'?['capacity-race'] as const:[])]){
        const now=Date.parse('2099-01-01T12:00:00Z'),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
        const team=await identities.createTeam({timezone:'UTC'});
        const actor=await identities.createUser({email:'event-guards@example.test',password_hash:'unused',email_verified:true});
        await identities.createMembership({team_id:team.team_id,user_id:actor.user_id,is_owner:false,roles:[{role:'events.organizer',granted_at:new Date(now).toISOString(),granted_by:actor.user_id}]});
        const token='event-guards-'+randomBytes(8).toString('hex');
        await identities.createSession({user_id:actor.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(now+3600000).toISOString()});
        const identity=await resolveIdentity(identities,{session_token:token},{clock});
        const {store}=createTestMemoryStorage();
        const site=asId('site'),event=asId('event'),program=asId('program'),resource=asId('resource'),customer=asId('customer');
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:asModel('rent_catalog.Location'),row:{...makeRow({id:site,data:{name:'Site',currency:'EUR'}}),parent:null}},
          {kind:'insert',model:asModel('employee.Employee'),row:{...makeRow({id:asId('employee'),data:{user:{id:actor.user_id},active:mode!=='prefix-false',operator_wide:false,home:{id:site},locations:[]}}),parent:null}},
          {kind:'insert',model:asModel('events.Program'),row:{...makeRow({id:program,data:{name:'Program'}}),parent:null}},
          {kind:'insert',model:asModel('events.Event'),row:{...makeRow({id:event,data:{location:{id:site},timezone:'UTC',from:'2099-01-02T09:00:00.000Z',until:'2099-01-02T10:00:00.000Z',capacity:'10',price:{minor:'0',currency:'EUR'},sales_until:'2099-01-02T08:00:00.000Z',venue:null,pending_change:null,revision:'1',cancelled:false}}),parent:{model:asModel('events.Program'),id:program}}},
          {kind:'insert',model:asModel('rent_reservations.Resource'),row:{...makeRow({id:resource,data:{...(mode==='prefix-false'?{}:{active:mode!=='inactive'}),location:{id:site},party_limit:'10'}}),parent:null}},
          {kind:'insert',model:asModel('customer.Customer'),row:{...makeRow({id:customer,data:{active:true,locations:[{id:site}]}}),parent:null}},
          ...[0,1].map(index=>({kind:'insert' as const,model:asModel('events.Registration'),row:{...makeRow({id:asId('ticket-'+index),data:{checked_in:null,state:'confirmed',expires:'2099-01-03T12:00:00.000Z'}}),parent:{model:asModel('events.Event'),id:event}}})),
        ]}));
        let raced=false;
        if(mode==='capacity-race'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(!raced && batch.writes.some(write=>write.kind==='insert'&&write.model==='events.Change')){
              raced=true;
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('events.Registration'),row:{...makeRow({id:asId('racing-ticket'),data:{checked_in:null,state:'confirmed',expires:'2099-01-03T12:00:00.000Z'}}),parent:{model:asModel('events.Event'),id:event}}}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const inputs={event:{id:event,version:'1'},location:{id:site,version:'1'},timezone:'UTC',from:'2099-01-03T09:00:00.000Z',until:'2099-01-03T10:00:00.000Z',capacity:mode==='capacity'?'1':mode==='capacity-race'?'2':'10',sales_until:'2099-01-03T08:00:00.000Z',reason:'Move event',
          ...(mode==='omitted'?{}:(mode==='null'||mode==='capacity-race')?{resource:null,customer:null}:{resource:{id:resource,version:'1'},customer:{id:customer,version:'1'}})};
        const time=now.toString(16).padStart(12,'0'),random=randomBytes(10).toString('hex'),id=`${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
        const result=await invoker.invokeMutation({operation:'events.check_change',operation_id:id,inputs},identity);
        const success=mode==='omitted'||mode==='null'||profile==='guards'&&mode==='live';
        if(success){assert.ok('result' in result,profile+'/'+mode+': '+JSON.stringify(result));assert.equal(result.result.status,'committed');if(profile==='guards')assert.equal(result.result.result,'1');}
        else {assert.ok('error' in result,profile+'/'+mode+': '+JSON.stringify(result));assert.equal(result.error.code,'rule_failed',profile+'/'+mode+': '+JSON.stringify(result));}
        if(mode==='capacity-race')assert.equal(raced,true,'race occurs at original commit');
        if(profile==='created'){
          const changes=await store.query({model:asModel('events.Change'),authority:'owner'});
          assert.equal(changes.length,success?1:0,mode+': created row is atomic');
          const current=await store.load(asModel('events.Event'),event);assert.ok(current);
          const routes=await store.query({model:asModel('work.handler_occurrence'),authority:'owner'});
          assert.equal(routes.filter(row=>row.data['handler']==='events.consume').length,success?1:0,mode+': exact event route shares commit');
          if(success){assert.deepEqual(current.data['pending_change'],{id:changes[0]!.id});assert.deepEqual(changes[0]!.data['account'],{id:actor.user_id});
            const replay=await invoker.invokeMutation({operation:'events.check_change',operation_id:id,inputs},identity);
            assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
            assert.equal((await store.query({model:asModel('events.Change'),authority:'owner'})).length,1);
            assert.equal((await store.query({model:asModel('work.handler_occurrence'),authority:'owner'})).filter(row=>row.data['handler']==='events.consume').length,1,'replay emits no second route');
          }else assert.equal(current.data['pending_change'],null,mode+': failed prefix or late Require publishes no link');
        }
      }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
