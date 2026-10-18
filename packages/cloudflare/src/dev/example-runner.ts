/**
 * Compiled artifact -> isolated example rows. The testkit functions are
 * injected by the CLI/session host because testkit already depends on this
 * package; importing it here would make a package cycle. No example logic is
 * reimplemented: the owning loader, table runner and report builder decide
 * row outcomes.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactOperationInput, ArtifactModelField, ClosedInputs, CompileArtifact, ExampleCaseResult, ExampleReport, FqOperationName, ModelName, OperationId, RecordId, RecordParent, ReportValue, ResolvedCaller, ResolvedIdentity, StoragePort, StoredRow, TableCaseResult } from "@canlang/contracts";
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText, toInstant, type IdentityStore } from "@canlang/identity";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import { createD1OwnerRouter } from "@canlang/state/storage/owner-router";
import { decodeValue, encodeValue, validateValue, parseTypeId, printTypeId, isUserRef, isDatetime, isRecordRef, type NormalizedSchema } from "@canlang/values";
import { cleanupAfterFailure, DevCleanupError } from "./cleanup.js";
import { RuntimeExampleResources } from "./runtime-host-example-resources.js";
import { createLocalRowScope, type LocalRowScope } from "./row-scope.js";
import { resolveExampleFixtureImports } from "./example-fixture-imports.js";
import { parseArtifactText } from "../runtime/artifact.js";
import { assembleModules, type AssembledModules } from "../runtime/modules.js";
import { invokeReadCanonical, loadCanonicalDescriptors, materializeCanonicalExampleSnapshots } from "../runtime/invoke.js";
import { bindNativeRecord } from "../runtime/native-records.js";
import type { CanonicalEffectsScope, CanonicalReadQuery } from "../runtime/context.js";
import { buildInvoker, createTeamOwnerStorageBoundary, type TeamOwnerStorageBoundary } from "../worker/assembly.js";

/** Structural port to the real @canlang/testkit exports; no runtime edge. */
export interface ExampleTestkitPort {
  readonly loadExampleSuite: Function;
  readonly runTable: Function;
  readonly createReport: Function;
  readonly fixtureValuesOf: Function;
}

export class MissingExampleTestkitError extends Error {
  constructor() {
    super("example runner: install @canlang/testkit to execute compiled behavior rows");
    this.name = "MissingExampleTestkitError";
  }
}

/** Prefer the application's producer, then the producer shipped with this runtime. */
export async function loadInstalledExampleTestkit(applicationRoot: string): Promise<ExampleTestkitPort> {
  let entry: string;
  try {
    entry = createRequire(resolve(applicationRoot, "package.json")).resolve("@canlang/testkit");
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND" ||
        error.message.split("\n", 1)[0] !== "Cannot find module '@canlang/testkit'") throw error;
    try { entry = createRequire(import.meta.url).resolve("@canlang/testkit"); }
    catch (fallbackError) {
      if (fallbackError instanceof Error && (fallbackError as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
          fallbackError.message.split("\n", 1)[0] === "Cannot find module '@canlang/testkit'") {
        throw new MissingExampleTestkitError();
      }
      throw fallbackError;
    }
  }
  const kit = await import(pathToFileURL(entry).href);
  requirement(kit.loadExampleSuite, "testkit loader");
  requirement(kit.runTable, "testkit table runner");
  requirement(kit.createReport, "testkit report builder");
  requirement(kit.fixtureValuesOf, "testkit fixture lookup");
  return kit;
}

export interface ExampleCall {
  readonly operation: string;
  readonly inputs: unknown;
  readonly request?: unknown;
  readonly by: unknown;
  readonly scope: ExampleRowScope;
}

export type ExampleCallOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly unsupported: true; readonly detail: string };

export interface ExampleFixtureMaterialization {
  /** Names confirmed in the scope's real resource store. */
  readonly materialized: readonly string[];
  /** Stored row references replacing draft recipe fields before cell evaluation. */
  readonly values: ReadonlyMap<string, unknown>;
}

export interface ExampleFixtureRecipe {
  readonly name: string;
  readonly kind: "model" | "user" | "file" | "delivery";
  readonly label?: string;
}

/** Producer hooks; the adapter never synthesizes domain rows or outcomes. */
export interface ExampleRuntimeHooks {
  /** Commit every non-user fixture into the row's actual local resources. */
  readonly materializeFixtures: (input: {
    readonly scope: ExampleRowScope;
    readonly fixtures: ReadonlyMap<string, unknown>;
    readonly required: readonly ExampleFixtureRecipe[];
  }) => Promise<ExampleFixtureMaterialization>;
  /** Persist seed-field cells before the rejection baseline is captured. */
  readonly prepareRowCells?: (input: {
    readonly scope: ExampleRowScope;
    readonly fixtures: ReadonlyMap<string, unknown>;
    readonly baselineInputs: unknown;
    readonly inputs: unknown;
    readonly selectors: readonly string[];
    readonly selectorChannels?: readonly ("input" | "request" | "caller")[];
    readonly cells: readonly unknown[];
  }) => Promise<{ readonly fixtures: ReadonlyMap<string, unknown>; readonly inputs: unknown }>;
  /** Invoke the compiled operation through canonical admission. */
  readonly invoke: (input: {
    readonly call: ExampleCall;
    readonly identity: ResolvedIdentity;
    readonly rowCaller: ResolvedCaller;
  }) => Promise<ExampleCallOutcome>;
  /** Return the live values that emitted observation closures inspect. */
  readonly observeLive: (input: {
    readonly scope: ExampleRowScope;
    readonly fixtures: ReadonlyMap<string, unknown>;
  }) => Promise<unknown>;
}

export interface CompiledExampleInput {
  /** Exact serialized artifact bytes, rather than a reconstructed JSON view. */
  readonly artifactBytes: Uint8Array;
  readonly artifactLabel: string;
  /** Revision already verified against the coherent source capture. */
  readonly sourceRevision: string;
  /** Source-current portable Worker module map from the runtime producer. */
  readonly worker: {
    readonly mainModule: string;
    readonly modules: Readonly<Record<string, string>>;
    readonly binaryModules?: Readonly<Record<string, Uint8Array>>;
  };
  readonly workerName: string;
  readonly compatibilityDate: string;
  readonly d1Binding: string;
  readonly testkit: ExampleTestkitPort;
  /** Optional override; the default commits fixtures and uses buildInvoker. */
  readonly hooks?: ExampleRuntimeHooks;
  /** Emitter factory bindings; the default is the authored self/other names. */
  readonly bindings?: { readonly self: unknown; readonly other: unknown; readonly outsider?: unknown; readonly imported: unknown };
  /** Execute one authored table row, used by the isolated rerun coordinator. */
  readonly selectedRow?: { readonly operation: string; readonly rowIndex: number };
  /** Correlates a fresh row scope with its attempt; never reused as D1 state. */
  readonly runId?: string;
  /** Request/daemon lifetime; never retained in a rerun recipe. */
  readonly signal?: AbortSignal;
}

export interface CompiledExampleResult {
  /** False whenever any row failed, could not set up, or was unsupported. */
  readonly ok: boolean;
  readonly executed: number;
  readonly report: ExampleReport;
}

interface RowAccounts {
  readonly self: string;
  readonly other: string;
  readonly outsider: string;
  readonly users: Readonly<Record<string, { readonly account: string; readonly roles: readonly string[] }>>;
}

interface UserFixture {
  readonly name: string;
  readonly roles: readonly string[];
}

interface CallerSelection {
  readonly kind: string;
  readonly roles?: readonly string[];
}

