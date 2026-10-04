// Focused follow-up for an incomplete user-reported description/string symptom.
// Uses preserved extension + captured settings; reads bundled themes without UI changes.
const fs=require('node:fs'), path=require('node:path');
const dir=__dirname, evidence=JSON.parse(fs.readFileSync(path.join(dir,'theme-installation-evidence.json'),'utf8'));
const jsonc=require('/Applications/Cursor.app/Contents/Resources/app/node_modules/jsonc-parser');
const cases=[
 {id:'description-and-inline-translation',source:'# A "quoted" title. @{nl="Een titel."}\napp Demo label="A title"@{nl="Een titel"}\nGiven\n Thing {caption:text label="Caption"@{nl="Opschrift"},next:int=1}\nWhen\nThen\n page / title="Title"@{nl="Titel"} order=1\n  text "Text"@{nl="Tekst"},row.caption'},
 {id:'escaped-string-and-next-declaration',source:' message first="A \\"quote\\" and # sign"@{nl="Een {placeholder}"}\n message second="Second"@{}\n ## Plain comment\n # Raw description with \\@{literal} marker.\n role manager\n #= captions.title\n role operator'},
 {id:'description-then-quoted-locale',source:'# First description line.\n# Final description line. @{"pt-BR"="Descrição",nl=null}\napp Demo\nGiven\n message named="Text"@{"pt-BR"="Texto",nl=null}\nWhen\nThen'}
];
function theme(p){const t=jsonc.parse(fs.readFileSync(p,'utf8'));const prev=t.include?theme(path.resolve(path.dirname(p),t.include)):{colors:{},settings:[]};return {colors:{...prev.colors,...t.colors},settings:[...prev.settings,...(t.tokenColors||[])]};}
(async()=>{const results={capturedPaletteAt:evidence.capturedAt,cases,editors:{}};
 for(const [name,editor] of Object.entries(evidence.editors)){
  const app=`/Applications/${name}.app/Contents/Resources/app`,tm=require(app+'/node_modules/vscode-textmate'),onig=require(app+'/node_modules/vscode-oniguruma');
  await onig.loadWASM(fs.readFileSync(app+'/node_modules/vscode-oniguruma/release/onig.wasm'));
  const p=editor.probes.find(p=>p.label.includes('current-theme'));const t=theme(p.themePath);
  const custom=editor.settings['editor.tokenColorCustomizations'].textMateRules||[];
  const registry=new tm.Registry({theme:{settings:[{settings:{foreground:t.colors['editor.foreground'],background:t.colors['editor.background']}},...t.settings,...custom]},onigLib:Promise.resolve({createOnigScanner:s=>new onig.OnigScanner(s),createOnigString:s=>new onig.OnigString(s)}),loadGrammar:async()=>JSON.parse(fs.readFileSync(path.join(dir,'latest-extension/syntaxes/can.tmLanguage.json'),'utf8'))});
  const grammar=await registry.loadGrammar('source.can');results.editors[name]=cases.map(c=>{let state=tm.INITIAL;return {id:c.id,lines:c.source.split('\n').map((line,i)=>{const r=grammar.tokenizeLine(line,state),binary=grammar.tokenizeLine2(line,state);state=r.ruleStack;const map=registry.getColorMap();return {line:i+1,source:line,depth:state.depth,tokens:r.tokens.map(token=>{let at=0;while(at+2<binary.tokens.length&&binary.tokens[at+2]<=token.startIndex)at+=2;return {text:line.slice(token.startIndex,token.endIndex),scopes:token.scopes,foreground:map[(binary.tokens[at+1]>>>15)&511]};})};})};});
 }
 fs.writeFileSync(path.join(dir,'description-results.json'),JSON.stringify(results,null,2)+'\n');
 for(const [editor,groups] of Object.entries(results.editors))for(const c of groups){console.log(editor,c.id);for(const l of c.lines)console.log(l.line,l.tokens.filter(t=>t.text.trim()).map(t=>t.text+' '+t.scopes.at(-1)+' '+t.foreground).join(' | '));}
})();
