import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Decimal,parseDecimal,encodeValue,decodeValue,normalizeSchema,validateValue,validateOperationInput,isUpdateOmitted} from '@canlang/values';
import {parseDecimal as stdlibParseDecimal} from '@canlang/stdlib';
import {tag,reconstruct} from '@canlang/values/bindings/carriers';
assert.equal(parseDecimal,stdlibParseDecimal);
const artifact=JSON.parse(readFileSync(process.argv[2] ?? 'artifact.json','utf8'));
const base=resolve(dirname(process.argv[2] ?? 'artifact.json'),'generated');
for(const module of artifact.modules){const file=resolve(base,module.path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)));
const registry=entry.canApp(), context={memberships:['members'],actor:{id:'actor'}};
const call=(name,...args)=>{const item=artifact.callables.find(item=>item.id===`Exact.${name}`);assert(item,name);let fn=registry;for(const key of item.member)fn=fn[key];return fn(context,...args);};
const exact=(value,coef,scale)=>{assert(value instanceof Decimal);assert(Object.isFrozen(value));assert.equal(value.coef,coef);assert.equal(value.scale,scale);};
for(const [name,coef,scale] of [['positive',150n,2],['negative',-150n,2],['zero',0n,2],['integer',99999999999999999999999999999999999999n,0],['fraction',99999999999999999999123456789012345678n,18],['tiny',1n,18],['optional',7n,0],['defaults',150n,2]])exact(await call(name),coef,scale);
// Authored literals reach the real arithmetic owner with no binary-float step.
for(const [name,coef,scale] of [
 ['exactSum',30n,2],['difference',125n,2],['product',-30000n,4],
 ['quotient',125n,3],['bigSum',123456789012345678901201n,4],
 ['repeating',333333333333333333n,18],
])exact(await call(name),coef,scale);
assert.equal(await call('whole'),42n);
const nested=await call('nested');exact(nested.amount,3n,0);nested.values.forEach((v,i)=>exact(v,[150n,-200n,4n][i],[2,2,0][i]));
exact(await call('literal',{}),-150n,2);
exact(await call('identity'),150n,2);
const explicit=parseDecimal('9.00');assert.equal(await call('identity',explicit),explicit);
assert.equal(await call('identity',null),null); // undefined-only default; no null substitution
assert.equal(await call('mutate',{value:explicit}),explicit);
const fields=entry.appDefinition.models['Exact.Amount'].fields;
exact(fields.value.default,150n,2);exact(fields.integral.default,42n,0);exact(fields.nullableDefault.default,200n,2);
exact(entry.appDefinition.operations['Exact.mutate'].inputs.value.default,250n,2);
const nativeDefaultGap=(()=>{try{normalizeSchema({contracts:{Native:{fields:{amount:{type:'decimal',default:fields.value.default}}}}});return null;}catch(error){return {name:error.name,violations:error.violations};}})();
assert.equal(nativeDefaultGap.name,'SchemaError');
assert.equal(nativeDefaultGap.violations[0].code,'type');
// This explicit descriptor adapter qualifies artifact wire defaults through the owner.
// It does not assert appDefinition native metadata is a schema's wire input.
const wireFields=Object.fromEntries(artifact.models[0].fields.map(field=>[field.name,{type:field.field.kind+(field.nullable?'?':''),...(field.default?{default:field.default.value}:{})}]));
assert.equal(wireFields.value.default,'1.50');assert.equal(wireFields.integral.default,'42');
const operation=artifact.operations.find(op=>op.name==='Exact.mutate');
assert(operation);
const inputFields=Object.fromEntries(operation.inputs.fields.map(field=>[field.name,{type:field.field.kind,...(field.default?{default:field.default.value}:{})}]));
const operationSchema=normalizeSchema({operations:{mutate:{inputs:inputFields}}});
exact(await call('mutate',validateOperationInput(operationSchema,'mutate',{})),250n,2);
exact(await call('mutate',validateOperationInput(operationSchema,'mutate',{value:'9.00'})),900n,2);
assert.throws(()=>validateOperationInput(operationSchema,'mutate',{value:null}));
const schema=normalizeSchema({contracts:{Amount:{fields:wireFields}}});
const omitted=validateValue(schema,'Amount',{},'create');exact(omitted.value,150n,2);exact(omitted.integral,42n,0);assert.equal(omitted.optional,null);exact(omitted.nullableDefault,200n,2);
const nullable=validateValue(schema,'Amount',{nullableDefault:null},'create');assert.equal(nullable.nullableDefault,null);
const replaced=validateValue(schema,'Amount',{value:'9.00'},'create');exact(replaced.value,900n,2);
assert.throws(()=>validateValue(schema,'Amount',{value:null},'create'));
const update=validateValue(schema,'Amount',{},'update');for(const value of Object.values(update))assert(isUpdateOmitted(value));
const updated=validateValue(schema,'Amount',{nullableDefault:null},'update');assert.equal(updated.nullableDefault,null);assert(isUpdateOmitted(updated.value));
assert.equal(encodeValue('decimal',fields.value.default),'1.5');exact(decodeValue('decimal','1.5'),15n,1);
assert.deepEqual(tag(fields.value.default),{t:'decimal',coef:'150',scale:2});exact(reconstruct(tag(fields.value.default)),150n,2);
console.log('Decimal: source derives/scenario, nested/contextual integers, native metadata and executable defaults, artifact-wire create/null/update, scale normalization and carrier controls passed; native metadata schema input gap: '+JSON.stringify(nativeDefaultGap));
