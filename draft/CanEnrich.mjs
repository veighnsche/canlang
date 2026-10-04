import {choose, count, create, delivery, emit, equalValue, first, hasRole, int64, local_date, records, require as check, same, send, set, subtractDuration, compareInstant, any} from "@canlang/stdlib";
import {actions, details, edit, form, history, message, renderPage, table, text, breadcrumbs, preferences, toggle, input, pagination, checkbox, button, modal, diff, divider, radio, textarea, select} from "@canlang/ui";
// Desired lowering: breadcrumbs, preferences, toggle, input, pagination,
// checkbox, button, modal, diff, divider, radio, textarea and select are proposed
// @canlang/ui contracts (desired/unimplemented). modal uses caption.
import {Customer} from "./customer.mjs";

// Handwritten desired output. Proposed imports implement DESIGN §13 contracts later.
// Binding adapters own decoding/transport. App functions own consent and fact review.
export const Company="enrich.Company", AcceptedFact="enrich.AcceptedFact", SourcesV1="enrich.SourcesV1", Fact="enrich.Fact";
export const current=(c,company,field)=>first(records(c,AcceptedFact,{parent:company,where:fact=>fact.field===field,order:{by:fact=>fact.ordinal,direction:"desc"}}));
const page={owner:"enrich",path:"/enrichment",poll:5000n,title:message("Company enrichment",{nl:"Bedrijfsverrijking"}),description:message("Compare evidence, usage and prior decisions before accepting individual facts.",{nl:"Vergelijk bewijs, gebruik en eerdere beslissingen voordat u afzonderlijke gegevens accepteert."}),admit:async c=>{check(hasRole(c,"enrich.researcher")||hasRole(c,"enrich.reviewer"),"forbidden");return {};},render:enrichmentPage};
export const appDefinition={
 id:"CanEnrich",uses:["enrich"],description:message("Enrich known companies with reviewed registry facts and retained source evidence.",{nl:"Verrijk bekende bedrijven met beoordeelde registergegevens en bewaard bronbewijs."}),
 packages:{enrich:{label:message("Company enrichment",{nl:"Bedrijfsverrijking"}),roles:{researcher:{id:"enrich.researcher",label:message("Company researcher",{nl:"Bedrijfsonderzoeker"})},reviewer:{id:"enrich.reviewer",label:message("Fact reviewer",{nl:"Gegevensbeoordelaar"})}}}},
 bindings:{"enrich.Sources":{capability:SourcesV1,from:"deployment.company_sources"}},
 contracts:{
  [Fact]:{exported:true,fields:{value:{type:"text",trim:true,min:1n,max:2000n},source:{type:"url"},observed:{type:"datetime",nullable:true},detail:{type:"text",nullable:true,max:2000n}}},
  "enrich.Report":{fields:{number:{type:"text",min:8n,max:8n},provider:{type:"enum",cases:["registry","aggregator"]},complete:{type:"bool"},legal_name:{type:"enrich.Fact",nullable:true},registered_office:{type:"enrich.Fact",nullable:true},registry_status:{type:"enrich.Fact",nullable:true},detail:{type:"text",nullable:true,max:2000n}}},
 },
 capabilities:{[SourcesV1]:{exported:true,version:1n,operations:{lookup:{inputs:{number:{type:"enrich.Report.number"},provider:{type:"enrich.Report.provider"}},result:{type:"enrich.Report"}}}}},
 models:{
  [Company]:{exported:true,label:message("Linked legal company",{nl:"Gekoppelde rechtspersoon"}),fields:{customer:{type:Customer},number:{type:"enrich.Report.number"},enabled:{type:"bool",default:true},current:{type:"enrich.Run",nullable:true,default:null}},unique:[{fields:["customer","number"]}],readGrants:[{rule:"Company.read.1"}],invariants:["Company.invariant.1"],locks:["Company.lock.1"]},
  "enrich.Lookup":{parent:Company,label:message("Provider evidence",{nl:"Extern bronbewijs"}),fields:{provider:{type:"enrich.Report.provider"},request:{type:"delivery",operation:"enrich.Sources.lookup",nullable:true,default:null}},readGrants:[{rule:"Lookup.read.1"}],locks:["Lookup.lock.1"]},
  "enrich.Run":{parent:Company,label:message("Enrichment review",{nl:"Verrijkingsbeoordeling"}),fields:{requested_by:{type:"user",server:"actor"},primary:{type:"enrich.Lookup",nullable:true,default:null},fallback:{type:"enrich.Lookup",nullable:true,default:null},allow_fallback:{type:"bool"},stopped:{type:"bool",default:false}},readGrants:[{rule:"Run.read.1"}],invariants:["Run.invariant.1"],locks:["Run.lock.1","Run.lock.2"]},
  [AcceptedFact]:{exported:true,parent:Company,label:message("Accepted company fact",{nl:"Geaccepteerd bedrijfsgegeven"}),fields:{field:{type:"enum",cases:["legal_name","registered_office","registry_status"]},ordinal:{type:"int",min:1n},lookup:{type:"enrich.Lookup"},value:{type:"enrich.Fact"},prior:{type:AcceptedFact,nullable:true,default:null},reason:{type:"text",trim:true,min:1n,max:2000n},reviewer:{type:"user",server:"actor"}},unique:[{fields:["field","ordinal"]}],readGrants:[{rule:"AcceptedFact.read.1"}],invariants:["AcceptedFact.invariant.1"],locks:["AcceptedFact.lock.1"]},
 },
 events:{"enrich.Assess":{fields:{run:{type:"enrich.Run"}}}},preferences:{enrich:{fields:{enabled:{type:"bool",default:true}}}},
 pure:{
  "enrich.report":{handler:"report",inputs:{lookup:{type:"enrich.Lookup"}},result:{type:"enrich.Report",nullable:true}},
  "enrich.reusable":{handler:"reusable",inputs:{company:{type:Company},provider:{type:"enrich.Report.provider"}},result:{type:"enrich.Lookup",nullable:true}},
  "enrich.capacity":{handler:"capacity",inputs:{company:{type:Company}},result:{type:"bool"}},
  "enrich.live":{handler:"live",inputs:{run:{type:"enrich.Run"}},result:{type:"bool"}},
  "enrich.incomplete":{handler:"incomplete",inputs:{value:{type:"enrich.Report"}},result:{type:"bool"}},
  "enrich.selected":{handler:"selected",inputs:{value:{type:"enrich.Report"},field:{type:"enrich.AcceptedFact.field"}},result:{type:"enrich.Fact",nullable:true}},
  "enrich.current":{exported:true,handler:"current",inputs:{company:{type:Company},field:{type:"enrich.AcceptedFact.field"}},result:{type:"enrich.AcceptedFact",nullable:true}},
 },
 operations:{
  "enrich.Company.create":{handler:"createCompany",kind:"create",model:Company,by:"enrich.researcher",when:"Company",read:false,inputs:{fields:["customer","number"]}},
  "enrich.Company.update":{handler:"updateCompany",kind:"update",model:Company,by:"enrich.researcher",when:"Company",read:false,inputs:{record:{type:Company},changes:{fields:["enabled"]}}},
  "enrich.start":{handler:"start",result:{type:"enrich.Run"},by:"enrich.researcher",read:false,inputs:{company:{type:Company},refresh:{type:"bool",default:false},fallback:{type:"bool",default:true}},label:message("Research company",{nl:"Bedrijf onderzoeken"}),description:message("Reuse a successful result or explicitly authorize a fresh paid lookup.",{nl:"Hergebruik een geslaagd resultaat of machtig expliciet een nieuwe betaalde raadpleging."})},
  "enrich.fallback":{handler:"fallback",by:"enrich.researcher",read:false,inputs:{run:{type:"enrich.Run"},refresh:{type:"bool",default:false}},label:message("Consult secondary source",{nl:"Tweede bron raadplegen"}),description:message("Explicitly consent to the secondary lookup after uncertainty or partial evidence.",{nl:"Geef expliciet toestemming voor de tweede bron na onzeker of gedeeltelijk bewijs."})},
  "enrich.accept":{handler:"accept",by:"enrich.reviewer",read:false,inputs:{run:{type:"enrich.Run"},lookup:{type:"enrich.Lookup"},field:{type:"enrich.AcceptedFact.field"},prior:{type:AcceptedFact,nullable:true},reason:{type:"enrich.AcceptedFact.reason"}},label:message("Accept sourced fact",{nl:"Brongegeven accepteren"}),description:message("Accept one exact sourced fact against its previous decision; disagreeing providers never win silently.",{nl:"Accepteer één exact brongegeven tegenover de vorige beslissing; tegenstrijdige bronnen winnen nooit stilzwijgend."})},
  "enrich.stop":{handler:"stop",by:"enrich.researcher",read:false,inputs:{run:{type:"enrich.Run"}},label:message("Stop review",{nl:"Beoordeling stoppen"}),description:message("Stop this review without pretending that a charged provider request was cancelled.",{nl:"Stop deze beoordeling zonder te doen alsof een betaalde externe aanvraag is geannuleerd."})},
 },
 handlers:{
  "enrich.looked_up":{on:"enrich.Sources.lookup.completed",handler:"looked_up",description:message("Only a selected live review may use the completion to continue its consented waterfall.",{nl:"Alleen een geselecteerde actieve beoordeling mag na voltooiing verdergaan met de toegestane bronnenreeks."})},
  "enrich.assess":{on:"enrich.Assess",handler:"assess",description:message("Automatic secondary cost requires a definitive incomplete primary; uncertainty remains a human decision.",{nl:"Automatische vervolgkosten vereisen een definitief onvolledig primair resultaat; onzekerheid blijft een menselijke beslissing."})},
 },
 pages:[page],disabled:["enrich.Company.delete","enrich.Lookup.create","enrich.Lookup.update","enrich.Lookup.delete","enrich.Run.create","enrich.Run.update","enrich.Run.delete","enrich.AcceptedFact.create","enrich.AcceptedFact.update","enrich.AcceptedFact.delete"],
};

