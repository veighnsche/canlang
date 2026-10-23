// Finite A07 foundation proof over actual emitted values hosts and the
// native raw Worker policy and Miniflare SDK. Supply private staged emit paths;
// this never writes shared dist/target or changes backend defaults.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = resolve(process.env.CAN_VALUES_DIST ?? "packages/values/dist");
const self = fileURLToPath(import.meta.url);
const wasmPath = join(dist, "bindings/generated/values_semantics_bg.wasm");
const bytes = () => new Uint8Array(readFileSync(wasmPath));
const bootstrapURL = pathToFileURL(join(dist, "bindings/bootstrap.js")).href;
const hostCase = process.argv.find((arg) => arg.startsWith("--host-case="))?.split("=")[1];

// Deliberate independent startup-control module, not generated production
// glue: exports abi_version=999 and the no-op wasm-bindgen start hook.
const utf8 = (value) => [...new TextEncoder().encode(value)];
const section = (id, payload) => [id, payload.length, ...payload];
const wrongABI = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [2, 96, 0, 1, 127, 96, 0, 0]),
  ...section(3, [2, 0, 1]),
  ...section(7, [2, 11, ...utf8("abi_version"), 0, 0, 16, ...utf8("__wbindgen_start"), 0, 1]),
  ...section(10, [2, 5, 0, 65, 231, 7, 11, 2, 0, 11]),
]);
const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const missingTransport = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [2, 96, 0, 1, 127, 96, 0, 0]),
  ...section(3, [2, 0, 1]),
  ...section(7, [2, 11, ...utf8("abi_version"), 0, 0, 16, ...utf8("__wbindgen_start"), 0, 1]),
  ...section(10, [2, 4, 0, 65, 1, 11, 2, 0, 11]),
]);

