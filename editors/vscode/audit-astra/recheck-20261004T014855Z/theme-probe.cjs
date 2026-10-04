const fs=require('fs'),path=require('path'),crypto=require('crypto');
const j=require('/Applications/Cursor.app/Contents/Resources/app/node_modules/jsonc-parser');
const hashes={};const cap=p=>{const s=fs.readFileSync(p);hashes[p]=crypto.createHash('sha256').update(s).digest('hex');return j.parse(s.toString())};
const theme=p=>{const d=cap(p),b=d.include?theme(path.resolve(path.dirname(p),d.include)):{colors:{},rules:[]};return {colors:{...b.colors,...d.colors},rules:[...b.rules,...(d.tokenColors||[])]};};
const sources=[
 {id:'structure-and-presentation',lines:[
  'app Demo','Given',
  ' Record {do:text,require:text,scenario:text,page:text,examples:text,text:text}',
  ' use records {Record}', ' role allowed = self != null',
  'When',' scenario run(do:text,require:text,examples:text) -> text',
  '  require do != ""','  do','   let page = do','   return page',
  '  examples','   (do="ok",require="",examples=""): "ok"',
  'Then',' page /work','  require self != null','  title "Work"',
  '  text row.do','  table Record as page','  form run','  card row.page',
  '  # Label @{nl="Hallo","nl-NL"="Hallo"}',
  '  text "Label"@{nl="Hallo","nl-NL"="Hallo"}',
  'package Shared','Given',' Item {name:text}','When',
  ' scenario page(scenario:text) -> text','  do return scenario',
  'Then',' page /shared','  text "Shared"'
 ]},
 {id:'contextual-names',lines:[
  'app Contextual','Given',
  ' Record {do:text,require:text,page:text,examples:text,scenario:text,title:text,form:text}',
  'When',' scenario page(do:text,require:text,examples:text,scenario:text) -> text',
  '  require do != ""','  do','   let examples = row.page','   return examples',
  'Then',' page /contextual','  text row.page','  text row.require',
  '  form page'
 ]},
 {id:'translation-markers',lines:['# Label @{nl="Hallo"}','message label="Label"@{nl="Hallo"}','# Label @{"nl-NL"="Hallo"}','message label="Label"@{"nl-NL"="Hallo"}']}
];
(async()=>{
 const grammarPath=path.join(__dirname,'snapshot/editors/vscode/syntaxes/can.tmLanguage.json'),grammar=cap(grammarPath);
 const data={capturedAt:new Date().toISOString(),grammarPath,grammarSha256:hashes[grammarPath],snapshotManifest:cap(path.join(__dirname,'snapshot/editors/vscode/package.json')),hashes,editors:{}};
 for(const [name,root]of [['Cursor','/Users/vince/.cursor/extensions'],['Antigravity IDE','/Users/vince/.antigravity-ide/extensions']]){
  const app=`/Applications/${name}.app/Contents/Resources/app`,registration=cap(path.join(root,'extensions.json')).find(e=>e.identifier.id==='canlang.canlang-draft-highlighting');
  const installed=path.join(root,registration.relativeLocation),installedGrammarPath=path.join(installed,'syntaxes/can.tmLanguage.json');cap(installedGrammarPath);
  const manifest=cap(path.join(installed,'package.json')),settingsPath=`/Users/vince/Library/Application Support/${name}/User/settings.json`,settings=cap(settingsPath),selected={};
  for(const k of ['workbench.colorTheme','editor.tokenColorCustomizations','editor.semanticTokenColorCustomizations','editor.semanticHighlighting.enabled'])if(k in settings)selected[k]=settings[k];
  const themePath=path.join(app,name==='Cursor'?'extensions/theme-cursor/themes/cursor-dark-hc-color-theme.json':'extensions/theme-defaults/themes/dark_modern.json'),t=theme(themePath);
  const tm=require(path.join(app,'node_modules/vscode-textmate')),onig=require(path.join(app,'node_modules/vscode-oniguruma'));await onig.loadWASM(fs.readFileSync(path.join(app,'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
  const reg=new tm.Registry({theme:{settings:[{settings:{foreground:t.colors['editor.foreground'],background:t.colors['editor.background']}},...t.rules,...(settings['editor.tokenColorCustomizations']?.textMateRules||[])]},onigLib:Promise.resolve({createOnigScanner:s=>new onig.OnigScanner(s),createOnigString:s=>new onig.OnigString(s)}),loadGrammar:async()=>grammar});
  const g=await reg.loadGrammar('source.can'),map=reg.getColorMap();
  const cases=sources.map(source=>{let state=null;return {id:source.id,lines:source.lines.map((line,index)=>{const a=g.tokenizeLine(line,state),b=g.tokenizeLine2(line,state);state=a.ruleStack;return {lineNumber:index+1,line,tokens:a.tokens.map(tok=>{let i=0;while(i+2<b.tokens.length&&b.tokens[i+2]<=tok.startIndex)i+=2;const m=b.tokens[i+1];return {text:line.slice(tok.startIndex,tok.endIndex),scopes:tok.scopes,foreground:map[(m>>>15)&511],fontStyle:(m>>>11)&15};})};})};});
  data.editors[name]={registration,manifest,installedGrammarPath,installedGrammarSha256:hashes[installedGrammarPath],snapshotMatchesInstalled:hashes[installedGrammarPath]===data.grammarSha256,settingsPath,settings:selected,themePath,textmateVersion:cap(path.join(app,'node_modules/vscode-textmate/package.json')).version,onigurumaVersion:cap(path.join(app,'node_modules/vscode-oniguruma/package.json')).version,cases};
 }
 fs.writeFileSync(path.join(__dirname,'theme-evidence.json'),JSON.stringify(data,null,2)+'\n');
 console.log('Captured',data.capturedAt,data.grammarSha256);
 for(const[n,e]of Object.entries(data.editors)){console.log(n,e.registration.version,e.snapshotMatchesInstalled);for(const c of e.cases)for(const l of c.lines)console.log(c.id,l.line,JSON.stringify(l.tokens.filter(t=>t.text.trim()).map(t=>[t.text,t.scopes.at(-1),t.foreground,t.fontStyle])));}
})().catch(e=>{console.error(e);process.exitCode=1});
