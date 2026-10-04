// Read-only descriptor/source correspondence inspection; no app operation or BDD execution.
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('draft/CanDecide.can','utf8');
const target=fs.readFileSync('draft/CanDecide.mjs','utf8');
const context={message:(...args)=>({message:args})};vm.createContext(context);
vm.runInContext(target.replace(/^import .*;\n/gm,'').replaceAll('export ','')+'\nglobalThis.inspect={appDefinition,canApp,exampleFixtures};',context);
const {appDefinition:a,canApp,exampleFixtures}=context.inspect,r=canApp(),f=exampleFixtures({self:{},other:{},imported:{}});
for(const [id,op]of Object.entries(a.operations))if(typeof r[op.handler]!=='function')throw Error('Missing '+id);
for(const [id,m]of Object.entries(a.models)){
 const short=id.split('.').pop(),line=source.split('\n').find(l=>l.startsWith('  '+short+' {')||l.startsWith('  '+short+' in '));
 const fields=[...line.slice(line.indexOf('{')+1,line.indexOf('}')).matchAll(/(?:^|,)\s*(\w+):/g)].map(m=>m[1]);
 if(fields.join(',')!==Object.keys(m.fields).join(','))throw Error('Stored field mismatch '+id);
 for(const grant of m.readGrants)if(typeof r.read[grant.rule]!=='function')throw Error('Missing read '+grant.rule);
 for(const name of m.locks??[])if(!r.locks[name])throw Error('Missing lock '+name);
 for(const name of m.invariants??[])if(typeof r.invariants[name]!=='function')throw Error('Missing invariant '+name);
 for(const d of Object.values(m.derived??{}))if(typeof r.derives[d.handler]!=='function')throw Error('Missing derive '+d.handler);
}
const declared=[...source.matchAll(/^  scenario (\w+)\(/gm)].map(m=>'decide.'+m[1]);
for(const id of declared)if(!a.operations[id])throw Error('Missing source operation '+id);
if(Object.keys(f).join(',')!=='fixtures,examples')throw Error('Bad factory');
if(Object.keys(f.fixtures).length!==[...source.matchAll(/^  fixture /gm)].length)throw Error('Fixture count');
for(const e of f.examples){if(e.seed)throw Error('Alternate seed');if(e.rows&&e.sequence)throw Error('Mixed example');}
const out={scope:'Static descriptors and source names only; no handlers, providers or BDD bodies executed',models:Object.keys(a.models).length,scenarios:declared.length,operations:Object.keys(a.operations).length,fixtures:Object.keys(f.fixtures).length,tables:f.examples.filter(e=>e.rows).length,rows:f.examples.reduce((n,e)=>n+(e.rows?.length??0),0),sequences:f.examples.filter(e=>e.sequence).length};console.log(JSON.stringify(out,null,2));
