// ECMAScript/platform reference facts only. No Can package imports or execution.
// These demonstrate primitive behavior used in source-derived witnesses; they
// are not end-to-end consumers, package tests or protocol acceptance.
import assert from 'node:assert/strict';

const entries = [];
function fact(id, observed, expected) {
  assert.deepEqual(observed, expected);
  entries.push({ id, observed });
}

const form = {};
new URLSearchParams('__proto__=x&ok=y').forEach((value, key) => { form[key] = value; });
const json = JSON.parse('{"__proto__":"x","ok":"y"}');
fact('own-key-transport', {
  formOwnProto: Object.hasOwn(form, '__proto__'),
  jsonOwnProto: Object.hasOwn(json, '__proto__'),
  safeFromEntriesOwnProto: Object.hasOwn(Object.fromEntries(new URLSearchParams('__proto__=x')), '__proto__'),
}, { formOwnProto: false, jsonOwnProto: true, safeFromEntriesOwnProto: true });

const filters = {};
filters['__proto__'] = 'x';
fact('filter-key-drop', Object.keys(filters), []);

const a = JSON.parse('{"n":9007199254740993}');
const b = JSON.parse('{"n":9007199254740992}');
fact('json-integer-rounding', {
  reserialized: JSON.stringify(a), equalParsed: a.n === b.n,
  safeInteger: Number.isSafeInteger(a.n),
}, { reserialized: '{"n":9007199254740992}', equalParsed: true, safeInteger: false });

const zero = JSON.parse('{"n":-0}');
fact('json-negative-zero', {
  initialNegative: Object.is(zero.n, -0),
  reserialized: JSON.stringify(zero),
  afterRoundtripNegative: Object.is(JSON.parse(JSON.stringify(zero)).n, -0),
}, { initialNegative: true, reserialized: '{"n":0}', afterRoundtripNegative: false });

const badUtf8 = new Uint8Array([0x22, 0x80, 0x22]);
const goodReplacement = new TextEncoder().encode('"\ufffd"');
fact('replacement-utf8', {
  badText: new TextDecoder().decode(badUtf8),
  goodText: new TextDecoder().decode(goodReplacement),
  parsed: JSON.parse(new TextDecoder().decode(badUtf8)),
}, { badText: '"\ufffd"', goodText: '"\ufffd"', parsed: '\ufffd' });

fact('utf16-json-versus-raw-utf8', {
  loneJson: JSON.stringify('\ud800'), replacementJson: JSON.stringify('\ufffd'),
  rawBytesEqual: Buffer.from(new TextEncoder().encode('\ud800')).equals(Buffer.from(new TextEncoder().encode('\ufffd'))),
}, { loneJson: '"\\ud800"', replacementJson: '"\ufffd"', rawBytesEqual: true });

const keys = { '2': 'two', '10': 'ten', a: 'a' };
const sortedEntries = Object.keys(keys).sort().map(key => [key, keys[key]]);
fact('canonical-order-owner', {
  lexicalKeys: sortedEntries.map(([key]) => key),
  reassembledJson: JSON.stringify(Object.fromEntries(sortedEntries)),
  manualLexicalJson: '{' + sortedEntries.map(([key, value]) => JSON.stringify(key) + ':' + JSON.stringify(value)).join(',') + '}',
}, {
  lexicalKeys: ['10', '2', 'a'],
  reassembledJson: '{"2":"two","10":"ten","a":"a"}',
  manualLexicalJson: '{"10":"ten","2":"two","a":"a"}',
});

fact('missing-null-and-undefined', {
  omitted: JSON.stringify({}), explicitNull: JSON.stringify({ x: null }),
  explicitUndefined: JSON.stringify({ x: undefined }),
  arrayUndefined: JSON.stringify([undefined]),
}, { omitted: '{}', explicitNull: '{"x":null}', explicitUndefined: '{}', arrayUndefined: '[null]' });

console.log(JSON.stringify({
  kind: 'platform-reference-only', node: process.version,
  packageCodeExecuted: false, endToEndAcceptance: false, entries,
}, null, 2));
