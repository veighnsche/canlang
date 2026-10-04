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
 const cases=JSON.parse(fs.readFileSync(path.join(audit,'execution-presentation-probes.json'),'utf8'));
 const results=cases.map(c=>({...c,lines:tokenize(c.source)}));
 fs.writeFileSync(path.join(audit,process.argv[3] || 'execution-presentation-probe-results.json'),JSON.stringify(results,null,2)+'\n');
 if (false) {
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.name.endsWith('.can')?[path.join(dir,e.name)]:[]);
  const corp=walk(path.join(snapshot,'draft')).concat(walk(path.join(snapshot,'examples'))).sort().map(file=>({file:path.relative(snapshot,file),lines:tokenize(fs.readFileSync(file,'utf8'))}));
  fs.writeFileSync(path.join(audit,'corpus-tokens.json'),JSON.stringify(corp)+'\n');
  console.log(JSON.stringify({probes:results.length,corpusFiles:corp.length,corpusLines:corp.reduce((a,c)=>a+c.lines.length,0)}));
 }
 for(const c of results) {console.log('\n'+c.id);for(const l of c.lines) console.log(l.line+': '+l.tokens.filter(t=>t.text.trim()).map(t=>t.text+' <'+t.scopes.at(-1)+'>').join(' | '));}
})();
