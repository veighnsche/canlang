/** Ordinary TS serving through the installed portable Worker. Native
 * preparation is not selected. Node's existing stale-file/final-await proof
 * is retained separately in prepared-validation.test.ts. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { CompileArtifact } from '@canlang/contracts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const installed = process.env['CANLANG_SERVING_INSTALL'];
const require = createRequire(installed ? join(resolve(installed), 'package.json') : import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const load = (specifier: string) => nodeImport(pathToFileURL(require.resolve(specifier)).href);
const operation = 'TypedOperationForms.Entry.create';
const model = 'TypedOperationForms.Entry';
const route = `/api/operations/${operation}`;
const workers: Miniflare[] = [];
function operationId(): string {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

// A separate test entry adds observation only. Every installed production
// module, including the issuer and the self-contained HTTP module, is intact.
// In particular there is no second Interfaces copy with another WeakMap.
const adapter = `
import original from './main.js';
import { artifact, modules, verdict } from './artifact.js';
import { derivedInputs } from './derived-inputs.js';
import { assembleWorker } from './assembly.js';
import { buildProductionDeps } from '../runtime/env-assembly.js';
import { createPreparedValidationCatalog } from '../runtime/prepared-validation.js';
import { handleOperationRequest, handlePageRequest, catalogFromArtifactOperations, INPUT_CHOICES_VERSION } from './http-operations.js';
export default { async fetch(request, env, ctx) {
  const mode = new URL(request.url).pathname.slice('/__serving/'.length);
  if (!new URL(request.url).pathname.startsWith('/__serving/')) return original.fetch(request, env, ctx);
  const deps = await buildProductionDeps(env);
  const before = await deps.store.readRevision();
  if (mode === 'copied-assembly' || mode === 'changed-artifact') {
    let message = null;
    const changed = mode === 'changed-artifact' ? structuredClone(artifact) : artifact;
    if (mode === 'changed-artifact') changed.sources[0].sha256 = '0'.repeat(64);
    try {
      await createPreparedValidationCatalog(changed, mode === 'copied-assembly' ? {...modules} : modules,
        catalogFromArtifactOperations(artifact), 'TypedOperationForms');
    } catch (error) { message = error.message; }
    return Response.json({ message, before, after: await deps.store.readRevision() });
  }
  const baked = structuredClone(derivedInputs);
  if (mode === 'stale-derived') baked[${JSON.stringify(operation)}].inputs[0].required =
    !baked[${JSON.stringify(operation)}].inputs[0].required;
  let observed;
  const factory = Object.assign(http => async (req, op) => {
    // Retain the real request-issued object; probe through its own installed
    // public handler after the handler's finally has closed it. The logger is
    // the existing diagnostic port, not a new catalog/issuer/debug API.
    const captured = http.catalog;
    const errors = [];
    const response = await handleOperationRequest({...http, logger:{log(level, message, fields){
      if(level === 'error') errors.push(fields?.detail?.message);
      http.logger.log(level, message, fields);
    }}}, req, op);
    const probe = async catalog => {
      const errors = [];
      // A fresh plausible UUIDv7 ensures the probe reaches source admission.
      const body = { operation_id: req.headers.get('x-serving-probe-id'), inputs: {label:'closed catalog probe'} };
      const valid = new Request(req.url, {method:'POST', headers:req.headers, body:JSON.stringify(body)});
      const result = await handleOperationRequest({...http, catalog, logger:{log(level, message, fields){
        if(level === 'error') errors.push(fields?.detail?.message);
      }}}, valid, op);
      return { status:result.status, errors };
    };
    observed = { errors, closed:await probe(captured), copied:await probe({...captured}) };
    return response;
  }, {inputChoicesVersion:INPUT_CHOICES_VERSION});
  const worker = await assembleWorker(artifact, modules, {...deps, http:{derivedInputs:baked,
    createPageHandler:http => request => handlePageRequest(http, request), createOperationHandler:factory}}, verdict);
  const target = new URL(request.url); target.pathname = ${JSON.stringify(route)};
  const response = await worker.fetch(new Request(target, request));
  return Response.json({ status:response.status, body:await response.json(), observed,
    before, after:await deps.store.readRevision() });
}};
`;

describe('installed ordinary TS prepared validation in isolated workerd', () => {
  let dir: string;
  let bundle: Awaited<ReturnType<typeof import('../src/deploy/bundle.js')['buildDeployBundleWithAssets']>>;
  let main: string;
  let identity: typeof import('@canlang/identity');
  beforeAll(async () => {
    const producer = process.env['CANLANG_SERVING_ARTIFACT'];
    const sourcePath = join(root, 'packages/cloudflare/test/fixtures/typed-operation-forms.can');
    // Qualification supplies frozen compiler output. Ordinary repository runs
    // use the existing compiler, like the retained Node serving fixture.
    const artifact = JSON.parse(producer ? await readFile(producer, 'utf8') :
      execFileSync(join(root, 'compiler/target/debug/can'), ['compile', '--format=json', sourcePath], {encoding:'utf8'})) as CompileArtifact;
    const source = await readFile(sourcePath);
    assert.ok(artifact.sources.some(entry => entry.path.endsWith('typed-operation-forms.can') &&
      entry.sha256 === createHash('sha256').update(source).digest('hex')), 'compiled original source must still be current');
    const deploy = await load('@canlang/cloudflare/deploy/bundle') as typeof import('../src/deploy/bundle.js');
    identity = await load('@canlang/identity');
    main = deploy.DEPLOY_MAIN_MODULE;
    bundle = deploy.buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    dir = await mkdtemp(join(await realpath(tmpdir()), 'can-serving-workerd-'));
    deploy.writeDeployBundleWithAssets(bundle, dir);
  }, 120000);
  afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.dispose())); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function setup(controlled = false) {
    const entry = controlled ? 'worker/serving-qualification.js' : main;
    const modules = controlled ? {...bundle.modules, [entry]:adapter} : bundle.modules;
    const worker = new Miniflare({ compatibilityDate:'2026-07-15', modulesRoot:'/',
      modules:[entry, ...Object.keys(modules).filter(path => path !== entry)].map(path => ({
        type:'ESModule' as const, path:`/${path}`, contents:modules[path]!,
      })), d1Databases:{DB:'serving-validation'} });
    workers.push(worker);
    const DB = await worker.getD1Database('DB');
    const { buildProductionDeps } = await nodeImport(pathToFileURL(join(dir, 'runtime/env-assembly.js')).href);
    const deps = await buildProductionDeps({ DB });
    const password = 'worker-serving-password';
    const user = await deps.identityStore.createUser({email:'worker-serving@example.test',
      password_hash:await identity.hashPassword(password), email_verified:true});
    const team = await deps.identityStore.createTeam({timezone:'Europe/Brussels'});
    await deps.identityStore.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:true,roles:[]});
    const { token } = await identity.loginWithPassword(deps.identityStore, {email:user.email,password});
    const session = await deps.identityStore.findSessionByTokenHash(await identity.sha256HexText(token));
    assert.ok(session); await deps.identityStore.setSessionTeam(session.session_id,team.team_id);
    const cookie = identity.buildSessionCookie(token,{maxAgeSeconds:3600,secure:false});
    const csrf = await identity.deriveCsrfToken(token);
    const headers = {cookie,'content-type':'application/json','x-csrf-token':csrf,'x-serving-probe-id':operationId()};
    const post = (body: string, path = route, extra: Record<string,string> = {}) =>
      worker.dispatchFetch(`https://example.test${path}`,{method:'POST',headers:{...headers,...extra},body});
    const receipt = (id: string) => deps.store.readReceipt({app:'TypedOperationForms',owner:team.team_id,
      principal:user.user_id,operation,operationId:id});
    return {worker,deps,user,post,receipt};
  }

  test('actual default Worker preserves State defaults, HTTP diagnostic order, CSRF and capped-body admission', async () => {
    const {worker,deps,user,post,receipt} = await setup();
    const id = operationId(), body = JSON.stringify({operation,operation_id:id,inputs:{label:'Worker canonical default'}});
    const success = await post(body);
    assert.equal(success.status,200,await success.clone().text());
    const committed = await success.json();
    const rows = await deps.store.query({model,authority:'owner'});
    assert.equal(rows.length,1);
    assert.deepEqual(rows[0].data,{label:'Worker canonical default',count:'1',owner:{id:user.user_id}});
    assert.deepEqual((await receipt(id)).resolvedDefaults,{count:'1',owner:{id:user.user_id}});
    const before = await deps.store.readRevision(), history = await deps.store.historyFor(model,rows[0].id);
    const replay = await post(body); assert.equal(replay.status,200);
    const replayed = await replay.json() as {status:string;records:unknown};
    assert.equal(replayed.status,'replayed');
    assert.deepEqual(replayed.records,(committed as {records:unknown}).records);
    const denied = [
      [{unknown:1,count:'bad'},400,/Unknown input 'unknown'/,'/unknown','unknown'],
      [{count:'bad'},400,/Missing required input 'label'/,'/label','required'],
      [{label:'ok',count:'bad'},400,/./,'/count','binding_mismatch'],
    ] as const;
    for (const [inputs,status,message,path,code] of denied) {
      const nonce = operationId();
      const response = await post(JSON.stringify({operation_id:nonce,inputs}));
      assert.equal(response.status,status);
      const error = await response.json() as {code:string;message:string;fields:Array<{path:string;code:string}>};
      assert.equal(error.code,'validation'); assert.match(error.message,message);
      assert.equal(error.fields[0]?.path,path); assert.equal(error.fields[0]?.code,code);
      assert.equal(await receipt(nonce),null,'HTTP refusal must precede receipt/effects');
    }
    assert.equal((await post(body,route,{'x-csrf-token':'wrong'})).status,403);
    assert.equal((await post(body,route,{cookie:''})).status,403);
    assert.equal((await post('x'.repeat(1_048_577))).status,429);
    assert.equal((await post('{')).status,400);
    assert.equal((await worker.dispatchFetch(`https://example.test${route}`)).status,404);
    assert.equal(await deps.store.readRevision(),before);
    assert.deepEqual(await deps.store.query({model,authority:'owner'}),rows);
    assert.deepEqual(await deps.store.historyFor(model,rows[0].id),history);
  },120000);

  test('same-graph controlled adapter observes request cleanup and genuine issuer/copy/stale refusals', async () => {
    const {deps,post,receipt} = await setup(true);
    for (const [inputs,status] of [[{label:'adapter canonical'},200],[{unknown:1,count:'bad'},400]] as const) {
      const nonce = operationId();
      const response = await post(JSON.stringify({operation_id:nonce,inputs}),'/__serving/lifetime');
      assert.equal(response.status,200,await response.clone().text());
      const result = await response.json() as any;
      assert.equal(result.status,status,JSON.stringify(result));
      assert.deepEqual(result.observed.closed,{status:422,errors:['Source validation catalog is closed.']});
      assert.deepEqual(result.observed.copied,{status:422,errors:['Source validation requires its original catalog, not copied readers.']});
      if (status !== 200) { assert.equal(result.after,result.before); assert.equal(await receipt(nonce),null); }
    }
    const revision = await deps.store.readRevision();
    for (const [mode,message] of [['copied-assembly',/not assembler-owned/],['changed-artifact',/differs from assembled source/]] as const) {
      const response = await post('{}',`/__serving/${mode}`);
      assert.equal(response.status,200);
      const result = await response.json() as any;
      assert.match(result.message,message); assert.equal(result.before,revision); assert.equal(result.after,revision);
    }
    const nonce = operationId();
    const stale = await post(JSON.stringify({operation_id:nonce,inputs:{label:'stale derived must refuse'}}),'/__serving/stale-derived');
    assert.equal(stale.status,200);
    const refused = await stale.json() as any;
    assert.notEqual(refused.status,200); assert.equal(refused.before,revision); assert.equal(refused.after,revision);
    assert.match(refused.observed.errors[0],/catalog differs from its checked owning operation/);
    assert.equal(await receipt(nonce),null);
    assert.equal(await deps.store.readRevision(),revision);
  },120000);
});
