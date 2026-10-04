import { require as check,hasRole,active_member,same,records,first,count,any,int64,create,set,send,call,delivery,trim } from "@canlang/stdlib";
import { message,renderPage,list,gallery,table,form,actions,content,text,title,edit,breadcrumbs,pagination,badge,status,loading,chat_bubble,alert,fieldset,input,textarea,select,range,checkbox,file_input } from "@canlang/ui";
// Desired lowering: breadcrumbs, pagination, badge, status, loading, chat_bubble,
// alert, fieldset, file_input and placed controls are proposed @canlang/ui
// contracts (desired/unimplemented). gallery with empty+pagination (collection, GRAMMAR L419).
import { Conversation,Branch,Turn,can_use } from "./chat.mjs";
/* Handwritten desired target, not implemented code generation/runtime. ImagesV1
 * owns safe graph inspection, allowlist validation, durable provider correlation,
 * sequenced observations, targeted stop and receiving-app file finalization.
 * The selected CanGallery composition adds review; this owner never publishes.
 */
export const Run="creative.Run";
export const Output="creative.Output";
export const generate="creative.generate";
export function definition(c,template){return {graph:template.graph,prompt:{node:template.prompt_node,key:template.prompt_key},negative:{node:template.negative_node,key:template.negative_key},width:{node:template.width_node,key:template.width_key},height:{node:template.height_node,key:template.height_key}};}
export async function can_view(c,person,run){return person!==null&&await active_member(c,person,c.team)&&same(run.author,person)&&(run.conversation===null||await can_use(c,person,run.conversation));}
const studioDescriptor={owner:"creative",path:"/creative",title:message("Image studio",{nl:"Beeldstudio"}),poll:1000n,admit:async c=>{check(hasRole(c,"members"),"forbidden");return {};},render:studioPage};
const chatDescriptor={owner:"creative",path:"/creative/from-chat",title:message("Chat to image",{nl:"Van gesprek naar beeld"}),poll:1000n,admit:async c=>{check(hasRole(c,"members"),"forbidden");return {};},render:chatPage};
const recoveryDescriptor={owner:"creative",path:"/creative/recovery",title:message("Unresolved image jobs",{nl:"Onopgeloste beeldtaken"}),poll:1000n,admit:async c=>{check(hasRole(c,"members"),"forbidden");return {};},render:recoveryPage};
const workflowsDescriptor={owner:"creative",path:"/creative/workflows",title:message("Workflow templates",{nl:"Workflowsjablonen"}),poll:1000n,admit:async c=>{check(hasRole(c,"creative.creative_manager"),"forbidden");return {};},render:workflowsPage};
export const appDefinition={
 id:"CanCreative",uses:["chat","creative"],context:{files:{types:["application/pdf","image/png","image/jpeg","text/plain","application/json"]}},
 description:message("Turn private ideas into bounded image jobs using employee-published workflow revisions.",{nl:"Zet privé-ideeën om in begrensde beeldtaken met door medewerkers gepubliceerde workflowversies."}),
 packages:{creative:{roles:{creative_manager:{id:"creative.creative_manager",label:message("Creative administrator",{nl:"Creatief beheerder"})}}}},
 bindings:{"creative.Images":{capability:"std.ImagesV1",from:"deployment.images"}},
 models:{
  "creative.Template":{label:message("Image workflow",{nl:"Beeldworkflow"}),readGrants:[{rule:"Template.read.1",fields:["name","active","current"]},{rule:"Template.read.2"}],invariants:["Template.require.1"],locks:["Template.lock.1"],fields:{name:{type:"text",trim:true,max:200n},owner:{type:"user",server:"actor"},graph:{type:"file"},prompt_node:{type:"text",default:"6"},prompt_key:{type:"text",default:"text"},negative_node:{type:"text",default:"7"},negative_key:{type:"text",default:"text"},width_node:{type:"text",default:"5"},width_key:{type:"text",default:"width"},height_node:{type:"text",default:"5"},height_key:{type:"text",default:"height"},outputs:{type:"int",default:1n,min:1n,max:4n},duration:{type:"duration",default:120000n},active:{type:"bool",default:true},current:{type:"creative.Revision",nullable:true},inspection:{type:"delivery",operation:"creative.Images.inspect",nullable:true}}},
  "creative.Revision":{parent:"creative.Template",label:message("Immutable workflow revision",{nl:"Onveranderlijke workflowversie"}),readGrants:[{rule:"Revision.read.1",fields:["parent","number","definition","published","digest","outputs","duration"]},{rule:"Revision.read.2"}],invariants:["Revision.require.1"],locks:["Revision.lock.1","Revision.lock.2"],unique:[{fields:["number"]}],fields:{number:{type:"int",min:1n},definition:{type:"std.WorkflowDefinition"},outputs:{type:"int",min:1n,max:4n},duration:{type:"duration"},validation:{type:"delivery",operation:"creative.Images.validate",nullable:true},published:{type:"bool",default:false},digest:{type:"text",nullable:true}}},
  "creative.Budget":{label:message("Image-job allowance",{nl:"Budget voor beeldtaken"}),readGrants:[{rule:"Budget.read.1"}],invariants:["Budget.require.1"],locks:["Budget.lock.1"],fields:{account:{type:"user",unique:true},cap:{type:"int",min:1n},parallel:{type:"int",default:2n,min:1n,max:10n},spent:{type:"int",default:0n,min:0n},held:{type:"int",default:0n,min:0n},running:{type:"int",default:0n,min:0n,max:10n},active:{type:"bool",default:true}}},
  [Run]:{exported:true,label:message("Image generation",{nl:"Beeldgeneratie"}),readGrants:[{rule:"Run.read.1",fields:["source","author","conversation","revision","prompt","negative","width","height","state","used","unfinished","stop_requested","detail","request.id","request.status","request.error","request.progress.state","request.progress.detail","cancellation.id","cancellation.status","cancellation.error","reconciliation.id","reconciliation.status","reconciliation.error","delivery_state","stop_delivery","reconcile_delivery","created","updated"]},{rule:"Run.read.2",fields:["source","author","conversation","state","used","unfinished","stop_requested","detail","request.id","request.status","request.error","request.progress.state","request.progress.detail","cancellation.id","cancellation.status","cancellation.error","reconciliation.id","reconciliation.status","reconciliation.error","delivery_state","stop_delivery","reconcile_delivery","created","updated"]}],invariants:["Run.require.1"],locks:["Run.lock.1"],derived:{state:{handler:"Run.state",type:"std.ImageRun.state",nullable:true},detail:{handler:"Run.detail",type:"text",nullable:true},delivery_state:{handler:"Run.delivery_state",type:"std.DeliveryResult.status",nullable:true,label:message("Submission receipt",{nl:"Indieningsbewijs"})},stop_delivery:{handler:"Run.stop_delivery",type:"std.DeliveryResult.status",nullable:true,label:message("Stop receipt",{nl:"Stopbewijs"})},reconcile_delivery:{handler:"Run.reconcile_delivery",type:"std.DeliveryResult.status",nullable:true,label:message("Recovery receipt",{nl:"Herstelbewijs"})}},fields:{source:{type:"text",unique:true},author:{type:"user",server:"actor"},conversation:{type:Conversation,nullable:true},revision:{type:"creative.Revision"},budget:{type:"creative.Budget"},prompt:{type:"std.ImageRequest.prompt"},negative:{type:"std.ImageRequest.negative"},width:{type:"std.ImageRequest.width"},height:{type:"std.ImageRequest.height"},request:{type:"delivery",operation:"creative.Images.submit",nullable:true},cancellation:{type:"delivery",operation:"creative.Images.cancel",nullable:true},reconciliation:{type:"delivery",operation:"creative.Images.reconcile",nullable:true},used:{type:"int",nullable:true,min:0n,max:1n},unfinished:{type:"bool",default:true},stop_requested:{type:"bool",default:false}}},
  [Output]:{exported:true,parent:Run,label:message("Finalized image",{nl:"Afgerond beeldbestand"}),readGrants:[{rule:"Output.read.1"}],locks:["Output.lock.1"],unique:[{fields:["position"]}],fields:{position:{type:"int",min:0n,max:3n},image:{type:"file"}}}
 },
 pure:{"creative.definition":{handler:"definition",inputs:{template:{type:"creative.Template"}},result:{type:"std.WorkflowDefinition"}},"creative.can_view":{handler:"can_view",exported:true,inputs:{person:{type:"user",nullable:true},run:{type:Run}},result:{type:"bool"}}},

 operations:{
  "creative.Template.create":{handler:"createTemplate",kind:"create",model:"creative.Template",by:"creative.creative_manager",when:"Template",inputs:{fields:["name","graph","prompt_node","prompt_key","negative_node","negative_key","width_node","width_key","height_node","height_key","outputs","duration"]}},
  "creative.Template.update":{handler:"updateTemplate",kind:"update",model:"creative.Template",by:"creative.creative_manager",when:"Template",inputs:{record:{type:"creative.Template"},changes:{fields:["name","graph","prompt_node","prompt_key","negative_node","negative_key","width_node","width_key","height_node","height_key","outputs","duration","active"]}}},
  "creative.Budget.create":{handler:"createBudget",kind:"create",model:"creative.Budget",by:"creative.creative_manager",inputs:{fields:["account","cap","parallel"]}},
  "creative.Budget.update":{handler:"updateBudget",kind:"update",model:"creative.Budget",by:"creative.creative_manager",inputs:{record:{type:"creative.Budget"},changes:{fields:["cap","parallel","active"]}}},
  "creative.inspect":{handler:"inspect",description:message("Inspect allowed input destinations without starting a generation.",{nl:"Inspecteer toegestane invoerbestemmingen zonder een generatie te starten."}),by:"creative.creative_manager",inputs:{template:{type:"creative.Template"}},label:message("Inspect workflow inputs",{nl:"Workflowinvoer inspecteren"})},
  "creative.validate":{handler:"validate",description:message("Freeze this draft graph and mapping into a new revision for safe provider validation.",{nl:"Leg deze conceptgraaf en koppelingen vast in een nieuwe versie voor veilige validatie."}),by:"creative.creative_manager",result:{type:"creative.Revision"},inputs:{template:{type:"creative.Template"}},label:message("Validate new revision",{nl:"Nieuwe versie valideren"})},
  "creative.publish":{handler:"publish",description:message("Publish only the exact successfully validated immutable snapshot; later draft edits cannot change it.",{nl:"Publiceer alleen de exact gevalideerde onveranderlijke momentopname; latere conceptwijzigingen veranderen die niet."}),by:"creative.creative_manager",inputs:{revision:{type:"creative.Revision"}},label:message("Publish workflow and graph to members",{nl:"Workflow en graaf met leden delen"})},
  [generate]:{handler:"generate",description:message("Submit one bounded image job with a frozen published workflow and explicit authorized chat context.",{nl:"Dien één begrensde beeldtaak in met een vaste gepubliceerde workflow en expliciet toegestane gesprekscontext."}),exported:true,by:"members",result:{type:Run},inputs:{template:{type:"creative.Template"},prompt:{type:"std.ImageRequest.prompt"},negative:{type:"std.ImageRequest.negative",default:""},width:{type:"std.ImageRequest.width",default:512n},height:{type:"std.ImageRequest.height",default:512n},conversation:{type:Conversation,nullable:true,default:null}},label:message("Generate images",{nl:"Beelden genereren"})},
  "creative.from_turn":{handler:"from_turn",description:message("Deliberately copy an owned chat turn into the normal image form's canonical generation operation.",{nl:"Kopieer bewust een eigen gespreksbericht naar de canonieke beeldgeneratiebewerking."}),by:"members",result:{type:Run},inputs:{turn:{type:Turn},template:{type:"creative.Template"},negative:{type:"std.ImageRequest.negative",default:""},width:{type:"std.ImageRequest.width",default:512n},height:{type:"std.ImageRequest.height",default:512n}},label:message("Create image from this message",{nl:"Maak een beeld van dit bericht"})},
  "creative.stop":{handler:"stop",description:message("Request a targeted external stop and retain uncertainty until the provider confirms the outcome.",{nl:"Vraag een gerichte externe stop en behoud onzekerheid totdat de aanbieder de uitkomst bevestigt."}),by:"members",inputs:{run:{type:Run}},label:message("Stop image job",{nl:"Beeldtaak stoppen"})},
  "creative.reconcile":{handler:"reconcile",description:message("Reconcile the existing image job without submitting a replacement or releasing unconfirmed usage.",{nl:"Controleer de bestaande beeldtaak zonder een vervanging in te dienen of onbevestigd gebruik vrij te geven."}),by:"members",inputs:{run:{type:Run}},label:message("Check image outcome",{nl:"Beelduitkomst controleren"})},
  "creative.release_skipped":{handler:"release_skipped",description:message("Release the reservation only when the authoritative receipt proves the job was never dispatched.",{nl:"Geef de reservering alleen vrij wanneer het gezaghebbende bewijs aantoont dat de taak nooit is verzonden."}),by:"members",inputs:{run:{type:Run}},label:message("Release unsent job",{nl:"Niet-verzonden taak vrijgeven"})}
 },
 handlers:{"creative.template_edited":{handler:"template_edited",on:"creative.Template.update"},"creative.conversation_revoked":{handler:"conversation_revoked",on:"chat.Conversation.updated"},"creative.member_removed":{handler:"member_removed",on:"teams.member_removed"},"creative.image_progressed":{handler:"image_progressed",on:"creative.Images.submit.progressed"}},
 pages:[studioDescriptor,chatDescriptor,recoveryDescriptor,workflowsDescriptor],disabled:["creative.Template.delete","creative.Revision.create","creative.Revision.update","creative.Revision.delete","creative.Budget.delete","creative.Run.create","creative.Run.update","creative.Run.delete","creative.Output.create","creative.Output.update","creative.Output.delete"]
};
export function canApp(){
 const crudWhen={Template:(c,row)=>same(row.owner,c.actor)};
 return {
  crudWhen,definition,can_view,
  read:{"Template.read.1":c=>hasRole(c,"members"),"Template.read.2":(c,r)=>hasRole(c,"creative.creative_manager")&&same(r.owner,c.actor),"Revision.read.1":(c,r)=>hasRole(c,"members")&&r.published&&r.parent.active,"Revision.read.2":(c,r)=>hasRole(c,"creative.creative_manager")&&same(r.parent.owner,c.actor),"Budget.read.1":(c,r)=>hasRole(c,"creative.creative_manager")||(hasRole(c,"members")&&same(r.account,c.actor)),"Run.read.1":(c,r)=>can_view(c,c.actor,r),"Run.read.2":(c,r)=>hasRole(c,"members")&&same(r.author,c.actor),"Output.read.1":(c,r)=>can_view(c,c.actor,r.parent)},
  invariants:{"Template.require.1":(c,r)=>r.duration>=1000n&&r.duration<=900000n&&(r.current===null||(same(r.current.parent,r)&&r.current.published)),"Revision.require.1":(c,r)=>r.duration>=1000n&&r.duration<=900000n&&(!r.published||r.digest!==null),"Budget.require.1":(c,r)=>int64(r.spent+r.held)<=r.cap&&r.running<=r.parallel,"Run.require.1":(c,r)=>int64(r.width%64n)===0n&&int64(r.height%64n)===0n},
  locks:{"Template.lock.1":{fields:["owner"]},"Revision.lock.1":{fields:["number","definition","outputs","duration","validation"]},"Revision.lock.2":{fields:["published","digest"],when:(c,r)=>r.published},"Budget.lock.1":{fields:["account"]},"Run.lock.1":{fields:["source","author","conversation","revision","budget","prompt","negative","width","height","request"]},"Output.lock.1":{fields:["position","image"]}},
  derives:{async "Run.state"(c,r){return (await delivery(c,{record:r,field:"request"},["progress.state"]))?.progress?.state??null;},async "Run.detail"(c,r){return (await delivery(c,{record:r,field:"request"},["progress.detail"]))?.progress?.detail??null;},async "Run.delivery_state"(c,r){return (await delivery(c,{record:r,field:"request"},["status"]))?.status??null;},async "Run.stop_delivery"(c,r){return (await delivery(c,{record:r,field:"cancellation"},["status"]))?.status??null;},async "Run.reconcile_delivery"(c,r){return (await delivery(c,{record:r,field:"reconciliation"},["status"]))?.status??null;},},
  async createTemplate(c,input){check(hasRole(c,"creative.creative_manager"),"forbidden");await create(c,"creative.Template",input,{when:crudWhen.Template});},
  async updateTemplate(c,{record,changes}){check(hasRole(c,"creative.creative_manager"),"forbidden");await set(c,record,changes,{when:crudWhen.Template});},
  async createBudget(c,input){check(hasRole(c,"creative.creative_manager"),"forbidden");await create(c,"creative.Budget",input);},async updateBudget(c,{record,changes}){check(hasRole(c,"creative.creative_manager"),"forbidden");await set(c,record,changes);},
  async template_edited(c,{event}){await set(c,event.after,{inspection:null});},
  async inspect(c,{template}){check(hasRole(c,"creative.creative_manager"),"forbidden");check(same(template.owner,c.actor)&&template.active);const inspection=await send(c,"creative.Images.inspect",{graph:template.graph});await set(c,template,{inspection});},
  async validate(c,{template}){check(hasRole(c,"creative.creative_manager"),"forbidden");check(same(template.owner,c.actor)&&template.active);const value=definition(c,template);const revision=await create(c,"creative.Revision",{parent:template,number:int64(count(await records(c,"creative.Revision",{parent:template}))+1n),definition:value,outputs:template.outputs,duration:template.duration});const validation=await send(c,"creative.Images.validate",{value});await set(c,revision,{validation});return revision;},
  async publish(c,{revision}){
   check(hasRole(c,"creative.creative_manager"),"forbidden");check(same(revision.parent.owner,c.actor)&&revision.parent.active&&!revision.published);
   const validation=await delivery(c,{record:revision,field:"validation"},["status","result"]);check(validation?.status==="succeeded"&&validation?.result?.valid===true&&validation?.result?.digest!=null);
   await set(c,revision,{published:true,digest:validation.result.digest});await set(c,revision.parent,{current:revision});
  },
  async generate(c,{template,prompt,negative="",width=512n,height=512n,conversation=null}){
   check(hasRole(c,"members"),"forbidden");check(template.active&&template.current!==null&&template.current.published&&trim(prompt)!=="");check(int64(width%64n)===0n&&int64(height%64n)===0n&&(conversation===null||await can_use(c,c.actor,conversation)));
   const budget=first(await records(c,"creative.Budget",{where:r=>same(r.account,c.actor),order:{by:r=>r.id}}));check(budget!==null&&budget.active&&budget.running<budget.parallel&&int64(int64(budget.spent+budget.held)+1n)<=budget.cap);
   const revision=template.current;check(revision.digest!==null);const run=await create(c,Run,{source:c.operation.id,conversation,revision,budget,prompt,negative,width,height});await set(c,budget,{held:int64(budget.held+1n),running:int64(budget.running+1n)});
   const request=await send(c,"creative.Images.submit",{value:{source:run.source,revision:1n,workflow:revision.definition,validation:revision.digest,prompt,negative,width,height,max_outputs:revision.outputs,max_duration:revision.duration}},{when:async()=>await active_member(c,run.author,c.team)&&template.active&&budget.active&&!run.stop_requested&&(run.conversation===null||await can_use(c,run.author,run.conversation))});
   await set(c,run,{request});return run;
  },
  async from_turn(c,{turn,template,negative="",width=512n,height=512n}){check(hasRole(c,"members"),"forbidden");check(await can_use(c,c.actor,turn.parent.parent));return await call(c,generate,{template,prompt:turn.content,negative,width,height,conversation:turn.parent.parent});},
  async stop(c,{run}){check(hasRole(c,"members"),"forbidden");check(same(run.author,c.actor)&&run.unfinished&&(await delivery(c,{record:run,field:"cancellation"},["status"]))?.status!=="pending");const cancellation=await send(c,"creative.Images.cancel",{source:run.source,revision:1n});await set(c,run,{stop_requested:true,cancellation});},
  async reconcile(c,{run}){check(hasRole(c,"members"),"forbidden");check(same(run.author,c.actor)&&(run.unfinished||run.used===null)&&(await delivery(c,{record:run,field:"reconciliation"},["status"]))?.status!=="pending");const reconciliation=await send(c,"creative.Images.reconcile",{source:run.source,revision:1n});await set(c,run,{reconciliation});},
  async release_skipped(c,{run}){check(hasRole(c,"members"),"forbidden");check(same(run.author,c.actor)&&(await delivery(c,{record:run,field:"request"},["status"]))?.status==="skipped"&&(await delivery(c,{record:run,field:"request"},["progress"]))?.progress==null&&run.used===null&&run.unfinished);await set(c,run.budget,{held:int64(run.budget.held-1n),running:int64(run.budget.running-1n)});await set(c,run,{used:0n,unfinished:false});},
  async conversation_revoked(c,{event}){
   const conversation=first(await records(c,Conversation,{where:r=>r.id===event.id,order:{by:r=>r.id}}));
   if(conversation!==null&&!conversation.active)for(const run of await records(c,Run,{where:r=>same(r.conversation,conversation)&&r.unfinished,limit:10n})){
    if((await delivery(c,{record:run,field:"cancellation"},["status"]))?.status!=="pending"){const cancellation=await send(c,"creative.Images.cancel",{source:run.source,revision:1n});await set(c,run,{stop_requested:true,cancellation});}
   }
  },
  async member_removed(c,{event}){if(await active_member(c,event.user,c.team))return;for(const run of await records(c,Run,{where:r=>same(r.author,event.user)&&r.unfinished,limit:10n}))if((await delivery(c,{record:run,field:"cancellation"},["status"]))?.status!=="pending"){const cancellation=await send(c,"creative.Images.cancel",{source:run.source,revision:1n});await set(c,run,{stop_requested:true,cancellation});}},
  async image_progressed(c,{event}){
   for(const run of await records(c,Run,{where:async r=>(await delivery(c,{record:r,field:"request"},["id"]))?.id===event.delivery_id,limit:1n})){
    const value=(await delivery(c,{record:run,field:"request"},["progress"]))?.progress??null;
    if(value!==null){
     check(count(value.outputs)<=run.revision.outputs&&(value.state!=="succeeded"||count(value.outputs)>0n));check(run.used===null||run.used===value.charged_jobs);
     if(run.used===null&&value.charged_jobs!==null){await set(c,run.budget,{held:int64(run.budget.held-1n),spent:int64(run.budget.spent+value.charged_jobs)});await set(c,run,{used:value.charged_jobs});}
     if(run.unfinished&&["succeeded","failed","cancelled"].includes(value.state)){await set(c,run.budget,{running:int64(run.budget.running-1n)});await set(c,run,{unfinished:false});}
     check(count(value.outputs)<=4n,"limit");for(const output of value.outputs)if(!any(await records(c,Output,{parent:run}),r=>r.position===output.position))await create(c,Output,{parent:run,position:output.position,image:output.image});
    }
   }
  }
 };
}
export async function studioPage(c){return renderPage(c,studioDescriptor,()=>[
 breadcrumbs({context:c}),
 form({context:c,operation:generate,display:"inline",children:[
  fieldset({context:c,caption:message("Image prompt",{nl:"Beeldprompt"}),children:[
   select({context:c,field:"template"}),
   textarea({context:c,field:"prompt"}),
   textarea({context:c,field:"negative"})]}),
  fieldset({context:c,caption:message("Size and context",{nl:"Formaat en context"}),children:[
   input({context:c,field:"width"}),
   input({context:c,field:"height"}),
   select({context:c,field:"conversation"})]})]}),
 list({context:c,model:Run,where:r=>can_view(c,c.actor,r),order:["-created"],empty:message("No image jobs yet",{nl:"Nog geen beeldtaken"}),renderRow:(run,rv)=>[
  pagination({context:rv}),
  title({context:rv,value:run.prompt}),
  status({context:rv,value:run.delivery_state}),
  status({context:rv,value:run.stop_delivery}),
  status({context:rv,value:run.reconcile_delivery}),
  badge({context:rv,value:run.state}),
  text({context:rv,values:[run.stop_requested,run.used,run.detail]}),
  loading({context:rv,value:run.unfinished}),
  gallery({context:rv,model:Output,parent:run,image:"image",order:["position"],empty:message("No images yet",{nl:"Nog geen beelden"}),children:[pagination({context:rv})]}),
  actions({context:rv,operations:["creative.stop","creative.reconcile","creative.release_skipped"],boundArgs:{run}}),
 ]}),
 table({context:c,model:"creative.Budget",columns:["cap","spent","held","running","active"],empty:message("No image-job allowances",{nl:"Geen budgetten voor beeldtaken"}),renderRow:(row,rv)=>[pagination({context:rv})]})
 ]);}
