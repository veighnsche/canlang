/**
 * Local preview admission for the first one-file D1/Identity profile.
 * The package producer supplies a portable bundle and its complete consumed
 * input inventory; the session owns capture, revisions, and promotion.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivationVerdict, CompileArtifact } from "@canlang/contracts";
import { CSRF_FIELD, PRESESSION_FIELD, TEAM_FIELD } from "@canlang/contracts";
import { deriveCsrfToken, parseSessionCookie } from "@canlang/identity";
import {
  assertLinksResolve,
  assertWorkerdLoadable,
  bundleMixedSha256,
  inventorizeAssets,
  type PackageDeployBundle,
} from "../deploy/bundle.js";
import { PINNED_COMPATIBILITY_DATE } from "./zero-config.js";
import { startLocalDev, type LocalDev } from "./local-run.js";
import type { D1Database } from "@cloudflare/workers-types";
import { startProtectedPreview, type ProtectedPreview } from "./preview-bridge.js";
import {
  captureIsCurrent,
  verifyCompilerSources,
  type CapturedFileIdentity,
  type SingleFileCapture,
} from "./source-capture.js";
import type { SessionServicePreview } from "./session-service.js";
import type { CompiledExampleInput } from "./example-runner.js";

const PROFILE = "local-d1-identity";
const BROWSER_KEYS = ["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"] as const;
export const LOCAL_PREVIEW_CAPABILITIES = [
  "canlang.builtins", "values.decimal", "values.int64", "values.money", "values.temporal", "state",
  "state.machines", "state.parameters", "interfaces.input-choices",
] as const;
const PROFILE_CAPABILITIES = new Set<string>(LOCAL_PREVIEW_CAPABILITIES);
const SHA256 = /^[a-f0-9]{64}$/;

export class PreviewAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreviewAdmissionError";
  }
}

/** Availability is explicit even when a resource has no local implementation. */
export interface LocalPreviewResources {
  readonly d1?: { readonly binding: string; readonly availability: "real_local" | "simulated" | "unavailable" };
  /** Identity is the production D1-backed service, not a synthetic caller. */
  readonly identity?: { readonly backingBinding: string; readonly availability: "real_local" | "simulated" | "unavailable" };
}

/**
 * T06 producer evidence. `consumedInputs` must enumerate every installed
 * package output read to produce this bundle, with the same logical names as
 * the immutable capture. The producer, not an agent request, owns this claim.
 */
export interface PortableBundleEvidence {
  readonly bundle: PackageDeployBundle;
  readonly captureEpochMaterial: string;
  /** Hash of the parsed artifact's JSON serialization, not compiler stdout bytes. */
  readonly artifactJsonSha256: string;
  readonly consumedInputs: readonly Pick<CapturedFileIdentity, "name" | "canonicalPath" | "sha256" | "bytes">[];
}

export interface LocalPreviewBundleRequest {
  readonly artifact: CompileArtifact;
  readonly capture: SingleFileCapture;
  /** Derived only after source, capability and resource admission. */
  readonly verdict: ActivationVerdict & { readonly active: true };
  readonly assets: { readonly browser: true; readonly valuesWasm: boolean };
}

export interface LocalPreviewBuilderOptions {
  readonly resources: LocalPreviewResources;
  /** Trusted T06 producer runs the actual activation gates for this local build. */
  readonly activationVerdict?: (artifact: CompileArtifact, capture: SingleFileCapture) => Promise<ActivationVerdict>;
  /** Recheck the same gates on the serving Worker's actual DB before exposure. */
  readonly confirmRunningActivation?: (artifact: CompileArtifact, capture: SingleFileCapture, db: D1Database, databaseId: string, owner?: string, identities?: D1Database) => Promise<ActivationVerdict>;
  /** Trusted installed-package producer. No provider means no ready preview. */
  readonly produceBundle?: (request: LocalPreviewBundleRequest) => Promise<PortableBundleEvidence>;
  /** T06 host configuration, called only after the protected loopback origin exists. */
  readonly workerVarsForOrigin?: (origin: string) => Readonly<Record<string, unknown>>;
  /** Real D1 Identity seed; its credentials are disclosed only by preview.open. */
  readonly seedLocalActors?: (db: D1Database) => Promise<LocalPreviewSeed>;
}

