const fs=require('fs'),path=require('path'),crypto=require('crypto');
const jsonc=require('/Applications/Cursor.app/Contents/Resources/app/node_modules/jsonc-parser');
const hashes={};const capture=p=>{const s=fs.readFileSync(p);hashes[p]=crypto.createHash('sha256').update(s).digest('hex');return jsonc.parse(s.toString());};
const loadTheme=p=>{const d=capture(p),base=d.include?loadTheme(path.resolve(path.dirname(p),d.include)):{colors:{},rules:[]};return {colors:{...base.colors,...d.colors},rules:[...base.rules,...(d.tokenColors||[])]};};
(async()=>{
 const grammarPath=path.join(__dirname,'snapshot/editors/vscode/syntaxes/can.tmLanguage.json'),grammar=capture(grammarPath);
 const lines=['app Inline','Given',' Item {ready:bool}','When',' scenario check(item:Item)','  do require item.ready; require item.ready','Then',' page /','  text "ok"'];
 const data={capturedAt:new Date().toISOString(),grammarPath,grammarSha256:hashes[grammarPath],hashes,lines,editors:{}};
 for(const name of ['Cursor','Antigravity IDE']){
  const app=`/Applications/${name}.app/Contents/Resources/app`,settingsPath=`/Users/vince/Library/Application Support/${name}/User/settings.json`,settings=capture(settingsPath);
  const selected={};for(const key of ['workbench.colorTheme','editor.tokenColorCustomizations','editor.semanticTokenColorCustomizations','editor.semanticHighlighting.enabled'])if(key in settings)selected[key]=settings[key];
  const themePath=path.join(app,name==='Cursor'?'extensions/theme-cursor/themes/cursor-dark-hc-color-theme.json':'extensions/theme-defaults/themes/dark_modern.json'),theme=loadTheme(themePath);
  const tm=require(path.join(app,'node_modules/vscode-textmate')),onig=require(path.join(app,'node_modules/vscode-oniguruma'));await onig.loadWASM(fs.readFileSync(path.join(app,'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
  const registry=new tm.Registry({theme:{settings:[{settings:{foreground:theme.colors['editor.foreground'],background:theme.colors['editor.background']}},...theme.rules,...(settings['editor.tokenColorCustomizations']?.textMateRules||[])]},onigLib:Promise.resolve({createOnigScanner:s=>new onig.OnigScanner(s),createOnigString:s=>new onig.OnigString(s)}),loadGrammar:async()=>grammar});
  const g=await registry.loadGrammar('source.can'),colors=registry.getColorMap();let state=null;
  const tokens=lines.map(line=>{const a=g.tokenizeLine(line,state),b=g.tokenizeLine2(line,state);state=a.ruleStack;return {line,tokens:a.tokens.map(t=>{let i=0;while(i+2<b.tokens.length&&b.tokens[i+2]<=t.startIndex)i+=2;const m=b.tokens[i+1];return {text:line.slice(t.startIndex,t.endIndex),scopes:t.scopes,foreground:colors[(m>>>15)&511],fontStyle:(m>>>11)&15};})};});
  const requires=tokens[5].tokens.filter(t=>t.text.trim()==='require');
  data.editors[name]={settingsPath,settings:selected,themePath,textmateVersion:capture(path.join(app,'node_modules/vscode-textmate/package.json')).version,onigurumaVersion:capture(path.join(app,'node_modules/vscode-oniguruma/package.json')).version,tokens,requires,whiteBold:requires.length===2&&requires.every(t=>t.foreground==='#FFFFFF'&&t.fontStyle===2&&t.scopes.at(-1)==='keyword.control.structure.can')};
 }
 fs.writeFileSync(path.join(__dirname,'inline-require-theme-evidence.json'),JSON.stringify(data,null,2)+'\n');
 let report=`# Changed-rule inline require verification\n\nCaptured **${data.capturedAt} UTC**. Tested only the frozen grammar SHA-256 **${data.grammarSha256}** and the promised inline require case in a complete app/Given Item/When scenario/Then page context. Current relevant user rules were captured once. No installed grammar inspection, broader palette/corpus replay, source chasing, UI actions, installation, settings, or source changes were performed.\n\n\`do require item.ready; require item.ready\`\n\n| Editor | Occurrence | Actual scope | Foreground | Style | Result |\n|---|---|---|---|---|---|\n`;
 for(const[name,e]of Object.entries(data.editors))e.requires.forEach((t,i)=>report+=`| ${name} | ${i===0?'after do':'after semicolon'} | \`${t.scopes.at(-1)}\` | ${t.foreground} | ${t.fontStyle===2?'bold':t.fontStyle} | ${e.whiteBold?'passes':'fails'} |\n`);
 report+='\nFull authored context, token stacks, colors/styles, relevant captured settings, engine versions, and source/theme/settings hashes are preserved in `inline-require-theme-evidence.json`. This verifies resolved TextMate metadata; runtime editor rendering is visually unverified.\n';
 fs.writeFileSync(path.join(__dirname,'inline-require-theme-result.md'),report);
 console.log(data.capturedAt,data.grammarSha256);for(const[name,e]of Object.entries(data.editors))console.log(name,e.whiteBold,JSON.stringify(e.requires));
})().catch(e=>{console.error(e);process.exitCode=1});
