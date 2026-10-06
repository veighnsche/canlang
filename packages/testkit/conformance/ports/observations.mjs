#!/usr/bin/env bun
/**
 * C05.1 deterministic current-TS observers for port parity measurement.
 *
 * Run from the repository root: `bun packages/testkit/conformance/ports/observations.mjs`
 * Options: `--workload <id>` (repeatable; default all), `--seed <n>` (default 1),
 *   `--check <baseline.json>` (verify against frozen bytes), `--pretty`.
 * Env: `CAN_OBS_HEAD` pins the observed source commit in the report.
 *
 * Rules (frozen by workloads.json, enforced here, never advisory):
 * - every observed call executes EXACTLY ONCE per run (`observe` throws on a
 *   repeated tag) — side-effectful getters/callbacks are never shadow-run twice;
 * - every fixture input is rejected if it carries getters/setters
 *   (`assertNoAccessors`); proxies/symbols/cycles are refused by the same rule;
 * - this runner records actuals only. Behavior oracles live in frozen
 *   baseline files produced by a first run, compared via `--check`.
 * - timings are recorded, never asserted: provisional budgets in
 *   workloads.json are UNRATIFIED until the V11.1/C05 procedure ratifies them.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { addInt, subtractInt, multiplyInt, modInt, compareInt, INT64_MIN, INT64_MAX } from "../../../../packages/values/src/int.ts";
import { Decimal, addDecimal, multiplyDecimal, divideDecimal, compareDecimal } from "../../../../packages/values/src/decimal.ts";
import { money, addMoney, subtractMoney, multiplyMoney, divideMoney, moneyRatio, isKnownCurrency } from "../../../../packages/values/src/money.ts";
import { date, datetime, add_days, add_months, dateToEpochDays, epochDaysToDate, assertDatetimeInRange } from "../../../../packages/values/src/temporal.ts";
import { sumInt, sumDecimal } from "../../../../packages/values/src/array.ts";
import { normalizeSchema, validateValue } from "../../../../packages/values/src/schema.ts";
import { decodeValue, encodeValue } from "../../../../packages/values/src/wire.ts";
import { computeBackoff, classifyFailure, listDeadLetter, reconcileUncertain, DEFAULT_RETRY_POLICY } from "../../../../packages/work/src/receipt/index.ts";
import { everyScopeKey, computeEverySlot, deriveRecurringOccurrenceId } from "../../../../packages/work/src/schedule/every.ts";
import { parseArtifactText } from "../../../../packages/cloudflare/src/runtime/artifact.ts";
import { checkCompilerVersionMatch } from "../../../../packages/cloudflare/src/deploy/compat.ts";

/* ---------- canonical serialization (bigint-safe, key-ordered) ---------- */

function canonical(value, seen = new Set()) {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map((v) => canonical(v, seen));
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new Error("observations: cyclic value cannot be canonicalized");
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key], seen);
    seen.delete(value);
    return out;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (value === Infinity) return { $number: "Infinity" };
    if (value === -Infinity) return { $number: "-Infinity" };
    if (Object.is(value, -0)) return { $number: "-0" };
    return value;
  }
  if (value === undefined) return { $undefined: true };
  return value;
}

function digestOf(records) {
  return createHash("sha256").update(JSON.stringify(records.map((record) => canonical(record)))).digest("hex");
}

/* ---------- single-run + accessor guards ---------- */

const seenTags = new Set();

function observe(tag, fn) {
  if (seenTags.has(tag)) throw new Error(`observations: tag executed twice: ${tag}`);
  seenTags.add(tag);
  return fn();
}

function assertNoAccessors(value, path = "$", seen = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (seen.has(value)) throw new Error(`observations: cyclic fixture at ${path}`);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`observations: symbol key at ${path}`);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      throw new Error(`observations: accessor at ${path}.${String(key)}`);
    }
    if ("value" in desc) assertNoAccessors(desc.value, `${path}.${String(key)}`, seen);
  }
  seen.delete(value);
}

function capture(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    const out = { ok: false, error: { name: error?.constructor?.name ?? typeof error } };
    if (error instanceof Error) {
      out.error.message = error.message;
      if ("code" in error) out.error.code = error.code;
      if ("violations" in error && Array.isArray(error.violations)) {
        out.error.violations = error.violations.map((v) => ({ path: v.path, code: v.code }));
      }
    } else {
      out.error.message = String(error);
    }
    return out;
  }
}

function stubRandom(samples) {
  let i = 0;
  let consumed = 0;
  return {
    port: { nextUnit: () => { consumed += 1; const v = samples[i % samples.length]; i += 1; return v; } },
    consumed: () => consumed,
  };
}

/* ---------- environment / resources ---------- */