interface RowSpec {
  readonly rowIndex: number;
  readonly caller: CallerSelection;
  /** Testkit replaces this after evaluating authored expectations in setup. */
  readonly expected: unknown;
  setup(scope: ExampleRowScope, accounts: RowAccounts): Promise<void>;
  invoke(scope: ExampleRowScope, caller: ResolvedCaller): Promise<ExampleCallOutcome>;
  observe(scope: ExampleRowScope): Promise<ReportValue[]>;
}

interface LoadedSuite {
  readonly rows: readonly RowSpec[];
  readonly userFixtures: readonly UserFixture[];
}

interface StashedRow {
  readonly fixtures: ReadonlyMap<string, unknown>;
}

interface RunnerHooks {
  readonly prepareFixtures: (
    scope: ExampleRowScope,
    fixtures: ReadonlyMap<string, unknown>,
    required: readonly ExampleFixtureRecipe[],
  ) => Promise<ReadonlyMap<string, unknown>>;
  readonly prepareRowCells?: ExampleRuntimeHooks["prepareRowCells"];
  readonly invokeCall: (call: ExampleCall) => Promise<ExampleCallOutcome>;
  readonly observeScope: (scope: ExampleRowScope, stashed: StashedRow) => Promise<unknown>;
}

/** A real D1 + Identity scope for exactly one row. */
export interface ExampleRowScope extends LocalRowScope {
  readonly store: StoragePort;
  readonly ownerStorage: TeamOwnerStorageBoundary | undefined;
  readonly identities: IdentityStore;
  readonly d1Id: string;
  readonly currentTeamId: string | null;
  readonly fixtureActorId: string | null;
  /** One clock shared by fixture expressions, invocation and observations. */
  readonly nowMs: number;
  /** Resolve verified current Identity facts, including a public caller. */
  identityFor(by: unknown, rowCaller: ResolvedCaller, fixtures: ReadonlyMap<string, unknown>): Promise<ResolvedIdentity>;
  provisionActors(accounts: RowAccounts, selection: CallerSelection, users: readonly UserFixture[]): Promise<void>;
}

function requirement(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`example runner: missing ${name} producer`);
}

