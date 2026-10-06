// Explicit original-source capture for n01.rust-str-escape.v1.
// Expected string bytes come only from the frozen Node builtin oracle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../../..');
const frozenPath = path.join(root, 'implementation/rust-port-orchestration/contracts-20261007/oracles/frozen-oracle.json.gz');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha256(fs.readFileSync(file));
const units = text => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const validUtf8Hex = text => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = text.charCodeAt(++i); if (!(d >= 0xdc00 && d <= 0xdfff)) return undefined; }
    else if (c >= 0xdc00 && c <= 0xdfff) return undefined;
  }
  return Buffer.from(text, 'utf8').toString('hex');
};
function encode(v) {
  if (typeof v === 'string') return { stringUnits: units(v), ...(validUtf8Hex(v) === undefined ? {} : { utf8Hex: validUtf8Hex(v) }) };
  if (typeof v === 'bigint') return { bigint: v.toString() };
  if (typeof v === 'number') {
    const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, false);
    return { numberBits: b.getBigUint64(0, false).toString(16).padStart(16, '0'), stringText: String(v) };
  }
  if (v === undefined) return { undefined: true };
  if (v === null || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object') {
    const ownKeys = Reflect.ownKeys(v).map(k => typeof k === 'string' ? { stringUnits: units(k) } : { symbol: String(k) });
    return { ownKeys, entries: Object.keys(v).map(k => ({ keyUnits: units(k), value: encode(v[k]) })) };
  }
  return { type: typeof v };
}
function observeError(error) {
  const fields = ['name', 'kind', 'code', 'message', 'violations'];
  return {
    outcome: 'throw', ownKeys: Reflect.ownKeys(error).map(k => typeof k === 'string' ? { stringUnits: units(k) } : { symbol: String(k) }),
    fields: fields.map(key => ({ key, present: key in error, own: Object.hasOwn(error, key), ...(key in error ? { value: encode(error[key]) } : {}) })),
    violations: Array.isArray(error.violations) ? error.violations.map(v => ({
      ownKeys: Reflect.ownKeys(v).map(k => typeof k === 'string' ? { stringUnits: units(k) } : { symbol: String(k) }),
      fields: ['path', 'code', 'message', 'expected', 'actual'].map(key => ({ key, present: Object.hasOwn(v, key), ...(Object.hasOwn(v, key) ? { value: key === 'path' ? v.path.map(x => typeof x === 'string' ? { stringUnits: units(x) } : { number: x }) : encode(v[key]) } : {}) })),
    })) : undefined,
  };
}
function observe(run) { try { return { outcome: 'return', value: encode(run()) }; } catch (e) { return observeError(e); } }
function ownObject(entries) { const o = {}; for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); return o; }
function stageSources(stage) {
  const require = createRequire(import.meta.url);
  const ts = require(path.join(root, 'node_modules/typescript/lib/typescript.js'));
  const pkg = path.join(root, 'packages/values');
  const files = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) files.push(p); } };
  walk(path.join(pkg, 'src'));
  for (const p of ['bindings/backend.ts', 'bindings/carriers.ts']) files.push(path.join(pkg, p));
  for (const file of files) {
    const rel = path.relative(pkg, file).replace(/\.ts$/, '.js');
    const out = path.join(stage, rel); fs.mkdirSync(path.dirname(out), { recursive: true });
    const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } });
    fs.writeFileSync(out, result.outputText);
  }
  fs.writeFileSync(path.join(stage, 'package.json'), '{"type":"module"}\n');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
  return files;
}

