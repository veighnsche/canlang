import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const [root, can, scratch] = process.argv.slice(2);
registerHooks({resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0, -3)+'.ts', context.parentURL);
    if (existsSync(candidate)) return {url:candidate.href, shortCircuit:true};
  }
  return next(specifier, context);
}});
const load = path => import(pathToFileURL(resolve(root, path)));
const {loadArtifactFile} = await load('packages/cloudflare/src/runtime/artifact.ts');
const {assembleModules} = await load('packages/cloudflare/src/runtime/modules.ts');
const ui = await import('@canlang/ui');
const source = `app StaticTitle
use Captions {invoice as importedCaption}
Given
 message caption = "Invoice"@{nl="Factuur"}
When
Then
 page /local title=caption
  text "ready"
 page /imported title=importedCaption
  text "ready"
package Captions source="fr"
 Given
  export message invoice = "Facture"@{nl="Factuur"}
 When
 Then
`;
const compile = (name, text) => {
  const file = resolve(scratch, name+'.can');
  writeFileSync(file, text);
  return spawnSync(can, ['compile', '--format=json', '--catalog', resolve(root, 'packages/values/dist/catalog.json'), file], {encoding:'utf8', timeout:15000});
};
const compiled = compile('StaticTitle', source);
assert.equal(compiled.status, 0, compiled.stdout+'\n'+compiled.stderr);
const artifactPath = resolve(scratch, 'StaticTitle.json');
writeFileSync(artifactPath, compiled.stdout);
const assembled = await assembleModules(loadArtifactFile(artifactPath), {
  workDir:resolve(scratch, 'assembled'),
  stdlibUrl:import.meta.resolve('@canlang/stdlib'),
  uiUrl:import.meta.resolve('@canlang/ui'),
});
const generated = await import(assembled.entryUrl);
const local = generated.appDefinition.pages.find(page => page.path === '/local');
const imported = generated.appDefinition.pages.find(page => page.path === '/imported');
assert.deepEqual(ui.resolveMessage(local.title, {preferredLocales:['nl'], appDefaultLocale:'en'}), {text:'Factuur', locale:'nl'});
assert.deepEqual(ui.resolveMessage(imported.title, {preferredLocales:['es'], appDefaultLocale:'en'}), {text:'Facture', locale:'fr'});
assert.deepEqual(ui.resolveMessage(imported.title, {preferredLocales:['nl'], appDefaultLocale:'en'}), {text:'Factuur', locale:'nl'});
for (const [name, invalid] of [
  ['Parameterized', source.replace('message caption = "Invoice"', 'message caption(value:text) = "Invoice {value}"')],
  ['Computed', source.replace('title=caption', 'title=(1 + 2)')],
  ['Nonmessage', source.replace('message caption = "Invoice"@{nl="Factuur"}', 'derive caption():text = "Invoice"').replace('title=caption', 'title=caption()')],
  ['NonmessageReference', source.replace('message caption = "Invoice"@{nl="Factuur"}', 'derive caption():text = "Invoice"')],
]) {
  const refused = compile(name, invalid);
  assert.equal(refused.status, 10, refused.stdout+'\n'+refused.stderr);
  const response = JSON.parse(refused.stdout);
  assert.ok(response.diagnostics.some(diagnostic => diagnostic.code === 'E3013'), refused.stdout);
  assert.equal(response.modules, undefined);
}
console.log('static page title: local and imported message, translation, owning language, semantic refusal and no artifact modules passed');
