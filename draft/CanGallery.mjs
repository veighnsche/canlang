import { require as check,hasRole,active_member,same,records,count,any,first,create,set,trim } from "@canlang/stdlib";
import { message,renderPage,list,gallery,table,form,content,text,title,edit,badge,breadcrumbs,button,checkbox,input,modal,pagination,select,slot,textarea } from "@canlang/ui";
import { Output,can_view } from "./creative.mjs";
/* Handwritten desired target; shared runtime, gallery renderer and fixture runner
 * are unimplemented. A submission intentionally owns a selected authorized file
 * attachment. It never grants the reviewer access to its private source run/chat.
 * Catalog factories added by the frontend replan (breadcrumbs, pagination, badge,
 * button, modal, slot, select, input, textarea, checkbox) are desired contracts.
 */
export async function can_read(c,person,collection){return person!==null&&await active_member(c,person,c.team)&&collection.active&&(same(collection.owner,person)||any(await records(c,"gallery.Access",{parent:collection}),a=>same(a.account,person)&&a.active));}
export async function can_review(c,person,collection){return person!==null&&hasRole(c,"gallery.reviewer",person)&&await can_read(c,person,collection);}
const approvedDescriptor={owner:"gallery",path:"/gallery",title:message("Approved collections",{nl:"Goedgekeurde collecties"}),poll:1000n,admit:async c=>{check(hasRole(c,"members"),"forbidden");return {};},render:approvedPage};
const submissionsDescriptor={owner:"gallery",path:"/gallery/submit",title:message("My images and submissions",{nl:"Mijn beelden en inzendingen"}),poll:1000n,admit:async c=>{check(hasRole(c,"members"),"forbidden");return {};},render:submissionsPage};
const reviewDescriptor={owner:"gallery",path:"/gallery/review",title:message("Image review",{nl:"Beeldbeoordeling"}),poll:1000n,admit:async c=>{check(hasRole(c,"gallery.reviewer"),"forbidden");return {};},render:reviewPage};
const accessDescriptor={owner:"gallery",path:"/gallery/access",title:message("Collection access",{nl:"Collectietoegang"}),admit:async c=>{check(hasRole(c,"gallery.curator"),"forbidden");return {};},render:accessPage};
export const appDefinition={
 id:"CanGallery",uses:["chat","creative","gallery"],context:{files:{types:["application/pdf","image/png","image/jpeg","text/plain","application/json"]}},
 description:message("Review finalized creative assets and share approved collections without exposing private conversations.",{nl:"Beoordeel afgeronde creatieve bestanden en deel goedgekeurde collecties zonder privégesprekken openbaar te maken."}),
 packages:{gallery:{roles:{curator:{id:"gallery.curator",label:message("Collection curator",{nl:"Collectiebeheerder"})},reviewer:{id:"gallery.reviewer",label:message("Image reviewer",{nl:"Beeldbeoordelaar"})}}}},
 models:{
  "gallery.Collection":{label:message("Image collection",{nl:"Beeldcollectie"}),readGrants:[{rule:"Collection.read.1",fields:["name","owner","active"]}],locks:["Collection.lock.1"],fields:{name:{type:"text",trim:true,max:200n},owner:{type:"user",server:"actor"},active:{type:"bool",default:true}}},
  "gallery.Access":{parent:"gallery.Collection",label:message("Collection access",{nl:"Collectietoegang"}),readGrants:[{rule:"Access.read.1"}],locks:["Access.lock.1"],unique:[{fields:["account"]}],fields:{account:{type:"user"},active:{type:"bool",default:true}}},
  "gallery.Submission":{parent:"gallery.Collection",label:message("Submitted image",{nl:"Ingediend beeld"}),readGrants:[{rule:"Submission.read.1"},{rule:"Submission.read.2",fields:["parent","image","author","title","statement","rights","state","decision","reviewed_by","reason","decided_at","withdraw_reason","withdrawn_by","withdrawn_at","created","updated"]},{rule:"Submission.read.3",fields:["parent","image","author","title","statement","rights","state","decision","reviewed_by","reason","decided_at","created","updated"]}],invariants:["Submission.require.1"],locks:["Submission.lock.1","Submission.lock.2","Submission.lock.3"],unique:[{fields:["output"],where:(c,r)=>["pending","approved"].includes(r.state)}],fields:{output:{type:Output},image:{type:"file"},author:{type:"user",server:"actor"},title:{type:"text",trim:true,max:200n},statement:{type:"text",max:4000n},rights:{type:"text",max:4000n},state:{type:"enum",values:["pending","approved","rejected","withdrawn"],default:"pending",label:{text:message("Review state",{nl:"Beoordelingsstatus"}),values:{pending:message("Awaiting review",{nl:"Wacht op beoordeling"}),approved:message("Approved",{nl:"Goedgekeurd"}),rejected:message("Changes required",{nl:"Wijzigingen nodig"}),withdrawn:message("Withdrawn",{nl:"Ingetrokken"})}}},decision:{type:"enum",values:["approved","rejected"],nullable:true},reviewed_by:{type:"user",nullable:true},reason:{type:"text",nullable:true},decided_at:{type:"datetime",nullable:true},withdraw_reason:{type:"text",nullable:true},withdrawn_by:{type:"user",nullable:true},withdrawn_at:{type:"datetime",nullable:true}}}
 },
 pure:{"gallery.can_read":{handler:"can_read",inputs:{person:{type:"user",nullable:true},collection:{type:"gallery.Collection"}},result:{type:"bool"}},"gallery.can_review":{handler:"can_review",inputs:{person:{type:"user",nullable:true},collection:{type:"gallery.Collection"}},result:{type:"bool"}}},
 operations:{
  "gallery.Collection.create":{handler:"createCollection",kind:"create",model:"gallery.Collection",by:"gallery.curator",when:"Collection",inputs:{fields:["name"]}},
  "gallery.Collection.update":{handler:"updateCollection",kind:"update",model:"gallery.Collection",by:"gallery.curator",when:"Collection",inputs:{record:{type:"gallery.Collection"},changes:{fields:["name","active"]}}},
  "gallery.Access.create":{handler:"createAccess",kind:"create",model:"gallery.Access",by:"gallery.curator",when:"Access",inputs:{fields:["account"]}},
  "gallery.Access.update":{handler:"updateAccess",kind:"update",model:"gallery.Access",by:"gallery.curator",when:"Access",inputs:{record:{type:"gallery.Access"},changes:{fields:["active"]}}},
  "gallery.submit":{handler:"submit",description:message("Submit a readable successful output and explicit rights evidence, copying only the selected finalized image.",{nl:"Dien een leesbaar succesvol resultaat in met expliciet rechtenbewijs en kopieer alleen het geselecteerde afgeronde beeld."}),by:"members",result:{type:"gallery.Submission"},label:message("Submit for review",{nl:"Ter beoordeling indienen"}),inputs:{output:{type:Output},collection:{type:"gallery.Collection"},title:{type:"text"},statement:{type:"text"},rights:{type:"text"}}},
  "gallery.review":{handler:"review",description:message("Record an independent review of exactly the frozen image and evidence.",{nl:"Leg een onafhankelijke beoordeling vast van precies het vastgelegde beeld en bewijs."}),by:"gallery.reviewer",label:message("Review image",{nl:"Beeld beoordelen"}),inputs:{submission:{type:"gallery.Submission"},approve:{type:"bool"},reason:{type:"text"}}},
  "gallery.withdraw":{handler:"withdraw",description:message("Withdraw visibility while retaining the original approval or rejection and who made it.",{nl:"Trek de zichtbaarheid in en behoud de oorspronkelijke goed- of afkeuring en de beoordelaar."}),by:"members",label:message("Withdraw image",{nl:"Beeld intrekken"}),inputs:{submission:{type:"gallery.Submission"},reason:{type:"text"}}},
  "gallery.approved":{handler:"approved",description:message("Return only approved assets under current collection access and normal field/file grants.",{nl:"Toon alleen goedgekeurde bestanden binnen actuele collectietoegang en gewone veld- en bestandsrechten."}),by:"members",read:true,result:{type:"gallery.Submission",array:true},label:message("Open approved collection",{nl:"Goedgekeurde collectie openen"}),inputs:{collection:{type:"gallery.Collection"}}}
 },pages:[approvedDescriptor,submissionsDescriptor,reviewDescriptor,accessDescriptor],disabled:["gallery.Collection.delete","gallery.Access.delete","gallery.Submission.create","gallery.Submission.update","gallery.Submission.delete"]
};
export function canApp(){
 const crudWhen={Collection:(c,r)=>same(r.owner,c.actor),Access:async(c,r)=>same(r.parent.owner,c.actor)&&(!r.active||await active_member(c,r.account,c.team))};
 return {crudWhen,can_read,can_review,
  read:{"Collection.read.1":c=>hasRole(c,"members"),"Access.read.1":(c,r)=>hasRole(c,"members")&&(same(r.account,c.actor)||same(r.parent.owner,c.actor)),"Submission.read.1":(c,r)=>hasRole(c,"members")&&same(r.author,c.actor),"Submission.read.2":(c,r)=>can_review(c,c.actor,r.parent),"Submission.read.3":async(c,r)=>await can_read(c,c.actor,r.parent)&&r.state==="approved"},
  invariants:{"Submission.require.1":(c,r)=>(r.decision===null&&r.reviewed_by===null&&r.decided_at===null)||(r.decision!==null&&r.reviewed_by!==null&&r.decided_at!==null&&!same(r.reviewed_by,r.author))},
  locks:{"Collection.lock.1":{fields:["owner"]},"Access.lock.1":{fields:["account"]},"Submission.lock.1":{fields:["output","image","author","title","statement","rights"]},"Submission.lock.2":{fields:["decision","reviewed_by","reason","decided_at"],when:(c,r)=>r.decision!==null},"Submission.lock.3":{fields:["state","withdraw_reason","withdrawn_by","withdrawn_at"],when:(c,r)=>r.state==="withdrawn"}},
  async createCollection(c,input){check(hasRole(c,"gallery.curator"),"forbidden");await create(c,"gallery.Collection",input,{when:crudWhen.Collection});},
  async updateCollection(c,{record,changes}){check(hasRole(c,"gallery.curator"),"forbidden");await set(c,record,changes,{when:crudWhen.Collection});},
  async createAccess(c,input){check(hasRole(c,"gallery.curator"),"forbidden");await create(c,"gallery.Access",input,{when:crudWhen.Access});},
  async updateAccess(c,{record,changes}){check(hasRole(c,"gallery.curator"),"forbidden");await set(c,record,changes,{when:crudWhen.Access});},
  async submit(c,{output,collection,title,statement,rights}){check(hasRole(c,"members"),"forbidden");check(await can_view(c,c.actor,output.parent)&&output.parent.state==="succeeded"&&collection.active);check(trim(title)!==""&&trim(statement)!==""&&trim(rights)!=="");check(!any(await records(c,"gallery.Submission",{parent:collection}),r=>same(r.output,output)&&["pending","approved"].includes(r.state)));return await create(c,"gallery.Submission",{parent:collection,output,image:output.image,title,statement,rights});},
  async review(c,{submission,approve,reason}){check(hasRole(c,"gallery.reviewer"),"forbidden");check(await can_review(c,c.actor,submission.parent)&&submission.state==="pending"&&!same(submission.author,c.actor)&&trim(reason)!=="");if(approve)await set(c,submission,{state:"approved",decision:"approved",reviewed_by:c.actor,reason,decided_at:c.now});else await set(c,submission,{state:"rejected",decision:"rejected",reviewed_by:c.actor,reason,decided_at:c.now});},
  async withdraw(c,{submission,reason}){check(hasRole(c,"members"),"forbidden");check(same(submission.author,c.actor)||await can_review(c,c.actor,submission.parent)||(hasRole(c,"gallery.curator")&&same(submission.parent.owner,c.actor)));check(submission.state!=="withdrawn"&&trim(reason)!=="");await set(c,submission,{state:"withdrawn",withdraw_reason:reason,withdrawn_by:c.actor,withdrawn_at:c.now});},
  async approved(c,{collection}){check(hasRole(c,"members"),"forbidden");check(await can_read(c,c.actor,collection));return await records(c,"gallery.Submission",{parent:collection,where:r=>r.state==="approved",order:{by:r=>r.decided_at,direction:"desc"}});}
 };
}
export async function approvedPage(c){return renderPage(c,approvedDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination. */
 breadcrumbs({context:c}),
 list({context:c,model:"gallery.Collection",where:collection=>can_read(c,c.actor,collection),empty:message("No collections available",{nl:"Geen collecties beschikbaar"}),renderRow:(collection,cv)=>[
  pagination({context:cv}),
  title({context:cv,value:collection.name}),
  form({context:cv,operation:"gallery.approved",arguments:{collection},renderResult:(result,rv)=>[gallery({context:rv,items:result,image:"image",empty:message("No approved images yet",{nl:"Nog geen goedgekeurde beelden"}),renderRow:(row,iv)=>[
   pagination({context:iv}),
   title({context:iv,value:row.title}),text({context:iv,values:[row.author,row.rights,row.decided_at]})]})]})]})]);}