export async function chatPage(c){return renderPage(c,chatDescriptor,()=>[
 breadcrumbs({context:c}),
 list({context:c,model:Conversation,where:r=>r.active,empty:message("No conversations",{nl:"Geen gesprekken"}),renderRow:(conversation,cv)=>[
  pagination({context:cv}),
  title({context:cv,value:conversation.title}),
  list({context:cv,model:Branch,parent:conversation,empty:message("No branches",{nl:"Geen vertakkingen"}),renderRow:(branch,bv)=>[
   pagination({context:bv}),
   title({context:bv,value:branch.title}),
   list({context:bv,model:Turn,parent:branch,order:["position"],empty:message("No messages",{nl:"Geen berichten"}),renderRow:(turn,tv)=>[
    pagination({context:tv}),
    chat_bubble({context:tv,slots:{header:()=>[text({context:tv,values:[turn.role]})],content:()=>[content({context:tv,value:turn.content})]}}),
    form({context:tv,operation:"creative.from_turn",arguments:{turn},children:[
     fieldset({context:tv,caption:message("Image prompt",{nl:"Beeldprompt"}),children:[
      select({context:tv,field:"template"}),
      textarea({context:tv,field:"negative"})]}),
     fieldset({context:tv,caption:message("Size",{nl:"Formaat"}),children:[
      input({context:tv,field:"width"}),
      input({context:tv,field:"height"})]})]})]})
   ]})
  ]})
 ]);}