// Compare original public host observations with an actually bootstrapped
// selected Wasm producer. Fresh subjects prevent the first run consuming the
// second run's getters/iterators; raw thrown sentinel identity is checked too.
async function verifyAccessOrder(bootstrapWasm) {
  bootstrapWasm(bytes());
  const values = await import(pathToFileURL(join(dist, "src/index.js")).href);
  const { wasmBackend, tsBackend, selectExactBackend } = await import(pathToFileURL(join(dist, "bindings/backend.js")).href);
  const glue = await import(pathToFileURL(join(dist, "bindings/generated/values_semantics.js")).href);
  let nativeCalls = 0, injected;
  const selected = wasmBackend({ abi_version: () => glue.abi_version(), exact_call: request => {
    nativeCalls++;
    if (injected !== undefined) throw injected;
    return glue.exact_call(request);
  } });
  const canonical = tsBackend();
  const decimalShell = (trace, side, poison) => ({
    get kind() { trace.push(`${side}.kind`); return 'decimal'; },
    get coef() { trace.push(`${side}.coef`); if (poison !== undefined) throw poison; return 2n; },
    get scale() { trace.push(`${side}.scale`); return 0; },
  });
  const cases = [
    { name: 'reported decimal poison currency', api: 'addDecimal', make: (trace, sentinel) => [{ kind: 'money', minor: 1n,
      get currency() { trace.push('currency'); throw sentinel; } }, 1n] },
    { name: 'left decimal accessor shell', api: 'addDecimal', make: trace => [decimalShell(trace, 'left'), new values.Decimal(1n, 0)] },
    { name: 'right decimal accessor shell', api: 'addDecimal', make: trace => [new values.Decimal(1n, 0), decimalShell(trace, 'right')] },
    { name: 'left decimal getter sentinel', api: 'multiplyDecimal', sentinel: true,
      make: (trace, sentinel) => [decimalShell(trace, 'left', sentinel), new values.Decimal(1n, 0)] },
    { name: 'right decimal getter sentinel', api: 'divideDecimal', sentinel: true,
      make: (trace, sentinel) => [new values.Decimal(1n, 0), decimalShell(trace, 'right', sentinel)] },
    { name: 'wrong first primitive before right poison', api: 'addDecimal', make: (trace, sentinel) => [true,
      { get kind() { trace.push('right.kind'); throw sentinel; } }] },
    { name: 'symbol stays owning decimal error', api: 'addDecimal', make: () => [Symbol('invalid'), 1n] },
    { name: 'integer range precedes invalid right', api: 'addInt', make: () => [9223372036854775808n, 'invalid'] },
    { name: 'money unknown currency before poison value', api: 'money', make: (trace, sentinel) => [
      { get kind() { trace.push('value.kind'); throw sentinel; } }, 'ZZZ'] },
    { name: 'money unknown currency before invalid primitive', api: 'money', make: () => [false, 'ZZZ'] },
    { name: 'proxy around genuine Decimal', api: 'addDecimal', make: trace => [new Proxy(new values.Decimal(2n, 0), {
      get(target, key, receiver) { trace.push(`decimal:${String(key)}`); return Reflect.get(target, key, receiver); },
    }), new values.Decimal(1n, 0)] },
    { name: 'frozen structural Decimal clone', api: 'addDecimal', make: () => [Object.freeze({ kind: 'decimal', coef: 2n, scale: 0 }), new values.Decimal(1n, 0)] },
    { name: 'aggregate custom iterator and ignored properties', api: 'sumDecimal', make: (trace, sentinel) => {
      const items = [new values.Decimal(1n, 0), new values.Decimal(2n, 0)];
      const array = [...items];
      Object.defineProperty(array, Symbol.iterator, { get() {
        trace.push('iterator'); return function* () { trace.push('iterate'); yield* items; };
      } });
      Object.defineProperty(array, 'map', { get() { trace.push('map'); throw sentinel; } });
      Object.defineProperty(array, 'extra', { enumerable: true, get() { trace.push('extra'); throw sentinel; } });
      return [array];
    } },
    { name: 'direct backend argument Proxy', op: 'add-decimal', make: trace => new Proxy([new values.Decimal(1n, 0), new values.Decimal(2n, 0)], {
      get(target, key, receiver) { trace.push(`args:${String(key)}`); return Reflect.get(target, key, receiver); },
    }), native: true },
    { name: 'direct backend argument custom iterator', op: 'add-int', native: true, make: (trace, sentinel) => {
      const args = [];
      Object.defineProperty(args, Symbol.iterator, { get() { trace.push('args.iterator'); return function* () {
        trace.push('args.iterate'); yield 1n; yield 2n;
      }; } });
      Object.defineProperty(args, 'map', { get() { trace.push('args.map'); throw sentinel; } });
      return args;
    } },
    { name: 'direct backend iterator reentrant public call', op: 'add-int', native: true, nativeCount: 1, make: trace => {
      const args = [];
      args[Symbol.iterator] = function* () {
        trace.push(`inner:${values.addInt(10n, 20n)}`);
        yield 1n; yield 2n;
      };
      return args;
    } },
    { name: 'direct backend ignores extra unused object', op: 'add-int', make: (trace, sentinel) => [1n, 2n,
      { get kind() { trace.push('extra.kind'); throw sentinel; } }] },
    { name: 'direct backend missing argument', op: 'add-int', make: () => [1n] },
    { name: 'genuine primitive native addition', api: 'addInt', native: true, make: () => [1n, 2n] },
    { name: 'genuine factory native Decimal', api: 'addDecimal', native: true, make: () => [new values.Decimal(1n, 0), new values.Decimal(2n, 0)] },
    { name: 'genuine factory native Money', api: 'addMoney', native: true, make: () => [values.makeMoney(1n, 'USD'), values.makeMoney(2n, 'USD')] },
    { name: 'genuine factory native Date', api: 'compareDate', native: true, make: () => [values.makeDate(2026, 1, 1), values.makeDate(2026, 1, 2)] },
    { name: 'genuine factory native Datetime', api: 'compareInstant', native: true, make: () => [values.makeDatetime(0n), values.makeDatetime(1n)] },
  ];
  const observe = (test, backend, sentinel) => {
    selectExactBackend(backend);
    const trace = [];
    const args = test.make(trace, sentinel);
    nativeCalls = 0;
    let outcome;
    try {
      const result = test.op === undefined ? Reflect.apply(values[test.api], undefined, args)
        : (backend ?? canonical).call(test.op, args);
      outcome = { value: JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? { bigint: String(value) } : value)) };
    } catch (error) {
      if (error === sentinel) outcome = { sentinel: true };
      else outcome = { error: { name: error?.name, code: error?.code, message: error?.message } };
    }
    return { trace, outcome, nativeCalls };
  };
  try {
    for (const test of cases) {
      const sentinel = new Error(`raw sentinel: ${test.name}`);
      const expected = observe(test, null, sentinel);
      const actual = observe(test, selected, sentinel);
      assert.deepEqual({ trace: actual.trace, outcome: actual.outcome },
        { trace: expected.trace, outcome: expected.outcome }, test.name);
      if (test.sentinel) assert.deepEqual(actual.outcome, { sentinel: true }, test.name);
      if (test.native) assert.ok(actual.nativeCalls > 0, `${test.name}: a genuine native call is required`);
      if (test.nativeCount !== undefined) assert.equal(actual.nativeCalls, test.nativeCount, `${test.name}: only the outer call is native`);
      if (!test.native && test.name !== 'integer range precedes invalid right' && test.name !== 'money unknown currency before invalid primitive') {
        assert.equal(actual.nativeCalls, 0, `${test.name}: unissued host graphs must stay canonical`);
      }
    }
    selectExactBackend(selected);
    nativeCalls = 0;
    const first = values.addDecimal(new values.Decimal(1n, 0), new values.Decimal(2n, 0));
    assert.equal(values.addDecimal(first, new values.Decimal(3n, 0)).coef, 6n);
    assert.equal(nativeCalls, 2, 'reconstructed factory values retain genuine native admission');
    const sentinel = new Error('injected actual native boundary failure');
    injected = sentinel; nativeCalls = 0;
    assert.throws(() => values.addDecimal(new values.Decimal(1n, 0), new values.Decimal(2n, 0)), error => error === sentinel);
    assert.equal(nativeCalls, 1, 'an admitted native failure propagates without canonical retry');
  } finally { injected = undefined; selectExactBackend(null); }
}