function captureEnv(seed) {
  return {
    runtime: typeof Bun !== "undefined" ? `bun/${Bun.version}` : `node/${process.version}`,
    platform: process.platform,
    arch: process.arch,
    seed,
    head: process.env.CAN_OBS_HEAD ?? "unpinned",
  };
}

/* ---------- workloads (current-TS only; each entry runs once) ---------- */

const H = 10n ** 1000n;
const C38 = 10n ** 38n - 1n;

const WORKLOADS = [
  {
    id: "values-arith",
    plan: "exact-values",
    entries: ["int.ts", "decimal.ts", "money.ts"],
    run(check) {
      check("addInt(H,-H)", observe("values-arith/add", () => addInt(H, -H)));
      check("subtractInt(H,H)", observe("values-arith/sub", () => subtractInt(H, H)));
      check("multiplyInt(H,0)", observe("values-arith/mul", () => multiplyInt(H, 0n)));
      check("modInt(H,3)", observe("values-arith/mod", () => modInt(H, 3n)));
      check("compareInt(H,H+1)", observe("values-arith/cmp", () => compareInt(H, H + 1n)));
      check("modInt(INT64_MIN,-1)", observe("values-arith/mod-edge", () => modInt(INT64_MIN, -1n)));
      check("int64 bounds", observe("values-arith/bounds", () => ({ min: INT64_MIN, max: INT64_MAX })));
      const parts = (d) => ({ coef: d.coef, scale: d.scale });
      check("addDecimal(H,-H)", observe("values-arith/dadd", () => parts(addDecimal(H, -H))));
      check("multiplyDecimal(H,0)", observe("values-arith/dmul", () => parts(multiplyDecimal(H, 0n))));
      check("divideDecimal(H,H)", observe("values-arith/ddiv", () => parts(divideDecimal(H, H))));
      check("divideDecimal(1,H)", observe("values-arith/ddiv-scale", () => parts(divideDecimal(1n, H))));
      check("compareDecimal(H,H+1)", observe("values-arith/dcmp", () => compareDecimal(H, H + 1n)));
      check(
        "wide scaled division",
        observe("values-arith/dwide", () => parts(divideDecimal(new Decimal(C38, 18), new Decimal(C38, 18))))
      );
      const m1 = money(100n, "USD");
      const m2 = money(250n, "USD");
      check("money fixture", observe("values-arith/mfix", () => ({ m1, m2 })));
      check("addMoney", observe("values-arith/madd", () => addMoney(m1, m2)));
      check("subtractMoney", observe("values-arith/msub", () => subtractMoney(m2, m1)));
      check("multiplyMoney", observe("values-arith/mmul", () => multiplyMoney(m1, 3n)));
      check("divideMoney", observe("values-arith/mdiv", () => divideMoney(m2, 2n)));
      check("moneyRatio", observe("values-arith/mratio", () => parts(moneyRatio(m2, m1))));
      check("isKnownCurrency USD/XX", observe("values-arith/ccy", () => [isKnownCurrency("USD"), isKnownCurrency("XX")]));
      check("addMoney currency mismatch", observe("values-arith/mmismatch", () => capture(() => addMoney(m1, money(1n, "EUR")))));
      check("money unknown currency", observe("values-arith/munknown", () => capture(() => money(1n, "XX"))));
    },
  },
  {
    id: "values-temporal",
    plan: "exact-values",
    entries: ["temporal.ts"],
    run(check) {
      check("date parse", observe("values-temporal/date", () => date("2026-02-28")));
      check("datetime parse", observe("values-temporal/datetime", () => datetime("2026-02-28T12:34:56.789Z")));
      check("add_days month clamp", observe("values-temporal/add-days", () => add_days(date("2026-01-31"), 1n)));
      check("add_months clamp", observe("values-temporal/add-months", () => add_months(date("2026-01-31"), 1n)));
      check("epoch round trip", observe("values-temporal/epoch", () => epochDaysToDate(dateToEpochDays(date("2026-06-15")))));
      check("datetime range ok", observe("values-temporal/range-ok", () => assertDatetimeInRange(1780272000000n)));
      check("date out of range", observe("values-temporal/range-err", () => capture(() => date("0000-01-01"))));
      check("add_months year edge", observe("values-temporal/year-edge", () => capture(() => add_months(date("9999-12-01"), 1n))));
    },
  },
  {
    id: "values-agg",
    plan: "exact-values",
    entries: ["array.ts"],
    run(check) {
      check("sumInt cancel", observe("values-agg/sumint", () => sumInt([H, 1n, -H])));
      check("sumInt empty", observe("values-agg/sumint-empty", () => sumInt([])));
      check(
        "sumDecimal mixed-scale zero",
        observe("values-agg/sumdec", () => {
          const d = sumDecimal([new Decimal(C38, 0), new Decimal(-C38, 0), new Decimal(0n, 18)]);
          return { coef: d.coef, scale: d.scale };
        })
      );
      check("sumDecimal empty", observe("values-agg/sumdec-empty", () => {
        const d = sumDecimal([]);
        return { coef: d.coef, scale: d.scale };
      }));
    },
  },
  {
    id: "validate-calls",
    plan: "input-validation",
    entries: ["schema.ts", "wire.ts"],
    run(check) {
      const descriptor = {
        contracts: {
          Widget: { fields: { name: { type: "text" }, qty: { type: "int", min: "1", max: "99" } } },
        },
      };
      assertNoAccessors(descriptor);
      const schema = observe("validate-calls/normalize", () => normalizeSchema(descriptor));
      const good = { name: "w", qty: "3" };
      assertNoAccessors(good);
      check("validateValue create ok", observe("validate-calls/create", () => validateValue(schema, "Widget", good, "create")));
      const bad = { name: "w", qty: "0", extra: 1 };
      assertNoAccessors(bad);
      check("validateValue create violations", observe("validate-calls/violations", () => capture(() => validateValue(schema, "Widget", bad, "create"))));
      check("validateValue update omission", observe("validate-calls/update", () => validateValue(schema, "Widget", { name: "w" }, "update")));
      check("decodeValue int", observe("validate-calls/decode", () => decodeValue("int", "9007199254740993")));
      check("encodeValue int", observe("validate-calls/encode", () => encodeValue("int", 9007199254740993n)));
      check("decodeValue bad int", observe("validate-calls/decode-err", () => capture(() => decodeValue("int", "nope"))));
    },
  },
  {
    id: "work-decisions",
    plan: "work-transitions",
    entries: ["receipt/index.ts", "schedule/every.ts"],
    run(check) {
      const r1 = stubRandom([0.5]);
      check(
        "computeBackoff nominal",
        observe("work-decisions/backoff", () => computeBackoff({ attempt: 1, firstAttemptAtMs: 0, nowMs: 1000, random: r1.port }))
      );
      check("backoff samples consumed", observe("work-decisions/backoff-samples", () => r1.consumed()));
      const r2 = stubRandom([0.25]);
      check(
        "computeBackoff exhausted",
        observe("work-decisions/exhausted", () => computeBackoff({
          attempt: DEFAULT_RETRY_POLICY.maxAttempts,
          firstAttemptAtMs: 0,
          nowMs: 1000,
          random: r2.port,
        }))
      );
      check("exhausted samples consumed", observe("work-decisions/exhausted-samples", () => r2.consumed()));
      check(
        "classifyFailure matrix",
        observe("work-decisions/classify", () => [
          classifyFailure({ kind: "handler-require-false", require: "r" }),
          classifyFailure({ kind: "permanent", code: "E", message: "m" }),
          classifyFailure({ kind: "transient", code: "E", message: "m" }),
        ])
      );
      check("everyScopeKey", observe("work-decisions/scope", () => everyScopeKey("team", "team_1")));
      check("computeEverySlot", observe("work-decisions/slot", () => computeEverySlot(3600000, 60000)));
      check(
        "deriveRecurringOccurrenceId",
        observe("work-decisions/occ", () => deriveRecurringOccurrenceId("App", "H.d", "team", "team_1", 42))
      );
      const items = [
        { id: "b", state: "dead" },
        { id: "a", state: "dead" },
        { id: "c", state: "pending" },
      ];
      assertNoAccessors(items);
      check("listDeadLetter order", observe("work-decisions/dead", () => listDeadLetter(items)));
      const uncertain = { id: "u1", state: "uncertain" };
      assertNoAccessors(uncertain);
      check(
        "reconcileUncertain delivered",
        observe("work-decisions/reconcile", () => reconcileUncertain(uncertain, { kind: "delivered", result: 7 }))
      );
      check(
        "reconcileUncertain null-evidence noop",
        observe("work-decisions/reconcile-noop", () => reconcileUncertain(uncertain, null))
      );
    },
  },
  {
    id: "artifact-checks",
    plan: "artifact-preparation",
    entries: ["runtime/artifact.ts", "deploy/compat.ts"],
    run(check) {
      const minimal = {
        artifact_version: 1,
        language_version: "1.0.0",
        tool_version: "0.1.0",
        sources: [{ path: "src/app.can", sha256: "a".repeat(64) }],
        modules: [{ path: "out/app.js", js: "export {};", map: { version: 3, file: "app.js", sources: ["app.can"], sourcesContent: [null], names: [], mappings: "" } }],
        callables: [{ id: "app.Thing.create", kind: "operation", module: "out/app.js", export: "create", member: ["createThing"] }],
        pages: [{ owner: "app", path: "/", module: "out/app.js", export: "IndexPage" }],
        requires: [{ capability: "values.decimal", min_version: 2 }],
        tests: [],
      };
      assertNoAccessors(minimal);
      check(
        "parseArtifactText valid",
        observe("artifact-checks/parse", () => {
          const loaded = parseArtifactText(JSON.stringify(minimal), "fixture.json");
          return { version: loaded.artifact.artifact_version, modules: loaded.artifact.modules.map((m) => m.path), callables: loaded.artifact.callables.length };
        })
      );
      check(
        "parseArtifactText bad version",
        observe("artifact-checks/parse-err", () => capture(() => parseArtifactText(JSON.stringify({ ...minimal, artifact_version: 2 }), "fixture.json")))
      );
      check("parseArtifactText malformed", observe("artifact-checks/parse-malformed", () => capture(() => parseArtifactText("{nope", "fixture.json"))));
      check(
        "checkCompilerVersionMatch match",
        observe("artifact-checks/compat-match", () => checkCompilerVersionMatch(
          { identity: { compilerVersion: "1.0.0" } },
          { contractsVersion: 1, runtimeVersion: "1.0.0", capabilities: [], knownLanguageVersions: ["1.0.0"], supportsSchedules: false },
        ))
      );
      check(
        "checkCompilerVersionMatch mismatch",
        observe("artifact-checks/compat-mismatch", () => checkCompilerVersionMatch(
          { identity: { compilerVersion: "2.0.0" } },
          { contractsVersion: 1, runtimeVersion: "1.0.0", capabilities: [], knownLanguageVersions: ["1.0.0"], supportsSchedules: false },
        ))
      );
    },
  },
];

