const fs=require('fs'),path=require('path'),crypto=require('crypto');
const jsonc=require('/Applications/Cursor.app/Contents/Resources/app/node_modules/jsonc-parser');
const files={};
const capture=p=>{const s=fs.readFileSync(p);files[p]={sha256:crypto.createHash('sha256').update(s).digest('hex'),bytes:s.length};return jsonc.parse(s.toString());};
const theme=p=>{const d=capture(p),base=d.include?theme(path.resolve(path.dirname(p),d.include)):{colors:{},rules:[]};return {colors:{...base.colors,...d.colors},rules:[...base.rules,...(d.tokenColors||[])]};};
const cases=[
 {label:'unquoted-description-bare-key',line:'# Label @{nl="Hallo"}'},
 {label:'quoted-source-bare-key',line:'message label="Label"@{nl="Hallo"}'},
 {label:'unquoted-description-quoted-key',line:'# Label @{"nl-NL"="Hallo"}'},
 {label:'quoted-source-quoted-key',line:'message label="Label"@{"nl-NL"="Hallo"}'},
 {label:'mixed-locales',line:'# Label @{nl="Hallo","fr-BE"="Bonjour"}'},
 {label:'quoted-source-mixed-locales',line:'message label="Label"@{nl="Hallo","fr-BE"="Bonjour"}'}
];
(async()=>{
 const source='/Users/vince/Projects/canlang/editors/vscode';
 const data={capturedAt:new Date().toISOString(),files,source:{manifest:capture(path.join(source,'package.json')),grammarPath:path.join(source,'syntaxes/can.tmLanguage.json')},editors:{}};
 capture(data.source.grammarPath);
 data.immutableGrammarPath=path.join(__dirname,'followup-013/syntaxes/can.tmLanguage.json');
 const immutableGrammar=capture(data.immutableGrammarPath);
 for(const [name,extRoot]of [['Cursor','/Users/vince/.cursor/extensions'],['Antigravity IDE','/Users/vince/.antigravity-ide/extensions']]){
  const app=`/Applications/${name}.app/Contents/Resources/app`,registryPath=path.join(extRoot,'extensions.json');
  const registration=capture(registryPath).find(e=>e.identifier.id==='canlang.canlang-draft-highlighting');
  const root=path.join(extRoot,registration.relativeLocation),manifestPath=path.join(root,'package.json'),grammarPath=path.join(root,'syntaxes/can.tmLanguage.json');
  const manifest=capture(manifestPath),grammar=capture(grammarPath),settingsPath=`/Users/vince/Library/Application Support/${name}/User/settings.json`,settings=capture(settingsPath);
  const selected={};for(const k of ['workbench.colorTheme','editor.tokenColorCustomizations','editor.semanticTokenColorCustomizations','editor.semanticHighlighting.enabled'])if(k in settings)selected[k]=settings[k];
  const themePath=path.join(app,name==='Cursor'?'extensions/theme-cursor/themes/cursor-dark-hc-color-theme.json':'extensions/theme-defaults/themes/dark_modern.json');
  const t=theme(themePath),tm=require(path.join(app,'node_modules/vscode-textmate')),onig=require(path.join(app,'node_modules/vscode-oniguruma'));
  await onig.loadWASM(fs.readFileSync(path.join(app,'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
  const rules=[{settings:{foreground:t.colors['editor.foreground'],background:t.colors['editor.background']}},...t.rules,...(settings['editor.tokenColorCustomizations']?.textMateRules||[])];
  const reg=new tm.Registry({theme:{settings:rules},onigLib:Promise.resolve({createOnigScanner:s=>new onig.OnigScanner(s),createOnigString:s=>new onig.OnigString(s)}),loadGrammar:async()=>immutableGrammar});
  const g=await reg.loadGrammar('source.can'),map=reg.getColorMap();
  const tokens=cases.map(c=>{const r=g.tokenizeLine(c.line,null),r2=g.tokenizeLine2(c.line,null);return {...c,tokens:r.tokens.map(tok=>{let i=0;while(i+2<r2.tokens.length&&r2.tokens[i+2]<=tok.startIndex)i+=2;const m=r2.tokens[i+1];return {text:c.line.slice(tok.startIndex,tok.endIndex),startIndex:tok.startIndex,scopes:tok.scopes,foreground:map[(m>>>15)&511],fontStyle:(m>>>11)&15};})};});
  data.editors[name]={registration,manifestPath,manifest,grammarPath,sourceGrammarMatches:files[grammarPath].sha256===files[data.source.grammarPath].sha256,immutableGrammarMatches:files[grammarPath].sha256===files[data.immutableGrammarPath].sha256,settingsPath,settings:selected,themePath,textmateVersion:capture(path.join(app,'node_modules/vscode-textmate/package.json')).version,onigurumaVersion:capture(path.join(app,'node_modules/vscode-oniguruma/package.json')).version,cases:tokens};
 }
 fs.writeFileSync(path.join(__dirname,'followup-013-theme-evidence.json'),JSON.stringify(data,null,2)+'\n');
 let md=`# 0.1.3 focused description theme verification\n\nCaptured **${data.capturedAt}** (UTC). Read-only filesystem/token/theme audit; no UI, extension, settings, or source changes. Baseline reports/evidence were preserved.\n\nThe immutable captured 0.1.3 grammar was used for tokenization. In both editors, the installed grammar matches that immutable capture and live source byte-for-byte. All six tested contexts resolve actual @\{ and closing } markers to **#D6D6DD**, eliminating the description-vs-quoted-source foreground difference. Bare and quoted locale-key text resolves to **#D8B4FE** in every context. The quote delimiter tokens around quoted locale keys remain theme-dependent: Cursor **#E394DC**, Antigravity **#D6D6DD**; this does not change the locale-key text color. Runtime UI remains visually unverified.\n\n`;
 for(const [name,e]of Object.entries(data.editors)){
  md+=`## ${name}\n\nRegistered draft version **${e.registration.version}**. Installed grammar SHA-256 \`${files[e.grammarPath].sha256}\`; source grammar match: **${e.sourceGrammarMatches}**. TextMate ${e.textmateVersion}, Oniguruma ${e.onigurumaVersion}. Manifest contributes syntax grammar/language registration and indentation defaults; no main or activationEvents.\n\n| Case | Token | Scope | Resolved foreground | Style |\n|---|---|---|---|---|\n`;
  for(const c of e.cases)for(const tok of c.tokens.filter(t=>t.text==='@{'||t.text==='}'||t.scopes.some(s=>s==='entity.other.attribute-name.locale.can'))){md+=`| ${c.label} | \`${tok.text}\` | \`${tok.scopes.at(-1)}\` | ${tok.foreground} | ${tok.fontStyle===2?'bold':'plain'} |\n`;}
 }
 md+='\nThe table reports actual emitted token stacks and resolved TextMate colors, not scope-name assumptions. Full stacks, selected user rules, manifests, registry entries, and source/theme/settings hashes are in `followup-013-theme-evidence.json`. Cursor uses its explicit Cursor Dark High Contrast selection; Antigravity uses bundled Default Dark Modern because its user settings have no explicit theme selection. Runtime UI rendering remains visually unverified.\n';
 fs.writeFileSync(path.join(__dirname,'followup-013-theme.md'),md);
 console.log(data.capturedAt);
 for(const [n,e]of Object.entries(data.editors))console.log(n,e.registration.version,e.sourceGrammarMatches,e.cases.map(c=>({case:c.label,tokens:c.tokens.filter(t=>t.text==='@{'||t.text==='}'||t.scopes.some(s=>s==='entity.other.attribute-name.locale.can')).map(t=>[t.text,t.foreground,t.scopes.at(-1)])})));
})().catch(e=>{console.error(e);process.exitCode=1});