function nonempty(value: string, name: string): void {
  if (value.length === 0) throw new Error(`example runner: ${name} is required`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLoadedSuite(value: unknown, scope: string): LoadedSuite {
  if (!isRecord(value) || !Array.isArray(value["rows"]) || !Array.isArray(value["userFixtures"])) {
    throw new Error(`example runner: testkit returned an invalid suite for ${scope}`);
  }
  for (const row of value["rows"] as unknown[]) {
    if (!isRecord(row) || !Number.isInteger(row["rowIndex"]) || typeof row["setup"] !== "function" ||
        typeof row["invoke"] !== "function" || typeof row["observe"] !== "function" ||
        !Array.isArray(row["seed"])) {
      throw new Error(`example runner: testkit returned an invalid row for ${scope}`);
    }
  }
  return value as unknown as LoadedSuite;
}

function checkedFixtureValues(value: unknown, scope: string): ReadonlyMap<string, unknown> {
  if (!(value instanceof Map)) {
    throw new Error(`example runner: ${scope} has no provisioned fixture values`);
  }
  return value;
}

function cancellationError(): Error {
  return new DOMException("example runner: cancelled", "AbortError");
}

/** Await a row phase without waiting for an unresponsive producer after shutdown. */
function withCancellation<T>(signal: AbortSignal | undefined, run: () => Promise<T>,
  cleanup?: () => Promise<void>): Promise<T> {
  if (signal === undefined) return run();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => finish(() => {
      const disposal = cleanup === undefined ? Promise.resolve() : Promise.resolve().then(cleanup);
      void disposal.catch(() => undefined).then(() => reject(cancellationError()));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void Promise.resolve().then(run).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

interface ExampleOwnerProfile {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly app: string;
}

async function createRowScope(input: CompiledExampleInput, moduleIndex: number, rowIndex: number,
  ownerProfile?: ExampleOwnerProfile): Promise<ExampleRowScope> {
  const d1Id = randomUUID();
  const currentStateId = randomUUID();
  const otherStateId = randomUUID();
  const currentBinding = "CAN_EXAMPLE_STATE_CURRENT";
  const otherBinding = "CAN_EXAMPLE_STATE_OTHER";
  const attempt = input.runId === undefined ? "" : `-${input.runId.slice(0, 8)}`;
  const workerName = `${input.workerName.slice(0, 32)}${attempt}-${moduleIndex}-${rowIndex}-${d1Id.slice(0, 8)}`;
  const base = await createLocalRowScope(d1Id, {
    workerName,
    compatibilityDate: input.compatibilityDate,
    mainModule: input.worker.mainModule,
    modules: input.worker.modules,
    ...(input.worker.binaryModules === undefined ? {} : { binaryModules: input.worker.binaryModules }),
    d1Binding: input.d1Binding,
    ...(ownerProfile === undefined ? {} : { additionalD1Databases: [
      { binding: currentBinding, id: currentStateId },
      { binding: otherBinding, id: otherStateId },
    ] }),
  });
  try {
    const db = await base.dev.getD1Database(input.d1Binding);
    if (ownerProfile === undefined) await ensureSchema(db);
    await ensureIdentitySchema(db);
    let store: StoragePort | null = ownerProfile === undefined ? createD1Storage(db) : null;
    let ownerStorage: TeamOwnerStorageBoundary | undefined;
    const identities = createD1IdentityStore(db);
    const tokens = new Map<string, string>();
    const actorAccounts = new Map<string, string>();
    let currentTeamId: string | null = null;
    let otherTeamId: string | null = null;
    let accountsOfRow: RowAccounts | null = null;
    let ownerUserId: string | null = null;
    let nowMs = Date.now();

    async function addActor(account: string, teamId: string, roles: readonly string[], isOwner = false): Promise<void> {
      const user = await identities.createUser({
        email: `${account}@examples.invalid`,
        password_hash: "example-only-unusable",
        email_verified: true,
      });
      actorAccounts.set(user.user_id, account);
      if (isOwner) ownerUserId = user.user_id;
      await identities.createMembership({
        team_id: teamId,
        user_id: user.user_id,
        is_owner: isOwner,
        roles: roles.filter(role => role !== "members").map(role => ({
          role,
          granted_at: toInstant(Date.now()),
          granted_by: ownerUserId ?? user.user_id,
        })),
      });
      const token = randomBytes(32).toString("base64url");
      await identities.createSession({
        user_id: user.user_id,
        token_sha256: await sha256HexText(token),
        expires_at: toInstant(Date.now() + 60 * 60_000),
        last_team_id: teamId,
      });
      tokens.set(account, token);
    }

    const scope: ExampleRowScope = {
      ...base,
      get store() {
        if (store === null) throw new Error("example runner: current owner store is not provisioned");
        return store;
      },
      get ownerStorage() { return ownerStorage; },
      identities,
      d1Id,
      get currentTeamId() { return currentTeamId; },
      get fixtureActorId() { return ownerUserId; },
      get nowMs() { return nowMs; },
      async provisionActors(accounts, selection, users) {
        if (accountsOfRow !== null) throw new Error("example runner: row actors already provisioned");
        const current = await identities.createTeam({});
        const other = await identities.createTeam({});
        currentTeamId = current.team_id;
        otherTeamId = other.team_id;
        accountsOfRow = accounts;
        const selfRoles = selection.kind === "membership" ? selection.roles ?? [] : [];
        await addActor(accounts.self, current.team_id, selfRoles, true);
        await addActor(accounts.other, current.team_id, []);
        await addActor(accounts.outsider, other.team_id, []);
        for (const user of users) {
          const account = accounts.users[user.name]?.account;
          if (account === undefined) throw new Error(`example runner: missing account for user fixture ${user.name}`);
          await addActor(account, current.team_id, user.roles);
        }
        if (ownerProfile !== undefined) {
          const currentDb = await base.dev.getD1Database(currentBinding);
          const otherDb = await base.dev.getD1Database(otherBinding);
          const routes = new Map([
            [current.team_id, currentDb],
            [other.team_id, otherDb],
          ]);
          const router = createD1OwnerRouter({ resolveBinding: requested => {
            if (requested.app !== ownerProfile.app) return null;
            const routedDb = routes.get(requested.owner);
            return routedDb === undefined ? null : {
              app: ownerProfile.app, owner: requested.owner, db: routedDb, initializeFresh: true,
            };
          } });
          ownerStorage = await createTeamOwnerStorageBoundary({ artifact: ownerProfile.artifact,
            asm: ownerProfile.asm, app: ownerProfile.app, identities, router });
          const selfToken = tokens.get(accounts.self);
          if (selfToken === undefined) throw new Error("example runner: fixture owner has no verified session");
          const self = await resolveIdentity(identities, { session_token: selfToken, team_id: current.team_id });
          store = await ownerStorage.forIdentity(self);
        }
        nowMs = Date.now();
      },
      async identityFor(by, rowCaller, fixtures) {
        if (accountsOfRow === null || currentTeamId === null || otherTeamId === null) {
          throw new Error("example runner: row actors are unavailable");
        }
        if (by === "public") return resolveIdentity(identities, { team_id: currentTeamId });
        let account: string | null = null;
        if (by === "self" || (input.bindings !== undefined && by === input.bindings.self)) account = accountsOfRow.self;
        else if (by === "other" || (input.bindings !== undefined && by === input.bindings.other)) account = accountsOfRow.other;
        else if (by === "outsider" || (input.bindings !== undefined && by === input.bindings.outsider && by !== undefined)) account = accountsOfRow.outsider;
        else if (typeof by === "string" && Object.hasOwn(accountsOfRow.users, by)) {
          account = accountsOfRow.users[by]!.account;
        } else if (typeof by === "string" && (by === "members" || rowCaller.roles.includes(by))) {
          account = rowCaller.account === "public" ? null : rowCaller.account;
        } else if (Array.isArray(by)) {
          // The Testkit has already resolved and provisioned this row caller.
          // Match its static role selection; this path never installs grants.
          const length = Object.getOwnPropertyDescriptor(by, "length");
          const roles: string[] = [];
          let valid = length !== undefined && "value" in length &&
            Reflect.ownKeys(by).length === length.value + 1;
          if (valid) for (let index = 0; index < length!.value; index++) {
            const entry = Object.getOwnPropertyDescriptor(by, String(index));
            if (entry === undefined || !("value" in entry) || !entry.enumerable ||
                typeof entry.value !== "string" || entry.value.length === 0 ||
                ["self", "other", "outsider", "public"].includes(entry.value)) {
              valid = false;
              break;
            }
            roles.push(entry.value);
          }
          const expected = roles.length === 0 ? ["members"] : roles;
          if (valid && rowCaller.account === accountsOfRow.self && rowCaller.authenticated &&
              rowCaller.team === "current" && expected.length === rowCaller.roles.length &&
              expected.every((role, index) => role === rowCaller.roles[index])) account = accountsOfRow.self;
        } else if (isUserRef(by) && actorAccounts.has(by.id)) {
          account = actorAccounts.get(by.id)!;
        } else if (typeof by === "object" && by !== null) {
          for (const [name, value] of fixtures) {
            if (value === by && accountsOfRow.users[name] !== undefined) {
              account = accountsOfRow.users[name]!.account;
              break;
            }
          }
        }
        if (account === null) throw new Error("example runner: call names no provisioned actor");
        const token = tokens.get(account);
        if (token === undefined) throw new Error("example runner: call actor has no verified session");
        // Explicit current scope keeps an authenticated other-team member
        // without current membership distinct from an anonymous caller.
        return resolveIdentity(identities, { session_token: token, team_id: currentTeamId });
      },
    };
    return scope;
  } catch (error) {
    return cleanupAfterFailure(error, () => base.dispose());
  }
}

function assertNoModuleCollisions(artifact: CompileArtifact): void {
  const paths = new Set(artifact.modules.map(module => module.path));
  for (const test of artifact.tests) {
    if (paths.has(test.module.path)) {
      throw new Error(`example runner: duplicate production/test module path ${test.module.path}`);
    }
    paths.add(test.module.path);
  }
}

interface StoredFixtureBinding {
  readonly model: string;
  readonly id: string;
  readonly version: number;
}

function fixtureFieldType(field: ArtifactModelField | ArtifactOperationInput): string {
  if (field.valueType !== undefined) return field.valueType;
  const type = field.field.kind === "ref" ? field.field.model
    : field.field.kind === "nominal" ? field.field.name
    : ({ string: "text", integer: "int", boolean: "bool", decimal: "decimal", money: "money",
      datetime: "datetime", date: "date", duration: "duration", user: "user" } as Record<string, string>)[field.field.kind];
  if (type === undefined) throw new Error(`example runner: fixture field ${field.name} needs a supported value type`);
  return `${type}${field.array === undefined ? "" : "[]"}${field.nullable === true ? "?" : ""}`;
}

function checkFixtureValue(value: unknown): void {
  const active = new Set<object>(); let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 16384 || depth > 64) throw new Error("example runner: fixture value traversal bound exceeded");
    if (value === null || typeof value !== "object") return;
    if (active.has(value)) throw new Error("example runner: cyclic example input");
    active.add(value);
    for (const item of Object.values(value)) visit(item, depth + 1);
    active.delete(value);
  };
  visit(value, 0);
}

function fieldWire(field: ArtifactModelField, value: unknown, schema?: NormalizedSchema,
  resolver?: Parameters<typeof encodeValue>[2]): unknown {
  checkFixtureValue(value);
  if (value === null) return null;
  if (field.field.kind === "enum") {
    const values = field.field.values;
    const encode = (item: unknown): string => {
      if (typeof item !== "string" || !values.includes(item)) throw new Error(`example runner: invalid enum fixture field ${field.name}`);
      return item;
    };
    if (field.array !== undefined) {
      if (!Array.isArray(value)) throw new Error(`example runner: fixture field ${field.name} requires an array`);
      return value.map(encode);
    }
    return encode(value);
  }
  return encodeValue(fixtureFieldType(field), value as never, resolver, schema);
}

function nativeFixtureField(field: ArtifactModelField, wire: unknown, schema?: NormalizedSchema): unknown {
  if (wire === null || field.field.kind === "enum") return wire;
  return schema === undefined ? decodeValue(fixtureFieldType(field), wire)
    : validateValue(schema, fixtureFieldType(field), wire, "create");
}

function fixtureView(artifact: CompileArtifact, modelName: string, row: StoredRow, schema?: NormalizedSchema): Record<string, unknown> {
  const model = artifact.models?.find(candidate => candidate.name === modelName);
  if (model === undefined) throw new Error(`example runner: unknown model ${modelName}`);
  const view: Record<string, unknown> = { id: row.id, version: BigInt(row.version) };
  for (const field of model.fields) {
    if (Object.hasOwn(row.data, field.name)) view[field.name] = nativeFixtureField(field, row.data[field.name], schema);
  }
  bindNativeRecord(view, modelName, row.id, row.version);
  return view;
}

function wireInputs(value: unknown, references: ReadonlyMap<object, StoredFixtureBinding>, seen = new Set<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (isUserRef(value)) return encodeValue("user", value);
  if (isDatetime(value)) return encodeValue("datetime", value);
  if (value === null || typeof value !== "object") return value;
  const reference = references.get(value);
  if (reference !== undefined) return { id: reference.id, version: String(reference.version) };
  if (isRecord(value) && typeof value["id"] === "string") {
    for (const binding of references.values()) {
      if (binding.id === value["id"]) {
        const version = value["version"] ?? binding.version;
        if (typeof version !== "bigint" && typeof version !== "number" && typeof version !== "string") {
          throw new Error("example runner: fixture reference version must be an integer");
        }
        return { id: binding.id, version: String(version) };
      }
    }
  }
  if (seen.has(value)) throw new Error("example runner: cyclic example input");
  seen.add(value);
  const output = Array.isArray(value)
    ? value.map(item => wireInputs(item, references, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wireInputs(item, references, seen)]));
  seen.delete(value);
  return output;
}

function applyRequestOverrides(inputs: Record<string, unknown>, request: unknown): { inputs: Record<string, unknown>; operationId?: string } {
  if (request === undefined) return { inputs };
  if (!isRecord(request)) throw new Error("example runner: request overrides must be an object");
  const operationId = request["operation_id"];
  if (operationId !== undefined && typeof operationId !== "string") throw new Error("example runner: request operation_id must be text");
  const merge = (base: Record<string, unknown>, overrides: Record<string, unknown>, path: string): Record<string, unknown> => {
    const next = { ...base };
    for (const [key, value] of Object.entries(overrides)) {
      if (path === "" && key === "operation_id") continue;
      if (!Object.hasOwn(base, key)) throw new Error(`example runner: request override ${path}${key} names no input`);
      next[key] = isRecord(value) && isRecord(base[key]) ? merge(base[key], value, `${path}${key}.`) : value;
    }
    return next;
  };
  return { inputs: merge(inputs, request, ""), ...(operationId === undefined ? {} : { operationId }) };
}

function closedOperationInputs(kind: string, inputs: Record<string, unknown>): Record<string, unknown> {
  if (kind !== "update" || !isRecord(inputs["changes"])) return inputs;
  const { changes, ...rest } = inputs;
  for (const [name, value] of Object.entries(changes)) {
    if (Object.hasOwn(rest, name)) throw new Error(`example runner: update field ${name} is ambiguous`);
    rest[name] = value;
  }
  return rest;
}

function freshOperationId(): OperationId {
  const time = Date.now().toString(16).padStart(12, "0");
  const bytes = randomBytes(10).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${bytes.slice(0, 3)}-8${bytes.slice(4, 7)}-${bytes.slice(7, 19)}` as OperationId;
}

/** The first local profile's real D1 fixture and canonical invocation ports. */
function canonicalExampleHooks(artifact: CompileArtifact, asm: AssembledModules,
  tableOperations: WeakMap<ExampleRowScope, Readonly<{ id: string; source: string }>>,
  operationName: string,
): ExampleRuntimeHooks {
  const models = artifact.models ?? [];
  const operations = artifact.operations ?? [];
  const results = new WeakMap<ExampleRowScope, { readonly type: string; readonly wire: unknown; readonly identity: ResolvedIdentity }>();
  const invoked = new WeakSet<ExampleRowScope>();
  const rows = new WeakMap<ExampleRowScope, Map<string, StoredFixtureBinding>>();
  const references = new WeakMap<ExampleRowScope, Map<object, StoredFixtureBinding>>();
  const bindingFor = (value: unknown, model: string, bindings: ReadonlyMap<object, StoredFixtureBinding>,
    named: ReadonlyMap<string, StoredFixtureBinding>): StoredFixtureBinding | undefined => {
    if (!isRecord(value)) return undefined;
    const original = bindings.get(value);
    if (original !== undefined) return original.model === model
      ? [...named.values()].find(binding => binding.model === model && binding.id === original.id) : undefined;
    // This port is reached only at a declared Model slot; Contract business
    // id/kind/model fields never select a fixture identity.
    return isRecordRef(value) && value.model === model
      ? [...named.values()].find(binding => binding.model === model && binding.id === value.id) : undefined;
  };
  const resolverFor = (bindings: ReadonlyMap<object, StoredFixtureBinding>,
    named?: ReadonlyMap<string, StoredFixtureBinding>, versioned = false): NonNullable<Parameters<typeof encodeValue>[2]> => value => {
    const original = typeof value === "object" && value !== null ? bindings.get(value) : undefined;
    const binding = original === undefined || named === undefined ? original
      : [...named.values()].find(binding => binding.model === original.model && binding.id === original.id);
    return binding === undefined ? undefined
      : decodeValue(binding.model, { id: binding.id, ...(versioned ? { version: String(binding.version) } : {}) }) as never;
  };
  return {
    async materializeFixtures({ scope, fixtures, required }) {
      if (rows.has(scope) || invoked.has(scope)) throw new Error("example runner: fixture setup is already complete");
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const values = new Map(fixtures);
      const rowBindings = new Map<string, StoredFixtureBinding>();
      const objectBindings = new Map<object, StoredFixtureBinding>();
      const rawBindings = new Map<object, StoredFixtureBinding>();
      const users = new Map<object, unknown>();
      const modelNames = new Set(required.map(recipe => recipe.name));
      const caller: ResolvedCaller = { account: "self", team: "current", roles: [], authenticated: true };
      const identity = await scope.identityFor("self", caller, fixtures);
      // A user recipe is an Identity account, not the {roles} declaration.
      for (const [name, value] of fixtures) {
        if (modelNames.has(name) || !isRecord(value)) continue;
        const user = await scope.identityFor(name, caller, fixtures);
        if (user.actor === null) throw new Error(`example runner: user fixture ${name} has no account`);
        const native = decodeValue("user", { id: user.actor.user_id });
        users.set(value, native);
        values.set(name, native);
      }
      for (const recipe of required) {
        if (recipe.kind !== "model" || recipe.label === undefined) throw new Error(`example runner: ${recipe.name} needs a local ${recipe.kind} fixture producer`);
        const model = models.find(candidate => candidate.name === recipe.label);
        const fields = fixtures.get(recipe.name);
        if (model === undefined || !isRecord(fields)) throw new Error(`example runner: fixture ${recipe.name} has no declared model fields`);
        const binding = { model: model.name, id: randomUUID(), version: 1 };
        rowBindings.set(recipe.name, binding);
        rawBindings.set(fields, binding);
      }
      const translate = (value: unknown): unknown => isRecord(value) && users.has(value) ? users.get(value)
        : Array.isArray(value) ? value.map(item => isRecord(item) && users.has(item) ? users.get(item) : item) : value;
      const resolveFixture = resolverFor(rawBindings);
      const snapshots = required.map(recipe => {
        const binding = rowBindings.get(recipe.name)!;
        const model = models.find(candidate => candidate.name === binding.model)!;
        const fields = fixtures.get(recipe.name) as Record<string, unknown>;
        const declared = new Map(model.fields.filter(field => field.default?.kind !== "derived").map(field => [field.name, field]));
        for (const name of Object.keys(fields)) {
          if (!declared.has(name) && !(name === "parent" && model.parent !== undefined)) throw new Error(`example runner: fixture ${recipe.name} has unknown or reserved field ${name}`);
        }
        let parent: RecordParent | undefined;
        if (model.parent !== undefined) {
          const raw = fields["parent"];
          const target = isRecord(raw) ? rawBindings.get(raw) : undefined;
          if (target === undefined || target.model !== model.parent) throw new Error(`example runner: fixture ${recipe.name} has no matching parent recipe`);
          parent = { model: target.model as ModelName, id: target.id as RecordId };
        }
        const data = Object.fromEntries([...declared].filter(([name]) => Object.hasOwn(fields, name))
          .map(([name, field]) => [name, fieldWire(field, translate(fields[name]), loaded.valueSchema, resolveFixture)]));
        return { model: binding.model as ModelName, id: binding.id as RecordId, data, ...(parent === undefined ? {} : { parent }) };
      });
      const stored = snapshots.length === 0 ? new Map<string, StoredRow>()
        : await materializeCanonicalExampleSnapshots({ asm, artifact, store: scope.store, identity,
          now: scope.nowMs, operationId: freshOperationId(), snapshots });
      for (const [name, binding] of rowBindings) {
        const row = stored.get(`${binding.model}\0${binding.id}`);
        if (row === undefined) throw new Error(`example runner: fixture ${name} was not stored`);
        const view = fixtureView(artifact, binding.model, row, loaded.valueSchema);
        values.set(name, view);
        objectBindings.set(view, binding);
      }
      rows.set(scope, rowBindings);
      references.set(scope, objectBindings);
      return { materialized: required.map(recipe => recipe.name), values };
    },
    async prepareRowCells({ scope, fixtures, baselineInputs, inputs, selectors, selectorChannels, cells }) {
      const rowBindings = rows.get(scope), objectBindings = references.get(scope);
      if (rowBindings === undefined || objectBindings === undefined ||
          !isRecord(baselineInputs) || !isRecord(inputs)) return { fixtures, inputs };
      const operation = operations.find(operation => operation.name === operationName);
      if (operation === undefined) throw new Error(`example runner: unknown row operation ${operationName}`);
      const loaded = await loadCanonicalDescriptors(asm, artifact), schema = loaded.valueSchema;
      const resolved = (type: string): ReturnType<typeof parseTypeId> => {
        const aliases = new Set<string>();
        let parsed = parseTypeId(type);
        while (!parsed.array && parsed.base.kind === "nominal" && schema?.aliases?.[parsed.base.path] !== undefined) {
          if (aliases.has(parsed.base.path) || aliases.size >= 64) throw new Error("example runner: cyclic fixture input type");
          aliases.add(parsed.base.path);
          parsed = parseTypeId(schema.aliases[parsed.base.path]!.typeId);
        }
        return parsed;
      };
      const unsafe = (part: string) => ["__proto__", "constructor", "prototype"].includes(part);
      // Reapply only the already evaluated cells, retaining their authored order.
      // Clones of genuine fixture views keep their private setup binding.
      const setCell = (value: unknown, parts: readonly string[], cell: unknown, depth = 0): unknown => {
        if (parts.length === 0) return cell;
        if (depth >= 64 || parts.some(part => part === "" || unsafe(part))) throw new Error("example runner: invalid fixture cell path");
        const [head, ...tail] = parts;
        if (Array.isArray(value)) {
          const index = Number(head);
          if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) throw new Error("example runner: fixture cell array index is unavailable");
          const copy = [...value]; copy[index] = setCell(value[index], tail, cell, depth + 1); return copy;
        }
        if (!isRecord(value)) throw new Error("example runner: fixture cell requires its original object path");
        const copy = { ...value, [head!]: setCell(Object.hasOwn(value, head!) ? value[head!] : {}, tail, cell, depth + 1) };
        const binding = objectBindings.get(value);
        if (binding !== undefined) objectBindings.set(copy, binding);
        return copy;
      };
      const atPath = (value: unknown, parts: readonly string[]): unknown => {
        for (const part of parts) value = Array.isArray(value) ? value[Number(part)] : isRecord(value) ? value[part] : undefined;
        return value;
      };
      let effective: unknown = baselineInputs;
      const overrides = new Map<string, Record<string, unknown>>();
      for (const [index, selector] of selectors.entries()) {
        const channel = selectorChannels?.[index] ?? (selector === "as" ? "caller" : selector.startsWith("request.") ? "request" : "input");
        if (channel !== "input") continue;
        const parts = selector.split("."), root = parts[0]!;
        const input = operation.inputs.fields.find(input => input.name === root);
        let type = input === undefined || parts.length === 1 ? undefined : fixtureFieldType(input), value = isRecord(effective) ? effective[root] : undefined;
        let stored: { name: string; field: string; path: readonly string[] } | undefined;
        for (let offset = 1; type !== undefined && offset < parts.length; offset++) {
          const parsed = resolved(type), part = parts[offset]!;
          if (parsed.array) {
            const slot = Number(part);
            if (!Array.isArray(value) || !Number.isSafeInteger(slot) || slot < 0 || slot >= value.length) throw new Error("example runner: fixture reference array index is unavailable");
            type = printTypeId({ ...parsed, array: false, requiredArray: false, nullable: false }); value = value[slot]; continue;
          }
          const name = parsed.base.kind === "nominal" ? parsed.base.path : undefined;
          const model = models.find(model => model.name === name), contract = name === undefined ? undefined : schema?.contracts[name];
          if (model !== undefined) {
            const binding = bindingFor(value, model.name, objectBindings, rowBindings);
            const fixtureName = binding === undefined ? undefined : [...rowBindings].find(([, current]) => current.model === binding.model && current.id === binding.id)?.[0];
            if (fixtureName === undefined) throw new Error("example runner: row cell has no genuine declared fixture reference");
            const field = model.fields.find(field => field.name === part);
            if (field === undefined) throw new Error(`example runner: fixture cell cannot initialize unknown or reserved field ${part}`);
            if (field.default?.kind === "derived") throw new Error(`example runner: fixture cell cannot initialize derived field ${part}`);
            stored = { name: fixtureName, field: part, path: parts.slice(0, offset + 1) };
            type = fixtureFieldType(field);
          } else if (contract !== undefined) {
            type = contract.fields[part]?.typeId;
            if (type === undefined && stored !== undefined) throw new Error(`example runner: unknown stored Contract cell ${part}`);
          } else if (parsed.base.kind === "union" && part === "value" && isRecord(value) &&
              typeof value["type"] === "string" && parsed.base.arms.includes(value["type"])) {
            type = value["type"];
          } else {
            if (stored !== undefined) throw new Error(`example runner: fixture cell ${selector} has no declared nested field`);
            type = undefined;
          }
          value = isRecord(value) ? value[part] : undefined;
        }
        effective = setCell(effective, parts, cells[index]);
        if (stored !== undefined) {
          const fields = overrides.get(stored.name) ?? {};
          fields[stored.field] = atPath(effective, stored.path); overrides.set(stored.name, fields);
        }
      }
      if (overrides.size === 0) return { fixtures, inputs };
      if (invoked.has(scope)) throw new Error("example runner: fixture state is sealed after invocation");
      const updatedFixtures = new Map(fixtures), snapshots = [];
      const resolveFixture = resolverFor(objectBindings, rowBindings);
      for (const [name, fields] of overrides) {
        const binding = rowBindings.get(name)!, model = models.find(model => model.name === binding.model)!;
        const before = await scope.store.load(binding.model as ModelName, binding.id as RecordId);
        if (before === null) throw new Error(`example runner: fixture ${name} disappeared before row cells`);
        const data = { ...before.data };
        for (const [name, value] of Object.entries(fields)) data[name] = fieldWire(model.fields.find(field => field.name === name)!, value, schema, resolveFixture);
        snapshots.push({ model: binding.model as ModelName, id: before.id, data,
          ...(before.parent === null || before.parent === undefined ? {} : { parent: before.parent }) });
      }
      const identity = await scope.identityFor("self", { account: "self", team: "current", roles: [], authenticated: true }, fixtures);
      const saved = await materializeCanonicalExampleSnapshots({ asm, artifact, store: scope.store, identity,
        now: scope.nowMs, operationId: freshOperationId(), snapshots });
      // Publish only after the complete override batch passes its owning session.
      for (const name of overrides.keys()) {
        const binding = rowBindings.get(name)!, row = saved.get(`${binding.model}\0${binding.id}`);
        if (row === undefined) throw new Error(`example runner: fixture ${name} row cells were not stored`);
        const view = fixtureView(artifact, binding.model, row, schema), current = { ...binding, version: row.version as number };
        updatedFixtures.set(name, view); rowBindings.set(name, current); objectBindings.set(view, current);
      }
      // A fixture may occur repeatedly through Contract fields/arrays. Refresh
      // every declared reference slot while retaining ordinary input overrides.
      const seen = new Set<object>(); let nodes = 0;
      const refresh = (type: string, value: unknown, depth = 0): unknown => {
        if (++nodes > 16384 || depth > 64) throw new Error("example runner: fixture input traversal bound exceeded");
        const parsed = resolved(type);
        if (value === null || typeof value !== "object") return value;
        const name = parsed.base.kind === "nominal" ? parsed.base.path : undefined;
        if (!parsed.array && name !== undefined && models.some(model => model.name === name)) {
          const binding = bindingFor(value, name, objectBindings, rowBindings);
          const fixtureName = binding === undefined ? undefined : [...rowBindings].find(([, item]) => item.model === name && item.id === binding.id)?.[0];
          return fixtureName === undefined ? value : updatedFixtures.get(fixtureName);
        }
        const contract = name === undefined ? undefined : schema?.contracts[name];
        if (!parsed.array && contract === undefined && parsed.base.kind !== "union") return value;
        if (seen.has(value)) throw new Error("example runner: cyclic example input");
        seen.add(value);
        try {
          if (parsed.array) {
            if (!Array.isArray(value)) return value;
            const element = printTypeId({ ...parsed, array: false, requiredArray: false, nullable: false });
            return value.map(item => refresh(element, item, depth + 1));
          }
          if (contract !== undefined && isRecord(value)) return Object.fromEntries(Object.entries(value).map(([field, item]) =>
            [field, contract.fields[field] === undefined ? item : refresh(contract.fields[field]!.typeId, item, depth + 1)]));
          if (parsed.base.kind === "union" && isRecord(value) && typeof value["type"] === "string" && parsed.base.arms.includes(value["type"])) {
            return { ...value, value: refresh(value["type"], value["value"], depth + 1) };
          }
          return value;
        } finally { seen.delete(value); }
      };
      const updatedInputs = { ...effective as Record<string, unknown> };
      for (const input of operation.inputs.fields) if (input.field.kind !== "enum" && Object.hasOwn(updatedInputs, input.name)) updatedInputs[input.name] = refresh(fixtureFieldType(input), updatedInputs[input.name]);
      return { fixtures: updatedFixtures, inputs: updatedInputs };
    },
    async invoke({ call, identity }) {
      invoked.add(call.scope);
      results.delete(call.scope);
      tableOperations.delete(call.scope);
      const operation = operations.find(candidate => candidate.name === call.operation);
      if (operation === undefined) throw new Error(`example runner: unknown operation ${call.operation}`);
      // Loader/source failures are infrastructure failures, rather than an
      // authored business rejection that could satisfy an expected error row.
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      if (!isRecord(call.inputs)) throw new Error("example runner: operation inputs are not an object");
      checkFixtureValue(call.inputs);
      const flat = closedOperationInputs(operation.kind, call.inputs), bindings = references.get(call.scope) ?? new Map();
      const named = rows.get(call.scope) ?? new Map();
      const resolveInput: NonNullable<Parameters<typeof encodeValue>[2]> = value => {
        const original = typeof value === "object" && value !== null ? bindings.get(value) : undefined;
        const binding = original ?? (isRecordRef(value) ? [...named.values()].find(binding => binding.model === value.model && binding.id === value.id) : undefined);
        return binding === undefined ? undefined : decodeValue(binding.model, { id: binding.id, version: String(binding.version) }) as never;
      };
      const encoded = Object.fromEntries(Object.entries(flat).map(([name, value]) => {
        const input = operation.inputs.fields.find(input => input.name === name);
        return [name, input === undefined || input.field.kind === "enum" ? wireInputs(value, new Map())
          : encodeValue(fixtureFieldType(input), value as never, resolveInput, loaded.valueSchema)];
      }));
      const request = applyRequestOverrides(encoded, wireInputs(call.request, new Map()));
      const ownerStorage = call.scope.ownerStorage;
      if (ownerStorage === undefined && (artifact.models?.length ?? 0) > 0) {
        throw new Error("example runner: model-backed canonical row has no owner storage boundary");
      }
      const invoker = buildInvoker(artifact, asm, call.scope.store, {
        memberships: call.scope.identities,
        source: "example", now: () => call.scope.nowMs,
        ...(ownerStorage === undefined ? {} : { ownerStorage }),
      });
      const operationId = operation.kind === "read" ? undefined : request.operationId ?? freshOperationId();
      const outcome = operation.kind === "read"
        ? await invoker.invokeRead({ operation: call.operation as FqOperationName, inputs: request.inputs as ClosedInputs }, identity)
        : await invoker.invokeMutation({
          operation: call.operation as FqOperationName,
          operation_id: operationId as OperationId,
          inputs: request.inputs as ClosedInputs,
        }, identity);
      if ("error" in outcome) return { ok: false, error: outcome.error.code };
      if (operation.result !== undefined) {
        const served = outcome.result;
        if (!isRecord(served) || !Object.hasOwn(served, "result")) {
          throw new Error("example runner: declared operation result is absent from its canonical response");
        }
        results.set(call.scope, { type: operation.result.type, wire: served["result"], identity });
      }
      if (operationId !== undefined) {
        tableOperations.set(call.scope, Object.freeze({ id: operationId, source: "example" }));
      }
      return { ok: true };
    },
    async observeLive({ scope, fixtures }) {
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const values = new Map(fixtures);
      for (const [name, binding] of rows.get(scope) ?? []) {
        const stored = await scope.store.load(binding.model as ModelName, binding.id as RecordId);
        values.set(name, stored === null ? null : fixtureView(artifact, binding.model, stored, loaded.valueSchema));
      }
      const returned = results.get(scope);
      if (returned !== undefined) {
        const loaded = await loadCanonicalDescriptors(asm, artifact);
        const store = scope.ownerStorage === undefined ? scope.store : await scope.ownerStorage.forIdentity(returned.identity);
        const revision = await store.readRevision();
        const records = new Map<string, Awaited<ReturnType<typeof invokeReadCanonical>>>();
        const observeResult = async (type: string, wire: unknown): Promise<unknown> => {
          // Canonical disclosure may withhold even a nonnullable source result.
          // Absence never grants permission to recover it from owner storage.
          if (wire === null || type === "void") return null;
          const parsed = parseTypeId(type);
          if (parsed.array) {
            if (!Array.isArray(wire)) throw new Error("example runner: declared array result is not an array");
            const element = printTypeId({ ...parsed, array: false, requiredArray: false, nullable: false });
            const values: unknown[] = [];
            for (const value of wire) values.push(await observeResult(element, value));
            return values;
          }
          const modelName = parsed.base.kind === "nominal" ? parsed.base.path : undefined;
          const model = models.find(model => model.name === modelName);
          if (model === undefined) return loaded.valueSchema === undefined
            ? decodeValue(type, wire) : validateValue(loaded.valueSchema, type, wire, "create");
          decodeValue(type, wire);
          if (!isRecord(wire) || typeof wire["id"] !== "string") throw new Error("example runner: declared model result has no identity");
          const key = `${model.name}\0${wire["id"]}`;
          let served = records.get(key);
          if (served === undefined) {
            served = await invokeReadCanonical({ asm, artifact, operation: `${model.name}.read`, inputs: {} as ClosedInputs,
              selection: { where: { op: "eq", field: "id", value: wire["id"] }, limit: 1 },
              identity: returned.identity, store, memberships: scope.identities, source: "example" });
            records.set(key, served);
          }
          if (!("records" in served) || !Array.isArray(served.records)) throw new Error("example runner: result observation returned no authorized records");
          const row = served.records.find(record => record.id === wire["id"]);
          return row === undefined ? null : fixtureView(artifact, model.name, row, loaded.valueSchema);
        };
        values.set("result", await observeResult(returned.type, returned.wire));
        if (await store.readRevision() !== revision) throw new Error("example runner: result observation state changed");
      }
      return values;
    },
  };
}

/**
 * Execute every authored row. Missing test modules, hooks, fixture writes,
 * actor identities, observations and zero-row suites fail loud. Row-level
 * setup/invocation/assertion failures remain in the owning testkit report.
 */
export async function runCompiledExamples(input: CompiledExampleInput): Promise<CompiledExampleResult> {
  if (input.signal?.aborted) throw cancellationError();
  nonempty(input.artifactLabel, "artifactLabel");
  nonempty(input.sourceRevision, "sourceRevision");
  nonempty(input.workerName, "workerName");
  nonempty(input.d1Binding, "d1Binding");
  requirement(input.testkit?.loadExampleSuite, "testkit loader");
  requirement(input.testkit?.runTable, "testkit table runner");
  requirement(input.testkit?.createReport, "testkit report builder");
  requirement(input.testkit?.fixtureValuesOf, "testkit fixture lookup");
  if (input.hooks !== undefined) {
    requirement(input.hooks.materializeFixtures, "fixture materializer");
    requirement(input.hooks.invoke, "canonical invoker");
    requirement(input.hooks.observeLive, "live observer");
  }
  if (input.selectedRow !== undefined &&
      (input.selectedRow.operation.length === 0 ||
       !Number.isSafeInteger(input.selectedRow.rowIndex) || input.selectedRow.rowIndex < 0)) {
    throw new Error("example runner: selected row must name an operation and nonnegative row index");
  }
  if (input.runId !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(input.runId)) {
    throw new Error("example runner: invalid run ID");
  }
  if (input.worker.modules[input.worker.mainModule] === undefined) {
    throw new Error(`example runner: Worker entry ${input.worker.mainModule} is absent`);
  }

  const artifactText = Buffer.from(input.artifactBytes).toString("utf8");
  const loaded = parseArtifactText(artifactText, input.artifactLabel);
  const artifact = loaded.artifact;
  if (artifact.tests.length === 0) throw new Error("example runner: artifact has zero compiled test modules");
  assertNoModuleCollisions(artifact);
  const digest = createHash("sha256").update(input.artifactBytes).digest("hex");
  const workDir = await mkdtemp(join(tmpdir(), "can-example-modules-"));
  const resources = new RuntimeExampleResources();
  const release = async (): Promise<void> => {
    await resources.drain();
    await rm(workDir, { force: true, recursive: true });
  };
  try {
    // The production and test modules share one checked relative-import
    // graph on disk; only the separate portable Worker map enters workerd.
    const moduleArtifact: CompileArtifact = {
      ...artifact,
      modules: [...artifact.modules, ...artifact.tests.map(test => test.module)],
    };
    const asm = await assembleModules(
      { artifact: moduleArtifact, sourcePath: input.artifactLabel },
      { workDir, stdlibUrl: new URL("../runtime/stdlib.js", import.meta.url).href },
    );
    let ownerProfile: ExampleOwnerProfile | undefined;
    if ((artifact.models?.length ?? 0) > 0) {
      const first = artifact.modules[0];
      const url = first === undefined ? undefined : asm.moduleUrls[first.path];
      if (url === undefined) throw new Error("example runner: canonical app entry is missing");
      const module: unknown = await import(url);
      const definition = isRecord(module) ? module["appDefinition"] : undefined;
      if (!isRecord(definition) || typeof definition["id"] !== "string" || definition["id"] === "") {
        throw new Error("example runner: canonical app definition is missing");
      }
      ownerProfile = { artifact: moduleArtifact, asm, app: definition["id"] };
    }
    // Canonical source verification consumes the same complete artifact that
    // issued this assembly, including the actual compiled test modules. The
    // original compiler bytes still own the report digest and row inventory.
    const tableOperations = new WeakMap<ExampleRowScope, Readonly<{ id: string; source: string }>>();
    const loadSuite = input.testkit.loadExampleSuite as (
      moduleUrl: string,
      bindings: { self: unknown; other: unknown; outsider?: unknown; imported: unknown },
      hooks: RunnerHooks,
    ) => Promise<unknown>;
    const runTable = input.testkit.runTable as (spec: unknown) => Promise<TableCaseResult>;
    const fixtureValuesOf = input.testkit.fixtureValuesOf as (scope: ExampleRowScope) => unknown;
    const createReport = input.testkit.createReport as (identity: { digest: string; sourceRevision: string }) => {
      addCase(result: ExampleCaseResult): void;
      build(): ExampleReport;
    };
    const reportBuilder = createReport({ digest, sourceRevision: input.sourceRevision });
    let expectedRows = 0;
    const authoredBindings = input.bindings ?? { self: "self", other: "other", outsider: "outsider", imported: {} };
    for (const [moduleIndex, test] of artifact.tests.entries()) {
      if (input.signal?.aborted) throw cancellationError();
      if (input.selectedRow !== undefined && test.scope !== input.selectedRow.operation) continue;
      const runtimeHooks = input.hooks ?? canonicalExampleHooks(moduleArtifact, asm, tableOperations, test.scope);
      const url = asm.moduleUrls[test.module.path];
      if (url === undefined) throw new Error(`example runner: test module ${test.module.path} was not staged`);
      const rowCallers = new WeakMap<object, ResolvedCaller>();
      const rowIdentities = new WeakMap<object, ResolvedIdentity>();
      let observationScope: CanonicalEffectsScope | undefined;
      let evaluationScope: ExampleRowScope | undefined;
      const rowUserRefs = new WeakMap<ExampleRowScope, Readonly<Record<string, unknown>>>();
      let imported: unknown = authoredBindings.imported;
      const bindings = new Proxy(authoredBindings, {
        get: (target, property, receiver) => {
          if (property === "imported") return imported;
          if (property === "operation") {
            const operation = observationScope === undefined || evaluationScope === undefined
              ? undefined : tableOperations.get(evaluationScope);
            if (operation === undefined) throw new Error("example runner: no completed mutation operation context in this phase");
            return operation;
          }
          return property === "canonical" ? observationScope
          : input.bindings === undefined && evaluationScope !== undefined && typeof property === "string" &&
              ["self", "other", "outsider"].includes(property) ? rowUserRefs.get(evaluationScope)?.[property]
          : property === "now" && evaluationScope !== undefined ? decodeValue("datetime", new Date(evaluationScope.nowMs).toISOString())
          : Reflect.get(target, property, receiver);
        },
      });
      const disposeActive = () => resources.drain();
      const createScope = (rowIndex: number): Promise<ExampleRowScope> => resources.allocate(async () => {
        if (input.signal?.aborted) throw cancellationError();
        let owned: ExampleRowScope;
        try { owned = await createRowScope(input, moduleIndex, rowIndex, ownerProfile); }
        catch (error) {
          if (error instanceof DevCleanupError) resources.retain(error, error.dispose);
          throw error;
        }
        const scoped = Object.create(owned) as ExampleRowScope;
        resources.retain(scoped, () => owned.dispose());
        Object.defineProperty(scoped, "dispose", { value: () => resources.dispose(scoped) });
        if (input.signal?.aborted) {
          await resources.dispose(scoped);
          throw cancellationError();
        }
        return scoped;
      });
      const hooks: RunnerHooks = {
        prepareFixtures: async (scope, fixtures, required) => {
          const nonUser = required.filter(recipe => recipe.kind !== "user");
          const result = await withCancellation(input.signal, () =>
            runtimeHooks.materializeFixtures({ scope, fixtures, required: nonUser }));
          if (!isRecord(result) || !Array.isArray(result["materialized"]) || !(result["values"] instanceof Map)) {
            throw new Error(`example runner: ${test.scope} fixture materializer returned no stored values receipt`);
          }
          const actual = new Set(result.materialized);
          const missing = nonUser.find(recipe => !actual.has(recipe.name));
          if (missing !== undefined) throw new Error(`example runner: fixture ${missing.name} was not materialized`);
          return result.values;
        },
        ...(runtimeHooks.prepareRowCells === undefined ? {} : { prepareRowCells: (args) =>
          withCancellation(input.signal, () => runtimeHooks.prepareRowCells!(args)) }),
        invokeCall: async call => {
          if (input.signal?.aborted) throw cancellationError();
          const caller = rowCallers.get(call.scope);
          if (caller === undefined) return { ok: false, unsupported: true, detail: "row caller was not resolved" };
          if (call.by === null || call.by === undefined) {
            return { ok: false, unsupported: true, detail: "call has no selected actor" };
          }
          const fixtures = checkedFixtureValues(fixtureValuesOf(call.scope), test.scope);
          const identity = await withCancellation(input.signal, () => call.scope.identityFor(call.by, caller, fixtures));
          rowIdentities.set(call.scope, identity);
          return withCancellation(input.signal, () => runtimeHooks.invoke({ call, identity, rowCaller: caller }));
        },
        observeScope: async (scope, stashed) => withCancellation(input.signal, () => runtimeHooks.observeLive({
          scope, fixtures: stashed.fixtures,
        })),
      };
      imported = await withCancellation(input.signal, () =>
        resolveExampleFixtureImports(artifact.tests, asm.moduleUrls, test, bindings));
      const suite = asLoadedSuite(await withCancellation(input.signal, () => loadSuite(url, bindings, hooks)), test.scope);
      if (suite.rows.length === 0) {
        // Compiler fixture declarations can have their own test-only
        // module. They do not count as a passing example; a module for an
        // attaching operation must contribute actual rows.
        if (test.fixtures.includes(test.scope)) continue;
        throw new Error(`example runner: ${test.scope} emitted zero executable rows`);
      }
      const selectedRows = input.selectedRow === undefined
        ? suite.rows
        : suite.rows.filter(row => row.rowIndex === input.selectedRow!.rowIndex);
      if (selectedRows.length === 0) {
        throw new Error(`example runner: selected row ${test.scope}#${input.selectedRow!.rowIndex} is unavailable`);
      }
      if (input.selectedRow !== undefined && selectedRows.length !== 1) {
        throw new Error(`example runner: selected row ${test.scope}#${input.selectedRow.rowIndex} is ambiguous`);
      }
      expectedRows += selectedRows.length;
      const rows = selectedRows.map(row => ({
        ...row,
        // Testkit resolves authored values/errors during row.setup. The
        // wrapper must read that live expectation, not the initial empty
        // placeholder copied by the spread above.
        get expected() { return row.expected; },
        setup: async (scope: ExampleRowScope, accounts: RowAccounts): Promise<void> => {
          await withCancellation(input.signal, () => scope.provisionActors(accounts, row.caller, suite.userFixtures));
          if (input.bindings === undefined) {
            const refs: Record<string, unknown> = Object.create(null);
            for (const account of ["self", "other", "outsider"] as const) {
              const identity = await withCancellation(input.signal, () => scope.identityFor(account,
                { account, team: account === "outsider" ? "other" : "current", roles: [], authenticated: true }, new Map()));
              if (identity.actor === null) throw new Error(`example runner: ${account} has no provisioned user identity`);
              refs[account] = decodeValue("user", { id: identity.actor.user_id });
            }
            rowUserRefs.set(scope, Object.freeze(refs));
          }
          evaluationScope = scope;
          try { await withCancellation(input.signal, () => row.setup(scope, accounts)); }
          finally { evaluationScope = undefined; }
        },
        invoke: async (scope: ExampleRowScope, caller: ResolvedCaller): Promise<ExampleCallOutcome> => {
          rowCallers.set(scope, caller);
          evaluationScope = scope;
          try { return await withCancellation(input.signal, () => row.invoke(scope, caller)); }
          finally { evaluationScope = undefined; }
        },
        observe: async (scope: ExampleRowScope): Promise<ReportValue[]> => {
          if (input.hooks !== undefined) {
            evaluationScope = scope;
            try { return await withCancellation(input.signal, () => row.observe(scope)); }
            finally { evaluationScope = undefined; }
          }
          const caller = rowCallers.get(scope);
          if (caller === undefined) throw new Error("example runner: observation caller was not resolved");
          const identity = rowIdentities.get(scope);
          if (identity === undefined) throw new Error("example runner: observation identity was not resolved");
          const store = scope.ownerStorage === undefined ? scope.store : await scope.ownerStorage.forIdentity(identity);
          const revision = await store.readRevision();
          const refuse = async (): Promise<never> => { throw new Error("example runner: observations are read only"); };
          const read = async (model: string, query: CanonicalReadQuery) => {
            if (Object.keys(query).some(key => key !== "where") ||
                query.where !== undefined && typeof query.where !== "function") {
              throw new Error("example runner: unsupported observation query shape");
            }
            if (await store.readRevision() !== revision) throw new Error("example runner: observation state changed");
            const served = await invokeReadCanonical({ asm, artifact: moduleArtifact, operation: `${model}.read`,
              inputs: {} as ClosedInputs, identity, store, memberships: scope.identities, source: "example" });
            if (!("records" in served) || !Array.isArray(served.records)) throw new Error("example runner: observation read returned no records");
            if (await store.readRevision() !== revision) throw new Error("example runner: observation state changed");
            return served.records;
          };
          observationScope = { operation: test.scope, stageWrite: refuse, readModel: read,
            readRecords: async (model, query) => {
              const served = await read(model, query);
              const views = served.map(record => fixtureView(moduleArtifact, model, record));
              if (query.where === undefined) return views;
              const selected: Record<string, unknown>[] = [];
              for (const view of views) {
                const admitted: unknown = await (query.where as (record: unknown) => unknown)(view);
                if (typeof admitted !== "boolean") throw new Error("example runner: observation predicate must return bool");
                if (admitted) selected.push(view);
              }
              if (await store.readRevision() !== revision) throw new Error("example runner: observation state changed");
              return selected;
            },
          };
          evaluationScope = scope;
          try { return await withCancellation(input.signal, () => row.observe(scope)); }
          finally { observationScope = undefined; evaluationScope = undefined; }
        },
      }));
      let result: TableCaseResult;
      try {
        result = await withCancellation(input.signal, () => runTable({
          operation: test.scope, userFixtures: suite.userFixtures, rows, createScope,
        }), disposeActive);
      } catch (error) {
        try { await disposeActive(); }
        catch (cleanupError) { throw new DevCleanupError(error, cleanupError, release); }
        throw error;
      }
      await disposeActive();
      if (input.signal?.aborted) throw cancellationError();
      if (result.kind !== "table" || result.rows.length !== selectedRows.length) {
        throw new Error(`example runner: testkit returned incomplete rows for ${test.scope}`);
      }
      reportBuilder.addCase(result);
    }
    if (input.signal?.aborted) throw cancellationError();
    const report = reportBuilder.build();
    if (input.selectedRow !== undefined && expectedRows !== 1) {
      throw new Error(`example runner: selected row ${input.selectedRow.operation}#${input.selectedRow.rowIndex} is unavailable`);
    }
    if (report.summary.total !== expectedRows || expectedRows === 0) {
      throw new Error(`example runner: report counted ${report.summary.total}/${expectedRows} rows`);
    }
    await release();
    return {
      ok: report.summary.failed === 0 && report.summary.setupFailed === 0 && report.summary.unsupported === 0,
      executed: report.summary.total,
      report,
    };
  } catch (error) {
    try { await release(); }
    catch (cleanupError) {
      throw new DevCleanupError(error, cleanupError, release);
    }
    throw error;
  }
}
