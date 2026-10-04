// Read-only desired-target descriptor inspection. This does not run operations,
// emulate stdlib, execute BDD, or validate a provider/runtime implementation.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const helpers='check hasRole active_member same records first count any int64 create set send call delivery renderPage list gallery table form actions card details content text title edit'.split(' ');
const context=Object.fromEntries(helpers.map(name=>[name,()=>{throw Error('Operation helper executed during metadata inspection: '+name);} ]));
context.message=(source,translations)=>({source,translations});
const imported={};
const report=[];
for(const [app,owner] of [['CanChat','chat'],['CanCreative','creative'],['CanGallery','gallery']]){
 const source=fs.readFileSync(path.join(root,'draft',app+'.can'),'utf8');
 const target=fs.readFileSync(path.join(root,'draft',app+'.mjs'),'utf8');
 const code=target.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'')+'\n({appDefinition,canApp,exampleFixtures,exampleImports:typeof exampleImports==="undefined"?[]:exampleImports,exported:{'+(owner==='chat'?'Conversation,Branch,Turn,can_use':owner==='creative'?'Output,can_view':'')+'}});';
 const module=vm.runInNewContext(code,{...context,...imported},{filename:app+'.mjs'});
 const registry=module.canApp();
 const fixtures=module.exampleFixtures({self:{builtin:'self'},other:{builtin:'other'},imported});
 const sourceModels=[...source.matchAll(/^  (?:export )?([A-Z]\w*) (?:in \w+ )?\{/gm)].map(m=>owner+'.'+m[1]);
 const sourceScenarios=[...source.matchAll(/^  (?:export )?scenario (\w+)(.*)$/gm)];
 const sourceUser=sourceScenarios.filter(m=>m[2].includes(' by=')).map(m=>owner+'.'+m[1]);
 const sourceTrusted=sourceScenarios.filter(m=>m[2].includes(' on=')).map(m=>owner+'.'+m[1]);
 const sourcePages=[...source.matchAll(/^  page (\S+)/gm)].map(m=>m[1]);
 const sourceFixtures=[...source.matchAll(/^  (?:export )?fixture (\w+)=/gm)].map(m=>m[1]);
 const strings=a=>Array.from(a).sort().join('\n');
 assert.equal(strings(sourceModels),strings(Object.keys(module.appDefinition.models)));
 assert.equal(strings(sourceUser),strings(Object.keys(module.appDefinition.operations).filter(x=>!module.appDefinition.operations[x].kind)));
 assert.equal(strings(sourceTrusted),strings(Object.keys(module.appDefinition.handlers||{})));
 assert.equal(strings(sourcePages),strings(module.appDefinition.pages.map(p=>p.path)));
 assert.equal(strings(sourceFixtures),strings(Object.keys(fixtures.fixtures)));
 for(const op of Object.values(module.appDefinition.operations))assert.equal(typeof registry[op.handler],'function');
 for(const op of Object.values(module.appDefinition.handlers||{}))assert.equal(typeof registry[op.handler],'function');
 for(const model of Object.values(module.appDefinition.models)){
  for(const grant of model.readGrants||[])assert.equal(typeof registry.read[grant.rule],'function');
  for(const key of model.invariants||[])assert.equal(typeof registry.invariants[key],'function');
  for(const key of model.locks||[])assert.ok(registry.locks[key]);
  for(const value of Object.values(model.derived||{}))assert.equal(typeof registry.derives[value.handler],'function');
 }
 let tables=0,sequences=0,rows=0;
 for(const example of fixtures.examples){
  assert.ok(module.appDefinition.operations[example.operation]||module.appDefinition.handlers[example.operation]);
  if(example.sequence){sequences++;assert.ok(example.sequence.some(step=>step.operation===example.operation));}
  else {tables++;rows+=example.rows.length;assert.ok(Array.isArray(example.observations));assert.ok(example.observations.every(x=>typeof x==='function'));}
 }
 report.push({app,models:sourceModels.length,userOperations:sourceUser.length,trustedHandlers:sourceTrusted.length,pages:sourcePages.length,fixtures:sourceFixtures.length,tables,rows,sequences});
 Object.assign(imported,module.exported,fixtures.fixtures);
}
console.log(JSON.stringify({scope:'Descriptor inventory and references only; no operations, BDD or runtime executed',report},null,2));
