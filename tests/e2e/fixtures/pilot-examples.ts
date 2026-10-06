/**
 * T37 genuine examples: execute emitted BDD suites against the LIVE pilot
 * (real invoker + real D1) through the testkit runner. No doubles on this
 * path: fixtures become real records, invocations run the canonical
 * pipeline, observations read live rows.
 *
 * Live fixture provisioning (per row scope): ref-typed inputs that carry
 * a provisioned fixture value are created for real (`{model}.create`
 * with the fixture's creatable fields: scalars verbatim, `{kind:'user'}`
 * as the id string, explicit nulls kept) and substituted as
 * `{id, version}` refs. Fixture fields outside the create descriptor
 * (server-owned state such as `Task.done`) are established with a direct
 * fenced commit — the same seed privilege as the staff bootstrap — and
 * the substituted ref carries the resulting version. Anything else
 * (nested model refs, tagged date/money/file values) fails loud naming
 * the fixture and field: silent coercion would forge the example.
 *
 * Row callers resolve to the one staff caller this runner is built with
 * (the suite's `self`): per-`as` caller switching is a later slice, and
 * the pilot suites exercise single-caller tables.
 */
import type {
  CompileArtifact,
  FqOperationName,
  ModelName,
  MutationRef,
  OperationId,
  RecordId,
  RecordVersion,
  ReportValue,
  ResolvedIdentity,
  StoragePort,
  TableCaseResult,
} from "@canlang/contracts";
import {
  fixtureValuesOf,
  loadExampleSuite,
  stashedRowOf,
  type FixtureBindings,
} from "@canlang/testkit";
import { runTable, type CallOutcome, type RowScope } from "@canlang/testkit";
import type { OperationInvoker } from "../../../packages/cloudflare/src/worker/assembly.js";

export interface PilotExampleDeps {
  readonly artifact: CompileArtifact;
  readonly invoker: OperationInvoker;
  readonly store: StoragePort;
  /** Staff caller every example invocation runs as. */
  readonly caller: ResolvedIdentity;
  readonly userId: string;
  readonly now: () => number;
  readonly operationId: () => string;
}

