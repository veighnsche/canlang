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
 const scopes=(line,word,offset=0)=>{const result=grammar.tokenizeLine(line,tm.INITIAL);const i=line.indexOf(word,offset);assert(i>=0);return result.tokens.find(t=>t.startIndex<=i&&t.endIndex>i).scopes;};
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
 has(' scenario true(not:text) by=members','not','variable.other.property.declaration.can');
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
 has(' require WeeklyHours: row.opens<row.closes','row','variable.other.readwrite.can');
 has(' require WeeklyHours: row.opens<row.closes','opens','variable.other.property.can');
 has(' do let answer=custom(1)','answer','variable.other.readwrite.binding.can');
 has(' Todo {title:text trim unique max=200}','trim','storage.modifier.field.can');
 has(' Todo {title:text trim unique max=200}','unique','storage.modifier.field.can');
 has(' Todo {title:text=unique}','unique','variable.other.readwrite.can');
 has(' Child in Parent {title:text}','in','keyword.control.ownership.can');
 has(' Child in app {title:text}','app','entity.name.type.can');
 has(' scenario report(currency:currency) -> Summary[]? by=members','Summary','entity.name.type.can');
 has(' derive unique(not:text):text = trim(not)','not','variable.other.property.declaration.can');
 has(' table Todo archived=include as item','archived','keyword.control.query.can');
 has(' table Todo archived=include as item','include','keyword.control.query.can');
 has(' do return archived','archived','variable.other.readwrite.can');
 has(' page /customers/{Customer.id} title="Customer"','Customer','entity.name.type.can');
 has(' page /reports/{year:int} title="Report"','year','variable.other.readwrite.route.can');
 has(' page /reports/{year:int} title="Report"','int','entity.name.type.can');
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
 has(' examples create seed=[item]','examples','keyword.control.can');
 has(' title "\\u0041\\t\\n\\r\\b\\f\\/\\\\\\\""','\\u0041','constant.character.escape.can');
 has(' message greeting = "Hi"@{"pt-BR"="Olá",nl=null}','nl','entity.other.attribute-name.locale.can');
 for(const [line,word] of [
  [' preferences {view:enum(all,open)}','preferences'],[' role staff','role'],[' policy Todo read=members fields=title','policy'],[' unique Todo fields=title','unique'],[' lock Todo fields=title','lock'],[' retain Todo until=row.created+1d','retain'],
  [' crud Todo by=members fields=title create_fields=title create=none update=none delete=remove','crud'],[' if value is Shape','if'],[' else','else'],[' for item in Todo limit=10','for'],
  [' card "Title" layout=columns','card'],[' details "Title" display=drawer','details'],[' tabs preferences.view','tabs'],[' tab "Open"','tab'],[' list Todo order=-created search=title filter=done empty="None" defaults={done=false} display=split','list'],
  [' table Todo columns=title order={by=preferences.view,default=[title],cases={open=[-created]}}','table'],[' board Todo by=state columns=title','board'],[' calendar Todo start=from end=until','calendar'],[' form Todo.create arguments={parent=row} fields=title submit="Save" display=inline import=csv review=review','form'],
  [' title "Heading"','title'],[' text row.title,row.done','text'],[' content row.body','content'],[' metrics result.count,result.total','metrics'],[' copy app_url("/")','copy'],[' edit fields=title','edit'],[' delete','delete'],[' action finish','action'],[' actions finish,cancel','actions'],[' history','history']
 ]) has(line,word,['preferences','role'].includes(word)?'keyword.declaration.can':'keyword.control.can');
 const capability=[' export capability API version=1','  not(','   true:text,','   where:enum(true,not,select)','  ) -> Result[]?',' role next'];
 hasIn(capability,1,'not','entity.name.function.can');hasIn(capability,2,'true','variable.other.property.declaration.can');hasIn(capability,3,'true','variable.other.constant.enum.can');hasIn(capability,4,'Result','entity.name.type.can');hasIn(capability,5,'role','keyword.declaration.can');
 const continued=[' Todo {','  title:','   text','   trim label="Title",','  done:bool=false',' }'];
 hasIn(continued,2,'text','support.type.primitive.can');hasIn(continued,3,'trim','storage.modifier.field.can');hasIn(continued,3,'label','variable.other.property.key.can');
 const expressionOnly=[' do return Shape {','  value=context {title="Plain value"},','  true=false,','  not=not false',' }'];
 hasIn(expressionOnly,1,'context','variable.other.readwrite.can');hasIn(expressionOnly,2,'true','variable.other.property.key.can');hasIn(expressionOnly,3,'not','variable.other.property.key.can');

 has(' export contract Result {value:text}', 'contract', 'keyword.declaration.can');
 has(' export contract Result {value:text}', 'Result', 'entity.name.type.can');
 for(const word of ['Given','When','Then']) { has(' '+word,word,'keyword.control.section.'+word.toLowerCase()+'.can'); has(' Model {'+word+':text}',word,'variable.other.property.declaration.can'); has(' do return row.'+word,word,'variable.other.property.can'); }
 const manifest=JSON.parse(fs.readFileSync('editors/vscode/package.json','utf8'));
 for(const key of ['main','browser','activationEvents','dependencies']) assert(!(key in manifest));
 assert.equal(manifest.contributes.configurationDefaults['[can]']['editor.tabSize'],1);
 has(' require can_work(actor,deal.location)', 'can_work', 'entity.name.function.call.can');
 has(' do call remote.perform {value=true}', 'perform', 'variable.other.property.can');
 has(' do return custom.true(value)', 'true', 'entity.name.function.call.can');
 const collect=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?collect(dir+'/'+x.name):x.name.endsWith('.can')?[dir+'/'+x.name]:[]);
 const files=['draft','examples'].flatMap(collect);
 let lines=0;
 for(const file of files){let stack=tm.INITIAL;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const result=grammar.tokenizeLine(line,stack);stack=result.ruleStack;lines++;}assert.equal(stack.depth,1,file+' leaked a multiline scope');}
 console.log(`Focused token checks passed; tokenized ${files.length} current draft/example files (${lines} lines).`);
})().catch(e=>{console.error(e);process.exit(1)});