export async function submissionsPage(c){return renderPage(c,submissionsDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, badge, button, modal, slot, select, input, textarea. */
 breadcrumbs({context:c}),
 gallery({context:c,model:Output,where:output=>output.parent.state==="succeeded",image:"image",empty:message("No successful images to submit",{nl:"Geen geslaagde beelden om in te dienen"}),renderRow:(output,ov)=>[
  pagination({context:ov}),
  form({context:ov,operation:"gallery.submit",arguments:{output},children:[select({context:ov,field:"collection"}),input({context:ov,field:"title"}),textarea({context:ov,field:"statement"}),textarea({context:ov,field:"rights"})]})]}),
 gallery({context:c,model:"gallery.Submission",where:submission=>same(submission.author,c.actor),image:"image",empty:message("No submissions yet",{nl:"Nog geen inzendingen"}),renderRow:(submission,sv)=>[
  pagination({context:sv}),
  title({context:sv,value:submission.title}),badge({context:sv,value:submission.state}),text({context:sv,values:[submission.reason,submission.withdraw_reason]}),
  button({context:sv,opens:"withdraw_image"}),
  modal({context:sv,caption:message("Withdraw image",{nl:"Beeld intrekken"}),id:"withdraw_image",children:[slot({context:sv,name:"content",children:[form({context:sv,operation:"gallery.withdraw",arguments:{submission},display:"inline",children:[textarea({context:sv,field:"reason"})]})]})]})]})]);}
