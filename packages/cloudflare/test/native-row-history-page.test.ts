/** Genuine CLI source, canonical State writes and installed native page history. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, PageReadScope, RowView } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { ensureSchema, createD1Storage } from '@canlang/state/storage/d1';
import { asId, asModel, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { handlePageRequest, type PageHttpDeps } from '@canlang/interfaces';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';
import { invokeMutationCanonical, loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const app = 'RowHistory', model = asModel(`${app}.Entry`);
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(tables.success, true);
  const state: Record<string, readonly Record<string, unknown>[]> = {};
  for (const {name} of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    state[name] = rows.results.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return state;
}
type HistoryResult = Awaited<ReturnType<NonNullable<PageReadScope['readHistory']>>>;

test('native authored RowHistory views retain queried rows and render real current-authorized D1 history',
  { timeout: 120000 }, async () => {
    const source = join(root, 'compiler/tests/fixtures/row-history.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [source, compiler, catalog];
    const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
    const captured = await Promise.all(paths.map(async path => digest(await readFile(path))));
    const dir = await mkdtemp(join(tmpdir(), 'can-native-row-history-page-'));
    let worker: Miniflare | undefined, sequence = 0, now = FIXED_NOW;
    const clock = { nowMs: () => now };
    try {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const {stdout} = await promisify(execFile)(compiler, ['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(artifact.artifact_version, 1);
      assert.ok(artifact.sources.some(value => resolve(value.path) === source && value.sha256 === captured[0]));
      assert.equal(artifact.pages?.length, 1);
      const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(dir,'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui')});
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      assert.equal(loaded.models.length, 1); assert.equal(loaded.models[0]!.name, model);
      assert.deepEqual(loaded.secretFields.get(model), ['token']);
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { STATE: 'native-row-history-state', IDENTITY: 'native-row-history-identity' }, d1Persist: join(dir,'d1') });
      const db = await worker.getD1Database('STATE') as unknown as D1Database;
      const idDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      await ensureSchema(db); await ensureIdentitySchema(idDb);
      const identities = createD1IdentityStore(idDb, {clock}), team = await identities.createTeam({timezone:'UTC'});
      const user = await identities.createUser({email:'native-row-history@example.test',password_hash:'unused',email_verified:true});
      const membership = await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
      const token = 'native-row-history-session';
      await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),
        expires_at:new Date(FIXED_NOW+3600000).toISOString(),last_team_id:team.team_id});
      const identity = await resolveIdentity(identities,{session_token:token},{clock});
      assert.equal(identity.actor?.user_id,user.user_id); assert.equal(identity.team?.team_id,team.team_id);
      const store = createD1Storage(db);
      const resources = async () => ({state:await snapshot(db),identity:await snapshot(idDb)});
      const base = {artifact,asm,app,identity,source:'worker',store,memberships:identities,now:clock.nowMs};
      const ids: string[] = [];
      for (const label of ['First','Hidden','Last']) {
        const operationId = uuidv7(FIXED_NOW,++sequence); ids.push(operationId);
        assert.equal((await invokeMutationCanonical({...base,operation:`${model}.create`,operationId,inputs:{label}})).status,'committed');
      }
      // Equal create instants use State's id tiebreak. The controlled UUID
      // suffixes are ordered numerically and lexically at this fixed timestamp.
      assert.deepEqual(ids,[...ids].sort());
      now++;
      const revisionBeforeUpdate = await store.readRevision(), beforeUpdate = await resources();
      const revise = {...base,operation:`${app}.revise`,operationId:uuidv7(FIXED_NOW,++sequence),
        inputs:{entry:{id:ids[0]!,version:'1'}}};
      assert.equal((await invokeMutationCanonical(revise)).status,'committed');
      assert.equal(await store.readRevision(),revisionBeforeUpdate+1);
      const updated = await resources();
      assert.equal(updated.state.receipts!.length,beforeUpdate.state.receipts!.length+1);
      assert.equal(updated.state.fence_log!.length,beforeUpdate.state.fence_log!.length+1);
      assert.deepEqual(updated.identity,beforeUpdate.identity);
      assert.equal((await invokeMutationCanonical(revise)).status,'replayed');
      assert.deepEqual(await resources(),updated,'canonical replay has no local resource effects');
      const physicalRead = store.historyReadBounded; assert.ok(physicalRead);
      const revision = await store.readRevision();
      const raw = await physicalRead.call(store,{model,recordId:asId(ids[0]!),expectedRevision:revision,limit:100});
      assert.deepEqual(raw.map(entry => [entry.change,entry.version,entry.actor,entry.operationId]),
        [['create',1,user.user_id,ids[0]],['update',2,user.user_id,revise.operationId]]);
      assert.deepEqual(raw[1]!.before,raw[0]!.after);
      assert.ok(raw.every(entry => entry.auditProjection?.secretFields.join(',') === 'token'));
      const secrets = await Promise.all(ids.map(async id => {
        const row = await store.load(model,asId(id)); assert.ok(row); return String(row.data.token);
      }));
      let boundedReads = 0, legacyReads = 0, revokeDuringRead = false;
      let revocationSnapshot: Awaited<ReturnType<typeof resources>> | undefined;
      store.historyReadBounded = async function(request) {
        assert.equal(this,store); boundedReads++;
        const result = await physicalRead.call(store,request);
        if (revokeDuringRead) {
          revokeDuringRead=false; await identities.removeMembership(membership.membership_id);
          revocationSnapshot=await resources();
        }
        return result;
      };
      store.historyFor = async () => {legacyReads++;throw Error('Page history used legacy materialization');};
      const accepted: HistoryResult[] = [], refused: unknown[] = [], calls: string[] = [];
      let queried: readonly RowView[] = [];
      let pageDeps: PageHttpDeps | undefined;
      const host = await assembleWorker(artifact,asm,{store,identityStore:identities,now:clock.nowMs,
        http:{createPageHandler: supplied => {
          const deps = supplied as unknown as PageHttpDeps, createScope = deps.createReadScope; assert.ok(createScope);
          pageDeps = {...deps,createReadScope:async current => {
            const scope = await createScope(current); assert.ok(scope.readHistory);
            const query = scope.query, readHistory = scope.readHistory;
            return {...scope,query:async (...args:Parameters<typeof query>) => {
              const result = await query(...args); queried=result.rows; return result;
            },readHistory:async (locator: Parameters<NonNullable<PageReadScope['readHistory']>>[0]) => {
              assert.equal(locator.model,model);
              assert.ok(queried.some(row => row === locator.record),'compiled reused view retains its exact queried RowView');
              assert.equal(typeof locator.record.version,'string');
              assert.notEqual(locator.record.fields.label,'Hidden','authored require suppresses this history expansion');
              calls.push(locator.record.id);
              try {const result=await readHistory(locator);accepted.push(result);return result;}
              catch(error) {refused.push(error);throw error;}
            }};
          }};
          return request => handlePageRequest(pageDeps!,request);
        }}},{active:true});
      const cookie=buildSessionCookie(token,{maxAgeSeconds:3600,secure:false}).split(';')[0]!;
      const request=(partial=false)=>new Request(`https://example.test/history?team=${team.team_id}`,
        {headers:{cookie,...(partial?{'hx-request':'true'}:{})}});
      for (const partial of [false,true]) {
        accepted.length=0;refused.length=0;calls.length=0;
        const beforeRead=await resources(), beforeBounded=boundedReads;
        const response=await host.fetch(request(partial)), html=await response.text();
        assert.equal(response.status,200,html);
        assert.deepEqual(queried.map(row=>row.id),ids);
        assert.deepEqual(calls,[ids[0],ids[0],ids[2],ids[2]]);
        assert.equal(accepted.length,4);assert.equal(refused.length,0);assert.equal(boundedReads,beforeBounded+4);
        assert.deepEqual(accepted[0]!.entries.map(entry=>[entry.change,entry.version,entry.before,entry.after]),
          [['create',1,null,{label:'First'}],['update',2,{label:'First'},{label:'Revised'}]]);
        assert.deepEqual(accepted[1],accepted[0]);
        assert.deepEqual(accepted[2]!.entries.map(entry=>entry.after),[{label:'Last'}]);
        assert.deepEqual(accepted[3],accepted[2]);
        for(const result of accepted) {assert.equal(result.revision,revision);for(const entry of result.entries)assert.equal(Object.hasOwn(entry,'auditProjection'),false);}
        assert.equal((html.match(/<summary[^>]*>History<\/summary>/g)??[]).length,4);
        assert.doesNotMatch(html,/data-can-history="(?:empty|unavailable)"/);
        assert.doesNotMatch(html,/<details[^>]*\sopen(?:[\s=>])/);
        assert.ok(html.indexOf('First')<html.indexOf('Revised',html.indexOf('First')));
        for(const hidden of ['auditProjection',...secrets])assert.equal(html.includes(hidden),false);
        assert.deepEqual(await resources(),beforeRead,'full and partial authored history are read-only');
      }
      accepted.length=0;refused.length=0;calls.length=0;revokeDuringRead=true;
      const beforeRevoked=await resources(), beforeRevokedReads=boundedReads;
      const denied=await host.fetch(request(true)), deniedHtml=await denied.text();
      assert.equal(denied.status,200,deniedHtml);
      assert.equal(accepted.length,0);assert.equal(refused.length,4);
      assert.equal(boundedReads,beforeRevokedReads+1,'current membership refusal stops subsequent physical histories');
      assert.deepEqual(refused.map(error => { assert.ok(typeof error === 'object' && error !== null && 'code' in error); return error.code; }),
        ['forbidden','not_found','not_found','not_found'], 'in-flight revocation refuses; later history calls preserve State non-disclosure');
      assert.equal((deniedHtml.match(/data-can-history="unavailable"/g)??[]).length,4);
      assert.doesNotMatch(deniedHtml,/data-can-history="empty"/);
      for(const hidden of ['First','auditProjection',...secrets])assert.equal(deniedHtml.includes(hidden),false);
      assert.ok(revocationSnapshot);assert.deepEqual(revocationSnapshot.state,beforeRevoked.state);
      assert.deepEqual(await resources(),revocationSnapshot,'only the intentional Identity revocation changes resources');
      const later=await host.fetch(request(true)), laterHtml=await later.text();
      assert.equal(later.status,200,laterHtml);assert.equal(laterHtml.includes('First'),false);
      assert.equal(boundedReads,beforeRevokedReads+1);
      assert.deepEqual(await resources(),revocationSnapshot);
      assert.equal(await store.readRevision(),revision);assert.equal(legacyReads,0);
      assert.equal(JSON.stringify(artifact),originalArtifact);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),captured);
    } finally {await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });
