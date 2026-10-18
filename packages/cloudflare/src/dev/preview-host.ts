/** Real installed producers for the first local D1/Identity preview profile. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parsePreviewRoles, resolvePreviewRoles, type PreviewRoles } from "./preview-roles.js";
import { assembleModules, importVerifiedAssemblyModule } from "../runtime/modules.js";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CONTRACTS_VERSION, type ActivationVerdict, type CompileArtifact, type CompatibilityDescriptor, type EnvironmentSelection } from "@canlang/contracts";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import { createD1OwnerRouter } from "@canlang/state/storage/owner-router";
import { createD1IdentityStore, ensureIdentitySchema, hashPassword, setMemberRole } from "@canlang/identity";
import { checkActivationInventory } from "@canlang/state/migration/activate";
import { buildWorkInventory } from "@canlang/work/recovery";
import { activate } from "../deploy/activate.js";
import { buildOwnedDeployBundleWithAssets } from "../deploy/owned-bundle.js";
import { probeInstalledRuntime } from "../deploy/installed.js";
import { RELEASE_VERSION } from "../release/stamp.js";
import { startLocalDev } from "./local-run.js";
import { cleanupAfterFailure, DevCleanupError, retryableDispose } from "./cleanup.js";
import { LOCAL_PREVIEW_CAPABILITIES, PreviewAdmissionError, createLocalPreviewBuilder, type LocalPreviewBundleRequest, type LocalPreviewSeed, type LocalPreviewBuilderOptions, type PortableBundleEvidence } from "./preview-builder.js";
import { installedReferenceRoot, assertInstalledCatalog, bundlerExecutableInputs, compilerSourceInputs, installedOwnedSourceInputs, installedPortableBundleInputs } from "./preview-inputs.js";
import type { NamedInputPath } from "./source-capture.js";
import { captureIsCurrent, type SingleFileCapture } from "./source-capture.js";
import { PINNED_COMPATIBILITY_DATE } from "./zero-config.js";
import type { LocalCommandLifetime } from "../cli/command-lifetime.js";
import { defaultPreviewStateRoot } from "./preview-state.js";
import { configureLocalBindings, planLocalBindings, type LocalBindingImplementations } from "./local-bindings.js";

const BINDING_NAME = "DB";
const PROFILE_CAPABILITIES = [...LOCAL_PREVIEW_CAPABILITIES];

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function appName(capture: SingleFileCapture): string {
  const names = [...capture.sourceText.matchAll(/^\s*app\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm)].map(match => match[1]);
  if (names.length !== 1 || names[0] === undefined) {
    throw new PreviewAdmissionError("PROFILE_UNSUPPORTED", "preview needs one declared app identity");
  }
  return names[0];
}

function activationInput(artifact: CompileArtifact, capture: SingleFileCapture, databaseId: string,
  implementations: LocalBindingImplementations = {}): {
  descriptor: CompatibilityDescriptor; environment: EnvironmentSelection;
} {
  if (artifact.tool_version !== RELEASE_VERSION || artifact.language_version !== "1.0") {
    throw new PreviewAdmissionError("VERSION_MISMATCH", "compiled app does not match the installed local runtime release");
  }
  const requirement = { binding: BINDING_NAME, kind: "d1" as const, logicalName: "local-preview-db" };
  const plan = planLocalBindings(artifact);
  const resources = configureLocalBindings(plan, "unused", implementations, true).resources;
  return {
    descriptor: {
      identity: {
        appName: plan.app ?? appName(capture), sourceRevision: capture.sourceRevision,
        languageVersion: artifact.language_version, compilerVersion: artifact.tool_version,
        contractsVersion: CONTRACTS_VERSION, artifactDigest: `sha256:${digest(JSON.stringify(artifact))}`,
      },
      requiredCapabilities: artifact.requires.map(item => item.capability),
      resourceBindings: [requirement, ...resources.map(resource => resource.requirement)], secrets: [], schedules: [],
    },
    environment: {
      environment: "local-preview", resources: [{ requirement, resourceId: databaseId }, ...resources],
      secretsPresent: [], vars: {},
    },
  };
}

/** Check the actual D1 store with all four installed activation gates. */
export async function localPreviewActivationVerdict(
  artifact: CompileArtifact, capture: SingleFileCapture, db: D1Database, databaseId: string, owner?: string, identityDb?: D1Database, implementations: LocalBindingImplementations = {},
): Promise<ActivationVerdict> {
  if (owner !== undefined && (identityDb === undefined || identityDb === db ||
      await createD1IdentityStore(identityDb).findTeamById(owner) === null)) {
    throw new PreviewAdmissionError("IDENTITY_UNAVAILABLE", "serving owner must exist in its separate real Identity database");
  }
  const { descriptor, environment } = activationInput(artifact, capture, databaseId, implementations);
  await ensureSchema(db);
  const row = await db.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>();
  if (row === null || !Number.isSafeInteger(row.count)) {
    throw new PreviewAdmissionError("ACTIVATION_UNAVAILABLE", "local D1 work inventory could not be read");
  }
  if (row.count !== 0) {
    // The first profile owns a fresh isolated DB and has no migration or
    // carryover plan. Any work contradicts that contract and must block.
    return { active: false, reasons: [{ code: "blocked-work", detail: "local preview D1 contains outstanding work" }] };
  }
  const store = createD1Storage(db);
  const verdict = await activate({
    artifact, descriptor, environment,
    installed: probeInstalledRuntime({}, {
      contractsVersion: CONTRACTS_VERSION, runtimeVersion: RELEASE_VERSION,
      knownLanguageVersions: ["1.0"], capabilities: PROFILE_CAPABILITIES, supportsSchedules: false,
    }),
    store,
    inventory: { outboxItems: [], handlerContractFor: () => null, plan: { migrationId: `preview:${capture.sourceRevision}`, invalidates: [] } },
    gates: {
      buildWorkInventory,
      checkActivationInventory: (selectedStore, plan, inventory) => checkActivationInventory(
        selectedStore, plan as Parameters<typeof checkActivationInventory>[1], inventory,
      ),
    },
  });
  if (verdict.active && owner !== undefined) {
    const app = descriptor.identity.appName;
    const router = createD1OwnerRouter({ resolveBinding: requested => requested.app === app && requested.owner === owner
      ? { app, owner, db, initializeFresh: true } : null });
    await router.ownerScopedStoragePort({ app, owner });
  }
  return verdict;
}