export async function reviewPage(c){return renderPage(c,reviewDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, button, modal, slot, checkbox, textarea. */
 breadcrumbs({context:c}),
 gallery({context:c,model:"gallery.Submission",where:async s=>s.state==="pending"&&await can_review(c,c.actor,s.parent),image:"image",empty:message("No images awaiting review",{nl:"Geen beelden ter beoordeling"}),renderRow:(submission,sv)=>[
  pagination({context:sv}),
  title({context:sv,value:submission.title}),content({context:sv,value:submission.statement}),text({context:sv,values:[submission.author,submission.rights]}),
  button({context:sv,opens:"review_image"}),
  modal({context:sv,caption:message("Review image",{nl:"Beeld beoordelen"}),id:"review_image",children:[slot({context:sv,name:"content",children:[form({context:sv,operation:"gallery.review",arguments:{submission},display:"inline",children:[checkbox({context:sv,field:"approve"}),textarea({context:sv,field:"reason"})]})]})]})]})]);}
export async function accessPage(c){return renderPage(c,accessDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, input. */
 breadcrumbs({context:c}),
 form({context:c,operation:"gallery.Collection.create",children:[input({context:c,field:"name"})]}),
 list({context:c,model:"gallery.Collection",where:r=>same(r.owner,c.actor),empty:message("No collections yet",{nl:"Nog geen collecties"}),renderRow:(collection,cv)=>[
  pagination({context:cv}),
  title({context:cv,value:collection.name}),edit({context:cv,operation:"gallery.Collection.update",record:collection,fields:["name","active"]}),
  form({context:cv,operation:"gallery.Access.create",arguments:{parent:collection}}),
  table({context:cv,model:"gallery.Access",parent:collection,columns:["account","active"],empty:message("No granted accounts",{nl:"Geen accounts met toegang"}),renderRow:(record,av)=>[pagination({context:av}),edit({context:av,operation:"gallery.Access.update",record,fields:["active"]})]})]})]);}
