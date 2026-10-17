/** Actual captured native refusals and opt-in qualified Office provider join. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";
import { expect, it } from "vitest";
import { attachDevSessionService, startDevSessionService, type SessionCheckResponse, type SessionConstructQualification } from "../src/dev/session-service.js";
import type { CompilerConstructCandidates } from "../src/dev/construct-help.js";
import { firstProfileConstructIds } from "../src/dev/construct-help.js";
import { prepareLocalPreviewCapture } from "../src/dev/preview-inputs.js";
import { OFFICE_COLUMN_INTENT } from '../src/dev/construct-evidence.js';
import type { JevChoiceRequest, RankResult } from '../src/dev/jev-ranker.js';

const project = resolve(import.meta.dirname, "../../..");

it("retains the complete Office collection inventory without qualifying source intent or calling a provider", async () => {
  const source = "app OfficeChoice\nGiven\n Supply {name:text,quantity:int?,available:bool=true}\n policy Supply read=members\nWhen\n crud Supply by=members fields=name,quantity,available\nThen\n page / title=\"Supplies\"\n  stock_rows Supply empty=\"No supplies\"\n   text row.name,row.quantity,row.available\n";
  const appRoot = await mkdtemp(join(project, ".can-dev-office-choice-"));
  const runtimeDir = await mkdtemp(join(tmpdir(), "can-office-choice-control-"));
  const appPath = join(appRoot, "OfficeChoice.can");
  await writeFile(appPath, source);
  const version = async (name: string) => (JSON.parse(await readFile(
    join(project, `packages/${name}/package.json`), "utf8")) as { version: string }).version;
  const valuesVersion = await version("values"), uiVersion = await version("ui"), cloudflareVersion = await version("cloudflare");
  let providerCalls = 0;
  let owner: Awaited<ReturnType<typeof startDevSessionService>> | undefined;
  try {
    owner = await startDevSessionService({ selectedApp: "OfficeChoice", runtimeDir,
      // This refusal checks the actual compiler/help consumer only; no installed
      // preview qualification or runtime card evidence is claimed.
      capture: { checkoutRoot: project, appPath, profile: "local-d1-identity",
        compilerPath: join(project, "compiler/target/debug/can"),
        catalogPath: join(project, "packages/values/dist/catalog.json"),
        helpIndexPath: join(project, "docs/specification/CONSTRUCT-HELP.md"),
        packageInputPaths: [
          { name: `@canlang/values@${valuesVersion}/dist/src/catalog.js`, path: join(project, "packages/values/dist/src/catalog.js") },
          { name: `@canlang/ui@${uiVersion}/dist/src/catalog.js`, path: join(project, "packages/ui/dist/src/catalog.js") },
          { name: `@canlang/cloudflare@${cloudflareVersion}/dist/dev/compiler-check.js`, path: join(project, "packages/cloudflare/dist/dev/compiler-check.js") },
          { name: `@canlang/cloudflare@${cloudflareVersion}/dist/dev/preview-builder.js`, path: join(project, "packages/cloudflare/dist/dev/preview-builder.js") },
        ],
        extraInputPaths: [
          { name: "grammar", path: "docs/specification/GRAMMAR.md" },
          { name: `source:@canlang/values@${valuesVersion}/src/catalog.ts`, path: join(project, "packages/values/src/catalog.ts") },
          { name: `source:@canlang/ui@${uiVersion}/src/catalog.ts`, path: join(project, "packages/ui/src/catalog.ts") },
        ],
      },
      constructRanking: { allowExternal: () => true, transport: { choose: async () => {
        providerCalls++; throw new Error("unqualified source intent must remain local");
      } } },
    });
    const client = await attachDevSessionService({ checkoutRoot: project, app: "OfficeChoice",
      profile: "local-d1-identity", runtimeDir });
    const checked = await client.request({ command: "check" }) as SessionCheckResponse;
    expect(checked.state).toBe("errors"); expect(checked.current).toBe(true);
    expect(checked.preview).toBe("unavailable");
    expect(checked.evidence).toMatchObject({ capture_complete: true, analysis_complete: true,
      diagnostics_reported: 1, diagnostics_omitted: 0, diagnostics_service_omitted: 0 });
    const detail = await client.request({ command: "diagnostic.detail",
      payload: { revision: checked.revision, index: 0 } }) as {
      current: boolean; source: { sha256: string }; diagnostic: { code: string; message: string; primary: { start: number; end: number };
        construct_candidates: CompilerConstructCandidates };
      construct_help: { disposition: string; grammarCoverage: string; candidateCoverage: string;
        cards: { id: string; status: string }[]; classification: { id: string; profile: string; working: string }[] };
    };
    expect(detail.current).toBe(true);
    expect(detail.source.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(detail.diagnostic).toMatchObject({ code: "E2001", primary: { start: 197, end: 207 },
      construct_candidates: { version: 1, disposition: "exact", slot: "then.collection-presentation",
        complete: true, ids: ["can.v1.ui.list", "can.v1.ui.table"], context: {
          version: 1, messageKind: "unknown_collection_presentation", section: "Then", guess: "stock_rows",
          exactSourceSpan: true, structuralRecovery: false, recoveryComplete: true, nameFilterComplete: true,
          materialIntentChoice: true, evidenceSufficient: false, unsupportedBehaviorProven: false,
        } } });
    expect(detail.diagnostic.message).toContain("complete readonly alternatives");
    for (const exclusion of ["board", "gallery", "calendar", "timeline", "carousel", "hover_gallery", "steps", "text_rotate"])
      expect(detail.diagnostic.message).toContain(exclusion);
    expect(Buffer.from(source).subarray(197, 207).toString("utf8")).toBe("stock_rows");
    expect(detail.construct_help).toMatchObject({ disposition: "exact", grammarCoverage: "complete",
      candidateCoverage: "unknown" });
    expect(detail.construct_help.cards.map(card => card.id)).toEqual(["can.v1.ui.list", "can.v1.ui.table"]);
    expect(detail.construct_help.cards.every(card => card.status !== "working")).toBe(true);
    expect(detail.construct_help.classification).toEqual([
      { id: "can.v1.ui.list", profile: "included", working: "unqualified" },
      { id: "can.v1.ui.table", profile: "included", working: "unqualified" },
    ]);
    expect(await client.request({ command: "construct.rank", payload: { revision: checked.revision, index: 0 } }))
      .toMatchObject({ result: { state: "candidate_coverage_unknown",
        reason: "host profile or diagnostic branch qualification is unavailable" } });
    expect(providerCalls).toBe(0);
    expect(await client.request({ command: "preview.status" })).toMatchObject({ state: "unavailable", serving_build: null });
  } finally {
    await owner?.stop(); await rm(appRoot, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
  }
}, 60_000);

it("retains released native originating context and keeps unqualified ranking local by default", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "can-native-rank-"));
  const root = join(scratch, "source");
  const runtimeDir = join(scratch, "control");
  await mkdir(root, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  const source = "app T\nGiven\nWhen\n export scenairo\nThen\n";
  await writeFile(join(root, "T.can"), source);
  // Captured real help bytes retain their checked relative source links.
  for (const path of ["docs/specification/CONSTRUCT-HELP.md", "docs/specification/GRAMMAR.md",
    "docs/specification/DESIGN.md", "docs/design/UI-COMPONENTS.md"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(project, path), join(root, path));
  }
  const version = async (name: string): Promise<string> => {
    const manifest = JSON.parse(await readFile(join(project, `packages/${name}/package.json`), "utf8")) as { version: string };
    return manifest.version;
  };
  const valuesVersion = await version("values");
  const uiVersion = await version("ui");
  const cloudflareVersion = await version("cloudflare");
  let providerCalls = 0;
  const owner = await startDevSessionService({
    selectedApp: "T", runtimeDir,
    capture: {
      checkoutRoot: root, appPath: "T.can", profile: "local-d1-identity",
      compilerPath: join(project, "compiler/target/debug/can"),
      catalogPath: join(project, "packages/values/dist/catalog.json"),
      helpIndexPath: "docs/specification/CONSTRUCT-HELP.md",
      packageInputPaths: [
        { name: `@canlang/values@${valuesVersion}/dist/src/catalog.js`, path: join(project, "packages/values/dist/src/catalog.js") },
        { name: `@canlang/ui@${uiVersion}/dist/src/catalog.js`, path: join(project, "packages/ui/dist/src/catalog.js") },
        { name: `@canlang/cloudflare@${cloudflareVersion}/dist/dev/compiler-check.js`, path: join(project, "packages/cloudflare/dist/dev/compiler-check.js") },
        { name: `@canlang/cloudflare@${cloudflareVersion}/dist/dev/preview-builder.js`, path: join(project, "packages/cloudflare/dist/dev/preview-builder.js") },
      ],
      extraInputPaths: [
        { name: "grammar", path: "docs/specification/GRAMMAR.md" },
        { name: `source:@canlang/values@${valuesVersion}/src/catalog.ts`, path: join(project, "packages/values/src/catalog.ts") },
        { name: `source:@canlang/ui@${uiVersion}/src/catalog.ts`, path: join(project, "packages/ui/src/catalog.ts") },
      ],
    },
    // The actual native context is not safe ranking evidence or a profile proof.
    // No qualifier, disclosure callback, provider setup or external packet exists.
    constructRanking: { transport: { choose: async () => { providerCalls++; throw new Error("external transport must remain unused"); } } },
  });
  try {
    const client = await attachDevSessionService({ checkoutRoot: root, app: "T", profile: "local-d1-identity", runtimeDir });
    const checked = await client.request({ command: "check" }) as SessionCheckResponse;
    expect(checked.state).toBe("errors");
    expect(checked.current).toBe(true);
    expect(checked.evidence).toMatchObject({ capture_complete: true, analysis_complete: true,
      diagnostics_reported: 1, diagnostics_omitted: 0, diagnostics_service_omitted: 0 });
    expect(checked.preview).toBe("unavailable");
    const diagnostic = await client.request({ command: "diagnostic.detail", payload: { revision: checked.revision, index: 0 } }) as {
      current: boolean; source: { sha256: string };
      diagnostic: { code: string; primary: { start: number; end: number }; construct_candidates: CompilerConstructCandidates };
      construct_help: { grammarCoverage: string; candidateCoverage: string; cards: { id: string; status: string }[];
        classification: {id:string;profile:string;working:string}[] };
    };
    expect(diagnostic.current).toBe(true);
    expect(diagnostic.source.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    const routing = diagnostic.diagnostic.construct_candidates;
    expect(diagnostic.diagnostic.code).toBe("E1200");
    expect(routing).toMatchObject({ version: 1, disposition: "exact", slot: "when.exported-declaration", complete: true,
      context: { version: 1, messageKind: "unknown_when_declaration", section: "When", guess: "scenairo",
        exactSourceSpan: true, structuralRecovery: false, recoveryComplete: true, nameFilterComplete: true,
        materialIntentChoice: true, evidenceSufficient: false, unsupportedBehaviorProven: false } });
    expect([...routing.ids].sort()).toEqual([
      "can.v1.when.scenario.cohort", "can.v1.when.scenario.periodic", "can.v1.when.scenario.read",
      "can.v1.when.scenario.trusted", "can.v1.when.scenario.user",
    ]);
    const span = diagnostic.diagnostic.primary;
    expect(Buffer.from(source).subarray(span.start, span.end).toString("utf8")).toBe("scenairo");
    expect(diagnostic.construct_help.candidateCoverage).toBe("unknown");
    expect(diagnostic.construct_help.grammarCoverage).toBe("complete");
    expect(diagnostic.construct_help.cards.map(card => card.id).sort()).toEqual([...routing.ids].sort());
    expect(diagnostic.construct_help.cards.every(card => card.status !== "working")).toBe(true);
    expect(diagnostic.construct_help.classification).toContainEqual({id:"can.v1.when.scenario.periodic",profile:"outside",working:"unqualified"});
    expect(diagnostic.construct_help.classification).toContainEqual({id:"can.v1.when.scenario.user",profile:"included",working:"unqualified"});
    expect(diagnostic.construct_help.classification).toContainEqual({id:"can.v1.when.scenario.cohort",profile:"unknown",working:"unqualified"});
    const ranked = await client.request({ command: "construct.rank", payload: { revision: checked.revision, index: 0 } });
    expect(ranked).toMatchObject({ schema: "can.dev.construct-rank.v1", revision: checked.revision,
      result: { state: "candidate_coverage_unknown", reason: "host profile or diagnostic branch qualification is unavailable" } });
    expect(providerCalls).toBe(0);
    expect(await client.request({ command: "preview.status" })).toMatchObject({ state: "unavailable", serving_build: null });
  } finally {
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);

it("joins only actual current first-profile runtime and example outcomes through the private native session", async () => {
  // Native installed producer imports preserve ESM own-data metadata;
  // Vitest proxies expose export getters instead of the owning carrier.
  const nativeImport=compileFunction("return import(url)",["url"],{
    importModuleDynamically:vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const {createInstalledFirstProfileQualification}=await nativeImport(pathToFileURL(
    join(project,"packages/cloudflare/dist/dev/first-profile-qualification.js")).href
  ) as typeof import("../src/dev/first-profile-qualification.js");
  // Optional browser capture also consumes owner-issued Node namespaces.
  const {startDevSessionService,attachDevSessionService}=await nativeImport(pathToFileURL(
    join(project,"packages/cloudflare/dist/dev/session-service.js")).href
  ) as typeof import("../src/dev/session-service.js");
  const {prepareLocalPreviewCapture}=await nativeImport(pathToFileURL(
    join(project,"packages/cloudflare/dist/dev/preview-inputs.js")).href
  ) as typeof import("../src/dev/preview-inputs.js");
  // The qualification fixture remains Compiler-owned. Only this distinct
  // invalid application is temporary, inside the selected actual checkout.
  const appRoot=await mkdtemp(join(project,".can-dev-help-"));
  const runtimeDir=await mkdtemp(join(tmpdir(),"can-native-profile-control-"));
  const appPath=join(appRoot,"T.can");
  await writeFile(appPath,"app T\nGiven\nWhen\n export scenairo\nThen\n");
  const qualify=createInstalledFirstProfileQualification();
  let qualifications=0, providerCalls=0;
  const observed:SessionConstructQualification[]=[];
  const qualificationFailures:unknown[]=[];
  let owner:Awaited<ReturnType<typeof startDevSessionService>>|undefined;
  try {
    owner=await startDevSessionService({selectedApp:"T",runtimeDir,
    capture:prepareLocalPreviewCapture({checkoutRoot:project,appPath,
      compilerPath:join(project,"compiler/target/debug/can"),catalogPath:join(project,"packages/values/dist/catalog.json"),
      helpIndexPath:join(project,"docs/specification/CONSTRUCT-HELP.md")}),
    constructRanking:{qualify:async(request,signal)=>{qualifications++;try{const bundle=await qualify(request,signal);if(bundle)observed.push(bundle);return bundle;}catch(error){qualificationFailures.push(error);throw error;}},
      transport:{choose:async()=>{providerCalls++;throw new Error("no live ranking branch was qualified");}}}});
    const client=await attachDevSessionService({checkoutRoot:project,app:"T",profile:"local-d1-identity",runtimeDir});
    const checked=await client.request({command:"check"}) as SessionCheckResponse;
    expect(checked.state).toBe("errors");expect(checked.current).toBe(true);
    type Detail={construct_help:{candidateCoverage:string;grammarCoverage:string;classification:{id:string;profile:string;working:string}[]};
      diagnostic:{construct_candidates:CompilerConstructCandidates}};
    const readDetail=async()=>await client.request({command:"diagnostic.detail",payload:{revision:checked.revision,index:0}}) as Detail;
    let detail=await readDetail();
    expect(detail.construct_help.classification).toContainEqual({id:"can.v1.when.scenario.read",profile:"included",working:"unqualified"});
    // The daemon owns the real complete qualification job. Each bounded
    // socket request remains useful while pending; consume only its completed
    // same-revision result, preserving every whole-source proof assertion below.
    const deadline=Date.now()+150_000;
    while(!detail.construct_help.classification.some(item=>item.id==="can.v1.when.scenario.read" && item.working==="qualified")) {
      if(qualificationFailures.length)throw qualificationFailures[0];
      if(Date.now()>=deadline)throw new Error("whole first-profile qualification did not complete within its finite integration deadline");
      await new Promise(resolve=>setTimeout(resolve,1000));
      detail=await readDetail();
    }
    if(qualificationFailures.length)throw qualificationFailures[0];
    expect(detail.construct_help.grammarCoverage).toBe("complete");
    expect(detail.construct_help.candidateCoverage).toBe("unknown");
    expect(detail.construct_help.classification).toContainEqual({id:"can.v1.when.scenario.read",profile:"included",working:"qualified"});
    expect(detail.construct_help.classification).toContainEqual({id:"can.v1.when.scenario.user",profile:"included",working:"qualified"});
    expect(detail.diagnostic.construct_candidates.context).toMatchObject({materialIntentChoice:true,evidenceSufficient:false});
    expect(await client.request({command:"construct.rank",payload:{revision:checked.revision,index:0}}))
      .toMatchObject({result:{state:"candidate_coverage_unknown"}});
    const repeated=await readDetail();
    expect(repeated.construct_help).toEqual(detail.construct_help);
    expect(providerCalls).toBe(0);expect(qualifications).toBe(1);expect(observed).toHaveLength(1);
    const actual=observed[0]!;
    expect(Object.isFrozen(actual)).toBe(true);expect(actual.messageKinds).toEqual([]);
    const proofs=new Map(actual.proofs.map(proof=>[proof.id,proof]));
    for(const id of ["can.v1.field.trim","can.v1.field.min","can.v1.field.max","can.v1.policy","can.v1.invariant","can.v1.lock",
      "can.v1.when.scenario.read","can.v1.when.scenario.user","can.v1.builtin.count","can.v1.fixture.model","can.v1.fixture.user","can.v1.examples.table.crud","can.v1.examples.table.error","can.v1.examples.table.scenario"]) {
      const proof=proofs.get(id);expect(proof).toBeDefined();expect(Object.isFrozen(proof)).toBe(true);
      expect(proof!.compilerCheck).toContain("executed captured native compile");expect(proof!.runtimeCheck).toBeTruthy();
      expect(proof!.compilerSha256).toBe(actual.compilerSha256);expect(proof!.indexRevision).toBe(actual.indexRevision);
      if(id.includes("examples."))expect(proof!.exampleCheck).toContain("passed");
    }
    // This positive whole-source case requires the actual installed UI consumer;
    // optional absence remains a production withholding path, not UI evidence.
    expect([...proofs.keys()].sort()).toEqual(firstProfileConstructIds());
    for(const id of ["can.v1.ui.card","can.v1.ui.table","can.v1.ui.stat","can.v1.then.form",
      "can.v1.then.edit","can.v1.then.delete","can.v1.ui.tabs-selector","can.v1.type.enum"])
      expect(proofs.get(id)!.runtimeCheck).toContain("Chromium");
    expect(await client.request({command:"preview.status"})).toMatchObject({state:"unavailable"});
  } finally {await owner?.stop();await rm(appRoot,{recursive:true,force:true});await rm(runtimeDir,{recursive:true,force:true});}
}, 180_000);

it.skipIf(process.env.CAN_DEV_LIVE_JEV !== '1' && !process.env.CAN_DEV_OFFICE_RETAINED_JEV_LOG)('ranks the current native Office presentation with one bounded authorized live Jev request', async () => {
  const retainedLog = process.env.CAN_DEV_OFFICE_RETAINED_JEV_LOG;
  const started = performance.now();
  const phase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const begin = performance.now(); let complete = false;
    console.info(JSON.stringify({schema:'can.dev.office-phase.v1',phase:name,state:'started',elapsedMs:begin-started}));
    try { const value = await action(); complete = true; return value; }
    finally { console.info(JSON.stringify({schema:'can.dev.office-phase.v1',phase:name,complete,
      durationMs:performance.now()-begin,elapsedMs:performance.now()-started})); }
  };
  let retained: {request:JevChoiceRequest;response:unknown} | undefined;
  if (retainedLog) {
    const observations = (await readFile(retainedLog,'utf8')).split(/\r?\n/).flatMap(line => {
      try { const value = JSON.parse(line) as {schema?:unknown;request?:unknown;response?:unknown};
        return value?.schema==='can.dev.office-live-rank-observation.v1' ? [value] : []; }
      catch { return []; }
    });
    expect(observations).toHaveLength(1);
    const observation = observations[0]!;
    expect(observation.request).toBeTypeOf('object');
    const response = observation.response as {model?:unknown;answers?:{construct_for_occurrence?:{
      type?:unknown;choice?:unknown;confidence?:unknown;probabilities?:Record<string,unknown>}};
      usage?:{input_tokens?:unknown;output_tokens?:unknown}} | null;
    const answer=response?.answers?.construct_for_occurrence, ids=['can.v1.ui.list','can.v1.ui.table','none','unclear'];
    const unit=(value:unknown)=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1;
    expect(typeof response?.model==='string' && /^jev-[A-Za-z0-9.-]{1,60}$/.test(response.model) &&
      answer?.type==='choice' && typeof answer.choice==='string' && ids.includes(answer.choice) &&
      unit(answer.confidence) && ids.every(id=>unit(answer.probabilities?.[id])) &&
      Number.isSafeInteger(response?.usage?.input_tokens) && Number.isSafeInteger(response?.usage?.output_tokens)).toBe(true);
    retained={request:observation.request as JevChoiceRequest,response};
  } else {
    expect(Boolean(process.env.TYPESAFE_API_KEY?.trim()),'live provider requires the private host credential').toBe(true);
  }
  const nativeImport=compileFunction('return import(url)',['url'],{
    importModuleDynamically:vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const {createInstalledFirstProfileQualification}=await nativeImport(pathToFileURL(
    join(project,'packages/cloudflare/dist/dev/first-profile-qualification.js')).href
  ) as typeof import('../src/dev/first-profile-qualification.js');
  const {startDevSessionService,attachDevSessionService}=await nativeImport(pathToFileURL(
    join(project,'packages/cloudflare/dist/dev/session-service.js')).href
  ) as typeof import('../src/dev/session-service.js');
  const {prepareLocalPreviewCapture}=await nativeImport(pathToFileURL(
    join(project,'packages/cloudflare/dist/dev/preview-inputs.js')).href
  ) as typeof import('../src/dev/preview-inputs.js');
  const provider = retained ? undefined : new (await nativeImport(pathToFileURL(
    join(project,'packages/cloudflare/dist/dev/jev-transport.js')).href
  ) as typeof import('../src/dev/jev-transport.js')).JevHttpTransport(()=>process.env.TYPESAFE_API_KEY);
  const source='app OfficeChoice\nGiven\n Supply {name:text,quantity:int?,available:bool=true}\n policy Supply read=members\nWhen\n crud Supply by=members fields=name,quantity,available\nThen\n page / title="Supplies"\n  stock_rows Supply empty="No supplies"\n   text row.name,row.quantity,row.available\n';
  const sourceHash=createHash('sha256').update(source).digest('hex');
  const appRoot=await mkdtemp(join(project,'.can-dev-live-office-'));
  const runtimeDir=await mkdtemp(join(tmpdir(),'can-live-office-control-'));
  const appPath=join(appRoot,'OfficeChoice.can');await writeFile(appPath,source);
  const qualify=createInstalledFirstProfileQualification();
  const observed:SessionConstructQualification[]=[], qualificationFailures:unknown[]=[];
  const requests:JevChoiceRequest[]=[], responses:unknown[]=[];
  let qualificationCalls=0, transportCalls=0, providerCalls=0, elapsedMs=0;
  let owner:Awaited<ReturnType<typeof startDevSessionService>>|undefined;
  try {
    owner=await startDevSessionService({selectedApp:'OfficeChoice',runtimeDir,
      capture:prepareLocalPreviewCapture({checkoutRoot:project,appPath,
        compilerPath:join(project,'compiler/target/debug/can'),catalogPath:join(project,'packages/values/dist/catalog.json'),
        helpIndexPath:join(project,'docs/specification/CONSTRUCT-HELP.md')}),
      constructRanking:{allowExternal:()=>true,qualify:async(request,signal)=>{
        qualificationCalls++;try {const bundle=await phase('qualification',()=>qualify(request,signal));if(bundle)observed.push(bundle);return bundle;}
        catch(error){qualificationFailures.push(error);throw error;}
      },transport:{choose:async(request,signal)=>{
        transportCalls++;expect(transportCalls).toBe(1);
        expect(request.state).toMatchObject({source_sha256:sourceHash,span:{start:197,end:207},
          diagnostic_code:'E2001',message_kind:'unknown_collection_presentation',section:'Then',
          slot:'then.collection-presentation',guess:'stock_rows',
          author_intent:{label:'author_intent_data',text:OFFICE_COLUMN_INTENT}});
        const window=request.state.source_window as {text:string;logicalLines:number;bytesBeforeRedaction:number;redacted:boolean;truncated:boolean};
        expect(window.logicalLines).toBeLessThanOrEqual(5);expect(window.bytesBeforeRedaction).toBeLessThanOrEqual(1024);
        expect(window.redacted).toBe(true);expect(window.truncated).toBe(false);
        expect(window.text).toContain('text row.name,row.quantity,row.available');
        expect(window.text).not.toContain('Supplies');expect(window.text).not.toContain('No supplies');
        const serialized=JSON.stringify(request);
        expect(serialized).not.toContain(appPath);expect(serialized).not.toContain(project);
        expect(serialized).not.toContain(source);expect(serialized).not.toContain('Supply {');
        expect(Object.keys(request.questions.construct_for_occurrence.criteria).sort()).toEqual([
          'can.v1.ui.list','can.v1.ui.table','none','unclear']);
        requests.push(request);
        const begin=performance.now();
        let response: unknown;
        if (retained) {
          const semantic = (value:JevChoiceRequest) => {
            const state={...value.state};
            delete state.occurrence; delete state.revision_key;
            return {...value,state};
          };
          expect(semantic(request)).toEqual(semantic(retained.request));
          signal.throwIfAborted(); response=retained.response;
        } else { providerCalls++;expect(providerCalls).toBe(1);response=await provider!.choose(request,signal); }
        elapsedMs=performance.now()-begin;responses.push(response);return response;
      }}}});
    const client=await attachDevSessionService({checkoutRoot:project,app:'OfficeChoice',profile:'local-d1-identity',runtimeDir});
    const checked=await client.request({command:'check'}) as SessionCheckResponse;
    expect(checked.state).toBe('errors');expect(checked.current).toBe(true);expect(checked.preview).toBe('unavailable');
    expect(checked.evidence).toMatchObject({capture_complete:true,analysis_complete:true,diagnostics_reported:1,
      diagnostics_omitted:0,diagnostics_service_omitted:0});
    type Detail={current:boolean;source:{sha256:string};diagnostic:{construct_candidates:CompilerConstructCandidates};
      construct_help:{candidateCoverage:string;classification:{id:string;working:string}[]}};
    const readDetail=async()=>await client.request({command:'diagnostic.detail',payload:{revision:checked.revision,index:0}}) as Detail;
    let detail=await readDetail();
    const deadline=Date.now()+150_000;
    while(detail.construct_help.candidateCoverage!=='complete') {
      if(qualificationFailures.length)throw qualificationFailures[0];
      if(Date.now()>=deadline)throw new Error('actual Office branch/card qualification did not complete within the finite deadline');
      await new Promise(resolve=>setTimeout(resolve,1000));detail=await readDetail();
    }
    expect(detail.current).toBe(true);expect(detail.source.sha256).toBe(sourceHash);
    expect(detail.diagnostic.construct_candidates).toMatchObject({disposition:'exact',complete:true,
      ids:['can.v1.ui.list','can.v1.ui.table'],context:{materialIntentChoice:true,evidenceSufficient:false}});
    expect(observed).toHaveLength(1);expect(qualificationCalls).toBe(1);
    expect(observed[0]!.messageKinds).toEqual(['unknown_collection_presentation']);
    expect(observed[0]!.proofs.map(proof=>proof.id).sort()).toEqual(firstProfileConstructIds());
    for(const id of ['can.v1.ui.list','can.v1.ui.table'])
      expect(observed[0]!.proofs.find(proof=>proof.id===id)!.runtimeCheck).toContain('Chromium');
    expect(await client.request({command:'construct.rank',payload:{revision:checked.revision,index:0}}))
      .toMatchObject({result:{state:'intent_required'}});
    expect(await client.request({command:'construct.rank',payload:{revision:checked.revision,index:0,authorIntent:'Show supplies.'}}))
      .toMatchObject({result:{state:'intent_required'}});
    expect(providerCalls).toBe(0);expect(transportCalls).toBe(0);
    const payload={revision:checked.revision,index:0,authorIntent:OFFICE_COLUMN_INTENT};
    let ranked=await client.request({command:'construct.rank',payload}) as {revision:string;result:RankResult};
    if(ranked.result.state==='pending') {
      const ref=ranked.result.ref, pendingDeadline=Date.now()+6000;
      while(ranked.result.state==='pending' && Date.now()<pendingDeadline) {
        await new Promise(resolve=>setTimeout(resolve,100));
        ranked=await client.request({command:'rank.lookup',payload:{revision:checked.revision,ref}}) as typeof ranked;
      }
    }
    // Retain the actual bounded provider outcome even if a display gate fails.
    // Credentials, response headers and provider prose never enter this record.
    const reply=responses[0] as {model?:unknown;answers?:{construct_for_occurrence?:{
      type?:unknown;choice?:unknown;confidence?:unknown;probabilities?:Record<string,unknown>}};
      usage?:{input_tokens?:unknown;output_tokens?:unknown}}|undefined;
    const answer=reply?.answers?.construct_for_occurrence, ids=['can.v1.ui.list','can.v1.ui.table','none','unclear'];
    const finiteUnit=(value:unknown)=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1;
    const typedReply=typeof reply?.model==='string' && /^jev-[A-Za-z0-9.-]{1,60}$/.test(reply.model) &&
      answer?.type==='choice' && typeof answer.choice==='string' && ids.includes(answer.choice) &&
      finiteUnit(answer.confidence) && ids.every(id=>finiteUnit(answer.probabilities?.[id])) &&
      Number.isSafeInteger(reply.usage?.input_tokens) && Number.isSafeInteger(reply.usage?.output_tokens)
      ? {model:reply.model,answers:{construct_for_occurrence:{type:'choice',choice:answer.choice,
        confidence:answer.confidence,probabilities:Object.fromEntries(ids.map(id=>[id,answer.probabilities![id]]))}},
        usage:{input_tokens:reply.usage!.input_tokens,output_tokens:reply.usage!.output_tokens}} : null;
    console.info(JSON.stringify({schema:'can.dev.office-live-rank-observation.v1',request:requests[0],
      response:typedReply,
      elapsedMs,retained_response_replay:Boolean(retained),actualExternalCalls:providerCalls,transportCalls,
      result:ranked.result,expectedConstruct:'can.v1.ui.table',
      providerMatchedExpectedConstruct:typedReply?.answers.construct_for_occurrence.choice==='can.v1.ui.table'}));
    expect(ranked.revision).toBe(checked.revision);
    const postReplyDetail=await phase('post_reply_detail',readDetail);
    expect(postReplyDetail.current).toBe(true);
    expect(postReplyDetail.diagnostic.construct_candidates).toEqual(detail.diagnostic.construct_candidates);
    expect(providerCalls).toBe(retained ? 0 : 1);expect(transportCalls).toBe(1);expect(responses).toHaveLength(1);
    expect(typedReply).not.toBeNull();
    expect(['likely','intent_unclear','none']).toContain(ranked.result.state);
    if(ranked.result.state==='likely') {
      expect(['can.v1.ui.list','can.v1.ui.table']).toContain(ranked.result.card.id);
      expect(ranked.result.probability).toBeGreaterThanOrEqual(0.65);
      expect(ranked.result.confidence).toBeGreaterThanOrEqual(0.60);
      expect(ranked.result.probability-Math.max(...ranked.result.alternatives.map(item=>item.probability)))
        .toBeGreaterThanOrEqual(0.20);
    }
    expect(await phase('cached_rank',()=>client.request({command:'construct.rank',payload}))).toMatchObject({result:ranked.result});
    expect(providerCalls).toBe(retained ? 0 : 1);expect(qualificationCalls).toBe(1);
    expect(await readFile(appPath,'utf8')).toBe(source);
    expect(await phase('preview_status',()=>client.request({command:'preview.status'}))).toMatchObject({state:'unavailable',serving_build:null});
    await writeFile(appPath,`${source}## current-source invalidation\n`);
    expect(await phase('stale_rank',()=>client.request({command:'construct.rank',payload}))).toMatchObject({result:{state:'stale'}});
    expect(providerCalls).toBe(retained ? 0 : 1);
  } finally {await phase('cleanup',async()=>{await owner?.stop();await rm(appRoot,{recursive:true,force:true});await rm(runtimeDir,{recursive:true,force:true});});}
},180_000);