/* ---------- runner ---------- */

function parseArgs(argv) {
  const out = { workloads: [], seed: 1, check: null, pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workload") out.workloads.push(argv[(i += 1)]);
    else if (argv[i] === "--seed") out.seed = Number(argv[(i += 1)]);
    else if (argv[i] === "--check") out.check = argv[(i += 1)];
    else if (argv[i] === "--pretty") out.pretty = true;
    else throw new Error(`observations: unknown arg ${argv[i]}`);
  }
  if (!Number.isInteger(out.seed)) throw new Error("observations: --seed must be an integer");
  return out;
}

export const WORKLOAD_IDS = WORKLOADS.map((w) => w.id);

export function runWorkloads(ids, { seed = 1 } = {}) {
  const selected = ids.length > 0 ? WORKLOADS.filter((w) => ids.includes(w.id)) : WORKLOADS;
  const unknown = ids.filter((id) => !WORKLOADS.some((w) => w.id === id));
  if (unknown.length > 0) throw new Error(`observations: unknown workload(s): ${unknown.join(",")}`);
  const workloads = [];
  for (const workload of selected) {
    const observations = [];
    const check = (name, value) => {
      observations.push({ name, actual: value });
    };
    const start = process.hrtime.bigint();
    const heapBefore = process.memoryUsage().heapUsed;
    workload.run(check);
    const end = process.hrtime.bigint();
    workloads.push({
      id: workload.id,
      plan: workload.plan,
      entries: workload.entries,
      observations,
      resources: { durationNs: (end - start).toString(), heapUsedAfter: process.memoryUsage().heapUsed, heapUsedBefore: heapBefore },
    });
  }
  const records = workloads.flatMap((w) => w.observations.map((o) => [w.id, o.name, o.actual]));
  return { schema: "observations.mjs/1", env: captureEnv(seed), workloads, digest: digestOf(records) };
}

