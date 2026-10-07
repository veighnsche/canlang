import { writeFile } from 'node:fs/promises';
import * as ui from '@canlang/ui';
const rows=[];
for (const name of ['tab','order','card-control']) {
 try {
  const mod=await import(`./${name}.mjs`);
  const descriptor=mod.appDefinition.pages[0];
  const row={name,import:'ok',descriptor:{owner:descriptor.owner,path:descriptor.path,title:descriptor.title},bindings:await descriptor.admit({})};
  if(name==='card-control') {
   // Data-only presentation subset; no query/identity/HTTP substitute is supplied.
   row.render=await descriptor.render({appDefaultLocale:'en',preferredLocales:['en']},row.bindings);
   row.scope='Actual generated descriptor and public factories; pure static markup subset only';
  } else row.render='not executed: requires genuine authorized RowQueryRunner/identity runtime; no substitute query';
  rows.push(row);
 } catch(e) {rows.push({name,import:'failed',error:String(e)});}
}
rows.push({name:'actual-public-exports',tab:typeof ui.tab,tabs:typeof ui.tabs,kbd:typeof ui.kbd});
await writeFile(new URL('./consumer-observations.json',import.meta.url),JSON.stringify(rows,null,2)+'\n');
console.log(JSON.stringify(rows,null,2));
