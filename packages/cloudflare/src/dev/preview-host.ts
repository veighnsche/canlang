/** Real installed producers for the first local D1/Identity preview profile. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CONTRACTS_VERSION, type ActivationVerdict, type CompileArtifact, type CompatibilityDescriptor, type EnvironmentSelection } from "@canlang/contracts";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import { createD1IdentityStore, ensureIdentitySchema, hashPassword } from "@canlang/identity";
import { checkActivationInventory } from "@canlang/state/migration/activate";
import { buildWorkInventory } from "@canlang/work/recovery";
import { activate } from "../deploy/activate.js";
import { buildDeployBundleWithAssets } from "../deploy/bundle.js";
import { probeInstalledRuntime } from "../deploy/installed.js";
import { RELEASE_VERSION } from "../release/stamp.js";
import { startLocalDev } from "./local-run.js";
import { LOCAL_PREVIEW_CAPABILITIES, PreviewAdmissionError, createLocalPreviewBuilder, type LocalPreviewBundleRequest, type LocalPreviewSeed, type PortableBundleEvidence } from "./preview-builder.js";
import { assertInstalledCatalog, bunExecutable, compilerSourceInputs, installedOwnedSourceInputs, installedPortableBundleInputs } from "./preview-inputs.js";
import { captureIsCurrent, type SingleFileCapture } from "./source-capture.js";
import { PINNED_COMPATIBILITY_DATE } from "./zero-config.js";

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

function activationInput(artifact: CompileArtifact, capture: SingleFileCapture, databaseId: string): {
  descriptor: CompatibilityDescriptor; environment: EnvironmentSelection;
} {
  if (artifact.tool_version !== RELEASE_VERSION || artifact.language_version !== "1.0") {
    throw new PreviewAdmissionError("VERSION_MISMATCH", "compiled app does not match the installed local runtime release");
  }
  const requirement = { binding: BINDING_NAME, kind: "d1" as const, logicalName: "local-preview-db" };
  return {
    descriptor: {
      identity: {
        appName: appName(capture), sourceRevision: capture.sourceRevision,
        languageVersion: artifact.language_version, compilerVersion: artifact.tool_version,
        contractsVersion: CONTRACTS_VERSION, artifactDigest: digest(JSON.stringify(artifact)),
      },
      requiredCapabilities: artifact.requires.map(item => item.capability),
      resourceBindings: [requirement], secrets: [], schedules: [],
    },
    environment: {
      environment: "local-preview", resources: [{ requirement, resourceId: databaseId }],
      secretsPresent: [], vars: {},
    },
  };
}

/** Check the actual D1 store with all four installed activation gates. */
export async function localPreviewActivationVerdict(
  artifact: CompileArtifact, capture: SingleFileCapture, db: D1Database, databaseId: string,
): Promise<ActivationVerdict> {
  const { descriptor, environment } = activationInput(artifact, capture, databaseId);
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
  return activate({
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
}

/** The prebuild gate runs on a real, isolated local D1 binding. */
export async function preflightLocalPreviewActivation(
  artifact: CompileArtifact, capture: SingleFileCapture,
): Promise<ActivationVerdict> {
  checkedInstalledInputs(capture);
  if (!(await captureIsCurrent(capture))) {
    throw new PreviewAdmissionError("SOURCE_CHANGED", "preview inputs changed before activation");
  }
  const databaseId = `can-preview-preflight-${randomUUID()}`;
  const dev = await startLocalDev({
    workerName: `can-preview-preflight-${randomUUID()}`,
    compatibilityDate: PINNED_COMPATIBILITY_DATE,
    mainModule: "main.js",
    modules: { "main.js": "export default { fetch() { return new Response(null, { status: 404 }); } };" },
    d1Databases: [{ binding: BINDING_NAME, id: databaseId }],
  });
  try {
    return await localPreviewActivationVerdict(artifact, capture, await dev.getD1Database(BINDING_NAME), databaseId);
  } finally {
    await dev.dispose();
  }
}

function checkedInstalledInputs(capture: SingleFileCapture): PortableBundleEvidence["consumedInputs"] {
  const expected = installedPortableBundleInputs();
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
  const bun = capture.inputs.find(input => input.name === "extra:bun");
  if (bun?.state !== "present" || bun.canonicalPath !== bunExecutable()) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "bundler executable was not captured");
  }
  const grammar = capture.inputs.find(input => input.name === "extra:grammar");
  if (grammar?.state !== "present" || grammar.canonicalPath !== realpathSync(join(capture.root, "docs/specification/GRAMMAR.md"))) {
    throw new PreviewAdmissionError("BUNDLE_INPUTS_INCOMPLETE", "installed grammar reference was not captured");
  }
  const sourceInputs = installedOwnedSourceInputs();
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
  return capture.inputs.filter(input => input.name.startsWith("package:") || input.name.startsWith("extra:"));
}

/** Build the real portable module map from the captured installed outputs. */
export async function produceInstalledPortableBundle(request: LocalPreviewBundleRequest): Promise<PortableBundleEvidence> {
  const { artifact, capture, verdict, assets } = request;
  const consumedInputs = checkedInstalledInputs(capture);
  if (!(await captureIsCurrent(capture))) {
    throw new PreviewAdmissionError("SOURCE_CHANGED", "installed package input changed before portable bundling");
  }
  const bundle = buildDeployBundleWithAssets(artifact, { verdict, assets });
  if (!(await captureIsCurrent(capture))) {
    throw new PreviewAdmissionError("SOURCE_CHANGED", "installed package input changed during portable bundling");
  }
  return {
    bundle, captureEpochMaterial: capture.epochMaterial,
    artifactJsonSha256: digest(JSON.stringify(artifact)), consumedInputs,
  };
}

/** Seed ordinary verified users and memberships into the serving Identity D1. */
export async function seedLocalPreviewActors(db: D1Database): Promise<LocalPreviewSeed> {
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
  const ava = actors[0]!;
  return { actors: Object.freeze(actors), probe: { email: ava.email, password: ava.password, teamId: cedar.team_id } };
}

/** Host hook injected into the session owner; no caller can supply `active:true`. */
export function createInstalledLocalPreviewBuilder() {
  return createLocalPreviewBuilder({
    resources: {
      d1: { binding: BINDING_NAME, availability: "real_local" },
      identity: { backingBinding: BINDING_NAME, availability: "real_local" },
    },
    activationVerdict: preflightLocalPreviewActivation,
    confirmRunningActivation: localPreviewActivationVerdict,
    produceBundle: produceInstalledPortableBundle,
    seedLocalActors: seedLocalPreviewActors,
  });
}
