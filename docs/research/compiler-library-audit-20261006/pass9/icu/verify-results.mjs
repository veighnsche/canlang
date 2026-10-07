import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const dir=new URL('.',import.meta.url);
const read=(name)=>JSON.parse(readFileSync(new URL(name,dir),'utf8'));
const type=read('type-parity.json'),builtType=read('type-parity-built.json'),syntax=read('structure-parity.json'),builtSyntax=read('structure-parity-built.json'),render=read('render-results.json');
assert.deepEqual(type.cases,builtType.cases);assert.deepEqual(syntax.cases,builtSyntax.cases);
for(const c of type.cases){assert.equal(c.ownerValidation.ok,c.expectedOk);assert.equal(c.ownerDescriptor.ok,c.expectedOk);assert.equal(c.ownerRender.ok,c.expectedOk);}
for(const c of syntax.cases)assert.equal(c.owner.ok,c.expectedOk,c.id);
const typeMismatches=type.cases.filter(c=>(c.compiler.exit===0)!==c.expectedOk).map(c=>c.usage+'-'+c.type);
const syntaxMismatches=syntax.cases.filter(c=>(c.compiler.exit===0)!==c.expectedOk).map(c=>c.id);
assert.deepEqual(typeMismatches,['number-decimal','ordinal-decimal']);
assert.deepEqual(syntaxMismatches,['select-hyphen','duplicate-normalized','unknown-category','rich-tag','self-rich-tag','friendly-apostrophe-undeclared','pound-top','exact-leading-dot','exact-trailing-dot','white-undeclared','depth-arg-32']);
for(const c of render.cases){if(c.expected===null){assert.equal(c.result.ok,false);assert.equal(c.result.code,'out-of-range');}else {assert.equal(c.result.ok,true);assert.equal(c.result.value,c.expected);}}
console.log(JSON.stringify({verification:'pass: expected owner outcomes, source/built parity, rendering outcomes and frozen baseline anomaly set',typeCases:type.cases.length,syntaxCases:syntax.cases.length,renderCases:render.cases.length,typeMismatches,syntaxMismatches},null,2));