export const exampleImports=[{provider:"creative",member:"output",alias:"output"},{provider:"creative",member:"completed",alias:"completed"},{provider:"creative",member:"completed_request",alias:"completed_request"}];
export function exampleFixtures({self,other,imported}){
 const {output,completed,completed_request}=imported;
 const gallery_curator={dependencies:[],user:async()=>({roles:["gallery.curator"]})};
 const gallery_reviewer={dependencies:[],user:async()=>({roles:["gallery.reviewer"]})};
 const collection={model:"gallery.Collection",dependencies:[gallery_curator],value:async(c,s)=>({name:"Approved campaign art",owner:s.gallery_curator})};
 const reviewer_access={model:"gallery.Access",dependencies:[collection,gallery_reviewer],value:async(c,s)=>({parent:s.collection,account:s.gallery_reviewer})};
 const audience={model:"gallery.Access",dependencies:[collection,self],value:async(c,s)=>({parent:s.collection,account:s.self})};
 const submission={model:"gallery.Submission",dependencies:[collection,output,self],value:async(c,s)=>({parent:s.collection,output:s.output,image:s.output.image,author:s.self,title:"Quiet garden",statement:"For the launch presentation",rights:"Original generated artwork reviewed for company use"})};
 return {fixtures:{gallery_curator,gallery_reviewer,collection,reviewer_access,audience,submission},examples:[
  {operation:"gallery.submit",dependencies:[output,collection,self],inputs:async(c,s)=>({output:s.output,collection:s.collection,title:"Quiet garden",statement:"For the launch presentation",rights:"Company use reviewed"}),selectors:["as","completed_request.result","collection.active"],observations:[async(c,s)=>count(await records(c,"gallery.Submission",{parent:s.collection}))],rows:[
   {dependencies:[self],values:async(c,s)=>[s.self,{source:"creative-completed",revision:1n,sequence:2n,state:"succeeded",outputs:[{position:0n,image:s.output.image}],charged_jobs:1n,detail:null},true],expected:async()=>[1n]},
   {dependencies:[self],values:async(c,s)=>[s.self,{source:"creative-completed",revision:1n,sequence:2n,state:"failed",outputs:[{position:0n,image:s.output.image}],charged_jobs:1n,detail:null},true],error:"rule_failed"},
   {dependencies:[self],values:async(c,s)=>[s.self,{source:"creative-completed",revision:1n,sequence:2n,state:"succeeded",outputs:[{position:0n,image:s.output.image}],charged_jobs:1n,detail:null},false],error:"rule_failed"},
   {dependencies:[other],values:async(c,s)=>[s.other,{source:"creative-completed",revision:1n,sequence:2n,state:"succeeded",outputs:[{position:0n,image:s.output.image}],charged_jobs:1n,detail:null},true],error:"rule_failed"}]},
  {operation:"gallery.review",dependencies:[reviewer_access,submission],inputs:async(c,s)=>({submission:s.submission,approve:true,reason:"Rights and image reviewed"}),selectors:["as","reviewer_access.active","submission.author","completed.author"],observations:[async(c,s)=>s.submission.state,async(c,s)=>s.submission.reviewed_by],rows:[
   {dependencies:[gallery_reviewer,self],values:async(c,s)=>[s.gallery_reviewer,true,s.self,s.self],expected:async(c,s)=>["approved",s.gallery_reviewer]},
   {dependencies:[gallery_reviewer,self],values:async(c,s)=>[s.gallery_reviewer,false,s.self,s.self],error:"rule_failed"},
   {dependencies:[gallery_reviewer],values:async(c,s)=>[s.gallery_reviewer,true,s.gallery_reviewer,s.gallery_reviewer],error:"rule_failed"},
   {dependencies:[self],values:async(c,s)=>[s.self,true,s.self,s.self],error:"forbidden"}]},
  {operation:"gallery.review",dependencies:[reviewer_access,audience,submission],sequence:[
   {operation:"gallery.approved",by:async(c,s)=>s.self,inputs:async(c,s)=>({collection:s.collection}),bind:"before"},
   {observations:async(c,s,b)=>[count(b.before)],expected:async()=>[0n],types:["int"]},
   {operation:"gallery.review",by:async(c,s)=>s.gallery_reviewer,inputs:async(c,s)=>({submission:s.submission,approve:true,reason:"Approved for company launch materials"})},
   {operation:"gallery.approved",by:async(c,s)=>s.self,inputs:async(c,s)=>({collection:s.collection}),bind:"shared"},
   {observations:async(c,s,b)=>[count(b.shared),first(b.shared)?.image??null,first(b.shared)?.decision??null],expected:async(c,s)=>[1n,s.output.image,"approved"],types:["int","file?","gallery.Submission.decision?"]},
   {operation:"gallery.Access.update",by:async(c,s)=>s.gallery_curator,inputs:async(c,s)=>({record:s.audience,changes:{active:false}})},
   {operation:"gallery.approved",by:async(c,s)=>s.self,inputs:async(c,s)=>({collection:s.collection}),error:"rule_failed"},
   {operation:"gallery.withdraw",by:async(c,s)=>s.self,inputs:async(c,s)=>({submission:s.submission,reason:"Usage consent withdrawn"})},
   {observations:async(c,s)=>[s.submission.state,s.submission.decision,s.submission.reason,s.submission.withdraw_reason],expected:async()=>["withdrawn","approved","Approved for company launch materials","Usage consent withdrawn"],types:["gallery.Submission.state","gallery.Submission.decision?","text?","text?"]},
   {operation:"gallery.approved",by:async(c,s)=>s.gallery_reviewer,inputs:async(c,s)=>({collection:s.collection}),bind:"after"},
   {observations:async(c,s,b)=>[count(b.after)],expected:async()=>[0n],types:["int"]}
  ]}
 ]};
}
