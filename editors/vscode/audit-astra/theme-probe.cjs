// Independent read-only theme/install probe; writes evidence only in this audit directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const out = __dirname;
const snapshot = path.join(out, 'snapshot/editors/vscode');
const j = require('/Applications/Cursor.app/Contents/Resources/app/node_modules/jsonc-parser');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = p => j.parse(fs.readFileSync(p, 'utf8'));
const facts = { capturedAt: new Date().toISOString(), method: 'vscode-textmate tokenizeLine2 color metadata; theme include rules flattened in include-first order; no semantic token provider in draft manifest', files: {}, editors: {} };
function capture(p) { facts.files[p] = {sha256: sha(p), bytes: fs.statSync(p).size}; return read(p); }
function theme(p) {
 const d = capture(p);
 const inherited = d.include ? theme(path.resolve(path.dirname(p),d.include)) : {colors:{},settings:[]};
 return {colors:{...inherited.colors,...d.colors},settings:[...inherited.settings,...(Array.isArray(d.tokenColors)?d.tokenColors:[])],files:[...(inherited.files||[]),p]};
}
function names(v, s=new Set()) {
 if (Array.isArray(v)) v.forEach(e=>names(e,s));
 else if(v&&typeof v==='object') for(const [k,e] of Object.entries(v)) { if((k==='name'||k==='contentName')&&typeof e==='string'&&e.endsWith('.can')) s.add(e); else names(e,s); }
 return [...s].sort();
}
async function resolve(editor, root, themeRel, grammarPath, custom, label) {
 const app=`/Applications/${editor}.app/Contents/Resources/app`;
 const tm=require(path.join(app,'node_modules/vscode-textmate'));
 const onig=require(path.join(app,'node_modules/vscode-oniguruma'));
 await onig.loadWASM(fs.readFileSync(path.join(app,'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
 const d=capture(grammarPath), scopes=names(d), t=theme(path.join(app,themeRel));
 const settings=[{settings:{foreground:t.colors['editor.foreground']||'#D4D4D4',background:t.colors['editor.background']||'#1E1E1E'}},...t.settings,...custom];
 const onigLib={createOnigScanner:s=>new onig.OnigScanner(s),createOnigString:s=>new onig.OnigString(s)};
 const registry=new tm.Registry({theme:{settings},onigLib:Promise.resolve(onigLib),loadGrammar:async n=> n==='source.can.probe' ? {scopeName:n,patterns:scopes.map((scope,i)=>({match:`\\bP${i}\\b`,name:scope}))} : d});
 const probe=await registry.loadGrammar('source.can.probe');
 // A grammar rooted at source.can.probe inherits the source.can selector prefix.
 const colorMap=registry.getColorMap();
 const decode=m=>({foreground:colorMap[(m>>>15)&511],fontStyle:(m>>>11)&15});
 const resolved=scopes.map((scope,i)=>({scope,...decode(probe.tokenizeLine2(`P${i}`,null).tokens[1])}));
 const actual=await registry.loadGrammar('source.can');
 const lines=['app Ledger','Ledger { id:ID name:String count:Int }','scenario approve(item:Ledger) -> Ledger',' Given','  let record = Ledger(id=1)',' When','  do call approve(record)',' Then','  record.name == "ok"','  enum(open,closed)','  action(approve)','  by Member','  before.Ledger.name','  use Accounts { approve as accept }'];
 let state=null;
 const tokens=lines.map(line=>{
  const r=actual.tokenizeLine(line,state), r2=actual.tokenizeLine2(line,state);state=r.ruleStack;
  return {line,tokens:r.tokens.map(token=>{let at=0;while(at+2<r2.tokens.length&&r2.tokens[at+2]<=token.startIndex)at+=2;return {text:line.slice(token.startIndex,token.endIndex),scopes:token.scopes,...decode(r2.tokens[at+1])};})};
 });
 const canonicalTokens=[];
 for(const [relative,selected] of [['draft/CanDo.can',[19,41,42,121,137,145]],['draft/CanLeave.can',[25,44,45,120]],['draft/CanPropose.can',[224]]]) {
  const p=path.join(out,'snapshot',relative);facts.files[p]={sha256:sha(p),bytes:fs.statSync(p).size};
  let fileState=null;const fileLines=fs.readFileSync(p,'utf8').split(/\r?\n/);
  for(let index=0;index<fileLines.length;index++){
   const line=fileLines[index],r=actual.tokenizeLine(line,fileState),r2=actual.tokenizeLine2(line,fileState);fileState=r.ruleStack;
   if(selected.includes(index+1))canonicalTokens.push({source:p,lineNumber:index+1,line,tokens:r.tokens.map(token=>{let at=0;while(at+2<r2.tokens.length&&r2.tokens[at+2]<=token.startIndex)at+=2;return {text:line.slice(token.startIndex,token.endIndex),scopes:token.scopes,...decode(r2.tokens[at+1])};})});
  }
 }
 const possibleScopes=['source.can',...scopes];
 const relevantThemeRules=t.settings.filter(r=>r.scope===undefined||((Array.isArray(r.scope)?r.scope:[r.scope]).some(s=>typeof s==='string'&&s.split(',').some(selector=>selector.trim().split(/\s+/).every(part=>possibleScopes.some(scope=>scope===part||scope.startsWith(part+'.')))))));
 return {label,grammarPath,themePath:path.join(app,themeRel),themeFiles:t.files,baseForeground:t.colors['editor.foreground'],settingsRuleCount:settings.length,relevantThemeRules,resolved,tokens,canonicalTokens};
}
(async()=>{
 capture(path.join(snapshot,'package.json'));
 for(const [editor,extensionsRoot] of [['Cursor','/Users/vince/.cursor/extensions'],['Antigravity IDE','/Users/vince/.antigravity-ide/extensions']]){
  const app=`/Applications/${editor}.app/Contents/Resources/app`;
  const registry=capture(path.join(extensionsRoot,'extensions.json'));
  const obsolete=capture(path.join(extensionsRoot,'.obsolete'));
  const relevant=registry.filter(e=>/^(canlang|can-lang|ai-lang)\./.test(e.identifier.id));
  const installed=[];
  for(const dir of fs.readdirSync(extensionsRoot).filter(n=>/^(canlang|can-lang|ai-lang)\./.test(n))){
   const p=path.join(extensionsRoot,dir,'package.json'); if(!fs.existsSync(p))continue;
   const d=capture(p);installed.push({path:path.dirname(p),id:`${d.publisher}.${d.name}`,version:d.version,obsolete:obsolete[dir]||false,registered:relevant.some(e=>e.relativeLocation===dir),main:d.main||null,activationEvents:d.activationEvents||null,contributes:d.contributes});
  }
  const settingsPath=`/Users/vince/Library/Application Support/${editor}/User/settings.json`;
  const user=capture(settingsPath);
  const selected={};for(const [k,v] of Object.entries(user))if(/^(workbench\.(colorTheme|preferred.*ColorTheme)|window\.autoDetect(ColorScheme|HighContrast)|editor\.(tokenColorCustomizations|semanticTokenColorCustomizations|semanticHighlighting\.enabled)|files\.associations|\[can\])$/.test(k))selected[k]=v;
  const current=relevant.find(e=>e.identifier.id==='canlang.canlang-draft-highlighting');
  const grammar=path.join(extensionsRoot,current.relativeLocation,'syntaxes/can.tmLanguage.json');
  const e=facts.editors[editor]={version:capture(path.join(app,'package.json')).version,libraries:{textmate:capture(path.join(app,'node_modules/vscode-textmate/package.json')).version,oniguruma:capture(path.join(app,'node_modules/vscode-oniguruma/package.json')).version},registry:relevant,installed,settingsPath,settings:selected,probes:[]};
  const defaults=editor==='Cursor'?'extensions/theme-cursor/themes/cursor-dark-color-theme.json':'extensions/theme-defaults/themes/dark_modern.json';
  e.probes.push(await resolve(editor,extensionsRoot,defaults,path.join(snapshot,'syntaxes/can.tmLanguage.json'),[],'snapshot-0.1.1-default-dark'));
  e.probes.push(await resolve(editor,extensionsRoot,defaults,grammar,[],'installed-0.1.2-default-dark'));
  const currentTheme=editor==='Cursor'?'extensions/theme-cursor/themes/cursor-dark-hc-color-theme.json':defaults;
  e.probes.push(await resolve(editor,extensionsRoot,currentTheme,grammar,user['editor.tokenColorCustomizations']?.textMateRules||[],'installed-current-theme-and-user-rules'));
  const workbenchPath=path.join(app,'out/vs/workbench/workbench.desktop.main.js');
  capture(workbenchPath);
  const workbench=fs.readFileSync(workbenchPath,'utf8'),at=workbench.indexOf('COLOR_THEME_DARK=');
  e.defaultThemeCode={path:workbenchPath,offset:at,excerpt:workbench.slice(at,at+350)};
 }
 fs.writeFileSync(path.join(out,'theme-installation-evidence.json'),JSON.stringify(facts,null,2)+'\n');
 console.log('Evidence captured',facts.capturedAt);
 for(const [editor,e] of Object.entries(facts.editors))for(const p of e.probes){console.log(editor,p.label);console.log(p.resolved.filter(r=>/section\.|entity.name.(type|function)|variable.other.(readwrite|property)|attribute-name|support.type|storage.type|variable.parameter/.test(r.scope)));}
})().catch(e=>{console.error(e);process.exitCode=1;});