interface LiveRecord {
  readonly model: string;
  readonly id: string;
  readonly version: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createdId(result: unknown, what: string): string {
  const row = (result as { result?: unknown }).result as
    | { id?: unknown; version?: unknown; data?: unknown }
    | undefined;
  if (typeof row?.id !== "string") {
    throw new Error(`${what}: create result has no string id: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return row.id;
}

function errorCode(outcome: { error: { code?: unknown } | null }): string {
  const code: unknown = outcome.error?.code;
  return typeof code === "string" ? code : "unknown";
}

/**
 * Maps one fixture field value to a create input, or returns undefined
 * when the field is NOT creatable (server-owned establishment) versus
 * throwing loud on genuinely unmappable values.
 */
function toCreateInput(field: string, value: unknown, what: string): { creatable: true; input: unknown } | { creatable: false } | { unmapped: string } {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { creatable: true, input: value };
  }
  if (Array.isArray(value)) {
    const mapped: unknown[] = [];
    for (const [index, element] of value.entries()) {
      const item = toCreateInput(`${field}[${index}]`, element, what);
      if ("unmapped" in item) return item;
      if (!item.creatable) return { unmapped: `${field}[${index}] is not a creatable element` };
      mapped.push(item.input);
    }
    return { creatable: true, input: mapped };
  }
  if (isRecord(value)) {
    // `{kind:'user', id}` (e.g. `assignee=self`) passes through
    // VERBATIM: the canonical path stores inputs verbatim (probe-proven)
    // and downstream `same()` comparisons need tagged refs — a bare id
    // string would throw `invalid-construction` there. (The MCP
    // transport projection renders user inputs as strings; that
    // projection is not this path.)
    if (value["kind"] === "user" && typeof value["id"] === "string") {
      return { creatable: true, input: value };
    }
    return { unmapped: `${what}: field ${JSON.stringify(field)} is a nested object with no input mapping` };
  }
  return { unmapped: `${what}: field ${JSON.stringify(field)} has no input mapping` };
}

export class PilotExamples {
  private readonly provisioned = new WeakMap<RowScope, Map<string, LiveRecord>>();
  /**
   * Per-row revision markers: live provisioning (creates +
   * establishment) legitimately commits inside the invoke window the
   * rejection proof measures. Snapshots subtract the measured
   * provisioning bumps so the proof covers exactly the operation under
   * test — a real leak still trips it.
   */
  private readonly invokeMarks = new WeakMap<RowScope, { start: number; provisioned: number }>();

  constructor(private readonly deps: PilotExampleDeps) {}

  bindings(): FixtureBindings {
    return { self: { kind: "user", id: this.deps.userId }, other: null, imported: {} };
  }

  private liveRecords(scope: RowScope): Map<string, LiveRecord> {
    let cached = this.provisioned.get(scope);
    if (cached === undefined) {
      cached = new Map();
      this.provisioned.set(scope, cached);
    }
    return cached;
  }

  /**
   * Maps one applied ref input back to its fixture. Applied roots are
   * CLONES (input-cell application never mutates provisioned values),
   * so identity matches against the STASHED BASELINE root of the same
   * input name — the exact object the `inputs` closure returned.
   */
  private fixtureName(scope: RowScope, inputName: string): string | null {
    const baseline = stashedRowOf(scope)?.baselineInputs;
    const root = isRecord(baseline) ? baseline[inputName] : undefined;
    if (root === undefined) return null;
    const values = fixtureValuesOf(scope);
    if (values === undefined) return null;
    for (const [name, candidate] of values) {
      if (candidate === root) return name;
    }
    return null;
  }

  private opDescriptor(operation: string): { fields: ReadonlyArray<{ name: string; field: { kind: string; model?: string } }> } {
    const found = this.deps.artifact.operations?.find((op) => op.name === operation);
    if (found === undefined) {
      throw new Error(`pilot examples: operation ${JSON.stringify(operation)} is not in the artifact`);
    }
    return found.inputs;
  }

  /** Creates the live record for one fixture value; caches per scope. */
  private async ensureLiveRecord(
    scope: RowScope,
    fixture: string,
    model: string,
    value: Record<string, unknown>,
  ): Promise<LiveRecord> {
    const cached = this.liveRecords(scope).get(fixture);
    if (cached !== undefined) return cached;
    const what = `pilot examples fixture ${JSON.stringify(fixture)} (${model})`;
    const createOp = `${model}.create`;
    const descriptor = this.opDescriptor(createOp);
    const writable = new Set(descriptor.fields.map((field) => field.name));
    const inputs: Record<string, unknown> = {};
    const establish: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (!writable.has(field)) {
        establish[field] = fieldValue;
        continue;
      }
      const mapped = toCreateInput(field, fieldValue, what);
      if ("unmapped" in mapped) {
        throw new Error(mapped.unmapped);
      }
      if (!mapped.creatable) {
        establish[field] = fieldValue;
        continue;
      }
      inputs[field] = mapped.input;
    }
    const created = await this.deps.invoker.invokeMutation(
      {
        operation: createOp as FqOperationName,
        operation_id: this.deps.operationId() as OperationId,
        inputs,
      },
      this.deps.caller,
    );
    if (!("result" in created)) {
      throw new Error(`${what}: live create rejected with ${errorCode(created)}`);
    }
    const id = createdId(created.result, what);
    let version = 1;
    if (Object.keys(establish).length > 0) {
      const stored = await this.deps.store.load(model as ModelName, id as RecordId);
      if (stored === null) {
        throw new Error(`${what}: created row ${id} not readable for establishment`);
      }
      version = stored.version + 1;
      await this.deps.store.commit({
        expectedRevision: await this.deps.store.readRevision(),
        writes: [
          {
            kind: "update",
            model: model as ModelName,
            id: id as RecordId,
            expectedVersion: stored.version,
            row: { ...stored, version: version as RecordVersion, updated: this.deps.now(), data: { ...stored.data, ...establish } },
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
    }
    const live: LiveRecord = { model, id, version };
    this.liveRecords(scope).set(fixture, live);
    return live;
  }

  private async substituteRefs(
    scope: RowScope,
    operation: string,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const descriptor = this.opDescriptor(operation);
    const substituted: Record<string, unknown> = { ...inputs };
    for (const field of descriptor.fields) {
      if (field.field.kind !== "ref" || field.field.model === undefined) continue;
      const value: unknown = substituted[field.name];
      if (value === undefined) continue;
      if (isRecord(value) && typeof value["id"] === "string" && (typeof value["version"] === "string" || typeof value["version"] === "number")) {
        substituted[field.name] = { id: value["id"], version: String(value["version"]) } as MutationRef;
        continue;
      }
      if (!isRecord(value)) {
        throw new Error(
          `pilot examples: input ${JSON.stringify(field.name)} of ${operation} is neither a fixture value nor a record ref`,
        );
      }
      const fixture = this.fixtureName(scope, field.name);
      if (fixture === null) {
        throw new Error(
          `pilot examples: input ${JSON.stringify(field.name)} of ${operation} matches no provisioned fixture via its baseline root`,
        );
      }
      const live = await this.ensureLiveRecord(scope, fixture, field.field.model, value);
      substituted[field.name] = { id: live.id, version: String(live.version) } as MutationRef;
    }
    return substituted;
  }

  readonly invokeCall = async (call: {
    operation: string;
    inputs: unknown;
    by: unknown;
    scope: RowScope;
  }): Promise<CallOutcome> => {
    void call.by;
    if (!isRecord(call.inputs)) {
      throw new Error(`pilot examples: inputs of ${call.operation} are not an object`);
    }
    const start = Number(await this.deps.store.readRevision());
    const inputs = await this.substituteRefs(call.scope, call.operation, call.inputs);
    this.invokeMarks.set(call.scope, {
      start,
      provisioned: Number(await this.deps.store.readRevision()),
    });
    const outcome = await this.deps.invoker.invokeMutation(
      {
        operation: call.operation as FqOperationName,
        operation_id: this.deps.operationId() as OperationId,
        inputs,
      },
      this.deps.caller,
    );
    if ("error" in outcome) {
      return { ok: false, error: errorCode(outcome) };
    }
    return { ok: true };
  };

  readonly observeScope = async (scope: RowScope, stashed: { fixtures: ReadonlyMap<string, unknown> }): Promise<ReadonlyMap<string, unknown>> => {
    const observed = new Map<string, unknown>();
    for (const [name, fallback] of stashed.fixtures) {
      const live = this.liveRecords(scope).get(name);
      if (live === undefined) {
        observed.set(name, fallback);
        continue;
      }
      const row = await this.deps.store.load(live.model as ModelName, live.id as RecordId);
      if (row === null) {
        throw new Error(`pilot examples: live row for fixture ${JSON.stringify(name)} vanished`);
      }
      observed.set(name, row.data);
    }
    return observed;
  };

  createScope = async (_rowIndex: number): Promise<RowScope> => {
    const store = this.deps.store;
    const marks = this.invokeMarks;
    let scope!: RowScope;
    scope = {
      snapshot: async (): Promise<ReportValue> => {
        // Before invoke the marks are unset: raw revision. After
        // invoke: revision minus measured provisioning bumps.
        const mark = marks.get(scope);
        const revision = Number(await store.readRevision());
        return mark === undefined ? revision : revision - (mark.provisioned - mark.start);
      },
      dispose: async (): Promise<void> => {},
    };
    return scope;
  };

  /**
   * Executes one emitted suite module end to end. The caller stages the
   * suite (`stageSuiteModule`) and names the operation under test; every
   * row must pass (rejections exact, side-effect proofs clean).
   */
  async runSuite(suiteUrl: string, operation: string): Promise<TableCaseResult> {
    const suite = await loadExampleSuite(suiteUrl, this.bindings(), {
      invokeCall: this.invokeCall,
      observeScope: this.observeScope,
    });
    return runTable({
      operation,
      userFixtures: suite.userFixtures,
      createScope: this.createScope,
      rows: suite.rows,
    });
  }
}