export function canApp(){
 const report=async(c,lookup)=>(await delivery(c,{record:lookup,field:"request"},["result"]))?.result??null;
 const reusable=(c,company,provider)=>first(records(c,"enrich.Lookup",{parent:company,where:async lookup=>lookup.provider===provider&&compareInstant(lookup.created,subtractDuration(c.now,604800000n))>=0&&(await delivery(c,{record:lookup,field:"request"},["status"]))?.status==="succeeded",order:{by:lookup=>lookup.created,direction:"desc"}}));
 const capacity=async(c,company)=>(await count(records(c,"enrich.Lookup",{parent:company,where:lookup=>local_date(lookup.created,"UTC")===local_date(c.now,"UTC")})))<4n;
 const live=(c,run)=>run.parent.enabled&&same(run.parent.current,run)&&!run.stopped&&hasRole(c,"enrich.researcher",run.requested_by)&&run.parent.customer.active;
 const incomplete=(c,value)=>value.legal_name===null||value.registered_office===null||value.registry_status===null;
 const selected=(c,value,field)=>choose(field==="legal_name",value.legal_name,choose(field==="registered_office",value.registered_office,value.registry_status));
 const crudWhen={Company:async(c,row)=>row.customer.active&&row.customer.kind==="company"&&(!row.enabled||!await any(records(c,Company),link=>link.id!==row.id&&same(link.customer,row.customer)&&link.enabled))};
 return {
  report,reusable,capacity,live,incomplete,selected,current,crudWhen,
  read:{"Company.read.1":c=>hasRole(c,"enrich.researcher")||hasRole(c,"enrich.reviewer"),"Lookup.read.1":c=>hasRole(c,"enrich.researcher")||hasRole(c,"enrich.reviewer"),"Run.read.1":c=>hasRole(c,"enrich.researcher")||hasRole(c,"enrich.reviewer"),"AcceptedFact.read.1":c=>hasRole(c,"enrich.researcher")||hasRole(c,"enrich.reviewer")},
  invariants:{"Company.invariant.1":(c,row)=>row.current===null||same(row.current.parent,row),"Run.invariant.1":(c,row)=>row.primary!==null&&same(row.primary.parent,row.parent)&&(row.fallback===null||same(row.fallback.parent,row.parent)),"AcceptedFact.invariant.1":(c,row)=>same(row.lookup.parent,row.parent)&&(row.prior===null||(same(row.prior.parent,row.parent)&&row.prior.field===row.field))},
  locks:{"Company.lock.1":{fields:["customer","number"]},"Lookup.lock.1":{fields:["provider","request"]},"Run.lock.1":{fields:["requested_by","primary","allow_fallback"]},"Run.lock.2":{fields:["fallback"],when:(c,row)=>row.fallback!==null},"AcceptedFact.lock.1":{fields:["field","ordinal","lookup","value","prior","reason","reviewer"]}},
  async createCompany(c,input){check(hasRole(c,"enrich.researcher"),"forbidden");await create(c,Company,input,{when:crudWhen.Company});},
  async updateCompany(c,{record,changes}){check(hasRole(c,"enrich.researcher"),"forbidden");await set(c,record,changes,{when:crudWhen.Company});},
  async start(c,{company,refresh,fallback}){
   check(hasRole(c,"enrich.researcher"),"forbidden");check(company.enabled&&company.customer.active);
   const run=await create(c,"enrich.Run",{parent:company,allow_fallback:fallback});await set(c,company,{current:run});
   const cached=await reusable(c,company,"registry");
   if(!refresh&&cached!==null){await set(c,run,{primary:cached});await emit(c,"enrich.Assess",{run});}
   else {check(await capacity(c,company));const lookup=await create(c,"enrich.Lookup",{parent:company,provider:"registry"});const request=await send(c,"enrich.Sources.lookup",{number:company.number,provider:"registry"},{when:async()=>live(c,run)});await set(c,lookup,{request});await set(c,run,{primary:lookup});}
   return run;
  },
  async looked_up(c,{event}){
   const lookup=await first(records(c,"enrich.Lookup",{where:async item=>(await delivery(c,{record:item,field:"request"},["id"]))?.id===event.delivery_id}));
   if(lookup!==null&&lookup.parent.current!==null&&same(lookup.parent.current.primary,lookup))await emit(c,"enrich.Assess",{run:lookup.parent.current});
  },
  async assess(c,{event}){
   const run=event.run;
   if(live(c,run)&&run.allow_fallback&&run.fallback===null&&run.primary!==null&&(await delivery(c,{record:run.primary,field:"request"},["status"]))?.status==="succeeded"){
    const value=await report(c,run.primary);
    if(value!==null&&value.complete&&incomplete(c,value)){
     const cached=await reusable(c,run.parent,"aggregator");
     if(cached!==null)await set(c,run,{fallback:cached});
     else if(await capacity(c,run.parent)){const lookup=await create(c,"enrich.Lookup",{parent:run.parent,provider:"aggregator"});const request=await send(c,"enrich.Sources.lookup",{number:run.parent.number,provider:"aggregator"},{when:async()=>live(c,run)});await set(c,lookup,{request});await set(c,run,{fallback:lookup});}
    }
   }
  },
  async fallback(c,{run,refresh}){
   check(hasRole(c,"enrich.researcher"),"forbidden");check(live(c,run)&&run.fallback===null&&run.primary!==null&&["succeeded","failed","unknown","skipped"].includes((await delivery(c,{record:run.primary,field:"request"},["status"]))?.status));
   const cached=await reusable(c,run.parent,"aggregator");
   if(!refresh&&cached!==null)await set(c,run,{fallback:cached});
   else {check(await capacity(c,run.parent));const lookup=await create(c,"enrich.Lookup",{parent:run.parent,provider:"aggregator"});const request=await send(c,"enrich.Sources.lookup",{number:run.parent.number,provider:"aggregator"},{when:async()=>live(c,run)});await set(c,lookup,{request});await set(c,run,{fallback:lookup});}
  },
  async accept(c,{run,lookup,field,prior,reason}){
   check(hasRole(c,"enrich.reviewer"),"forbidden");check(live(c,run)&&(same(lookup,run.primary)||same(lookup,run.fallback))&&(await delivery(c,{record:lookup,field:"request"},["status"]))?.status==="succeeded"&&same(await current(c,run.parent,field),prior));
   const value=await report(c,lookup);check(value!==null&&value.number===run.parent.number&&value.provider===lookup.provider);
   const fact=selected(c,value,field);check(fact!==null&&(prior===null||!equalValue(c,"enrich.Fact",prior.value,fact)));
   await create(c,AcceptedFact,{parent:run.parent,field,ordinal:int64((prior?.ordinal??0n)+1n),lookup,value:fact,prior,reason});
  },
  async stop(c,{run}){check(hasRole(c,"enrich.researcher"),"forbidden");await set(c,run,{stopped:true});},
 };
}

