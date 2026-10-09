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
import type { ArtifactModelField, ClosedInputs, CompileArtifact, ExampleCaseResult, ExampleReport, FqOperationName, ModelName, OperationId, RecordId, RecordVersion, ReportValue, ResolvedCaller, ResolvedIdentity, StoragePort, StoredRow, TableCaseResult } from "@canlang/contracts";
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText, toInstant, type IdentityStore } from "@canlang/identity";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import { decodeValue, encodeValue } from "@canlang/values";
import { createLocalRowScope, type LocalRowScope } from "./row-scope.js";
import { parseArtifactText } from "../runtime/artifact.js";
import { assembleModules, type AssembledModules } from "../runtime/modules.js";
import { buildInvoker } from "../worker/assembly.js";

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

/** The invoking application installs the optional producer, without a package cycle. */
export async function loadInstalledExampleTestkit(applicationRoot: string): Promise<ExampleTestkitPort> {
  let entry: string;
  try {
    entry = createRequire(resolve(applicationRoot, "package.json")).resolve("@canlang/testkit");
  } catch {
    throw new MissingExampleTestkitError();
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
  readonly bindings?: { readonly self: unknown; readonly other: unknown; readonly imported: unknown };
  /** Execute one authored table row, used by the isolated rerun coordinator. */
  readonly selectedRow?: { readonly operation: string; readonly rowIndex: number };
  /** Correlates a fresh row scope with its attempt; never reused as D1 state. */
  readonly runId?: string;
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
  readonly identities: IdentityStore;
  readonly d1Id: string;
  readonly currentTeamId: string | null;
  readonly fixtureActorId: string | null;
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

async function createRowScope(input: CompiledExampleInput, moduleIndex: number, rowIndex: number): Promise<ExampleRowScope> {
  const d1Id = randomUUID();
  const attempt = input.runId === undefined ? "" : `-${input.runId.slice(0, 8)}`;
  const workerName = `${input.workerName.slice(0, 32)}${attempt}-${moduleIndex}-${rowIndex}-${d1Id.slice(0, 8)}`;
  const base = await createLocalRowScope(d1Id, {
    workerName,
    compatibilityDate: input.compatibilityDate,
    mainModule: input.worker.mainModule,
    modules: input.worker.modules,
    ...(input.worker.binaryModules === undefined ? {} : { binaryModules: input.worker.binaryModules }),
    d1Binding: input.d1Binding,
  });
  try {
    const db = await base.dev.getD1Database(input.d1Binding);
    await ensureSchema(db);
    await ensureIdentitySchema(db);
    const store = createD1Storage(db);
    const identities = createD1IdentityStore(db);
    const tokens = new Map<string, string>();
    let currentTeamId: string | null = null;
    let otherTeamId: string | null = null;
    let accountsOfRow: RowAccounts | null = null;
    let ownerUserId: string | null = null;

    async function addActor(account: string, teamId: string, roles: readonly string[], isOwner = false): Promise<void> {
      const user = await identities.createUser({
        email: `${account}@examples.invalid`,
        password_hash: "example-only-unusable",
        email_verified: true,
      });
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
      store,
      identities,
      d1Id,
      get currentTeamId() { return currentTeamId; },
      get fixtureActorId() { return ownerUserId; },
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
      },
      async identityFor(by, rowCaller, fixtures) {
        if (accountsOfRow === null || currentTeamId === null || otherTeamId === null) {
          throw new Error("example runner: row actors are unavailable");
        }
        if (by === "public") return resolveIdentity(identities, {});
        let account: string | null = null;
        if (by === "self" || (input.bindings !== undefined && by === input.bindings.self)) account = accountsOfRow.self;
        else if (by === "other" || (input.bindings !== undefined && by === input.bindings.other)) account = accountsOfRow.other;
        else if (by === "outsider") account = accountsOfRow.outsider;
        else if (typeof by === "string" && Object.hasOwn(accountsOfRow.users, by)) {
          account = accountsOfRow.users[by]!.account;
        } else if (typeof by === "string" && (by === "members" || rowCaller.roles.includes(by))) {
          account = rowCaller.account === "public" ? null : rowCaller.account;
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
    try {
      await base.dispose();
    } catch {
      // Preserve the provisioning failure after attempting owned disposal.
    }
    throw error;
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

function fieldWire(field: ArtifactModelField, value: unknown): unknown {
  if (value === null) return null;
  if (field.field.kind === "enum") {
    if (typeof value !== "string" || !field.field.values.includes(value)) {
      throw new Error(`example runner: invalid enum fixture field ${field.name}`);
    }
    return value;
  }
  const type = field.valueType ?? ({ string: "text", integer: "int", boolean: "bool", decimal: "decimal", money: "money", datetime: "datetime", duration: "duration" } as Record<string, string>)[field.field.kind];
  if (type === undefined) throw new Error(`example runner: fixture field ${field.name} needs a supported value type`);
  return encodeValue(type, value as never);
}

function nativeFixtureField(field: ArtifactModelField, wire: unknown): unknown {
  if (wire === null) return null;
  if (field.field.kind === "enum") return wire;
  const type = field.valueType ?? ({ string: "text", integer: "int", boolean: "bool", decimal: "decimal", money: "money", datetime: "datetime", duration: "duration" } as Record<string, string>)[field.field.kind];
  if (type === undefined) throw new Error(`example runner: fixture field ${field.name} needs a supported value type`);
  return decodeValue(type, wire);
}

function fixtureView(artifact: CompileArtifact, modelName: string, row: StoredRow): Record<string, unknown> {
  const model = artifact.models?.find(candidate => candidate.name === modelName);
  if (model === undefined) throw new Error(`example runner: unknown model ${modelName}`);
  const view: Record<string, unknown> = { id: row.id, version: BigInt(row.version) };
  for (const field of model.fields) {
    if (Object.hasOwn(row.data, field.name)) view[field.name] = nativeFixtureField(field, row.data[field.name]);
  }
  return view;
}

function wireInputs(value: unknown, references: ReadonlyMap<object, StoredFixtureBinding>, seen = new Set<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
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
function canonicalExampleHooks(artifact: CompileArtifact, asm: AssembledModules): ExampleRuntimeHooks {
  const models = artifact.models ?? [];
  const operations = artifact.operations ?? [];
  const rows = new WeakMap<ExampleRowScope, Map<string, StoredFixtureBinding>>();
  const references = new WeakMap<ExampleRowScope, Map<object, StoredFixtureBinding>>();
  return {
    async materializeFixtures({ scope, fixtures, required }) {
      const values = new Map(fixtures);
      const rowBindings = new Map<string, StoredFixtureBinding>();
      const objectBindings = new Map<object, StoredFixtureBinding>();
      const materialized: string[] = [];
      for (const recipe of required) {
        if (recipe.kind !== "model" || recipe.label === undefined) {
          throw new Error(`example runner: ${recipe.name} needs a local ${recipe.kind} fixture producer`);
        }
        const model = models.find(candidate => candidate.name === recipe.label);
        if (model === undefined) throw new Error(`example runner: fixture ${recipe.name} names unknown model ${recipe.label}`);
        if (model.parent !== undefined || model.uniqueKeys?.length) {
          throw new Error(`example runner: fixture ${recipe.name} needs parent or unique-key materialization`);
        }
        const fields = fixtures.get(recipe.name);
        if (!isRecord(fields)) throw new Error(`example runner: model fixture ${recipe.name} has no field record`);
        const declared = new Set(model.fields.map(field => field.name));
        for (const name of Object.keys(fields)) {
          if (!declared.has(name)) throw new Error(`example runner: fixture ${recipe.name} has unknown field ${name}`);
        }
        const data: Record<string, unknown> = {};
        for (const field of model.fields) {
          if (Object.hasOwn(fields, field.name)) data[field.name] = fieldWire(field, fields[field.name]);
          else if (field.default?.kind === "literal") data[field.name] = field.default.value;
          else if (field.required && !field.serverOnly) throw new Error(`example runner: fixture ${recipe.name} lacks required ${field.name}`);
          else if (field.serverOnly && field.default?.kind !== "derived") {
            throw new Error(`example runner: fixture ${recipe.name} needs a server-field initializer`);
          }
        }
        const actor = scope.fixtureActorId;
        if (actor === null || scope.currentTeamId === null) throw new Error("example runner: fixture owner was not provisioned");
        const now = Date.now();
        const row: StoredRow = {
          id: randomUUID() as RecordId,
          version: 1 as RecordVersion,
          created: now, updated: now, createdBy: actor, updatedBy: actor,
          archivedAt: null, parent: null, data,
        };
        await scope.store.commit({
          expectedRevision: await scope.store.readRevision(),
          writes: [{ kind: "insert", model: model.name as ModelName, row }],
          history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [],
        });
        const stored = await scope.store.load(model.name as ModelName, row.id);
        if (stored === null) throw new Error(`example runner: fixture ${recipe.name} was not stored`);
        const view = fixtureView(artifact, model.name, stored);
        const binding = { model: model.name, id: stored.id as string, version: stored.version as number };
        values.set(recipe.name, view);
        rowBindings.set(recipe.name, binding);
        objectBindings.set(view, binding);
        materialized.push(recipe.name);
      }
      rows.set(scope, rowBindings);
      references.set(scope, objectBindings);
      return { materialized, values };
    },
    async prepareRowCells({ scope, fixtures, baselineInputs, inputs, selectors, cells }) {
      const rowBindings = rows.get(scope);
      const objectBindings = references.get(scope);
      if (rowBindings === undefined || objectBindings === undefined ||
          !isRecord(baselineInputs) || !isRecord(inputs)) return { fixtures, inputs };
      const overrides = new Map<string, Record<string, unknown>>();
      for (const [index, selector] of selectors.entries()) {
        const parts = selector.split(".");
        if (parts.length !== 2) continue;
        const [root, fieldName] = parts as [string, string];
        const baselineRoot = baselineInputs[root];
        if (!isRecord(baselineRoot) || !objectBindings.has(baselineRoot)) continue;
        const fixtureName = [...fixtures].find(([, value]) => value === baselineRoot)?.[0];
        if (fixtureName === undefined) continue;
        const binding = rowBindings.get(fixtureName);
        const model = models.find(candidate => candidate.name === binding?.model);
        if (binding === undefined || model?.fields.some(field => field.name === fieldName) !== true) continue;
        const selected = overrides.get(fixtureName) ?? {};
        selected[fieldName] = cells[index];
        overrides.set(fixtureName, selected);
      }
      if (overrides.size === 0) return { fixtures, inputs };
      const updatedFixtures = new Map(fixtures);
      const updatedInputs = { ...inputs };
      for (const [name, fields] of overrides) {
        const binding = rowBindings.get(name)!;
        const model = models.find(candidate => candidate.name === binding.model)!;
        const stored = await scope.store.load(binding.model as ModelName, binding.id as RecordId);
        if (stored === null) throw new Error(`example runner: fixture ${name} disappeared before row cells`);
        const data = { ...stored.data };
        for (const [fieldName, value] of Object.entries(fields)) {
          const field = model.fields.find(candidate => candidate.name === fieldName)!;
          data[fieldName] = fieldWire(field, value);
        }
        const actor = scope.fixtureActorId;
        if (actor === null) throw new Error("example runner: fixture owner was not provisioned");
        const next: StoredRow = { ...stored, version: (stored.version + 1) as RecordVersion,
          updated: Date.now(), updatedBy: actor, data };
        await scope.store.commit({
          expectedRevision: await scope.store.readRevision(),
          writes: [{ kind: "update", model: binding.model as ModelName, id: stored.id,
            expectedVersion: stored.version, row: next }],
          history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [],
        });
        const saved = await scope.store.load(binding.model as ModelName, binding.id as RecordId);
        if (saved === null) throw new Error(`example runner: fixture ${name} row-cell update was not stored`);
        const oldValue = fixtures.get(name);
        if (isRecord(oldValue)) objectBindings.delete(oldValue);
        const view = fixtureView(artifact, binding.model, saved);
        const savedBinding = { model: binding.model, id: saved.id as string, version: saved.version as number };
        updatedFixtures.set(name, view);
        rowBindings.set(name, savedBinding);
        objectBindings.set(view, savedBinding);
        for (const [root, value] of Object.entries(baselineInputs)) {
          if (value === oldValue) updatedInputs[root] = view;
        }
      }
      return { fixtures: updatedFixtures, inputs: updatedInputs };
    },
    async invoke({ call, identity }) {
      const operation = operations.find(candidate => candidate.name === call.operation);
      if (operation === undefined) throw new Error(`example runner: unknown operation ${call.operation}`);
      const encoded = wireInputs(call.inputs, references.get(call.scope) ?? new Map());
      if (!isRecord(encoded)) throw new Error("example runner: operation inputs are not an object");
      const request = applyRequestOverrides(closedOperationInputs(operation.kind, encoded),
        wireInputs(call.request, new Map()));
      const invoker = buildInvoker(artifact, asm, call.scope.store, {
        memberships: call.scope.identities,
        source: "example",
      });
      const outcome = operation.kind === "read"
        ? await invoker.invokeRead({ operation: call.operation as FqOperationName, inputs: request.inputs as ClosedInputs }, identity)
        : await invoker.invokeMutation({
          operation: call.operation as FqOperationName,
          operation_id: (request.operationId ?? freshOperationId()) as OperationId,
          inputs: request.inputs as ClosedInputs,
        }, identity);
      return "error" in outcome ? { ok: false, error: outcome.error.code } : { ok: true };
    },
    async observeLive({ scope, fixtures }) {
      const values = new Map(fixtures);
      for (const [name, binding] of rows.get(scope) ?? []) {
        const stored = await scope.store.load(binding.model as ModelName, binding.id as RecordId);
        values.set(name, stored === null ? null : fixtureView(artifact, binding.model, stored));
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
  let failed = false;
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
    const runtimeHooks = input.hooks ?? canonicalExampleHooks(artifact, asm);
    const loadSuite = input.testkit.loadExampleSuite as (
      moduleUrl: string,
      bindings: { self: unknown; other: unknown; imported: unknown },
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
    const bindings = input.bindings ?? { self: "self", other: "other", imported: {} };
    for (const [moduleIndex, test] of artifact.tests.entries()) {
      if (input.selectedRow !== undefined && test.scope !== input.selectedRow.operation) continue;
      const url = asm.moduleUrls[test.module.path];
      if (url === undefined) throw new Error(`example runner: test module ${test.module.path} was not staged`);
      const rowCallers = new WeakMap<object, ResolvedCaller>();
      const hooks: RunnerHooks = {
        prepareFixtures: async (scope, fixtures, required) => {
          const nonUser = required.filter(recipe => recipe.kind !== "user");
          const result = await runtimeHooks.materializeFixtures({ scope, fixtures, required: nonUser });
          if (!isRecord(result) || !Array.isArray(result["materialized"]) || !(result["values"] instanceof Map)) {
            throw new Error(`example runner: ${test.scope} fixture materializer returned no stored values receipt`);
          }
          const actual = new Set(result.materialized);
          const missing = nonUser.find(recipe => !actual.has(recipe.name));
          if (missing !== undefined) throw new Error(`example runner: fixture ${missing.name} was not materialized`);
          return result.values;
        },
        ...(runtimeHooks.prepareRowCells === undefined ? {} : { prepareRowCells: runtimeHooks.prepareRowCells }),
        invokeCall: async call => {
          const caller = rowCallers.get(call.scope);
          if (caller === undefined) return { ok: false, unsupported: true, detail: "row caller was not resolved" };
          if (call.by === null || call.by === undefined) {
            return { ok: false, unsupported: true, detail: "call has no selected actor" };
          }
          const fixtures = checkedFixtureValues(fixtureValuesOf(call.scope), test.scope);
          const identity = await call.scope.identityFor(call.by, caller, fixtures);
          return runtimeHooks.invoke({ call, identity, rowCaller: caller });
        },
        observeScope: async (scope, stashed) => runtimeHooks.observeLive({
          scope,
          fixtures: stashed.fixtures,
        }),
      };
      const suite = asLoadedSuite(await loadSuite(url, bindings, hooks), test.scope);
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
        setup: async (scope: ExampleRowScope, accounts: RowAccounts): Promise<void> => {
          await scope.provisionActors(accounts, row.caller, suite.userFixtures);
          await row.setup(scope, accounts);
        },
        invoke: async (scope: ExampleRowScope, caller: ResolvedCaller): Promise<ExampleCallOutcome> => {
          rowCallers.set(scope, caller);
          return row.invoke(scope, caller);
        },
      }));
      const result = await runTable({
        operation: test.scope,
        userFixtures: suite.userFixtures,
        rows,
        createScope: (rowIndex: number) => createRowScope(input, moduleIndex, rowIndex),
      });
      if (result.kind !== "table" || result.rows.length !== selectedRows.length) {
        throw new Error(`example runner: testkit returned incomplete rows for ${test.scope}`);
      }
      reportBuilder.addCase(result);
    }
    const report = reportBuilder.build();
    if (input.selectedRow !== undefined && expectedRows !== 1) {
      throw new Error(`example runner: selected row ${input.selectedRow.operation}#${input.selectedRow.rowIndex} is unavailable`);
    }
    if (report.summary.total !== expectedRows || expectedRows === 0) {
      throw new Error(`example runner: report counted ${report.summary.total}/${expectedRows} rows`);
    }
    return {
      ok: report.summary.failed === 0 && report.summary.setupFailed === 0 && report.summary.unsupported === 0,
      executed: report.summary.total,
      report,
    };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await rm(workDir, { force: true, recursive: true });
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