function compareDigests(actual, expectedPath) {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  const diffs = [];
  if (expected.digest !== actual.digest) diffs.push(`digest mismatch: expected ${expected.digest} actual ${actual.digest}`);
  const expMap = new Map();
  for (const w of expected.workloads ?? []) for (const o of w.observations ?? []) expMap.set(`${w.id} :: ${o.name}`, JSON.stringify(canonical(o.actual)));
  for (const w of actual.workloads) {
    for (const o of w.observations) {
      const key = `${w.id} :: ${o.name}`;
      const exp = expMap.get(key);
      if (exp === undefined) diffs.push(`missing baseline observation: ${key}`);
      else if (exp !== JSON.stringify(canonical(o.actual))) diffs.push(`value drift: ${key}`);
      expMap.delete(key);
    }
  }
  for (const key of expMap.keys()) diffs.push(`baseline observation not reproduced: ${key}`);
  return diffs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = runWorkloads(args.workloads, { seed: args.seed });
  if (args.check !== null) {
    const diffs = compareDigests(report, args.check);
    if (diffs.length > 0) {
      console.log(JSON.stringify({ status: "drift", diffs }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ status: "match", digest: report.digest }));
    return;
  }
  console.log(JSON.stringify(canonical(report), args.pretty ? 2 : 0));
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try {
    main();
  } catch (error) {
    console.log(JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