export async function enrichmentPage(c,bindings){
 return renderPage(c,page,()=>[
  breadcrumbs({context:c}),
  preferences({context:c,children:[toggle({context:c,field:"enabled"})]}),
  form({context:c,operation:"enrich.Company.create",children:[select({context:c,field:"customer"}),input({context:c,field:"number"})]}),
  table({context:c,model:Company,where:company=>company.enabled===c.preferences.enrich.enabled,columns:["customer","number","enabled"],empty:message("No linked companies",{nl:"Geen gekoppelde bedrijven"}),renderRow:async(company,view)=>[
   pagination({context:view}),
   edit({context:view,operation:"enrich.Company.update",record:company,fields:["enabled"],children:[checkbox({context:view,field:"enabled"})]}),
   form({context:view,operation:"enrich.start",arguments:{company},children:[checkbox({context:view,field:"refresh"}),checkbox({context:view,field:"fallback"})]}),
   details({context:view,caption:message("Research and accepted facts",{nl:"Onderzoek en geaccepteerde gegevens"}),display:"drawer",children:[
    text({context:view,values:[await count(records(view,"enrich.Lookup",{parent:company,where:lookup=>local_date(lookup.created,"UTC")===local_date(view.now,"UTC")}))]}),
    table({context:view,model:"enrich.Run",parent:company,columns:["created","requested_by","primary.request.status","fallback.request.status","allow_fallback","stopped"],empty:message("No enrichment reviews",{nl:"Geen verrijkingsbeoordelingen"}),renderRow:async(run,runView)=>[
     pagination({context:runView}),
     actions({context:runView,operations:["enrich.stop"],boundArgs:{run}}),
     button({context:runView,opens:"fallback_dialog"}),
     modal({context:runView,caption:message("Consult secondary source",{nl:"Tweede bron raadplegen"}),id:"fallback_dialog",slots:{content:()=>[form({context:runView,operation:"enrich.fallback",arguments:{run},display:"inline",children:[checkbox({context:runView,field:"refresh"})]})]}}),
     diff({context:runView,slots:{before:async()=>[text({context:runView,values:[run.primary===null?null:(await delivery(runView,{record:run.primary,field:"request"},["result"]))?.result??null]})],after:async()=>[text({context:runView,values:[run.fallback===null?null:(await delivery(runView,{record:run.fallback,field:"request"},["result"]))?.result??null]})]}}),
     form({context:runView,operation:"enrich.accept",arguments:{run},children:[radio({context:runView,field:"field"}),textarea({context:runView,field:"reason"})]})
    ]}),
    table({context:view,model:AcceptedFact,parent:company,columns:["field","ordinal","value","lookup.provider","prior","reviewer","reason","created"],empty:message("No accepted facts",{nl:"Geen geaccepteerde gegevens"}),renderRow:(fact,fv)=>[pagination({context:fv})]}),
    divider({context:view,caption:message("Provider receipts",{nl:"Externe bronbewijzen"})}),
    table({context:view,model:"enrich.Lookup",parent:company,columns:["provider","created","request.status","request.result","request.error"],empty:message("No provider evidence",{nl:"Geen extern bronbewijs"}),renderRow:(lookup,lv)=>[pagination({context:lv})]}),
    history({context:view,record:company})
   ]})
  ]})
 ]);
}

