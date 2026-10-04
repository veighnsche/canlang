// Independent frozen-grammar audit. Loads installed TextMate/Oniguruma; no activation/settings edits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = '/Applications/Cursor.app/Contents/Resources/app/node_modules';
const tm = require(base + '/vscode-textmate');
const onig = require(base + '/vscode-oniguruma');
const dir = __dirname;
const grammarPath = path.join(dir, 'snapshot/editors/vscode/syntaxes/can.tmLanguage.json');
(async () => {
 const raw = fs.readFileSync(grammarPath);
 await onig.loadWASM(fs.readFileSync(base + '/vscode-oniguruma/release/onig.wasm'));
 const registry = new tm.Registry({
  onigLib: Promise.resolve({createOnigScanner: patterns => new onig.OnigScanner(patterns), createOnigString: text => new onig.OnigString(text)}),
  loadGrammar: async scope => scope === 'source.can' ? JSON.parse(raw) : null
 });
 const grammar = await registry.loadGrammar('source.can');
 const probes = JSON.parse(fs.readFileSync(path.join(dir, 'foundation-probes.json'), 'utf8'));
 const results = probes.map(probe => {
  let stack = tm.INITIAL;
  const lines = probe.source.split(/\r?\n/).map((line, index) => {
   const result = grammar.tokenizeLine(line, stack);
   stack = result.ruleStack;
   return {line: index+1, source: line, stackDepth: stack.depth, tokens: result.tokens.map(token => ({
    start: token.startIndex+1, end: token.endIndex+1, text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes
   }))};
  });
  return {...probe, lines};
 });
 const evidence = {grammarSha256: crypto.createHash('sha256').update(raw).digest('hex'), packageVersion: JSON.parse(fs.readFileSync(path.join(dir, 'snapshot/editors/vscode/package.json'), 'utf8')).version, results};
 fs.writeFileSync(path.join(dir, 'foundation-results.json'), JSON.stringify(evidence, null, 2)+'\n');
 const text = results.map(probe => probe.id+'\n'+probe.lines.map(line => line.line+': '+line.tokens.filter(token => token.text.trim()).map(token => token.text+' <'+token.scopes.at(-1)+'>').join(' | ')).join('\n')).join('\n\n');
 fs.writeFileSync(path.join(dir, 'foundation-results.txt'), text+'\n');
 console.log(JSON.stringify({grammarSha256: evidence.grammarSha256, version: evidence.packageVersion, probes: results.length}));
})().catch(error => {console.error(error); process.exitCode = 1;});