// A real JS codec -> Wasm structural-profile round trip. Canonical public
// validation supplies the independent expected values and exact diagnostics.
async function verifyNativeBounds(bootstrapWasm) {
  const exact = bootstrapWasm(bytes());
  const values = await import(pathToFileURL(join(dist, 'src/index.js')).href);
  const api = await import(pathToFileURL(join(dist, 'bindings/validation.js')).href);
  const { frameForWireValue } = await import(pathToFileURL(join(dist, 'bindings/owned-input.js')).href);
  const glue = await import(pathToFileURL(join(dist, 'bindings/generated/values_semantics.js')).href);
  let failure, failedCalls = 0, disposed = 0, structuralCalls = 0;
  const backend = api.validationBackend({ structural_abi_version: () => glue.structural_abi_version(), validation_call: request => {
    const { op } = JSON.parse(request); structuralCalls++;
    if (op === 'values.execute' && failure !== undefined) { failedCalls++; throw failure; }
    if (op === 'request.dispose') disposed++;
    return glue.validation_call(request);
  } });
  const codec = api.exactCodecFromBackend(exact);
  const metadata = value => {
    if (typeof value === 'bigint') return { t: 'bigint', digits: String(value) };
    if (typeof value === 'string') return { t: 'text', units: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) };
    if (typeof value === 'number') { const bits = Buffer.alloc(8); bits.writeDoubleBE(value); return { t: 'bits', bits: bits.toString('hex') }; }
    return { t: 'object', entries: Object.entries(value).map(([key, part]) => [key, metadata(part)]) };
  };
  const load = fields => {
    const nativeFields = Object.entries(fields).map(([name, field]) => ({ name, type_id: field.type,
      base: { t: 'scalar', name: field.type }, required: true,
      ...Object.fromEntries(['min', 'max'].filter(side => Object.hasOwn(field, side))
        .map(side => [`value_${side}`, metadata(values.decodeValue(field.type, field[side]))])) }));
    return api.loadOwnerPlan(backend, { abi: 'v1', profile: 'values', planProfile: 'values/v1', backend: 'native',
      owner_rev: 'real-wasm-bounds', bound: 8, provenance: { factory: 'normalizeSchema', owner_rev: 'real-wasm-bounds' },
      schema: { t: 'normalized', contracts: [{ name: 'Bounded', fields: nativeFields }], enums: [], operations: [] } });
  };
  const release = plan => { backend.call('plan.release', { owner: plan.owner, id: plan.id }); backend.call('owner.retire', { owner: plan.owner }); };
  const execute = (plan, input) => api.resolveDeferredValidation(backend, {
    owner: plan.owner, plan: plan.id, frame: frameForWireValue(input), profile: 'values/v1',
    target: { kind: 'contract', name: 'Bounded', mode: 'create' }, budgets: { nodes: 1000, depth: 50, text: 2000, entries: 100 },
  }, input, { exact: codec });
  const compare = (fields, plan, input) => {
    const schema = values.normalizeSchema({ contracts: { Bounded: { fields } } });
    let expected;
    try { expected = { value: values.validateValue(schema, 'Bounded', input, 'create') }; }
    catch (error) { assert.equal(error.name, 'SchemaError'); expected = { violations: error.violations }; }
    const result = execute(plan, input);
    if (expected.violations !== undefined) {
      assert.equal(result.outcome, 'invalid', JSON.stringify(result));
      const violations = result.violations.map(violation => ({ ...violation,
        path: violation.path.map(step => step.i ?? String.fromCharCode(...step.k)) }));
      assert.deepEqual(violations, expected.violations);
    } else {
      assert.equal(result.outcome, 'valid', JSON.stringify(result));
      for (const [name, field] of Object.entries(fields)) {
        const entry = result.value.entries.find(([key]) => String.fromCharCode(...key) === name);
        assert.deepEqual(entry[1], { t: 'exact', kind: field.type,
          value: frameForWireValue(values.encodeValue(field.type, expected.value[name])) });
      }
    }
  };
  const money = (minor, currency = 'USD') => ({ minor, currency });
  const cases = [
    ['int', '-10', '10', '-11', '11'],
    ['duration', '-10', '10', '-11', '11'],
    ['decimal', '1.50', '2.50', '1.49', '2.51'],
    ['decimal', '1234567890123456789012345678901234567.8', '1234567890123456789012345678901234567.8',
      '1234567890123456789012345678901234567.7', '1234567890123456789012345678901234567.9'],
    ['money', money('10'), money('20'), money('9'), money('21')],
    ['date', '2024-02-29', '2024-03-01', '2024-02-28', '2024-03-02'],
    ['datetime', '2024-02-29T00:00:00.000Z', '2024-02-29T00:00:01.000Z',
      '2024-02-28T23:59:59.999Z', '2024-02-29T00:00:01.001Z'],
  ];
  for (const [type, min, max, below, above] of cases) {
    const fields = { x: { type, min, max } }, plan = load(fields);
    try { for (const x of [min, max, below, above]) compare(fields, plan, { x }); }
    finally { release(plan); }
  }
  const fields = { amount: { type: 'money', min: money('10'), max: money('20') }, rate: { type: 'decimal', min: '1.5', max: '2.5' } };
  const ordered = load(fields);
  try {
    compare(fields, ordered, { amount: money('15', 'EUR'), rate: '3' });
    compare(fields, ordered, { amount: money('xx'), rate: '3' });
    const sentinel = new Error('native structural failure must propagate');
    failure = sentinel; failedCalls = 0; const beforeDispose = disposed;
    assert.throws(() => execute(ordered, { amount: money('15'), rate: '2' }), error => error === sentinel);
    failure = undefined;
    assert.equal(failedCalls, 1, 'native structural failure is never retried');
    assert.equal(disposed, beforeDispose + 1, 'failed native requests are disposed');
  } finally { failure = undefined; release(ordered); }
  const malformed = api.loadOwnerPlan(backend, { abi: 'v1', profile: 'values', planProfile: 'values/v1', backend: 'native',
    owner_rev: 'malformed-bounds', bound: 8, provenance: { factory: 'normalizeSchema', owner_rev: 'malformed-bounds' },
    schema: { t: 'normalized', contracts: [{ name: 'Bounded', fields: [{ name: 'x', type_id: 'decimal',
      base: { t: 'scalar', name: 'decimal' }, required: true, value_min: metadata('not a Decimal') }] }], enums: [], operations: [] } });
  try {
    const result = execute(malformed, { x: '2' });
    assert.equal(result.outcome, 'deferred'); assert.equal(result.reason, 'exact-codec');
    assert.equal(result.leaf, undefined); assert.equal(result.path, undefined);
    assert.ok(result.detail.length > 0, 'unsupported metadata must explicitly refuse without another codec loop');
  } finally { release(malformed); }
  assert.ok(structuralCalls > 0);
}

