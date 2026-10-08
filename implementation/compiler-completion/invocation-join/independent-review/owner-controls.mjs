import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invocation, makeRecordRef, parseDecimal, isDecimal, equalValue, normalizeSchema, validateValue, encodeValue, decodeValue, parseTypeId, printTypeId } from '@canlang/values';

const artifact = JSON.parse(readFileSync('artifact.json', 'utf8'));
const module = artifact.modules.find(item => item.js.includes('function canApp'));
const entry = await import(pathToFileURL(resolve('generated', module.path)));
const fields = entry.appDefinition.contracts['Invocations.References'].fields;
const schema = normalizeSchema({ contracts: { Proposal: { fields } } });
const call = invocation('Invocations.mutate', { record: makeRecordRef('Invocations.Item', 'r'), amount: parseDecimal('3.75'), note: 'text' });
const local = encodeValue(fields.local.type, call);
const choices = encodeValue(fields.choices.type, invocation('Invocations.empty', {}));

assert.deepEqual(parseTypeId(fields.choices.type).base.targets, ['Invocations.empty', 'Invocations.mutate']);
for (const [name, field] of Object.entries(fields)) {
  assert.deepEqual(Object.keys(field), ['type']);
  assert.equal(printTypeId(parseTypeId(field.type)), field.type, name);
}
const omitted = validateValue(schema, 'Proposal', { local, choices, required: [] }, 'create');
assert.deepEqual(omitted, { local: call, optional: null, choices: invocation('Invocations.empty', {}), many: [], required: [], nullableMany: null });
assert.throws(() => validateValue(schema, 'Proposal', { local, choices }, 'create'));
assert.throws(() => validateValue(schema, 'Proposal', { local: null, choices, required: [] }, 'create'));
assert.throws(() => normalizeSchema({ contracts: { Proposal: { fields: { local: { ...fields.local, nullable: true } } } } }));
assert.throws(() => normalizeSchema({ contracts: { Proposal: { fields: { local: { type: 'invocation', operations: ['Invocations.mutate'] } } } } }));
assert.deepEqual(decodeValue(fields.required.type, encodeValue(fields.required.type, [call])), [call]);
assert.deepEqual(decodeValue(fields.nullableMany.type, encodeValue(fields.nullableMany.type, [call])), [call]);
assert.equal(decodeValue(fields.optional.type, null), null);
assert.throws(() => encodeValue(fields.local.type, invocation('Invocations.empty', {})));

assert.notEqual(call.args.record, makeRecordRef('Invocations.Item', 'r'));
const admittedRecord = makeRecordRef('Invocations.Item', 'r');
const admittedDecimal = parseDecimal('3.75');
const clone = invocation('Invocations.mutate', { record: admittedRecord, amount: admittedDecimal });
assert.notEqual(clone.args.record, admittedRecord);
assert.notEqual(clone.args.amount, admittedDecimal);
assert.deepEqual(clone.args.record, admittedRecord);
assert(isDecimal(clone.args.amount));
assert(equalValue('decimal', clone.args.amount, admittedDecimal));
assert.equal(clone.args.amount.coef, admittedDecimal.coef);
assert.equal(clone.args.amount.scale, admittedDecimal.scale);
assert.notEqual(Object.getPrototypeOf(clone.args.amount), Object.getPrototypeOf(admittedDecimal));
console.log('Independent actual emitted field controls passed: canonical ordered target lists; closed descriptors; omission/null/required array semantics; array/null codecs; wrong-target rejection; native carrier structural cloning without pointer identity.');