export interface LocalPreviewActor {
  readonly label: string;
  readonly email: string;
  readonly password: string;
  readonly teams: readonly string[];
}

export interface LocalPreviewSeed {
  readonly actors: readonly LocalPreviewActor[];
  readonly probe: { readonly email: string; readonly password: string; readonly teamId: string };
  /** Trusted Identity producer output; never selected by browser request data. */
  readonly owners: readonly { readonly owner: string; readonly binding: string }[];
}

export type LocalPreviewWithActors = SessionServicePreview & {
  issueLocalActors(): readonly LocalPreviewActor[];
  exampleInput(): LocalPreviewExampleInput;
};

export type LocalPreviewExampleInput = Omit<CompiledExampleInput, "selectedRow" | "runId" | "testkit">;

function fail(code: string, message: string): never {
  throw new PreviewAdmissionError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function admitPreviewInputs(artifact: CompileArtifact, capture: SingleFileCapture, resources: LocalPreviewResources): void {
  if (capture.profile !== PROFILE) fail("PROFILE_UNSUPPORTED", `preview profile ${capture.profile} is unsupported`);
  const source = verifyCompilerSources(capture, { complete: true, sources: artifact.sources });
  if (!source.ok) fail("SOURCE_MISMATCH", `preview artifact source ${source.reason}`);
  if (resources.d1?.binding !== "DB" || resources.d1.availability !== "real_local") {
    fail("D1_UNAVAILABLE", "preview requires a real local D1 binding named DB");
  }
  if (resources.identity?.backingBinding !== "DB" || resources.identity.availability !== "real_local") {
    fail("IDENTITY_UNAVAILABLE", "preview requires real local Identity backed by DB");
  }
  for (const name of ["compiler", "catalog", "help-index"]) {
    if (!capture.inputs.some(input => input.name === name && input.state === "present")) {
      fail("INPUT_UNAVAILABLE", `preview requires captured ${name} input`);
    }
  }
  if (!capture.inputs.some(input => input.name.startsWith("package:") && input.state === "present")) {
    fail("INPUT_UNAVAILABLE", "preview requires captured package outputs");
  }
  if (artifact.pages.length === 0 || (artifact.operations?.length ?? 0) === 0) {
    fail("PROFILE_UNSUPPORTED", "preview profile requires a page and business operations");
  }
  if (artifact.callables.some(callable => callable.kind === "handler" || callable.kind === "migration")) {
    fail("PROFILE_UNSUPPORTED", "preview profile does not admit scheduled handlers or migrations");
  }
  for (const requirement of artifact.requires) {
    const supportedVersion = requirement.capability === "canlang.builtins" ? 0 : 1;
    if (!PROFILE_CAPABILITIES.has(requirement.capability) || requirement.min_version !== supportedVersion) {
      fail("CAPABILITY_UNAVAILABLE", `preview cannot admit ${requirement.capability}@${requirement.min_version}`);
    }
  }
}

async function admittedVerdict(
  artifact: CompileArtifact, capture: SingleFileCapture, options: LocalPreviewBuilderOptions,
): Promise<ActivationVerdict & { active: true }> {
  admitPreviewInputs(artifact, capture, options.resources);
  if (options.activationVerdict === undefined) {
    fail("ACTIVATION_UNAVAILABLE", "installed activation gate producer is unavailable");
  }
  const verdict = await options.activationVerdict(artifact, capture);
  if (verdict?.active !== true) {
    fail("ACTIVATION_REFUSED", "installed activation gates did not admit this preview build");
  }
  return verdict;
}

function compareInputEvidence(capture: SingleFileCapture, evidence: PortableBundleEvidence): void {
  if (evidence.captureEpochMaterial !== capture.epochMaterial) {
    fail("BUNDLE_REVISION_MISMATCH", "portable bundle was built for another captured revision");
  }
  const selected = capture.inputs.filter(input => input.name.startsWith("package:") || input.name.startsWith("extra:"));
  const observed = [...evidence.consumedInputs].sort((a, b) => a.name.localeCompare(b.name));
  const expected = [...selected].sort((a, b) => a.name.localeCompare(b.name));
  if (observed.length === 0 || observed.length !== expected.length) {
    fail("BUNDLE_INPUTS_INCOMPLETE", "portable bundle input inventory does not cover captured package outputs");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = observed[index];
    const input = expected[index];
    if (actual === undefined || input === undefined || input.state !== "present" || !SHA256.test(actual.sha256 ?? "") ||
        actual.name !== input.name || actual.canonicalPath !== input.canonicalPath ||
        actual.sha256 !== input.sha256 || actual.bytes !== input.bytes) {
      fail("BUNDLE_INPUTS_INCOMPLETE", "portable bundle consumed inputs differ from the captured package outputs");
    }
  }
}

function resourcesSha256(resources: PackageDeployBundle["resources"]): string {
  const rows = Object.keys(resources).sort().map(key => {
    const resource = resources[key];
    if (resource === undefined || !(resource.bytes instanceof Uint8Array) || typeof resource.contentType !== "string") {
      fail("RESOURCE_INVALID", `invalid browser resource ${key}`);
    }
    return { key, contentType: resource.contentType, bytes: resource.bytes.length, sha256: sha256(resource.bytes) };
  });
  return sha256(JSON.stringify({ version: 1, resources: rows }));
}

function snapshotBundle(source: PackageDeployBundle): PackageDeployBundle {
  return {
    ...source,
    modules: { ...source.modules },
    binaries: Object.fromEntries(Object.entries(source.binaries).map(([key, bytes]) => [key, new Uint8Array(bytes)])),
    resources: Object.fromEntries(Object.entries(source.resources).map(([key, resource]) =>
      [key, { bytes: new Uint8Array(resource.bytes), contentType: resource.contentType }])),
  };
}

function verifyBundle(artifact: CompileArtifact, capture: SingleFileCapture, evidence: PortableBundleEvidence): PackageDeployBundle {
  if (evidence.artifactJsonSha256 !== sha256(JSON.stringify(artifact))) {
    fail("BUNDLE_ARTIFACT_MISMATCH", "portable bundle artifact digest differs from checked artifact");
  }
  compareInputEvidence(capture, evidence);
  // Copy before checking: the checked bytes are exactly those later staged.
  let bundle: PackageDeployBundle;
  try { bundle = snapshotBundle(evidence.bundle); }
  catch { fail("BUNDLE_INVALID", "portable bundle module, binary or resource inventory is missing"); }
  if (bundle.mainModule !== "worker/main.js" || bundle.moduleCount !== Object.keys(bundle.modules).length ||
      bundle.modules[bundle.mainModule] === undefined || bundle.modules["worker/artifact.js"] === undefined ||
      bundle.modules["worker/http-assets.js"] === undefined || bundle.modules["worker/mcp-handler.js"] === undefined ||
      bundle.modules["worker/http-operations.js"] === undefined) {
    fail("BUNDLE_INVALID", "portable bundle lacks required Worker modules");
  }
  const sorted = Object.fromEntries(Object.entries(bundle.modules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (bundle.sha256 !== sha256(JSON.stringify({ mainModule: bundle.mainModule, modules: sorted })) ||
      bundle.mcpBundleBytes !== bundle.modules["worker/mcp-handler.js"]!.length ||
      bundle.httpOperationsBytes !== bundle.modules["worker/http-operations.js"]!.length ||
      bundle.mcpBundleBytes === 0 || bundle.httpOperationsBytes === 0 ||
      bundle.mixedSha256 !== bundleMixedSha256(bundle.mainModule, inventorizeAssets(bundle.modules, bundle.binaries))) {
    fail("BUNDLE_INTEGRITY", "portable bundle module or binary digest is invalid");
  }
  const staged = bundle.modules["worker/artifact.js"]!;
  if (!staged.split("\n").includes(`export const artifact = ${JSON.stringify(artifact)};`) ||
      !staged.split("\n").includes('export const verdict = {"active":true};')) {
    fail("BUNDLE_ARTIFACT_MISMATCH", "portable bundle does not stage the admitted artifact and verdict");
  }
  const keys = Object.keys(bundle.resources).sort();
  if (keys.join("\n") !== [...BROWSER_KEYS].sort().join("\n") ||
      bundle.resourcesSha256 !== resourcesSha256(bundle.resources) ||
      !staged.includes(`"resourcesSha256":"${bundle.resourcesSha256}"`)) {
    fail("RESOURCE_INVALID", "portable bundle lacks exact packaged browser resource evidence");
  }
  for (const key of BROWSER_KEYS) {
    const contentType = key.endsWith(".css") ? "text/css" : "application/javascript";
    if (bundle.resources[key]?.contentType !== contentType || bundle.resources[key]!.bytes.length === 0) {
      fail("RESOURCE_INVALID", `packaged browser resource ${key} is invalid`);
    }
  }
  assertWorkerdLoadable(bundle.modules);
  assertLinksResolve(bundle.modules, Object.keys(bundle.binaries));
  return bundle;
}

/** The bridge-selected origin is authoritative for production auth setup. */
export function selectPreviewWorkerVars(options: LocalPreviewBuilderOptions, origin: string): Readonly<Record<string, unknown>> {
  let selected: URL;
  try { selected = new URL(origin); }
  catch { fail("ORIGIN_INVALID", "preview bridge did not select a valid origin"); }
  if (selected.protocol !== "http:" || selected.hostname !== "127.0.0.1" || !selected.port ||
      selected.pathname !== "/" || selected.search || selected.hash || selected.username || selected.password) {
    fail("ORIGIN_INVALID", "preview auth origin must be the selected loopback address");
  }
  const vars = options.workerVarsForOrigin?.(origin);
  if (vars !== undefined && (vars === null || typeof vars !== "object" || Array.isArray(vars))) {
    fail("RESOURCE_INVALID", "preview Worker vars must be an object");
  }
  if (vars !== undefined && Object.keys(vars).some(key => [
    "DB", "STATE_DB", "STATE_CEDAR_DB", "STATE_OAK_DB", "CAN_STATE_OWNER", "CAN_STATE_OWNERS", "CAN_STATE_INITIALIZE_FRESH", "CAN_AUTH_ORIGIN",
  ].includes(key))) {
    fail("RESOURCE_INVALID", "preview Worker vars cannot replace D1, owner or selected auth origin bindings");
  }
  return Object.freeze({ ...(vars ?? {}), CAN_AUTH_ORIGIN: origin });
}

async function probeWorker(dev: LocalDev, bundle: PackageDeployBundle, origin: string, seed: LocalPreviewSeed): Promise<void> {
  const db = await dev.getD1Database("DB");
  const row = await db.prepare("SELECT 1 AS ready").first<{ ready: number }>();
  if (row?.ready !== 1) fail("D1_UNAVAILABLE", "real local DB binding did not answer a query");
  const auth = await dev.dispatchUrl(`${origin}/auth/login`, { method: "GET" });
  if (auth.status !== 200 || !(auth.headers.get("content-type") ?? "").startsWith("application/json")) {
    fail("IDENTITY_UNAVAILABLE", `installed Identity login descriptor returned HTTP ${auth.status}`);
  }
  let descriptor: unknown;
  try { descriptor = await auth.json(); } catch { fail("IDENTITY_UNAVAILABLE", "installed Identity login descriptor is invalid JSON"); }
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor) ||
      (descriptor as Record<string, unknown>)["form"] !== "login" ||
      (descriptor as Record<string, unknown>)["postTo"] !== "/auth/login" ||
      typeof (descriptor as Record<string, unknown>)["preSessionToken"] !== "string" ||
      !((descriptor as Record<string, unknown>)["preSessionToken"] as string)) {
    fail("IDENTITY_UNAVAILABLE", "installed Identity login descriptor or D1 token is missing");
  }
  const login = await dev.dispatchUrl(`${origin}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: seed.probe.email, password: seed.probe.password,
      [PRESESSION_FIELD]: (descriptor as Record<string, unknown>)["preSessionToken"] }),
  });
  const sessionCookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  const sessionToken = sessionCookie === undefined ? null : parseSessionCookie(sessionCookie);
  if (login.status !== 200 || sessionCookie === undefined || sessionToken === null) {
    fail("IDENTITY_UNAVAILABLE", `seeded member login returned HTTP ${login.status} without an app session`);
  }
  const csrf = await deriveCsrfToken(sessionToken);
  const selection = await dev.dispatchUrl(`${origin}/auth/select-team`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrf },
    body: JSON.stringify({ [TEAM_FIELD]: seed.probe.teamId, [CSRF_FIELD]: csrf }),
  });
  if (selection.status !== 200) {
    fail("IDENTITY_UNAVAILABLE", `seeded member team selection returned HTTP ${selection.status}`);
  }
  const grantResponse = await dev.dispatchUrl(`${origin}/mcp/grants`, {
    method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ client_id: "can-dev-local-probe" }),
  });
  let granted: unknown;
  try { granted = await grantResponse.json(); } catch { /* checked below */ }
  const grant = typeof granted === "object" && granted !== null && !Array.isArray(granted)
    ? (granted as Record<string, unknown>)["token"] : undefined;
  if (grantResponse.status !== 200 || typeof grant !== "string" || grant.length === 0) {
    fail("MCP_UNAVAILABLE", `seeded member MCP grant returned HTTP ${grantResponse.status}`);
  }
  const discovery = await dev.dispatchUrl(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: `Bearer ${grant}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  let discovered: unknown;
  try { discovered = await discovery.json(); } catch { /* checked below */ }
  const tools = typeof discovered === "object" && discovered !== null && !Array.isArray(discovered)
    ? (discovered as Record<string, unknown>)["result"] : undefined;
  const listed = typeof tools === "object" && tools !== null && !Array.isArray(tools)
    ? (tools as Record<string, unknown>)["tools"] : undefined;
  if (discovery.status !== 200 || !Array.isArray(listed) || listed.length === 0) {
    fail("MCP_UNAVAILABLE", `seeded member business MCP discovery returned HTTP ${discovery.status} without tools`);
  }
  const mcp = await dev.dispatchUrl(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (mcp.status !== 401 || !(mcp.headers.get("content-type") ?? "").startsWith("application/json")) {
    fail("MCP_UNAVAILABLE", `installed business MCP route did not refuse an anonymous caller (HTTP ${mcp.status})`);
  }
  for (const key of BROWSER_KEYS) {
    const response = await dev.dispatchUrl(`${origin}/assets/${key}`, { method: "GET" });
    const expected = bundle.resources[key]!;
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith(expected.contentType) ||
        sha256(new Uint8Array(await response.arrayBuffer())) !== sha256(expected.bytes)) {
      fail("RESOURCE_INVALID", `installed Worker did not serve packaged ${key} bytes`);
    }
  }
  const page = await dev.dispatchUrl(`${origin}/`, { method: "GET", headers: { cookie: sessionCookie } });
  if (page.status !== 200 || !(page.headers.get("content-type") ?? "").startsWith("text/html")) {
    fail("PAGE_UNAVAILABLE", `installed page route returned HTTP ${page.status}`);
  }
}

/**
 * Return the session-service previewBuilder hook. A build is offered for
 * promotion only after all probes and the protected bridge are ready.
 */
export function createLocalPreviewBuilder(options: LocalPreviewBuilderOptions):
  (artifact: CompileArtifact, capture: SingleFileCapture, artifactBytes?: Uint8Array) => Promise<LocalPreviewWithActors> {
  return async (artifact, capture, artifactBytes) => {
    const verdict = await admittedVerdict(artifact, capture, options);
    if (!(await captureIsCurrent(capture))) fail("SOURCE_CHANGED", "preview capture changed before build");
    if (options.produceBundle === undefined) fail("PORTABLE_BUNDLE_UNAVAILABLE", "no verified installed-package bundle producer is configured");
    const evidence = await options.produceBundle({
      artifact, capture, verdict,
      assets: { browser: true, valuesWasm: artifact.requires.some(item => item.capability.startsWith("values.")) },
    });
    const bundle = verifyBundle(artifact, capture, evidence);
    if (!(artifactBytes instanceof Uint8Array) || artifactBytes.length === 0 || artifactBytes.length > 16 * 1024 * 1024) {
      fail("ARTIFACT_BYTES_UNAVAILABLE", "exact verified compiler artifact bytes are unavailable");
    }
    let parsedBytes: unknown;
    try { parsedBytes = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes)) as unknown; }
    catch { fail("ARTIFACT_BYTES_INVALID", "verified compiler artifact bytes are not UTF-8 JSON"); }
    if (JSON.stringify(parsedBytes) !== JSON.stringify(artifact)) {
      fail("ARTIFACT_BYTES_MISMATCH", "verified compiler artifact bytes differ from the admitted artifact");
    }
    if (!(await captureIsCurrent(capture))) fail("SOURCE_CHANGED", "preview inputs changed during bundle production");
    let worker: LocalDev | null = null;
    let bridge: ProtectedPreview | null = null;
    let persistence: string | null = null;
    try {
      // The bridge is inaccessible until issueOpenUrl is returned after all
      // probes. Its chosen origin can therefore configure the real auth host.
      bridge = await startProtectedPreview({
        dispatchUrl(url, init) {
          if (worker === null) return Promise.reject(new Error("preview Worker is starting"));
          return worker.dispatchUrl(url, init);
        },
      });
      const vars = selectPreviewWorkerVars(options, bridge.url);
      const databaseId = `can-preview-${randomUUID()}`;
      if (options.seedLocalActors === undefined) {
        fail("IDENTITY_UNAVAILABLE", "real local Identity seed producer is unavailable");
      }
      persistence = await mkdtemp(join(tmpdir(), "can-preview-d1-"));
      const provisioning = await startLocalDev({
        workerName: `can-preview-provision-${randomUUID()}`,
        compatibilityDate: PINNED_COMPATIBILITY_DATE,
        mainModule: "provision.js",
        modules: { "provision.js": "export default { fetch() { return new Response(null, {status:404}); } };" },
        d1Databases: [{ binding: "DB", id: databaseId }],
        d1Persist: persistence,
      });
      let seed: LocalPreviewSeed;
      try { seed = await options.seedLocalActors(await provisioning.getD1Database("DB")); }
      finally { await provisioning.dispose(); }
      if (seed.actors.length !== 4 || !seed.actors.some(actor => actor.email === seed.probe.email && actor.password === seed.probe.password) ||
          seed.owners.length !== 2 || new Set(seed.owners.map(owner => owner.owner)).size !== 2 ||
          new Set(seed.owners.map(owner => owner.binding)).size !== 2 ||
          !seed.owners.some(owner => owner.owner === seed.probe.teamId) ||
          seed.owners.some(owner => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner.owner) ||
            !["STATE_CEDAR_DB", "STATE_OAK_DB"].includes(owner.binding))) {
        fail("IDENTITY_UNAVAILABLE", "real local Identity seed did not provide the expected isolated team matrix");
      }
      const ownerDatabases = (artifact.models === undefined || artifact.models.length === 0 ? [] : seed.owners)
        .map(owner => ({ ...owner, id: `can-preview-owner-${randomUUID()}` }));
      worker = await startLocalDev({
        workerName: `can-preview-${randomUUID()}`,
        compatibilityDate: PINNED_COMPATIBILITY_DATE,
        mainModule: bundle.mainModule,
        modules: bundle.modules,
        binaryModules: bundle.binaries,
        d1Databases: [{ binding: "DB", id: databaseId }, ...ownerDatabases.map(owner => ({ binding: owner.binding, id: owner.id }))],
        d1Persist: persistence,
        vars: { ...vars, ...(ownerDatabases.length === 0 ? {} : { CAN_STATE_OWNERS: { version: 1, owners: ownerDatabases.map(owner => ({
          owner: owner.owner, binding: owner.binding, initializeFresh: true,
        })) } }) },
      });
      if (options.confirmRunningActivation === undefined) {
        fail("ACTIVATION_UNAVAILABLE", "serving D1 activation confirmation is unavailable");
      }
      if (ownerDatabases.length === 0) {
        const runningVerdict = await options.confirmRunningActivation(artifact, capture,
          await worker.getD1Database("DB"), databaseId);
        if (runningVerdict.active !== true) {
          fail("ACTIVATION_REFUSED", "serving global D1 activation gates refused this preview build");
        }
      }
      for (const owner of ownerDatabases) {
        const runningVerdict = await options.confirmRunningActivation(artifact, capture,
          await worker.getD1Database(owner.binding), owner.id, owner.owner, await worker.getD1Database("DB"));
        if (runningVerdict.active !== true) {
          fail("ACTIVATION_REFUSED", "serving owner D1 activation gates refused this preview build");
        }
      }
      await probeWorker(worker, bundle, bridge.url, seed);
      if (!(await captureIsCurrent(capture))) fail("SOURCE_CHANGED", "preview inputs changed during startup");
      const protectedBridge = bridge;
      const builtWorker = worker;
      const builtBundle = bundle;
      const ownedPersistence = persistence;
      const exactArtifactBytes = new Uint8Array(artifactBytes);
      const workerName = `can-preview-examples-${randomUUID()}`;
      let actors: readonly LocalPreviewActor[] | null = seed.actors;
      let disposing: Promise<void> | null = null;
      return {
        id: `preview-${randomUUID()}`,
        issueOpenUrl: () => protectedBridge.issueOpenUrl(),
        observeRefusals: handler => protectedBridge.observeRefusals(handler),
        issueLocalActors: () => {
          if (actors === null) throw new Error("local preview actors are unavailable after disposal");
          return actors.map(actor => ({ ...actor, teams: [...actor.teams] }));
        },
        exampleInput: () => {
          if (actors === null) throw new Error("local preview examples are unavailable after disposal");
          return {
            artifactBytes: new Uint8Array(exactArtifactBytes),
            artifactLabel: capture.compilerOperand,
            sourceRevision: capture.sourceRevision,
            worker: {
              mainModule: builtBundle.mainModule,
              modules: { ...builtBundle.modules },
              binaryModules: Object.fromEntries(Object.entries(builtBundle.binaries)
                .map(([key, bytes]) => [key, new Uint8Array(bytes)])),
            },
            workerName,
            compatibilityDate: PINNED_COMPATIBILITY_DATE,
            d1Binding: "DB",
          };
        },
        dispose() {
          if (disposing !== null) return disposing;
          actors = null;
          disposing = (async () => {
            try { await protectedBridge.close(); }
            finally { try { await builtWorker.dispose(); } finally { await rm(ownedPersistence, { recursive: true, force: true }); } }
          })();
          return disposing;
        },
      };
    } catch (error) {
      try { await bridge?.close(); }
      finally { try { await worker?.dispose(); } finally {
        if (persistence !== null) await rm(persistence, { recursive: true, force: true });
      } }
      throw error;
    }
  };
}