export async function recoveryPage(c){return renderPage(c,recoveryDescriptor,()=>[
 breadcrumbs({context:c}),
 table({context:c,model:Run,where:r=>r.unfinished||r.used===null,columns:["state","delivery_state","stop_delivery","reconcile_delivery","used","detail"],empty:message("No unresolved image jobs",{nl:"Geen onopgeloste beeldtaken"}),renderRow:(run,rv)=>[pagination({context:rv}),status({context:rv,value:run.delivery_state}),actions({context:rv,operations:["creative.stop","creative.reconcile","creative.release_skipped"],boundArgs:{run}})]})
 ]);}
export async function workflowsPage(c){return renderPage(c,workflowsDescriptor,()=>[
 breadcrumbs({context:c}),
 alert({context:c,children:[text({context:c,values:[message("Upload an allowed API-format graph. Inspect its inputs, map the four fields, validate a snapshot, then publish it.",{nl:"Upload een toegestane API-graaf. Inspecteer de invoer, koppel vier velden, valideer een momentopname en publiceer deze."})]})]}),
 form({context:c,operation:"creative.Template.create",children:[
  fieldset({context:c,caption:message("Graph",{nl:"Graaf"}),children:[
   input({context:c,field:"name"}),
   file_input({context:c,field:"graph"})]}),
  fieldset({context:c,caption:message("Input mapping",{nl:"Invoerkoppeling"}),children:[
   input({context:c,field:"prompt_node"}),
   input({context:c,field:"prompt_key"}),
   input({context:c,field:"negative_node"}),
   input({context:c,field:"negative_key"}),
   input({context:c,field:"width_node"}),
   input({context:c,field:"width_key"}),
   input({context:c,field:"height_node"}),
   input({context:c,field:"height_key"})]}),
  fieldset({context:c,caption:message("Limits",{nl:"Limieten"}),children:[
   range({context:c,field:"outputs"}),
   input({context:c,field:"duration"})]})]}),
 list({context:c,model:"creative.Template",where:r=>same(r.owner,c.actor),empty:message("No workflow templates yet",{nl:"Nog geen workflowsjablonen"}),renderRow:async(template,tv)=>{
  const inspection=await delivery(tv,{record:template,field:"inspection"},["status","result.fields"]);
  return [pagination({context:tv}),title({context:tv,value:template.name}),edit({context:tv,operation:"creative.Template.update",record:template}),actions({context:tv,operations:["creative.inspect"],boundArgs:{template}}),text({context:tv,values:[inspection?.status??null]}),list({context:tv,items:inspection?.result?.fields??[],empty:message("No input fields found",{nl:"Geen invoervelden gevonden"}),renderRow:(row,rv)=>[pagination({context:rv}),text({context:rv,values:[row.node,row.key,row.kind,row.label]})]}),actions({context:tv,operations:["creative.validate"],boundArgs:{template}}),list({context:tv,model:"creative.Revision",parent:template,order:["-number"],empty:message("No revisions yet",{nl:"Nog geen versies"}),renderRow:async(revision,rv)=>[pagination({context:rv}),text({context:rv,values:[revision.number,revision.published,(await delivery(rv,{record:revision,field:"validation"},["status"]))?.status??null,revision.digest]}),actions({context:rv,operations:["creative.publish"],boundArgs:{revision}})]})];}}),
 form({context:c,operation:"creative.Budget.create",children:[
  input({context:c,field:"cap"}),
  range({context:c,field:"parallel"})]}),
 table({context:c,model:"creative.Budget",columns:["account","cap","parallel","spent","held","running","active"],empty:message("No image-job allowances",{nl:"Geen budgetten voor beeldtaken"}),renderRow:(record,rv)=>[pagination({context:rv}),edit({context:rv,operation:"creative.Budget.update",record,fields:["cap","parallel","active"],children:[input({context:rv,field:"cap"}),range({context:rv,field:"parallel"}),checkbox({context:rv,field:"active"})]})]})
 ]);}