const [stageArg, outArg] = process.argv.slice(2);
if (!stageArg || !outArg) throw new Error('usage: node string-escape.oracle.mjs <private staged src dir> <output.json>');
const stage = path.resolve(stageArg); fs.mkdirSync(stage, { recursive: true });
const donorFiles = stageSources(stage);
const [{ decodeValue, encodeValue }] = await Promise.all([
  import(pathToFileURL(path.join(stage, 'src/wire.js'))), import(pathToFileURL(path.join(stage, 'src/kinds.js'))),
]);
const frozenBytes = fs.readFileSync(frozenPath), frozen = JSON.parse(gunzipSync(frozenBytes));
const strings = frozen.strings.map(row => {
  const input = String.fromCharCode(...row.inputUnits);
  const quoted = JSON.stringify(input);
  const actualWire = quoted.length > 64 ? `${quoted.slice(0, 64)}...` : quoted;
  assert.deepEqual(units(quoted), row.quotedUnits, `frozen JSON.stringify mismatch: ${row.id}`);
  assert.deepEqual(units(actualWire), row.actualWireUnits, `frozen actual_wire mismatch: ${row.id}`);
  assert.equal(validUtf8Hex(input), row.inputUtf8Hex ?? undefined, `frozen input UTF-8 mismatch: ${row.id}`);
  assert.equal(validUtf8Hex(quoted), row.quotedUtf8Hex ?? undefined, `frozen quoted UTF-8 mismatch: ${row.id}`);
  assert.equal(validUtf8Hex(actualWire), row.actualWireUtf8Hex ?? undefined, `frozen actual_wire UTF-8 mismatch: ${row.id}`);
  const helperAdmitted = row.rustStrInputAdmitted;
  return { ...row, helperInput: encode(input), quoted: encode(quoted), actualWire: encode(actualWire),
    rustStrAdmitted: helperAdmitted, helperParityAdmitted: row.helperParityAdmitted,
    actualWireParityAdmitted: row.actualWireParityAdmitted,
    residual: row.excludedReason === null ? null : row.excludedReason };
});
const callerRows = [];
const add = (id, type, input, run) => callerRows.push({ id, type, input, observation: observe(run) });
const keys = ['control\u0001', 'quote"key', 'slash/key', 'BMP\u2028key', 'astral😀key', '__proto__'];
for (let i = 0; i < keys.length; i++) {
  const key = keys[i];
  const wire = ownObject([['minor', '1'], [key, `value-${i}`]]);
  add(`decode-extra-${i}`, 'decode', { scalar: 'money', entries: Object.keys(wire).map(k => ({ keyUnits: units(k), value: encode(wire[k]) })) }, () => decodeValue('money', wire));
}
for (const [id, wire] of [
  ['missing-both', ownObject([])], ['missing-currency', ownObject([['minor', '1']])],
  ['missing-minor', ownObject([['currency', 'USD']])], ['extra-and-missing', ownObject([['quote"key', 'x'], ['slash/key', 'y']])],
  ['bad-minor-and-currency', ownObject([['minor', '01'], ['currency', 'US']])],
]) add(`decode-${id}`, 'decode', { scalar: 'money', entries: Object.keys(wire).map(k => ({ keyUnits: units(k), value: encode(wire[k]) })) }, () => decodeValue('money', wire));
for (const [id, value] of [['bad-currency-wire', 'US'], ['quoted-currency-wire', 'USD"\\/😀'], ['long-currency-wire', '😀'.repeat(40)]]) {
  const wire = ownObject([['minor', '1'], ['currency', value]]);
  add(`decode-${id}`, 'decode', { scalar: 'money', entries: Object.keys(wire).map(k => ({ keyUnits: units(k), value: encode(wire[k]) })) }, () => decodeValue('money', wire));
}
for (const [id, value] of [['number', 2], ['null', null], ['object', { currency: 'USD' }]]) add(`decode-currency-${id}`, 'decode', { scalar: 'money', entries: [{ keyUnits: units('minor'), value: encode('1') }, { keyUnits: units('currency'), value: encode(value) }] }, () => decodeValue('money', ownObject([['minor', '1'], ['currency', value]])));
add('decode-scalar-string-wrong-wire', 'decode', { scalar: 'string', wire: { numberBits: '4000000000000000' } }, () => decodeValue('string', 2));
for (const [id, currency] of [['unknown', 'AAA'], ['lowercase', 'usd'], ['wrong-length', 'US']]) {
  const value = { kind: 'money', minor: 1n, currency };
  add(`encode-${id}`, 'encode', { scalar: 'money', value: encode(value), privateOrPublic: id === 'unknown' ? 'public-structurally-guarded-unknown-currency' : 'public-encode-guard-rejection' }, () => encodeValue('money', value));
}
add('encode-invalid-minor-precedence', 'encode', { scalar: 'money', value: encode({ kind: 'money', minor: 'bad', currency: 'AAA' }), privateOrPublic: 'public-structural-shape-precedence' }, () => encodeValue('money', { kind: 'money', minor: 'bad', currency: 'AAA' }));
add('encode-invalid-currency-shape-precedence', 'encode', { scalar: 'money', value: encode({ kind: 'money', minor: 1n, currency: 'US' }), privateOrPublic: 'public-structural-shape-precedence' }, () => encodeValue('money', { kind: 'money', minor: 1n, currency: 'US' }));
callerRows.find(x => x.id === 'decode-long-currency-wire').residual = 'actualWire-64-unit-astral-surrogate-split';
const fixture = {
  schemaVersion: 1, contract: 'n01.rust-str-escape.v1',
  engine: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, execPath: process.execPath },
  source: { frozenPath: path.relative(root, frozenPath), frozenSha256: sha256(frozenBytes), generatorSha256: hashFile(import.meta.filename), donorHashes: Object.fromEntries(donorFiles.map(f => [path.relative(root, f), hashFile(f)])) },
  strings, callers: callerRows,
  controls: [
    { id: 'escaped-slash', rowId: 'slash', expectedQuotedUnits: units(JSON.stringify('/')), mutant: [34, 92, 47, 34] },
    { id: 'uppercase-hex', rowId: 'c0:11', expectedQuotedUnits: units(JSON.stringify('\u000b')), mutant: [34, 92, 117, 48, 48, 48, 66, 34] },
    { id: 'escaped-u2028', rowId: 'separators', expectedQuotedUnits: units(JSON.stringify('\u2028\u2029')), mutant: units('"\\u2028\\u2029"') },
    { id: 'truncate-before-escape', rowId: 'quoted-len:65', expectedActualWireUnits: strings.find(x => x.id === 'quoted-len:65').actualWireUnits, mutant: units(JSON.stringify(String.fromCharCode(...strings.find(x => x.id === 'quoted-len:65').inputUnits).slice(0, 64))) },
  ],
  routeSummary: { strings: strings.length, rustStrAdmitted: strings.filter(x => x.rustStrAdmitted).length, helperParityAdmitted: strings.filter(x => x.helperParityAdmitted).length, actualWireParityAdmitted: strings.filter(x => x.actualWireParityAdmitted).length, astralCutResidual: strings.filter(x => x.id === 'astral-cut:62').map(x => x.id), jsOnlyUnpaired: strings.filter(x => !x.rustStrAdmitted).map(x => x.id), callerActualWireResiduals: callerRows.filter(x => x.residual).map(x => x.id) },
  limits: ['Node builtin string expectations and original TS caller observations only.', 'Rust helper admitted rows are not public backend qualification.', 'Arbitrary escaped MoneyParts are not admitted by public encodeValue; no synthetic internal formatter witness is claimed.', 'Astral split retains JS high-surrogate units separately from Rust truncation residual.', 'Four unpaired UTF-16 inputs retain the JS/TS route.'],
};
fs.writeFileSync(path.resolve(outArg), JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify({ strings: strings.length, callers: callerRows.length, routeSummary: fixture.routeSummary, sha256: hashFile(path.resolve(outArg)) }));
