// Descriptor inspection only. No operation, renderer, provider or BDD execution.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../../..'),reports=[];
for(const [app,owner] of [['CanWorkbench','workbench'],['CanEnrich','enrich']]){
 const source=fs.readFileSync(path.join(root,'draft',app+'.can'),'utf8');
 const target=fs.readFileSync(path.join(root,'draft',app+'.mjs'),'utf8');
 const code=target.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'')+'\n({appDefinition,canApp,exampleFixtures,exampleImports});';
 const mod=vm.runInNewContext(code,{message:(source,translations)=>({source,translations}),Customer:'customer.Customer'},{filename:app+'.mjs'});
 const registry=mod.canApp(),self={builtin:'self'},other={builtin:'other'};
 const imported=Object.fromEntries(mod.exampleImports.map(x=>[x.alias,{import:x.provider+'.'+x.member}]));
 const output=mod.exampleFixtures({self,other,imported}),definition=mod.appDefinition;
 const names=a=>Array.from(a).sort().join('\n');
 const sourceModels=[...source.matchAll(/^  (?:export )?([A-Z]\w*) (?:in \w+ )?\{/gm)].map(m=>owner+'.'+m[1]);
 const sourceScenarios=[...source.matchAll(/^  (?:export )?scenario (\w+)(.*)$/gm)];
 const user=sourceScenarios.filter(m=>m[2].includes(' by=')).map(m=>owner+'.'+m[1]);
 const handlers=sourceScenarios.filter(m=>m[2].includes(' on=')).map(m=>owner+'.'+m[1]);
 const fixtures=[...source.matchAll(/^  (?:export )?fixture (\w+)=/gm)].map(m=>m[1]);
 assert.equal(names(sourceModels),names(Object.keys(definition.models)));
 assert.equal(names(user),names(Object.keys(definition.operations).filter(x=>!definition.operations[x].kind)));
 assert.equal(names(handlers),names(Object.keys(definition.handlers)));
 assert.equal(names(fixtures),names(Object.keys(output.fixtures)));
 assert.equal(names(Object.keys(output)),names(['fixtures','examples']));
 let references=0;
 for(const entry of [...Object.values(definition.operations),...Object.values(definition.handlers),...Object.values(definition.pure)]){
  assert.equal(typeof registry[entry.handler],'function');references++;
  if(entry.result){assert.equal(typeof entry.result,'object');assert.equal(typeof entry.result.type,'string');assert.ok(!/[?\[\]]/.test(entry.result.type));}
  if(entry.when)assert.equal(typeof registry.crudWhen[entry.when],'function');
 }
 for(const capability of Object.values(definition.capabilities))for(const operation of Object.values(capability.operations)){assert.equal(typeof operation.result,'object');assert.equal(typeof operation.result.type,'string');}
 for(const model of Object.values(definition.models)){
  for(const grant of model.readGrants||[]){assert.equal(typeof registry.read[grant.rule],'function');references++;}
  for(const key of model.invariants||[]){assert.equal(typeof registry.invariants[key],'function');references++;}
  for(const key of model.locks||[]){assert.ok(registry.locks[key]);references++;}
  for(const value of Object.values(model.derived||{})){assert.equal(typeof registry.derives[value.handler],'function');references++;}
 }
 const visit=o=>{if(o&&typeof o==='object'){assert.ok(!Object.hasOwn(o,'required'));for(const x of Object.values(o))visit(x);}};visit(definition.contracts);
 let rows=0,tables=0,sequences=0;
 for(const example of output.examples){
  assert.ok(definition.operations[example.operation]||definition.handlers[example.operation]);
  assert.ok(Array.isArray(example.dependencies)&&example.dependencies.every(Boolean));assert.ok(!Object.hasOwn(example,'seed'));
  if(example.sequence){sequences++;assert.ok(example.sequence.some(step=>step.operation===example.operation));}
  else {tables++;rows+=example.rows.length;assert.equal(typeof example.inputs,'function');assert.ok(example.observations.every(x=>typeof x==='function'));for(const row of example.rows)assert.ok(row.dependencies.every(Boolean));}
 }
 const sourceExamples=[...source.matchAll(/^   examples[^\n]*\n(    do\n)?/gm)];
 assert.equal(sourceExamples.filter(m=>m[1]).length,sequences);assert.equal(sourceExamples.filter(m=>!m[1]).length,tables);
 reports.push({app,models:sourceModels.length,userOperations:user.length,trustedHandlers:handlers.length,fixtures:fixtures.length,tables,rows,sequences,resolvedReferences:references});
}
console.log(JSON.stringify({scope:'Static metadata inventory and reference resolution only; no runtime or BDD execution.',reports},null,2));