export const exampleImports=[{provider:"chat",member:"conversation",alias:"conversation"}];
export function exampleFixtures({self,other,imported}){
 const {conversation}=imported;
 const manager={dependencies:[],user:async()=>({roles:["creative.creative_manager"]})};
 const graph={dependencies:[],file:async()=>({type:"application/json"})};
 const workflow={model:"creative.Template",dependencies:[manager,graph],value:async(c,s)=>({name:"Launch visuals",owner:s.manager,graph:s.graph})};
 const checked={delivery:"creative.Images.validate",dependencies:[graph],values:async(c,s)=>({request:{value:{graph:s.graph,prompt:{node:"6",key:"text"},negative:{node:"7",key:"text"},width:{node:"5",key:"width"},height:{node:"5",key:"height"}}},status:"succeeded",result:{valid:true,digest:"fixture-validated-graph",detail:null}})};
 const revision={model:"creative.Revision",dependencies:[workflow,graph,checked],value:async(c,s)=>({parent:s.workflow,number:1n,definition:{graph:s.graph,prompt:{node:"6",key:"text"},negative:{node:"7",key:"text"},width:{node:"5",key:"width"},height:{node:"5",key:"height"}},outputs:1n,duration:120000n,validation:s.checked,published:true,digest:"fixture-validated-graph"})};
 const budget={model:"creative.Budget",dependencies:[self],value:async(c,s)=>({account:s.self,cap:20n})};
 const image={dependencies:[],file:async()=>({type:"image/png"})};
 const completed_budget={model:"creative.Budget",dependencies:[self],value:async(c,s)=>({account:s.self,cap:20n,spent:1n})};
 const completed_request={delivery:"creative.Images.submit",dependencies:[graph,image],values:async(c,s)=>({request:{value:{source:"creative-completed",revision:1n,workflow:{graph:s.graph,prompt:{node:"6",key:"text"},negative:{node:"7",key:"text"},width:{node:"5",key:"width"},height:{node:"5",key:"height"}},validation:"fixture-validated-graph",prompt:"A quiet garden",negative:"",width:512n,height:512n,max_outputs:1n,max_duration:120000n}},status:"succeeded",result:{source:"creative-completed",revision:1n,sequence:2n,state:"succeeded",outputs:[{position:0n,image:s.image}],charged_jobs:1n,detail:null}})};
 const completed={model:Run,dependencies:[self,revision,completed_budget,completed_request],value:async(c,s)=>({source:"creative-completed",author:s.self,conversation:null,revision:s.revision,budget:s.completed_budget,prompt:"A quiet garden",negative:"",width:512n,height:512n,request:s.completed_request,used:1n,unfinished:false})};
 const output={model:Output,dependencies:[completed,image],value:async(c,s)=>({parent:s.completed,position:0n,image:s.image})};
 const held_budget={model:"creative.Budget",dependencies:[self],value:async(c,s)=>({account:s.self,cap:20n,held:1n,running:1n})};
 const observed_request={delivery:"creative.Images.submit",dependencies:[graph],values:async(c,s)=>({request:{value:{source:"creative-pending",revision:1n,workflow:{graph:s.graph,prompt:{node:"6",key:"text"},negative:{node:"7",key:"text"},width:{node:"5",key:"width"},height:{node:"5",key:"height"}},validation:"fixture-validated-graph",prompt:"A quiet garden",negative:"",width:512n,height:512n,max_outputs:1n,max_duration:120000n}},status:"succeeded",result:{source:"creative-pending",revision:1n,sequence:1n,state:"queued",outputs:[],charged_jobs:null,detail:null}})};
 const pending_run={model:Run,dependencies:[self,revision,held_budget,observed_request],value:async(c,s)=>({source:"creative-pending",author:s.self,conversation:null,revision:s.revision,budget:s.held_budget,prompt:"A quiet garden",negative:"",width:512n,height:512n,request:s.observed_request})};
 const prior_output={model:Output,dependencies:[pending_run,image],value:async(c,s)=>({parent:s.pending_run,position:0n,image:s.image})};
 return {fixtures:{manager,graph,workflow,checked,revision,budget,image,completed_budget,completed_request,completed,output,held_budget,observed_request,pending_run,prior_output},examples:[
  {operation:"creative.publish",dependencies:[revision],inputs:async(c,s)=>({revision:s.revision}),selectors:["as","revision.published","checked.result"],observations:[async(c,s)=>s.revision.published,async(c,s)=>s.workflow.current],rows:[
   {dependencies:[manager],values:async(c,s)=>[s.manager,false,{valid:true,digest:"fixture-validated-graph",detail:null}],expected:async(c,s)=>[true,s.revision]},
   {dependencies:[manager],values:async(c,s)=>[s.manager,false,{valid:false,digest:null,detail:"Mapping rejected"}],error:"rule_failed"},
   {dependencies:[manager],values:async(c,s)=>[s.manager,true,{valid:true,digest:"fixture-validated-graph",detail:null}],error:"rule_failed"},
   {dependencies:[other],values:async(c,s)=>[s.other,false,{valid:true,digest:"fixture-validated-graph",detail:null}],error:"forbidden"}]},
  {operation:generate,dependencies:[budget,workflow,self],inputs:async(c,s)=>({template:s.workflow,prompt:"A quiet garden",negative:"",width:512n,height:512n,conversation:null}),selectors:["as","workflow.current","budget.cap","budget.spent","width"],observations:[async(c,s)=>count(await records(c,Run,{where:r=>r.source===c.operation.id})),async(c,s)=>s.budget.held],rows:[
   {dependencies:[self,revision],values:async(c,s)=>[s.self,s.revision,20n,0n,512n],expected:async()=>[1n,1n]},
   {dependencies:[self,revision],values:async(c,s)=>[s.self,s.revision,1n,0n,512n],expected:async()=>[1n,1n]},
   {dependencies:[self,revision],values:async(c,s)=>[s.self,s.revision,1n,1n,512n],error:"rule_failed"},
   {dependencies:[self],values:async(c,s)=>[s.self,null,20n,0n,512n],error:"rule_failed"},
   {dependencies:[self,revision],values:async(c,s)=>[s.self,s.revision,20n,0n,513n],error:"rule_failed"}]},
  {operation:generate,dependencies:[budget,workflow,conversation,self],inputs:async(c,s)=>({template:s.workflow,prompt:"A private idea",negative:"",width:512n,height:512n,conversation:s.conversation}),selectors:["as","workflow.current","conversation.active","conversation.account"],observations:[async(c,s)=>count(await records(c,Run,{where:r=>r.source===c.operation.id}))],rows:[
   {dependencies:[self,revision],values:async(c,s)=>[s.self,s.revision,true,s.self],expected:async()=>[1n]},
   {dependencies:[self,revision],values:async(c,s)=>[s.self,s.revision,false,s.self],error:"rule_failed"},
   {dependencies:[self,other,revision],values:async(c,s)=>[s.self,s.revision,true,s.other],error:"rule_failed"}]},
  {operation:"creative.image_progressed",dependencies:[pending_run,image],inputs:async(c,s)=>({event:{delivery_id:s.observed_request.id}}),selectors:["observed_request.result"],observations:[async(c,s)=>s.pending_run.state,async(c,s)=>s.pending_run.used,async(c,s)=>s.held_budget.held,async(c,s)=>s.held_budget.spent,async(c,s)=>s.held_budget.running,async(c,s)=>count(await records(c,Output,{parent:s.pending_run}))],rows:[
   {dependencies:[image],values:async(c,s)=>[{source:"creative-pending",revision:1n,sequence:2n,state:"succeeded",outputs:[{position:0n,image:s.image}],charged_jobs:1n,detail:null}],expected:async()=>["succeeded",1n,0n,1n,0n,1n]},
   {dependencies:[],values:async()=>[{source:"creative-pending",revision:1n,sequence:1n,state:"queued",outputs:[],charged_jobs:null,detail:null}],expected:async()=>["queued",null,1n,0n,1n,0n]},
   {dependencies:[],values:async()=>[{source:"creative-pending",revision:1n,sequence:2n,state:"unknown",outputs:[],charged_jobs:null,detail:null}],expected:async()=>["unknown",null,1n,0n,1n,0n]},
   {dependencies:[],values:async()=>[{source:"creative-pending",revision:1n,sequence:2n,state:"cancelled",outputs:[],charged_jobs:null,detail:null}],expected:async()=>["cancelled",null,1n,0n,0n,0n]},
   {dependencies:[image],values:async(c,s)=>[{source:"creative-pending",revision:1n,sequence:2n,state:"failed",outputs:[{position:0n,image:s.image}],charged_jobs:1n,detail:null}],expected:async()=>["failed",1n,0n,1n,0n,1n]}]},
  {operation:"creative.image_progressed",dependencies:[pending_run,prior_output],inputs:async(c,s)=>({event:{delivery_id:s.observed_request.id}}),selectors:["observed_request.result","pending_run.used","pending_run.unfinished","held_budget.held","held_budget.spent","held_budget.running"],observations:[async(c,s)=>s.held_budget.held,async(c,s)=>s.held_budget.spent,async(c,s)=>s.held_budget.running,async(c,s)=>count(await records(c,Output,{parent:s.pending_run}))],rows:[{dependencies:[image],values:async(c,s)=>[{source:"creative-pending",revision:1n,sequence:2n,state:"succeeded",outputs:[{position:0n,image:s.image}],charged_jobs:1n,detail:null},1n,false,0n,1n,0n],expected:async()=>[0n,1n,0n,1n]}]},
  {operation:"creative.image_progressed",dependencies:[pending_run],inputs:async(c,s)=>({event:{delivery_id:s.observed_request.id}}),selectors:["observed_request.result","pending_run.unfinished","held_budget.running"],observations:[async(c,s)=>s.pending_run.used,async(c,s)=>s.held_budget.held,async(c,s)=>s.held_budget.spent,async(c,s)=>s.held_budget.running],rows:[{dependencies:[],values:async()=>[{source:"creative-pending",revision:1n,sequence:3n,state:"cancelled",outputs:[],charged_jobs:1n,detail:null},false,0n],expected:async()=>[1n,0n,1n,0n]}]}
 ]};
}
