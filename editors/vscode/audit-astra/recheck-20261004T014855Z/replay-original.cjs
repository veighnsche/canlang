// Read-only audit helper. Uses the editor's installed TextMate engine; no extension activation.
const fs = require('node:fs');
const path = require('node:path');
const base = '/Applications/Cursor.app/Contents/Resources/app/node_modules';
const tm = require(base + '/vscode-textmate');
const onig = require(base + '/vscode-oniguruma');
const audit = __dirname;
const snapshot = path.join(audit, 'snapshot');
(async () => {
 await onig.loadWASM(fs.readFileSync(base + '/vscode-oniguruma/release/onig.wasm'));
 const registry = new tm.Registry({onigLib: Promise.resolve({createOnigScanner: p=>new onig.OnigScanner(p),createOnigString:s=>new onig.OnigString(s)}),loadGrammar: async scope=>scope==='source.can'?JSON.parse(fs.readFileSync(process.argv[2] || path.join(snapshot,'editors/vscode/syntaxes/can.tmLanguage.json'),'utf8')):null});
 const grammar = await registry.loadGrammar('source.can');
 function tokenize(source) {
  let stack = tm.INITIAL;
  return source.split(/\r?\n/).map((line,index)=>{const result=grammar.tokenizeLine(line,stack);stack=result.ruleStack;return {line:index+1,source:line,tokens:result.tokens.map(t=>({start:t.startIndex+1,end:t.endIndex+1,text:line.slice(t.startIndex,t.endIndex),scopes:t.scopes})),stackDepth:stack.depth};});
 }
 const cases=JSON.parse(fs.readFileSync(path.join(audit,'original-probes.json'),'utf8'));
 const results=cases.map(c=>({...c,lines:tokenize(c.source)}));
 fs.writeFileSync(path.join(audit,process.argv[3] || 'probe-results.json'),JSON.stringify(results,null,2)+'\n');
 for(const c of results) {console.log('\n'+c.id);for(const l of c.lines) console.log(l.line+': '+l.tokens.filter(t=>t.text.trim()).map(t=>t.text+' <'+t.scopes.at(-1)+'>').join(' | '));}
})();