/** The prebuild gate runs on a real, isolated local D1 binding. */
export async function preflightLocalPreviewActivation(
  artifact: CompileArtifact, capture: SingleFileCapture, implementations: LocalBindingImplementations = {},
  onAllocated?: (dispose: () => Promise<void>) => void,
): Promise<ActivationVerdict> {
  checkedInstalledInputs(capture);
  if (!(await captureIsCurrent(capture))) {
    throw new PreviewAdmissionError("SOURCE_CHANGED", "preview inputs changed before activation");
  }
  const databaseId = `can-preview-preflight-${randomUUID()}`;
  const persistence = await mkdtemp(join(tmpdir(), "can-preview-preflight-"));
  let dev: Awaited<ReturnType<typeof startLocalDev>> | undefined;
  let failedStartup: DevCleanupError | undefined;
  const dispose = retryableDispose(async () => {
    await failedStartup?.dispose(); failedStartup = undefined;
    await dev?.dispose(); dev = undefined;
    await rm(persistence, { recursive: true, force: true });
  });
  try {
    const runtimeBindings = configureLocalBindings(planLocalBindings(artifact), persistence, implementations, true);
    dev = await startLocalDev({
      ...runtimeBindings.worker,
      workerName: `can-preview-preflight-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE,
      mainModule: "main.js",
      modules: { "main.js": "export default { fetch() { return new Response(null, { status: 404 }); } };" },
      d1Databases: [{ binding: BINDING_NAME, id: databaseId }],
    });
    onAllocated?.(dispose);
    const verdict = await localPreviewActivationVerdict(artifact, capture, await dev.getD1Database(BINDING_NAME), databaseId, undefined, undefined, implementations);
    await dispose();
    return verdict;
  } catch (error) {
    if (error instanceof DevCleanupError) failedStartup = error;
    return cleanupAfterFailure(error, dispose);
  }
}

function assertPackageClosure(capture: SingleFileCapture, expected: readonly NamedInputPath[]): void {
  const captured = capture.inputs.filter(input => input.name.startsWith("package:"));
  if (expected.length !== captured.length) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "captured package inventory differs from installed producer closure");
  }
  const byName = new Map(captured.map(input => [input.name, input]));
  for (const input of expected) {
    const selected = byName.get(`package:${input.name}`);
    if (selected?.state !== "present" || selected.sha256 === null || selected.bytes === null ||
        selected.canonicalPath !== realpathSync(input.path)) {
      throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", `installed producer input ${input.name} differs from capture`);
    }
  }
}

function assertSourceClosure(capture: SingleFileCapture, sourceInputs: readonly NamedInputPath[]): void {
  const capturedSources = capture.inputs.filter(input => input.name.startsWith("extra:source:"));
  if (sourceInputs.length !== capturedSources.length) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "captured package sources differ from installed producer closure");
  }
  const sourceByName = new Map(capturedSources.map(input => [input.name, input]));
  for (const input of sourceInputs) {
    const selected = sourceByName.get(`extra:${input.name}`);
    if (selected?.state !== "present" || selected.canonicalPath !== realpathSync(input.path)) {
      throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", `installed producer source ${input.name} differs from capture`);
    }
  }
}

function assertCompilerSourceClosure(capture: SingleFileCapture, compilerSources: readonly NamedInputPath[]): void {
  const capturedCompilerSources = capture.inputs.filter(input => input.name.startsWith("extra:compiler-source:"));
  if (compilerSources.length !== capturedCompilerSources.length) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "captured compiler sources differ from installed compiler closure");
  }
  const compilerSourceByName = new Map(capturedCompilerSources.map(input => [input.name, input]));
  for (const input of compilerSources) {
    const selected = compilerSourceByName.get(`extra:${input.name}`);
    if (selected?.state !== "present" || selected.canonicalPath !== realpathSync(input.path)) {
      throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", `compiler source ${input.name} differs from capture`);
    }
  }
}

function checkedInstalledInputs(capture: SingleFileCapture): PortableBundleEvidence["consumedInputs"] {
  const expected = installedPortableBundleInputs(capture.root);
  assertPackageClosure(capture, expected);
  for (const executable of bundlerExecutableInputs()) {
    const selected = capture.inputs.find(input => input.name === `extra:${executable.name}`);
    if (selected?.state !== "present" || selected.canonicalPath !== executable.path) {
      throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", `bundler ${executable.name} executable was not captured`);
    }
  }
  const grammar = capture.inputs.find(input => input.name === "extra:grammar");
  if (grammar?.state !== "present" || grammar.canonicalPath !== realpathSync(join(installedReferenceRoot(capture.root), "docs/specification/GRAMMAR.md"))) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "installed grammar reference was not captured");
  }
  const sourceInputs = installedOwnedSourceInputs(capture.root, expected);
  assertSourceClosure(capture, sourceInputs);
  const compilerPath = capture.inputs.find(input => input.name === "compiler")?.requestedPath;
  if (compilerPath === null || compilerPath === undefined) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "captured compiler is unavailable");
  }
  const compilerSources = compilerSourceInputs(capture.root, compilerPath);
  const catalogPath = capture.inputs.find(input => input.name === "catalog")?.requestedPath;
  if (catalogPath === null || catalogPath === undefined) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "captured Values catalog is unavailable");
  }
  assertInstalledCatalog(capture.root, catalogPath);
  assertCompilerSourceClosure(capture, compilerSources);
  return capture.inputs.filter(input => input.name.startsWith("package:") || input.name.startsWith("extra:"));
}

/** Build the real portable module map from the captured installed outputs. */
export async function produceInstalledPortableBundle(request: LocalPreviewBundleRequest & {
  readonly commandLifetime?: LocalCommandLifetime;
  readonly signal?: AbortSignal;
}): Promise<PortableBundleEvidence> {
  const { artifact, capture, verdict, assets, commandLifetime } = request;
  request.signal?.throwIfAborted();
  commandLifetime?.checkpoint("installed bundle inputs");
  const consumedInputs = checkedInstalledInputs(capture);
  if (!(await captureIsCurrent(capture))) {
    throw new PreviewAdmissionError("SOURCE_CHANGED", "installed package input changed before portable bundling");
  }
  commandLifetime?.checkpoint("installed bundle source check");
  const nativeBinary = consumedInputs.find(input => input.name === "extra:esbuild")!.canonicalPath!;
  const bundle = await buildOwnedDeployBundleWithAssets(artifact, { verdict, assets,
    esbuildBinaryPath: nativeBinary,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(commandLifetime === undefined ? {} : { commandLifetime }),
  });
  if (!(await captureIsCurrent(capture))) {
    throw new PreviewAdmissionError("SOURCE_CHANGED", "installed package input changed during portable bundling");
  }
  request.signal?.throwIfAborted();
  commandLifetime?.checkpoint("installed bundle result");
  return {
    bundle, captureEpochMaterial: capture.epochMaterial,
    artifactJsonSha256: digest(JSON.stringify(artifact)), consumedInputs,
  };
}

/** Seed ordinary verified users and memberships into the serving Identity D1. */
export async function seedLocalPreviewActors(db: D1Database, previewRoles: PreviewRoles = {}, artifact?: CompileArtifact, capture?: SingleFileCapture): Promise<LocalPreviewSeed> {
  let grants = parsePreviewRoles(previewRoles);
  if (Object.keys(grants).length !== 0) {
    if (artifact === undefined || capture === undefined) throw new Error("preview roles require the current compiled application");
    const workDir = await mkdtemp(join(tmpdir(), "can-preview-roles-"));
    try {
      const assembled = await assembleModules({ artifact, sourcePath: capture.appPath }, {
        workDir, stdlibUrl: new URL("../runtime/stdlib.js", import.meta.url).href,
      });
      const entry = await importVerifiedAssemblyModule(assembled, artifact.modules[0]!.path, artifact) as { appDefinition?: unknown };
      grants = resolvePreviewRoles(grants, entry.appDefinition);
    } finally { await rm(workDir, { recursive: true, force: true }); }
  }
  await ensureIdentitySchema(db);
  const identity = createD1IdentityStore(db);
  const cedar = await identity.createTeam({});
  const oak = await identity.createTeam({});
  const profiles = [
    { label: "Ava", email: "ava@preview.can.test", teams: ["Cedar"] as const, teamId: cedar.team_id, owner: true },
    { label: "Ben", email: "ben@preview.can.test", teams: ["Cedar"] as const, teamId: cedar.team_id, owner: false },
    { label: "Cal", email: "cal@preview.can.test", teams: ["Oak"] as const, teamId: oak.team_id, owner: true },
    { label: "Dee", email: "dee@preview.can.test", teams: [] as const, teamId: null, owner: false },
  ];
  const actors: Array<{ label: string; email: string; password: string; teams: readonly string[] }> = [];
  for (const profile of profiles) {
    const password = randomBytes(24).toString("base64url");
    const user = await identity.createUser({
      email: profile.email, password_hash: await hashPassword(password), email_verified: true,
    });
    if (profile.teamId !== null) {
      await identity.createMembership({
        team_id: profile.teamId, user_id: user.user_id, is_owner: profile.owner, roles: [],
      });
    }
    actors.push(Object.freeze({ label: profile.label, email: profile.email, password,
      teams: Object.freeze([...profile.teams]) }));
  }
  // Grants run through Identity's real current-owner API after all accounts
  // exist. Team ownership alone never implies an authored business role.
  for (const [label, roles] of Object.entries(grants)) {
    if (roles.length === 0) continue;
    const profile = profiles.find(item => item.label === label)!;
    if (profile.teamId === null) throw new Error("preview role actor must belong to a seeded team");
    const target = (await identity.findUserByEmail(profile.email))!;
    const ownerProfile = profiles.find(item => item.teamId === profile.teamId && item.owner)!;
    const owner = (await identity.findUserByEmail(ownerProfile.email))!;
    for (const role of roles) await setMemberRole(identity, {
      team_id: profile.teamId, member_user_id: target.user_id, role,
    }, { granted_by: owner.user_id });
  }
  const ava = actors[0]!;
  return { actors: Object.freeze(actors), probe: { email: ava.email, password: ava.password, teamId: cedar.team_id },
    owners: Object.freeze([
      Object.freeze({ owner: cedar.team_id, binding: "STATE_CEDAR_DB" }),
      Object.freeze({ owner: oak.team_id, binding: "STATE_OAK_DB" }),
    ]) };
}

/** Each actual local preview receives a private generated-form binding key. */
export function localPreviewWorkerVars(): Readonly<Record<string, unknown>> {
  return { CAN_FORM_BINDING_KEY: randomBytes(32).toString("base64url") };
}

/** Host hook injected into the session owner; no caller can supply `active:true`. */
export function createInstalledLocalPreviewBuilder(previewRoles: PreviewRoles = {}, runtimeImplementations: LocalBindingImplementations = {},
  target: Pick<LocalPreviewBuilderOptions, "externalOrigin" | "onAllocated" | "persistenceRoot"> = {}) {
  const roles = parsePreviewRoles(previewRoles);
  return createLocalPreviewBuilder({
    persistenceRoot: defaultPreviewStateRoot(),
    ...target,
    runtimeImplementations,
    resources: {
      d1: { binding: BINDING_NAME, availability: "real_local" },
      identity: { backingBinding: BINDING_NAME, availability: "real_local" },
    },
    activationVerdict: (artifact, capture) => preflightLocalPreviewActivation(artifact, capture, runtimeImplementations, target.onAllocated),
    confirmRunningActivation: (artifact, capture, db, id, owner, identityDb) => localPreviewActivationVerdict(artifact, capture, db, id, owner, identityDb, runtimeImplementations),
    produceBundle: produceInstalledPortableBundle,
    seedLocalActors: (db, artifact, capture) => seedLocalPreviewActors(db, roles, artifact, capture),
    workerVarsForOrigin: localPreviewWorkerVars,
  });
}