if (hostCase !== undefined) {
  const { bootstrapWasm, BootstrapError } = await import(bootstrapURL);
  const expectCode = (action, code) => assert.throws(action, (error) => {
    assert.ok(error instanceof BootstrapError);
    assert.equal(error.code, code);
    return true;
  });
  if (hostCase === "bounds") {
    await verifyNativeBounds(bootstrapWasm);
  } else if (hostCase === "access-order") {
    await verifyAccessOrder(bootstrapWasm);
  } else if (hostCase === "compiled") {
    const module = new WebAssembly.Module(bytes());
    const first = bootstrapWasm(module);
    assert.equal(first.call("add-int", [1n, 2n]), 3n);
    assert.equal(bootstrapWasm(module).call("add-int", [2n, 3n]), 5n);
    expectCode(() => bootstrapWasm(new WebAssembly.Module(bytes())), "init-failed");
    expectCode(() => bootstrapWasm(bytes()), "init-failed");
    assert.equal(first.call("add-int", [3n, 4n]), 7n);
  } else if (hostCase === "abi") {
    expectCode(() => bootstrapWasm(new WebAssembly.Module(wrongABI)), "abi-mismatch");
  } else if (hostCase === "missing-exports") {
    expectCode(() => bootstrapWasm(new WebAssembly.Module(emptyModule)), "init-failed");
  } else if (hostCase === "missing-transport-exports") {
    expectCode(() => bootstrapWasm(new WebAssembly.Module(missingTransport)), "init-failed");
  } else if (hostCase === "caller-methods") {
    bootstrapWasm(bytes());
    const corrupt = bytes();
    corrupt[0] = 255;
    corrupt.every = () => true;
    corrupt[Symbol.iterator] = () => { throw new Error("caller iterator must not execute"); };
    expectCode(() => bootstrapWasm(corrupt), "init-failed");
    assert.equal(bootstrapWasm(bytes()).call("add-int", [2n, 3n]), 5n);
  } else if (hostCase === "first-asset-mutation") {
    const first = bytes();
    const backend = bootstrapWasm(first);
    first[0] = 255;
    expectCode(() => bootstrapWasm(first), "init-failed");
    assert.equal(bootstrapWasm(bytes()).call("add-int", [2n, 3n]), 5n);
    assert.equal(backend.call("add-int", [3n, 4n]), 7n);
  } else if (hostCase === "caller-methods-first") {
    const first = bytes();
    first[Symbol.iterator] = () => { throw new Error("caller iterator must not execute"); };
    Object.defineProperty(first, "length", { value: 0 });
    assert.equal(bootstrapWasm(first).call("add-int", [2n, 3n]), 5n);
  } else if (hostCase === "externally-initialized") {
    const { initSync } = await import(pathToFileURL(join(dist, "bindings/generated/values_semantics.js")).href);
    initSync({ module: bytes() });
    expectCode(() => bootstrapWasm(new WebAssembly.Module(wrongABI)), "init-failed");
  } else {
    throw new Error(`unknown host case: ${hostCase}`);
  }
  console.log(JSON.stringify({ hostCase, status: "passed", executable: process.execPath }));
} else {
  for (const test of ["compiled", "abi", "missing-exports", "missing-transport-exports", "caller-methods", "first-asset-mutation", "caller-methods-first", "externally-initialized", "access-order", "bounds"]) {
    process.stdout.write(execFileSync(process.execPath, [self, `--host-case=${test}`], {
      encoding: "utf8", env: process.env,
    }));
  }
  if (!process.argv.includes("--host-only")) {
    const localRun = resolve(process.env.CAN_LOCAL_RUN ?? "packages/cloudflare/dist/runtime/native-preview.test-support.js");
    const { startLocalDev } = await import(pathToFileURL(localRun).href);
    const modules = {};
    const collect = (relative) => {
      const key = `values/${relative}`;
      if (modules[key] !== undefined) return;
      const source = readFileSync(join(dist, relative), "utf8");
      modules[key] = source;
      for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+\.js)["']/g)) {
        collect(join(dirname(relative), match[1]));
      }
    };
    collect("bindings/bootstrap.js");
    const positive = `
      import module from './values/bindings/generated/values_semantics_bg.wasm';
      import { bootstrapWasm } from './values/bindings/bootstrap.js';
      import { Decimal } from './values/src/decimal.js';
      import { makeDate, makeMoney } from './values/src/kinds.js';
      const backend = bootstrapWasm(module);
      const again = bootstrapWasm(module);
      export default { fetch() {
        const decimal = backend.call('add-decimal', [new Decimal(15n, 1), 2n]);
        const money = backend.call('add-money', [makeMoney(100n, 'USD'), makeMoney(25n, 'USD')]);
        let rejected;
        try { bootstrapWasm(new Uint8Array([0,1,2,3])); } catch (error) { rejected = error.code; }
        return Response.json({ int: String(again.call('add-int', [2n, 3n])),
          date: backend.call('date-to-epoch-days', [makeDate(2024, 2, 29)]),
          decimal: { instance: decimal instanceof Decimal, frozen: Object.isFrozen(decimal),
            coef: String(decimal.coef), bigint: typeof decimal.coef, scale: decimal.scale },
          money: { frozen: Object.isFrozen(money), minor: String(money.minor), bigint: typeof money.minor },
          changedAsset: rejected });
      } };`;
    const binaryKey = "values/bindings/generated/values_semantics_bg.wasm";
    const run = async (entry, binaryModules, check) => {
      let local;
      try {
        local = await startLocalDev({ workerName: "values-bootstrap-foundation", compatibilityDate: "2026-07-30",
          mainModule: "worker.mjs", modules: { ...modules, "worker.mjs": entry }, binaryModules });
        await check(await local.dispatch("/"));
      } finally {
        await local?.dispose();
      }
    };
    const expected = { int: "5", date: 19782,
      decimal: { instance: true, frozen: true, coef: "35", bigint: "bigint", scale: 1 },
      money: { frozen: true, minor: "125", bigint: "bigint" }, changedAsset: "init-failed" };
    for (let isolate = 0; isolate < 2; isolate += 1) {
      await run(positive, { [binaryKey]: bytes() }, async (response) => {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), expected);
      });
    }
    const negative = `import module from './${binaryKey}';
      import { bootstrapWasm } from './values/bindings/bootstrap.js';
      let code; try { bootstrapWasm(module); } catch (error) { code = error.code; }
      export default { fetch() { return Response.json({ code }); } };`;
    for (const [asset, code] of [[wrongABI, "abi-mismatch"], [emptyModule, "init-failed"], [missingTransport, "init-failed"]]) {
      await run(negative, { [binaryKey]: asset }, async (response) => {
        assert.deepEqual(await response.json(), { code });
      });
    }
    for (const [assets, name] of [[{}, "missing"], [{ [binaryKey]: new Uint8Array([0, 1, 2, 3]) }, "corrupt"]]) {
      await assert.rejects(run(positive, assets, async () => {}));
      console.log(JSON.stringify({ workerdStartup: name, status: "rejected" }));
    }
    console.log(JSON.stringify({ workerd: "passed", freshIsolates: 2, localRun, moduleCount: Object.keys(modules).length + 2 }));
  }
}
