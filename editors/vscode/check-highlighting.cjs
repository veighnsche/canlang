const fs = require('fs');
const assert = require('assert/strict');
const path = require('path');
process.chdir(path.resolve(__dirname, '../..'));
const resources = process.env.VSCODE_RESOURCES || '/Applications/Cursor.app/Contents/Resources/app';
const base = resources + '/node_modules/';
const tm = require(base + 'vscode-textmate');
const onig = require(base + 'vscode-oniguruma');
(async () => {
 await onig.loadWASM(fs.readFileSync(base+'vscode-oniguruma/release/onig.wasm').buffer);
 const registry = new tm.Registry({onigLib:Promise.resolve({createOnigScanner:p=>new onig.OnigScanner(p),createOnigString:s=>new onig.OnigString(s)}),loadGrammar:async()=>JSON.parse(fs.readFileSync('editors/vscode/syntaxes/can.tmLanguage.json','utf8'))});
 const grammar = await registry.loadGrammar('source.can');
 const scopes=(line,word,offset=0)=>{const state=/^ *page \//.test(line)?grammar.tokenizeLine('Then',tm.INITIAL).ruleStack:tm.INITIAL;const result=grammar.tokenizeLine(line,state);const i=line.indexOf(word,offset);assert(i>=0);return result.tokens.find(t=>t.startIndex<=i&&t.endIndex>i).scopes;};
 const has=(line,word,scope,offset=0)=>assert(scopes(line,word,offset).includes(scope),`${line}: ${word}: ${scopes(line,word,offset)}`);
 const lacks=(line,word,part,offset=0)=>assert(!scopes(line,word,offset).some(s=>s.includes(part)),`${line}: ${word}: ${scopes(line,word,offset)}`);
 has(' ## ignored # "text"','ignored','comment.line.number-sign.can');
 has(' # Written description. @{nl="Beschrijving"}','Written','string.unquoted.description.can');
 has(' #= labels.title','labels','entity.name.constant.message.can');
 has(' title "# inside"','#','string.quoted.double.can');
 has(' title "escaped \\" quote"','\\"','constant.character.escape.can');
 lacks(' title value # inline','inline','comment');
 lacks(' // obsolete comment','obsolete','comment');
 lacks(' /* obsolete */','obsolete','comment');
 lacks(" title 'old string'",'old','string');
 has(' event {true:bool=false,not:text,where:enum(true,not,select)}','event','entity.name.type.can');
 has(' event Updated {id:text}','event','keyword.declaration.can');
 has(' scenario true(not:text) by=members','true','entity.name.function.can');
 has(' scenario true(not:text) by=members','not','variable.parameter.can');
 has(' Todo {true:bool=false}','true','variable.other.property.declaration.can');
 has(' Todo {true:bool=false}','bool','support.type.primitive.can');
 has(' Todo {true:bool=false}','false','constant.language.literal.can');
 has(' Todo {state:enum(true,not,select)}','true','variable.other.constant.enum.can');
 has(' do set row {true=false,not=true}','true','variable.other.property.key.can');
 has(' do return row.true?.not','true','variable.other.property.can');
 has(' do return row.true?.not','not','variable.other.property.can');
 has(' do return not row.done and row.active','not','keyword.operator.word.can');
 has(' do return not row.done and row.active','and','keyword.operator.word.can');
 has(' do let selected=Todo as order where order.done select order.title','order','variable.other.readwrite.binding.can');
 has(' do return where','where','variable.other.readwrite.can');
 has(' page /work/{Todo.id} title="Work" poll=5s refresh=refresh','/work/{Todo.id}','string.unquoted.route.can');
 has(' form Todo.create import=csv review=inspect','import','variable.other.property.key.can');
 has(' table Todo order={by=preferences.view,default=[due],cases={all=[-created]}}','default','variable.other.property.key.can');
 has(' do send remote.perform {text="Hi"} as result; return result','send','keyword.control.effect.can');
 has(' do send remote.perform {text="Hi"} as result; return result','return','keyword.control.effect.can');
 has(' rename before.Todo.label to Todo.title','rename','keyword.control.can');
 lacks(' do return 5minutes','5','constant.numeric');
 has('   members,true,1 -> true,"1 task"','true','constant.language.literal.can',20);
 has(' do return 10MiB','10MiB','constant.numeric.unit.can');

 // Grammar families absent or sparse in the current corpus: focused in-memory fragments.
 const tokenLines=lines=>{let stack=tm.INITIAL;return lines.map(line=>{const out=grammar.tokenizeLine(line,stack);stack=out.ruleStack;return out.tokens.map(t=>({text:line.slice(t.startIndex,t.endIndex),start:t.startIndex,end:t.endIndex,scopes:t.scopes}));});};
 const hasIn=(lines,index,word,scope)=>{const i=lines[index].indexOf(word);assert(i>=0);const t=tokenLines(lines)[index].find(t=>t.start<=i&&t.end>i);assert(t.scopes.includes(scope),JSON.stringify({line:lines[index],word,scope,actual:t.scopes}));};
 has(' use syntax {not,true,null,event as false,as}', 'not', 'variable.other.readwrite.import.can');
 has(' use syntax {not,true,null,event as false,as}', 'true', 'variable.other.readwrite.import.can');
 has(' use syntax {not,true,null,event as false,as}', 'false', 'variable.other.readwrite.import.can');
 has(' use syntax {not,true,null,event as false,as}', 'as', 'keyword.control.import.can');
 has(' invariant WeeklyHours: row.opens<row.closes','row','variable.other.readwrite.can');
 has(' invariant WeeklyHours: row.opens<row.closes','opens','variable.other.property.can');
 has(' do let answer=custom(1)','answer','variable.other.readwrite.binding.can');
 has(' Todo {title:text trim unique max=200}','trim','storage.modifier.field.can');
 has(' Todo {title:text trim unique max=200}','unique','storage.modifier.field.can');
 has(' Todo {title:text=unique}','unique','variable.other.readwrite.can');
 has(' Child in Parent {title:text}','in','keyword.control.ownership.can');
 has(' Child in app {title:text}','app','entity.name.type.can');
 has(' scenario report(currency:currency) -> Summary[]? by=members','Summary','entity.name.type.can');
 has(' derive unique(not:text):text = trim(not)','not','variable.parameter.can');
 has(' table Todo archived=include as item','archived','keyword.control.query.can');
 has(' table Todo archived=include as item','include','keyword.control.query.can');
 has(' do return archived','archived','variable.other.readwrite.can');
 has(' page /customers/{Customer.id} title="Customer"','Customer','entity.name.type.can');
 has(' page /reports/{year:int} title="Report"','year','variable.other.readwrite.route.can');
 has(' page /reports/{year:int} title="Report"','int','support.type.primitive.can');
 has(' page /reports/{view:enum(all,open)} title="Report"','view','variable.other.readwrite.route.can');
 has(' binding Rooms DurableObject key=Calendar','DurableObject','storage.type.resource.can');
 has(' queue Jobs type=Work[]','Work','entity.name.type.can');
 has(' cache KV ttl=5m','KV','storage.type.resource.can');
 has(' analytics Visits {path:text}','Visits','entity.name.type.can');
 has(' files types="image/*" max=20MiB','20MiB','constant.numeric.unit.can');
 has(' locale default="nl"','default','variable.other.property.key.can');
 has(' theme mode=system accent=blue density=compact','theme','keyword.control.can');
 has(' rename owner','owner','keyword.control.ownership.can');
 has(' rename before.Todo.label to Todo.title','to','keyword.control.migration.can');
 has(' drop owner','owner','keyword.control.ownership.can');
 has(' invalidate before.handler','invalidate','keyword.control.can');
 has(' backfill Todo','backfill','keyword.control.can');
 has(' migration Tasks from="snapshot"','migration','keyword.declaration.can');
 has(' create Todo {title="New"} as result','Todo','entity.name.type.can');
 has(' emit Completed {record=row}','Completed','entity.name.type.can');
 has(' do schedule record.id at=now+5m event=Due {record}','at','variable.other.property.key.can');
 has(' examples create seed=[item]','examples','keyword.control.structure.can');
 has(' title "\\u0041\\t\\n\\r\\b\\f\\/\\\\\\\""','\\u0041','constant.character.escape.can');
 has(' message greeting = "Hi"@{"pt-BR"="Olá",nl=null}','nl','entity.other.attribute-name.locale.can');
 has(' message greeting = "Hi"@{"pt-BR"="Olá",nl=null}','pt-BR','entity.other.attribute-name.locale.can');
 for(const [line,word] of [
  [' preferences {view:enum(all,open)}','preferences'],[' role staff','role'],[' policy Todo read=members fields=title','policy'],[' unique Todo fields=title','unique'],[' lock Todo fields=title','lock'],[' retain Todo until=row.created+1d','retain'],
  [' crud Todo by=members fields=title create_fields=title create=none update=none delete=remove','crud'],[' if value is Shape','if'],[' else','else'],[' for item in Todo limit=10','for'],
  [' card "Title" layout=columns','card'],[' details "Title" display=drawer','details'],[' tabs preferences.view','tabs'],[' tab "Open"','tab'],[' list Todo order=-created search=title filter=done empty="None" defaults={done=false} display=split','list'],
  [' table Todo columns=title order={by=preferences.view,default=[title],cases={open=[-created]}}','table'],[' board Todo by=state columns=title','board'],[' calendar Todo start=from end=until','calendar'],[' form Todo.create arguments={parent=row} fields=title submit="Save" display=inline import=csv review=review','form'],
  [' title "Heading"','title'],[' text row.title,row.done','text'],[' content row.body','content'],[' metrics result.count,result.total','metrics'],[' copy app_url("/")','copy'],[' edit fields=title','edit'],[' delete','delete'],[' action finish','action'],[' actions finish,cancel','actions'],[' history','history']
 ]) {
  const ui=new Set(['card','details','tabs','tab','list','table','board','calendar','form','title','text','content','metrics','copy','edit','delete','action','actions','history']);
  if(ui.has(word)) hasIn(['Then',' page /audit title="Audit"','  '+line.trim()],2,word,'entity.name.tag.component.can');
  else has(line,word,['preferences','role'].includes(word)?'keyword.declaration.can':'keyword.control.can');
 }
 const categoryBoundary=['When',' scenario remove(row:Item) by=members','  do delete row','Then',' page /items title="Items"','  require members','  delete','app Next','Given',' Thing {table:text,list:text,action:action(remove)}'];
 hasIn(categoryBoundary,2,'delete','keyword.control.effect.can');hasIn(categoryBoundary,4,'page','entity.name.tag.component.page.can');hasIn(categoryBoundary,5,'require','keyword.control.guard.can');hasIn(categoryBoundary,6,'delete','entity.name.tag.component.can');hasIn(categoryBoundary,7,'app','keyword.declaration.owner.can');hasIn(categoryBoundary,9,'Thing','entity.name.type.can');
 has(' do return table','table','variable.other.readwrite.can');has(' do return row.list','list','variable.other.property.can');has(' Model {table:text}','table','variable.other.property.declaration.can');has(' Model {value:action(remove)}','action','storage.type.can');has(' do return action(row)','action','entity.name.function.call.can');
 assert(!tokenLines(['When',' card caption'])[1].some(t=>t.scopes.includes('entity.name.tag.component.can')));

 const capability=[' export capability API version=1','  not(','   true:text,','   where:enum(true,not,select)','  ) -> Result[]?',' role next'];
 hasIn(capability,1,'not','entity.name.function.can');hasIn(capability,2,'true','variable.parameter.can');hasIn(capability,3,'true','variable.other.constant.enum.can');hasIn(capability,4,'Result','entity.name.type.can');hasIn(capability,5,'role','keyword.declaration.can');
 const continued=[' Todo {','  title:','   text','   trim label="Title",','  done:bool=false',' }'];
 hasIn(continued,2,'text','support.type.primitive.can');hasIn(continued,3,'trim','storage.modifier.field.can');hasIn(continued,3,'label','variable.other.property.key.can');
 const expressionOnly=[' do return Shape {','  value=context {title="Plain value"},','  true=false,','  not=not false',' }'];
 hasIn(expressionOnly,1,'context','entity.name.type.constructor.can');hasIn(expressionOnly,2,'true','variable.other.property.key.can');hasIn(expressionOnly,3,'not','variable.other.property.key.can');

 has(' export contract Result {value:text}', 'contract', 'keyword.declaration.can');
 has(' export contract Result {value:text}', 'Result', 'entity.name.type.can');
 for(const word of ['Given','When','Then']) { has(' '+word,word,'keyword.control.section.'+word.toLowerCase()+'.can'); has(' Model {'+word+':text}',word,'variable.other.property.declaration.can'); has(' do return row.'+word,word,'variable.other.property.can'); }
 const manifest=JSON.parse(fs.readFileSync('editors/vscode/package.json','utf8'));
 for(const key of ['main','browser','activationEvents','dependencies']) assert(!(key in manifest));
 assert.equal(manifest.contributes.configurationDefaults['[can]']['editor.tabSize'],1);
 has(' require can_work(actor,deal.location)', 'can_work', 'entity.name.function.call.can');
 has(' do call remote.perform {value=true}', 'perform', 'entity.name.function.reference.can');
 has(' do return custom.true(value)', 'true', 'entity.name.function.call.can');
 // Regression cases from the independent audit, placed in their source categories.
 const at=(src,index,word,scope,nth=0)=>{const lines=src.split('\n');let pos=-1;for(let n=0;n<=nth;n++){do{pos=lines[index].indexOf(word,pos+1);assert(pos>=0);}while(/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)&&(/[A-Za-z0-9_]/.test(lines[index][pos-1]||'')||/[A-Za-z0-9_]/.test(lines[index][pos+word.length]||'')));}assert(pos>=0);const token=tokenLines(lines)[index].find(t=>t.start<=pos&&t.end>pos);assert(token.scopes.includes(scope),JSON.stringify({line:lines[index],word,expected:scope,actual:token.scopes}));};
 const execution='Given\n context {theme:text}\nWhen\n scenario make() by=members\n  do\n   return {value=1}\n   for in in values limit=1\n    return in\nThen';
 at(execution,1,'context','entity.name.type.can');at(execution,5,'return','keyword.control.effect.can');at(execution,6,'for','keyword.control.can');at(execution,6,'in','variable.other.readwrite.binding.can');at(execution,6,'in','keyword.operator.word.can',1);
 const exampleTable='When\n crud Item by=members fields=title\n  examples create\n   title -> count(Item)\n   do -> return\n  examples update item=first\n   title -> item.title\n   "New" -> "New"\n  examples delete item=first\n   as -> count(Item)\n   [member] -> 0\nThen';
 at(exampleTable,2,'examples','keyword.control.structure.can');at(exampleTable,2,'create','keyword.control.example-action.can');at(exampleTable,3,'title','variable.other.readwrite.can');at(exampleTable,3,'->','keyword.operator.can');at(exampleTable,4,'do','variable.other.readwrite.can');at(exampleTable,5,'update','keyword.control.example-action.can');at(exampleTable,8,'delete','keyword.control.example-action.can');
 const query='Given\n derive rows():Item[]=(Item\n  as where\n  where where.active\n  order=-where.created\n  select select\n )\n derive usable():bool=value.return and true\n derive selected():json=value.select as row select row\n derive operands():bool=x * and or where';
 at(query,2,'as','keyword.control.query.can');at(query,2,'where','variable.other.readwrite.binding.can');at(query,3,'where','keyword.control.query.can');at(query,4,'order','keyword.control.query.can');at(query,5,'select','keyword.control.query.can');at(query,5,'select','variable.other.readwrite.can',1);at(query,7,'return','variable.other.property.can');at(query,7,'and','keyword.operator.word.can');at(query,8,'as','keyword.control.query.can');at(query,9,'and','variable.other.readwrite.can');at(query,9,'or','keyword.operator.word.can');
 const joinedTypes='Given\n Item {\n  value:\n   trim,\n  other:A\n   |unique,\n  choices:Choice\n   [ ]\n   ?,\n  option:enum(one,two)\n   []? unique,\n  caption:text="x" trim\n }\nWhen\n scenario run(\n  input:trim,\n  other:A |\n   unique\n ) by=members -> Choice\n  do return input\nThen';
 at(joinedTypes,3,'trim','entity.name.type.can');at(joinedTypes,5,'unique','entity.name.type.can');at(joinedTypes,7,'[','storage.modifier.type.can');at(joinedTypes,8,'?','storage.modifier.type.can');at(joinedTypes,10,'unique','storage.modifier.field.can');at(joinedTypes,11,'trim','storage.modifier.field.can');at(joinedTypes,15,'input','variable.parameter.can');at(joinedTypes,17,'unique','entity.name.type.can');at(joinedTypes,18,'Choice','entity.name.type.can');at(joinedTypes,19,'do','keyword.control.structure.can');
 const defaults='Given\n Item {\n  value:text=\n   unique trim,\n  other:text=trim unique,\n  bounded:text min=minimum trim\n }';
 at(defaults,3,'unique','variable.other.readwrite.can');at(defaults,3,'trim','storage.modifier.field.can');at(defaults,4,'trim','variable.other.readwrite.can');at(defaults,4,'unique','storage.modifier.field.can');at(defaults,5,'minimum','variable.other.readwrite.can');at(defaults,5,'trim','storage.modifier.field.can');
 const operationTargets='When\n scenario invoke(item:Item) by=members\n  do\n   call ((pkg.run)) {item}\n   send (\n    Remote.run\n   ) {item} as delivery\n   call choose_action(item) {item}\nThen\n page /items title="Items" poll=5s refresh=refresh\n  form Item.create import=csv review=preview\n  actions approve,Item.update';
 at(operationTargets,3,'run','entity.name.function.reference.can');at(operationTargets,3,'(','punctuation.section.group.begin.can');at(operationTargets,5,'run','entity.name.function.reference.can');at(operationTargets,6,'delivery','variable.other.readwrite.binding.can');at(operationTargets,7,'choose_action','entity.name.function.call.can');at(operationTargets,7,'item','variable.other.readwrite.can');at(operationTargets,9,'refresh','entity.name.function.reference.can',1);at(operationTargets,10,'preview','entity.name.function.reference.can');at(operationTargets,11,'approve','entity.name.function.reference.can');at(operationTargets,11,'update','entity.name.function.reference.can');
 const selectors='Given\n policy Item read=members fields=not,true,false,null\nWhen\n crud Item by=members fields=not,true,false,null\nThen\n page /items title="Items"\n  table Item columns=not,true,false,null order=-created\n   edit fields=not,true,false,null\n  form Item.create fields=not,true,false,null';
 for(const line of [1,3,6,7,8]) for(const word of ['not','true','false','null']) at(selectors,line,word,'variable.other.property.selector.can');at(selectors,6,'created','variable.other.property.selector.can');
 const preferenceOrder='Then\n page /items title="Items"\n  table Item order={by=preferences.view,default=[-created],cases={open=[title]}} columns=title\n  table (Item as item order=-item.created) columns=title';
 at(preferenceOrder,2,'by','variable.other.property.key.can');at(preferenceOrder,2,'default','variable.other.property.key.can');at(preferenceOrder,2,'created','variable.other.property.selector.can');at(preferenceOrder,2,'title','variable.other.property.selector.can');at(preferenceOrder,3,'order','keyword.control.query.can');
 const shorthand='Given\n derive make(name:text):Item=Item {\n  name,\n  title=\n   name,\n  last\n }\nThen\n page /kinds/{kind:enum(one,two)} title="Kinds"\n page /acts/{target:action(pkg.first,pkg.second)} title="Actions"';
 at(shorthand,2,'name','variable.other.property.key.can');at(shorthand,4,'name','variable.other.readwrite.can');at(shorthand,5,'last','variable.other.property.key.can');at(shorthand,8,'enum','storage.type.can');at(shorthand,8,'one','variable.other.constant.enum.can');at(shorthand,9,'first','entity.name.function.reference.can');
 const maintenance='migration Rename from="old"\n rename before.Task to Work\n rename before.Task.title to Work.name\n drop before.Task.old\n invalidate before.refresh\n backfill Work\n  require before.title!=null\n  do set row {name=before.title}';
 at(maintenance,1,'Task','entity.name.type.can');at(maintenance,1,'Work','entity.name.type.can');at(maintenance,2,'title','variable.other.property.can');at(maintenance,2,'Work','entity.name.type.can');at(maintenance,2,'name','variable.other.property.can');at(maintenance,3,'old','variable.other.property.can');at(maintenance,4,'refresh','entity.name.function.reference.can');at(maintenance,5,'Work','entity.name.type.can');
 const callable='Given\n message greeting(name:text)="Hi {name}"@{}\n capability Remote version=1\n  load(id:text)->Item; save(item:Item)->bool\nWhen\n export scenario work(\n  input:Item\n ) by=members -> Item\n  do return input\nThen';
 at(callable,1,'greeting','entity.name.function.message.can');at(callable,3,'save','entity.name.function.can');at(callable,6,'input','variable.parameter.can');at(callable,8,'do','keyword.control.structure.can');
 const ownedNames=['app','package','event','contract','role','capability'];
 for(const name of ownedNames) {const owned='app Models\nGiven\n '+name+' in app {title:text}\nWhen\nThen';at(owned,2,name,'entity.name.type.can');at(owned,2,'in','keyword.control.ownership.can');}
 at('Given\n event in {title:text}\nWhen\nThen',1,'event','keyword.declaration.can');
 const inlineGuard='When\n scenario run(item:Item) by=members\n  do require item.ready\nThen';at(inlineGuard,2,'require','keyword.control.structure.can');
 const formJoined='Then\n page /items title="Items"\n  form (\n   pkg.run\n  ) fields=title review=preview\n  actions ((pkg.run)),choose_action(row)';
 at(formJoined,3,'run','entity.name.function.reference.can');at(formJoined,4,'title','variable.other.property.selector.can');at(formJoined,4,'preview','entity.name.function.reference.can');at(formJoined,5,'run','entity.name.function.reference.can');at(formJoined,5,'row','variable.other.readwrite.can');
 const qualifiedRename='migration pkg from="old"\n rename before.Task.title to pkg.Work.name\n rename before.Task to pkg.Work';
 at(qualifiedRename,1,'pkg','variable.other.readwrite.namespace.can');at(qualifiedRename,1,'Work','entity.name.type.can');at(qualifiedRename,1,'name','variable.other.property.can');at(qualifiedRename,2,'Work','entity.name.type.can');
 const exampleBindings='When\n scenario joined(select:text) by=members\n  do return select\n  examples seed=[\n   first,second\n  ] not="x" select="y" order="z" archived=include\n   select -> select\n   "x" -> "x"\nThen';
 for(const name of ['not','select','order','archived']) at(exampleBindings,5,name,'variable.other.property.key.can');
 const invariantScopes='app Constraints\nGiven\n require {invariant:text,require:text}\n invariant {require:text}\n invariant require: row.invariant!=null; invariant invariant: row.require!=null\n preferences {require:bool,invariant:bool}\n invariant preferences: row.require or row.invariant\nWhen\n scenario check(require:text,invariant:text) by=members\n  require invariant!=null\n  do return require\nThen\n page /constraints title="require invariant"\n  require members\nmigration Constraints from="old"\n backfill require\n  require before.invariant!=null\n  do return row';
 at(invariantScopes,2,'require','entity.name.type.can');at(invariantScopes,2,'invariant','variable.other.property.declaration.can');at(invariantScopes,3,'invariant','entity.name.type.can');
 at(invariantScopes,4,'invariant','keyword.declaration.invariant.can');at(invariantScopes,4,'require','entity.name.type.can');at(invariantScopes,4,'invariant','keyword.declaration.invariant.can',2);at(invariantScopes,6,'invariant','keyword.declaration.invariant.can');
 at(invariantScopes,8,'require','variable.parameter.can');at(invariantScopes,8,'invariant','variable.parameter.can');at(invariantScopes,9,'require','keyword.control.structure.can');at(invariantScopes,9,'invariant','variable.other.readwrite.can');at(invariantScopes,10,'require','variable.other.readwrite.can');at(invariantScopes,13,'require','keyword.control.guard.can');at(invariantScopes,16,'require','keyword.control.structure.can');
 const oldInvariant=tokenLines(['Given',' require Item: row.valid','When'])[1];assert(!oldInvariant.filter(t=>t.text.trim()==='require').some(t=>t.scopes.some(s=>s.startsWith('keyword.'))),'old Given require no longer introduces a declaration');
 console.log('Audit regression probes passed for F1–F8/F10, callable messages and capability semicolons.');
 // Check rendered token foregrounds with the existing Cursor theme and Antigravity default.
 const palette=JSON.parse(fs.readFileSync('editors/vscode/token-colors.json','utf8')).textMateRules;
 const jsonc=require('/Applications/Cursor.app/Contents/Resources/app/node_modules/jsonc-parser');
 const themeRules=file=>{const data=jsonc.parse(fs.readFileSync(file,'utf8'));return [...(data.include?themeRules(path.resolve(path.dirname(file),data.include)):[]),...(data.tokenColors||[])];};
 for(const [editor,themeFile] of [
  ['Cursor','/Applications/Cursor.app/Contents/Resources/app/extensions/theme-cursor/themes/cursor-dark-hc-color-theme.json'],
  ['Antigravity IDE','/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/theme-defaults/themes/dark_modern.json']
 ]) {
  const settings=JSON.parse(fs.readFileSync('/Users/vince/Library/Application Support/'+editor+'/User/settings.json','utf8'));
  const custom=settings['editor.tokenColorCustomizations'].textMateRules;
  assert.deepEqual(custom.filter(r=>r.name?.startsWith('Canlang ')),palette,editor+' installed palette differs');
  registry.setTheme({settings:[...themeRules(themeFile),...custom]});
  const foreground=(line,word,state=/^ *page \//.test(line)?grammar.tokenizeLine('Then',tm.INITIAL).ruleStack:tm.INITIAL)=>{const pos=line.indexOf(word),tokens=grammar.tokenizeLine2(line,state).tokens,colors=registry.getColorMap();for(let i=0;i<tokens.length;i+=2)if(tokens[i]<=pos&&(i+2===tokens.length||tokens[i+2]>pos))return colors[(tokens[i+1]>>>15)&511];throw new Error('Missing token '+word);};
  const fontStyle=(line,word,state=/^ *page \//.test(line)?grammar.tokenizeLine('Then',tm.INITIAL).ruleStack:tm.INITIAL)=>{const pos=line.indexOf(word),tokens=grammar.tokenizeLine2(line,state).tokens;for(let i=0;i<tokens.length;i+=2)if(tokens[i]<=pos&&(i+2===tokens.length||tokens[i+2]>pos))return (tokens[i+1]>>>11)&15;throw new Error('Missing token '+word);};
  // The same translation suffix has the same scopes/colors after literal prose and STRING.
  const suffix='@{nl="Translation","pt-BR"="Equipe",fr=null}';
  const paired=[' # Raw "quotes" stay prose '+suffix,' title "Label"'+suffix];
  for(const line of paired) {
   for(const key of ['nl','pt-BR','fr']) {has(line,key,'entity.other.attribute-name.locale.can');assert.equal(foreground(line,key),'#9CDCFE',editor+' locale key '+key);}
   for(const punctuation of ['@{',',','}','=']) assert.equal(foreground(line,punctuation),'#D6D6DD',editor+' translation punctuation '+punctuation);
   has(line,'Translation','string.quoted.double.can');has(line,'Equipe','string.quoted.double.can');
  }
  assert.equal(foreground(paired[0],'Translation'),foreground(paired[1],'Translation'),editor+' translated string');
  has(paired[0],'quotes','string.unquoted.description.can');lacks(paired[0],'quotes','string.quoted.double');
  has(' # Escaped \\@{literal} and "raw" quotes','literal','string.unquoted.description.can');
  has(' #= labels.summary','labels','entity.name.constant.message.can');
  hasIn([paired[0],' role next'],1,'role','keyword.declaration.can');
  const describedField=[' Model {',paired[0].replace(' #','  #'),'  title:text label="Title"'+suffix+',','  done:bool=false',' }'];
  hasIn(describedField,2,'text','support.type.primitive.can');hasIn(describedField,3,'done','variable.other.property.declaration.can');
  for(const section of ['Given','When','Then']) {assert.equal(foreground(' '+section,section),'#FFFFFF',editor+' '+section);assert.equal(fontStyle(' '+section,section),3,editor+' bold italic '+section);}
  for(const [line,word] of [[' use Sales {Invoice}','use'],[' role member','role'],[' event Paid {amount:int}','event'],[' export contract Result {value:text}','export'],[' policy Invoice read=members','policy'],[' do return value','return']]) assert.equal(foreground(line,word),'#C586C0',editor+' keyword '+word);
  for(const [line,word] of [['app Shop','app'],['package Sales','package'],['scenario run() by=members','scenario'],[' do return value','do'],[' require members','require'],[' examples create','examples'],[' page /items title="Items"','page']]) {assert.equal(foreground(line,word),'#FFFFFF',editor+' white structural keyword '+word);assert.equal(fontStyle(line,word),2,editor+' bold-only structural keyword '+word);}
  const givenState=grammar.tokenizeLine('Given',tm.INITIAL).ruleStack;
  assert.equal(foreground(' invariant Item: row.valid','invariant',givenState),'#C586C0',editor+' regular invariant keyword');
  assert.equal(fontStyle(' invariant Item: row.valid','invariant',givenState),0,editor+' plain invariant keyword');
  assert.equal(foreground(' invariant {require:text}','invariant',givenState),'#4EC9B0',editor+' contextual invariant model');
  assert.equal(foreground(' Item {invariant:text}','invariant',givenState),'#9CDCFE',editor+' contextual invariant field');
  const mapperState=grammar.tokenizeLine(' backfill Item',grammar.tokenizeLine('migration Move from="old"',tm.INITIAL).ruleStack).ruleStack;
  assert.equal(foreground('  require before.valid','require',mapperState),'#FFFFFF',editor+' backfill require');
  assert.equal(fontStyle('  require before.valid','require',mapperState),2,editor+' bold-only backfill require');
  const uiLine='  card "Heading"';const uiState=grammar.tokenizeLine(' page /items title="Items"',grammar.tokenizeLine('Then',tm.INITIAL).ruleStack).ruleStack;
  assert.equal(foreground(uiLine,'card',uiState),'#569CD6',editor+' frontend component');
  assert.equal(foreground('  require members','require',uiState),'#FFFFFF',editor+' presentation guard');
  assert.equal(fontStyle('  require members','require',uiState),2,editor+' bold-only presentation guard');
  assert.equal(foreground(' do require item.ready','require'),'#FFFFFF',editor+' inline guard');
  assert.equal(fontStyle(' do require item.ready','require'),2,editor+' bold-only inline guard');
  assert.equal(fontStyle(' Model {Given:text}','Given'),0,editor+' authored Given field stays plain');
  assert.equal(foreground('app Shop','Shop'),'#9CDCFE',editor+' owner identity');
  assert.equal(foreground(' do return row.package','package'),'#9CDCFE',editor+' ordinary member');
  for(const [line,word,color] of [
   [' contract Result {value:text}','Result','#4EC9B0'],[' contract Result {value:text}','text','#4EC9B0'],
   [' require can_work(actor,deal.location)','can_work','#DCDCAA'],[' require can_work(actor,deal.location)','actor','#9CDCFE'],[' require can_work(actor,deal.location)','location','#9CDCFE'],
   [' Model {Given:text}','Given','#9CDCFE'],[' do return row.When','When','#9CDCFE'],[' do return true','true','#B5CEA8']
  ]) assert.equal(foreground(line,word),color,editor+' '+word);
 }
 console.log('Verified bold italic white section markers, bold-only white structural words and conventional palette against both IDE settings/themes.');
 const collect=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?collect(dir+'/'+x.name):x.name.endsWith('.can')?[dir+'/'+x.name]:[]);
 const files=['draft','examples'].flatMap(collect);
 let lines=0;
 for(const file of files){let stack=tm.INITIAL;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const result=grammar.tokenizeLine(line,stack);assert(!result.stoppedEarly,file+' tokenizer stopped early');stack=result.ruleStack;lines++;}stack=grammar.tokenizeLine('app __HighlightingBoundary',stack).ruleStack;assert.equal(stack.depth,1,file+' leaked a multiline scope after section boundary');}
 console.log(`Focused token checks passed; tokenized ${files.length} current draft/example files (${lines} lines).`);
})().catch(e=>{console.error(e);process.exit(1)});