export const exampleImports=[{provider:"customer",member:"test_company",alias:"test_company"}];
export function exampleFixtures({self,other,imported}){
 const {test_company}=imported;
 const analyst={dependencies:[],user:async()=>({roles:["enrich.researcher"]})};
 const editor={dependencies:[],user:async()=>({roles:["enrich.reviewer"]})};
 const linked_company={model:Company,dependencies:[test_company],value:async(c,s)=>({customer:s.test_company,number:"01234567"})};
 const complete_receipt={delivery:"enrich.Sources.lookup",values:async()=>({request:{number:"01234567",provider:"registry"},status:"succeeded",result:{number:"01234567",provider:"registry",complete:true,legal_name:{value:"Example Limited",source:"https://example.test/registry/01234567",observed:null,detail:null},registered_office:null,registry_status:null,detail:"Address unavailable"}})};
 const primary={model:"enrich.Lookup",dependencies:[linked_company,complete_receipt],value:async(c,s)=>({parent:s.linked_company,provider:"registry",request:s.complete_receipt})};
 const secondary_receipt={delivery:"enrich.Sources.lookup",values:async()=>({request:{number:"01234567",provider:"aggregator"},status:"succeeded",result:{number:"01234567",provider:"aggregator",complete:true,legal_name:{value:"Example Ltd",source:"https://example.test/aggregator/01234567",observed:null,detail:null},registered_office:null,registry_status:null,detail:null}})};
 const secondary={model:"enrich.Lookup",dependencies:[linked_company,secondary_receipt],value:async(c,s)=>({parent:s.linked_company,provider:"aggregator",request:s.secondary_receipt})};
 const review_run={model:"enrich.Run",dependencies:[linked_company,analyst,primary,secondary],value:async(c,s)=>({parent:s.linked_company,requested_by:s.analyst,primary:s.primary,fallback:s.secondary,allow_fallback:true})};
 const unknown_receipt={delivery:"enrich.Sources.lookup",values:async()=>({request:{number:"01234567",provider:"registry"},status:"unknown"})};
 const unknown_lookup={model:"enrich.Lookup",dependencies:[linked_company,unknown_receipt],value:async(c,s)=>({parent:s.linked_company,provider:"registry",request:s.unknown_receipt})};
 const consented_run={model:"enrich.Run",dependencies:[linked_company,analyst,primary],value:async(c,s)=>({parent:s.linked_company,requested_by:s.analyst,primary:s.primary,allow_fallback:true})};
 const accepted={model:AcceptedFact,dependencies:[linked_company,primary,editor],value:async(c,s)=>({parent:s.linked_company,field:"legal_name",ordinal:1n,lookup:s.primary,value:{value:"Example Limited",source:"https://example.test/registry/01234567",observed:null,detail:null},reason:"Checked registry",reviewer:s.editor})};
 return {fixtures:{analyst,editor,linked_company,complete_receipt,primary,secondary_receipt,secondary,review_run,unknown_receipt,unknown_lookup,consented_run,accepted},examples:[
  {operation:"enrich.start",dependencies:[linked_company,primary],inputs:async(c,s)=>({company:s.linked_company,refresh:false,fallback:true}),selectors:["as","company.enabled"],observations:[async(c,s)=>count(records(c,"enrich.Lookup",{parent:s.company})),async(c,s)=>same(s.company.current.primary,s.primary)],rows:[
   {dependencies:[analyst],values:async(c,s)=>[s.analyst,true],expected:async()=>[1n,true]},
   {dependencies:[analyst],values:async(c,s)=>[s.analyst,false],error:"rule_failed"},
   {dependencies:[],values:async()=>["members",true],error:"forbidden"},
  ]},
  {operation:"enrich.start",dependencies:[linked_company,primary],inputs:async(c,s)=>({company:s.linked_company,refresh:true,fallback:false}),selectors:["as"],observations:[async(c,s)=>count(records(c,"enrich.Lookup",{parent:s.company})),async(c,s)=>same(s.company.current.primary,s.primary)],rows:[
   {dependencies:[analyst],values:async(c,s)=>[s.analyst],expected:async()=>[2n,false]},
  ]},
  {operation:"enrich.start",dependencies:[linked_company,analyst],sequence:[
   {operation:"enrich.start",by:async(c,s)=>s.analyst,inputs:async(c,s)=>({company:s.linked_company,refresh:true,fallback:false})},
   {operation:"enrich.start",by:async(c,s)=>s.analyst,inputs:async(c,s)=>({company:s.linked_company,refresh:true,fallback:false})},
   {operation:"enrich.start",by:async(c,s)=>s.analyst,inputs:async(c,s)=>({company:s.linked_company,refresh:true,fallback:false})},
   {operation:"enrich.start",by:async(c,s)=>s.analyst,inputs:async(c,s)=>({company:s.linked_company,refresh:true,fallback:false})},
   {observations:async(c,s)=>[await count(records(c,"enrich.Lookup",{parent:s.linked_company}))],expected:async()=>[4n],types:["int"]},
   {operation:"enrich.start",by:async(c,s)=>s.analyst,inputs:async(c,s)=>({company:s.linked_company,refresh:true,fallback:false}),error:"rule_failed"},
  ]},
  {operation:"enrich.assess",dependencies:[consented_run],inputs:async(c,s)=>({event:{run:s.consented_run}}),selectors:["event.run.parent.current","event.run.primary","event.run.allow_fallback","event.run.stopped"],observations:[async(c,s)=>count(records(c,"enrich.Lookup",{parent:s.event.run.parent})),async(c,s)=>s.event.run.fallback!==null],rows:[
   {dependencies:[consented_run,primary],values:async(c,s)=>[s.consented_run,s.primary,true,false],expected:async()=>[2n,true]},
   {dependencies:[consented_run,primary],values:async(c,s)=>[s.consented_run,s.primary,false,false],expected:async()=>[1n,false]},
   {dependencies:[consented_run,primary],values:async(c,s)=>[s.consented_run,s.primary,true,true],expected:async()=>[1n,false]},
   {dependencies:[consented_run,unknown_lookup],values:async(c,s)=>[s.consented_run,s.unknown_lookup,true,false],expected:async()=>[2n,false]},
  ]},
  {operation:"enrich.assess",dependencies:[consented_run,secondary],inputs:async(c,s)=>({event:{run:s.consented_run}}),selectors:["event.run.parent.current"],observations:[async(c,s)=>same(s.event.run.fallback,s.secondary),async(c,s)=>count(records(c,"enrich.Lookup",{parent:s.event.run.parent}))],rows:[
   {dependencies:[consented_run],values:async(c,s)=>[s.consented_run],expected:async()=>[true,2n]},
  ]},
  {operation:"enrich.fallback",dependencies:[consented_run],inputs:async(c,s)=>({run:s.consented_run,refresh:false}),selectors:["as","run.parent.current","run.primary"],observations:[async(c,s)=>count(records(c,"enrich.Lookup",{parent:s.run.parent})),async(c,s)=>s.run.fallback!==null],rows:[
   {dependencies:[analyst,consented_run,unknown_lookup],values:async(c,s)=>[s.analyst,s.consented_run,s.unknown_lookup],expected:async()=>[3n,true]},
   {dependencies:[analyst,consented_run,primary],values:async(c,s)=>[s.analyst,s.consented_run,s.primary],expected:async()=>[2n,true]},
   {dependencies:[consented_run,primary],values:async(c,s)=>["members",s.consented_run,s.primary],error:"forbidden"},
  ]},
  {operation:"enrich.accept",dependencies:[review_run,primary],inputs:async(c,s)=>({run:s.review_run,lookup:s.primary,field:"legal_name",prior:null,reason:"Checked source"}),selectors:["as","run.parent.current","run.stopped"],observations:[async(c,s)=>count(records(c,AcceptedFact,{parent:s.run.parent}))],rows:[
   {dependencies:[editor,review_run],values:async(c,s)=>[s.editor,s.review_run,false],expected:async()=>[1n]},
   {dependencies:[editor,review_run],values:async(c,s)=>[s.editor,s.review_run,true],error:"rule_failed"},
   {dependencies:[editor],values:async(c,s)=>[s.editor,null,false],error:"rule_failed"},
   {dependencies:[review_run],values:async(c,s)=>["members",s.review_run,false],error:"forbidden"},
  ]},
  {operation:"enrich.accept",dependencies:[review_run,secondary,accepted],inputs:async(c,s)=>({run:s.review_run,lookup:s.secondary,field:"legal_name",prior:null,reason:"Reviewed disagreement"}),selectors:["as","run.parent.current","prior"],observations:[async(c,s)=>count(records(c,AcceptedFact,{parent:s.run.parent}))],rows:[
   {dependencies:[editor,review_run,accepted],values:async(c,s)=>[s.editor,s.review_run,s.accepted],expected:async()=>[2n]},
   {dependencies:[editor,review_run],values:async(c,s)=>[s.editor,s.review_run,null],error:"rule_failed"},
  ]},
  {operation:"enrich.accept",dependencies:[review_run,primary],inputs:async(c,s)=>({run:s.review_run,lookup:s.primary,field:"registered_office",prior:null,reason:"Missing is not a fact"}),selectors:["as","run.parent.current"],observations:[async(c,s)=>count(records(c,AcceptedFact,{parent:s.run.parent}))],rows:[
   {dependencies:[editor,review_run],values:async(c,s)=>[s.editor,s.review_run],error:"rule_failed"},
  ]},
  {operation:"enrich.stop",dependencies:[primary,analyst,editor],sequence:[
   {operation:"enrich.start",by:async(c,s)=>s.analyst,inputs:async(c,s)=>({company:s.linked_company,refresh:false,fallback:false}),bind:"started"},
   {operation:"enrich.stop",by:async(c,s)=>s.analyst,inputs:async(c,s,b)=>({run:b.started})},
   {let:"stopped",value:async(c,s,b)=>first(records(c,"enrich.Run",{where:run=>run.id===b.started.id}))},
   {observations:async(c,s,b)=>[b.stopped!==null],expected:async()=>[true],types:["bool"]},
   {observations:async(c,s,b)=>[b.stopped.stopped,same(s.linked_company.current,b.stopped)],expected:async()=>[true,true],types:["bool","bool"]},
   {operation:"enrich.accept",by:async(c,s)=>s.editor,inputs:async(c,s,b)=>({run:b.stopped,lookup:s.primary,field:"legal_name",prior:null,reason:"Late result"}),error:"rule_failed"},
  ]},
 ]};
}
