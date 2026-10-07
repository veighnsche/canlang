import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as ui from '@canlang/ui';
import * as facade from '@canlang/stdlib';
import * as owner from '@canlang/cloudflare/runtime/stdlib';

const root = new URL('../../../../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');
const files = [
  'compiler/src/codegen/js.rs', 'packages/stdlib/src/index.ts',
  'packages/stdlib/package.json', 'packages/cloudflare/package.json',
  'packages/cloudflare/src/runtime/stdlib.ts', 'packages/cloudflare/src/runtime/invoke.ts',
  'packages/cloudflare/src/runtime/context.ts', 'packages/ui/src/messages.ts',
  'packages/ui/src/components.ts', 'packages/contracts/src/presentation.ts',
  'packages/ui/dist/src/messages.js', 'packages/ui/dist/src/components.js',
  'packages/ui/dist/src/index.js', 'packages/stdlib/dist/src/index.js',
  'implementation/compiler-completion/ui-ownership/research/selected-phase/card-control.mjs',
  'implementation/compiler-completion/ui-ownership/research/selected-phase/order.mjs',
];
const pins = {};
for (const file of files) pins[file] = createHash('sha256').update(await read(file)).digest('hex');
const results = {
  time: new Date().toISOString(), pins,
  routes: Object.fromEntries(['@canlang/ui','@canlang/stdlib','@canlang/cloudflare/runtime/stdlib'].map(name=>[name,import.meta.resolve(name)])),
  facade: { require: typeof facade.require, hasRole: typeof facade.hasRole },
  message: ui.message('Home'),
  actualConsumers: [],
  directProducerFixtures: [],
  qualification: 'Direct hasRole fixtures certify local function behavior only, not authenticated canonical admission or a generated scenario execution.',
};
for (const name of ['order','card-control']) {
  const row = { name };
  try {
    const mod = await import(new URL(`implementation/compiler-completion/ui-ownership/research/selected-phase/${name}.mjs`,root));
    row.import = 'ok';
    row.title = mod.appDefinition.pages[0].title;
    if (name === 'card-control') {
      try {
        const page=mod.appDefinition.pages[0];
        row.render = await page.render({appDefaultLocale:'en',preferredLocales:['en']},await page.admit({}));
      } catch(error) { row.renderError = error.stack; }
    }
  } catch(error) { row.importError = String(error); }
  results.actualConsumers.push(row);
}
for (const [name,context,role,subject] of [
  ['empty local roles',{memberships:[]},'members',undefined],
  ['local role present',{memberships:['Shop.editor']},'Shop.editor',undefined],
  ['canonical built-in present',{memberships:[],canonical:{builtinRoles:['public']}},'public',undefined],
  ['canonical ignores injected built-in',{memberships:['owner'],canonical:{builtinRoles:[]}},'owner',undefined],
  ['subject unsupported',{memberships:['Shop.editor']},'Shop.editor','person'],
]) {
  try { results.directProducerFixtures.push({name,result:owner.hasRole(context,role,subject)}); }
  catch(error) { results.directProducerFixtures.push({name,error:String(error)}); }
}
for (const [name,condition,code] of [['truthy guard',true,'forbidden'],['denied guard',false,'forbidden']]) {
  try { owner.require(condition,code); results.directProducerFixtures.push({name,result:'returned'}); }
  catch(error) { results.directProducerFixtures.push({name,error:String(error)}); }
}
const stdlibPackage = JSON.parse(await read('packages/stdlib/package.json'));
const cloudflarePackage = JSON.parse(await read('packages/cloudflare/package.json'));
results.dependencyCycle = {
  currentCloudflareToStdlib: cloudflarePackage.dependencies['@canlang/stdlib'],
  currentStdlibToCloudflare: stdlibPackage.dependencies['@canlang/cloudflare'] ?? null,
  proposalAddingCloudflareToStdlib: 'Introduces manifest cycle; turbo build dependsOn ^build. Runtime subpath currently uses only type imports + state transition, but package graph is still cyclic.',
};
await writeFile(new URL('./receipts.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
