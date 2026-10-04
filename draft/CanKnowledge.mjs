import { active_member, any, corpusStatus, count, create, delivery, first, groundedAvailable, hasRole, int64, local_date, records, require as check, same, send, set, trim } from "@canlang/stdlib";
import { actions, alert, badge, breadcrumbs, button, checkbox, collapse, content, edit, fieldset, form, history, input, list, message, modal, pagination, progress, renderPage, select, slot, status, table, text, textarea } from "@canlang/ui";

/* Handwritten desired target. DESIGN §13 and the accepted knowledge corpus contract
 * own admission, current grants, immutable revisions/files, grounded provenance,
 * index maintenance, observed runs, exact scalars and bounded canonical UI/MCP.
 * There is no app chunk/ACL cache, raw generated-text store or second result schema.
 * Catalog factories added by the frontend replan (breadcrumbs, pagination, badge,
 * status, collapse, alert, fieldset, input, select, checkbox, textarea, button,
 * modal, slot, progress) are desired contracts.
 * These imports, renderer, corpus controller and BDD runner are unimplemented. */
const knowledgeDescriptor = { owner: "knowledge", path: "/knowledge", title: message("Company knowledge", {nl:"Bedrijfskennis"}), poll: 5000n, admit: async c => { check(hasRole(c,"members"),"forbidden"); return {}; }, render: knowledgePage };
const editorDescriptor = { owner: "knowledge", path: "/knowledge/editor", title: message("Procedure editing", {nl:"Procedures bewerken"}), admit: async c => { check(hasRole(c,"knowledge.knowledge_author") || hasRole(c,"knowledge.knowledge_reviewer") ,"forbidden"); return {}; }, render: editorPage };
const expertDescriptor = { owner: "knowledge", path: "/knowledge/expert", title: message("Expert questions", {nl:"Expertvragen"}), admit: async c => { check(hasRole(c,"members"),"forbidden"); return {}; }, render: expertPage };
const settingsDescriptor = { owner: "knowledge", path: "/knowledge/settings", title: message("Knowledge settings", {nl:"Kennisinstellingen"}), admit: async c => { check(hasRole(c,"knowledge.knowledge_manager"),"forbidden"); return {}; }, render: settingsPage };

export const appDefinition = {
  id:"CanKnowledge", uses:["knowledge"],
  description:message("Publish reviewed company procedures and answer private questions with current authorized evidence.",{nl:"Publiceer beoordeelde bedrijfsprocedures en beantwoord privévragen met actueel bevoegd bewijs."}),
  context:{files:{types:["application/pdf","text/plain"],max:5242880n}},
  packages:{knowledge:{label:message("Company knowledge",{nl:"Bedrijfskennis"}),roles:{
    knowledge_manager:{id:"knowledge.knowledge_manager",label:message("Knowledge administrator",{nl:"Kennisbeheerder"})},
    knowledge_author:{id:"knowledge.knowledge_author",label:message("Procedure author",{nl:"Procedureauteur"})},
    knowledge_reviewer:{id:"knowledge.knowledge_reviewer",label:message("Publication reviewer",{nl:"Publicatiebeoordelaar"})},
  }}},
  corpora:{"knowledge.Handbook":{
    model:"knowledge.Revision",scope:"parent.parent",title:"title",content:["body","attachments"],from:"deployment.knowledge",eligible:(c,row)=>live(c,row),
    description:message("Index only current publications; derive retrieval from the same source fields and current read policies.",{nl:"Indexeer alleen actuele publicaties; leid opvraging af uit dezelfde bronvelden en actuele leesregels."}),
  }},
  models:{
    "knowledge.Topic":{label:message("Knowledge topic",{nl:"Kennisonderwerp"}),readGrants:[{rule:"Topic.read.1"}],invariants:["Topic.require.1"],fields:{
      name:{type:"text",trim:true,min:1n,max:100n},expert:{type:"user",label:message("Accountable expert",{nl:"Verantwoordelijke expert"})},active:{type:"bool",default:true},profile:{type:"text",min:1n,max:200n},policy_revision:{type:"text",min:1n,max:200n},input_tokens:{type:"int",default:8192n,min:1n,max:32768n},output_tokens:{type:"int",default:2048n,min:1n,max:4096n},duration:{type:"duration",default:120000n},daily_limit:{type:"int",default:20n,min:1n,max:100n},
    }},
    "knowledge.Audience":{parent:"knowledge.Topic",label:message("Topic readership",{nl:"Lezers van onderwerp"}),readGrants:[{rule:"Audience.read.1"}],unique:[{fields:["account"]}],locks:["Audience.lock.1"],fields:{account:{type:"user"},active:{type:"bool",default:true}}},
    "knowledge.Document":{parent:"knowledge.Topic",label:message("Procedure",{nl:"Procedure"}),readGrants:[{rule:"Document.read.1"},{rule:"Document.read.2",fields:["parent","name","owner","active","current"]}],locks:["Document.lock.1"],derived:{current:{handler:"Document.current",type:"knowledge.Revision",nullable:true}},fields:{name:{type:"text",trim:true,min:1n,max:200n},owner:{type:"user",server:"actor"},active:{type:"bool",default:true}}},
    "knowledge.Revision":{parent:"knowledge.Document",label:message("Immutable revision",{nl:"Onveranderlijke revisie"}),readGrants:[{rule:"Revision.read.1"}],unique:[{fields:["number"]}],invariants:["Revision.require.1"],locks:["Revision.lock.1"],derived:{index:{handler:"Revision.index",type:"std.IndexState",label:message("Index readiness",{nl:"Indexgereedheid"})}},fields:{number:{type:"int",min:1n,max:100n},title:{type:"text",trim:true,min:1n,max:200n},body:{type:"text",max:20000n},attachments:{type:"file",array:true,max:4n},author:{type:"user",server:"actor"},authored:{type:"datetime",server:"now"}}},
    "knowledge.Publication":{parent:"knowledge.Document",label:message("Publication decision",{nl:"Publicatiebesluit"}),readGrants:[{rule:"Publication.read.1"},{rule:"Publication.read.2",fields:["revision","active"]},{rule:"Publication.read.3",fields:["revision","active"]}],unique:[{fields:["revision"]},{fields:["active"],where:(c,row)=>row.active}],invariants:["Publication.require.1","Publication.require.2"],locks:["Publication.lock.1","Publication.lock.2"],fields:{revision:{type:"knowledge.Revision"},reason:{type:"text",trim:true,min:1n,max:2000n},reviewer:{type:"user",server:"actor"},reviewed:{type:"datetime",server:"now"},active:{type:"bool",default:true},withdrawal:{type:"text",nullable:true},withdrawn_by:{type:"user",nullable:true},withdrawn_at:{type:"datetime",nullable:true}}},
    "knowledge.DailyUsage":{parent:"knowledge.Topic",label:message("Question budget usage",{nl:"Verbruik vragenbudget"}),readGrants:[{rule:"DailyUsage.read.1"}],unique:[{fields:["account","day"]}],locks:["DailyUsage.lock.1"],fields:{account:{type:"user"},day:{type:"date"},requests:{type:"int",min:0n}}},
    "knowledge.Question":{parent:"knowledge.Topic",label:message("Private question",{nl:"Privévraag"}),readGrants:[{rule:"Question.read.1"},{rule:"Question.read.2",fields:["parent","account","request_value.question"]}],locks:["Question.lock.1"],derived:{
      state:{handler:"Question.state",type:"std.TextRun.state",nullable:true,label:message("Answer progress",{nl:"Antwoordvoortgang"})},coverage:{handler:"Question.coverage",type:"knowledge.Handbook.Run.coverage",nullable:true,label:message("Indexed source coverage",{nl:"Dekking geïndexeerde bronnen"})},answer:{handler:"Question.answer",type:"knowledge.Handbook.Answer",nullable:true},used:{handler:"Question.used",type:"int",nullable:true,label:message("Measured tokens",{nl:"Gemeten tokens"})},transport:{handler:"Question.transport",type:"std.DeliveryResult.status",nullable:true,label:message("Request delivery",{nl:"Verzoekbezorging"})},
    },fields:{account:{type:"user",server:"actor"},request_value:{type:"std.KnowledgeRequest"},request:{type:"delivery",operation:"knowledge.Handbook.answer",nullable:true},cancellation:{type:"delivery",operation:"knowledge.Handbook.cancel",nullable:true},reconciliation:{type:"delivery",operation:"knowledge.Handbook.reconcile",nullable:true},checks:{type:"int",default:0n,min:0n,max:3n},stop_requested:{type:"bool",default:false},unfinished:{type:"bool",default:true}}},
    "knowledge.Escalation":{parent:"knowledge.Question",label:message("Unresolved question",{nl:"Onopgeloste vraag"}),readGrants:[{rule:"Escalation.read.1"},{rule:"Escalation.read.2",fields:["parent","reason","state","resolution","resolved_by","resolved_at"]},{rule:"Escalation.read.3",fields:["note"]}],unique:[{fields:["state"],where:(c,row)=>row.state==="open"}],invariants:["Escalation.require.1"],locks:["Escalation.lock.1","Escalation.lock.2"],fields:{reason:{type:"text",trim:true,min:1n,max:2000n},state:{type:"enum",cases:["open","resolved","dismissed"],default:"open",label:{text:message("Expert review",{nl:"Expertbeoordeling"}),values:{open:message("Awaiting expert",{nl:"Wacht op expert"}),resolved:message("Published guidance supplied",{nl:"Gepubliceerde uitleg verstrekt"}),dismissed:message("Closed with explanation",{nl:"Gesloten met uitleg"})}}},resolution:{type:"knowledge.Revision",nullable:true},note:{type:"text",nullable:true},resolved_by:{type:"user",nullable:true},resolved_at:{type:"datetime",nullable:true}}},
  },
  pure:{
    "knowledge.readership":{handler:"readership",inputs:{person:{type:"user"},topic:{type:"knowledge.Topic"}},result:{type:"bool"}},
    "knowledge.editorial":{handler:"editorial",inputs:{person:{type:"user"},document:{type:"knowledge.Document"}},result:{type:"bool"}},
    "knowledge.live":{handler:"live",inputs:{revision:{type:"knowledge.Revision"}},result:{type:"bool"}},
  },
  operations:{
    "knowledge.Topic.create":{handler:"createTopic",kind:"create",model:"knowledge.Topic",by:"knowledge.knowledge_manager",when:"Topic",inputs:{fields:["name","expert","active","profile","policy_revision","input_tokens","output_tokens","duration","daily_limit"]}},
    "knowledge.Topic.update":{handler:"updateTopic",kind:"update",model:"knowledge.Topic",by:"knowledge.knowledge_manager",when:"Topic",inputs:{record:{type:"knowledge.Topic"},changes:{fields:["name","expert","active","profile","policy_revision","input_tokens","output_tokens","duration","daily_limit"]}}},
    "knowledge.Audience.create":{handler:"createAudience",kind:"create",model:"knowledge.Audience",by:"knowledge.knowledge_manager",when:"Audience",inputs:{parent:{type:"knowledge.Topic"},fields:["account","active"]}},
    "knowledge.Audience.update":{handler:"updateAudience",kind:"update",model:"knowledge.Audience",by:"knowledge.knowledge_manager",when:"Audience",inputs:{record:{type:"knowledge.Audience"},changes:{fields:["active"]}}},
    "knowledge.create_document":{handler:"create_document",description:message("Start a procedure under the author's explicit topic readership.",{nl:"Start een procedure binnen het expliciete leesrecht van de auteur op het onderwerp."}),by:"knowledge.knowledge_author",result:{type:"knowledge.Document"},label:message("New procedure",{nl:"Nieuwe procedure"}),inputs:{topic:{type:"knowledge.Topic"},name:{type:"text"}}},
    "knowledge.revise":{handler:"revise",description:message("Preserve each candidate's exact text and finalized files before independent approval.",{nl:"Bewaar de exacte tekst en afgeronde bestanden van elke kandidaat vóór onafhankelijke goedkeuring."}),by:"knowledge.knowledge_author",result:{type:"knowledge.Revision"},label:message("Propose revision",{nl:"Revisie voorstellen"}),inputs:{document:{type:"knowledge.Document"},title:{type:"text"},body:{type:"text"},attachments:{type:"file",array:true,default:[]}}},
    "knowledge.publish":{handler:"publish",description:message("A different reviewer publishes a revision and retires the earlier current publication atomically.",{nl:"Een andere beoordelaar publiceert een revisie en trekt de vorige actuele publicatie atomair in."}),by:"knowledge.knowledge_reviewer",label:message("Approve publication",{nl:"Publicatie goedkeuren"}),inputs:{revision:{type:"knowledge.Revision"},reason:{type:"text"}}},
    "knowledge.withdraw":{handler:"withdraw",description:message("Withdraw current guidance without erasing its review evidence or waiting for index deletion.",{nl:"Trek actuele uitleg in zonder beoordelingsbewijs te wissen of op indexverwijdering te wachten."}),by:"knowledge.knowledge_reviewer",label:message("Withdraw publication",{nl:"Publicatie intrekken"}),inputs:{publication:{type:"knowledge.Publication"},reason:{type:"text"}}},
    "knowledge.assign_author":{handler:"assign_author",description:message("Restore a responsible author without changing any already reviewed revision.",{nl:"Wijs een verantwoordelijke auteur toe zonder bestaande beoordeelde revisies te wijzigen."}),by:"knowledge.knowledge_manager",label:message("Assign author",{nl:"Auteur aanwijzen"}),inputs:{document:{type:"knowledge.Document"},account:{type:"user"}}},
    "knowledge.document_status":{handler:"document_status",description:message("Pause or restore future source eligibility; all revision history remains intact.",{nl:"Pauzeer of herstel toekomstig brongebruik; alle revisiegeschiedenis blijft bewaard."}),by:"knowledge.knowledge_reviewer",label:message("Set procedure availability",{nl:"Beschikbaarheid procedure instellen"}),inputs:{document:{type:"knowledge.Document"},active:{type:"bool"}}},
    "knowledge.reindex":{handler:"reindex",description:message("Repair indexing of the exact current revision using shared bounded indexing machinery.",{nl:"Herstel indexering van de exacte actuele revisie via gedeelde begrensde indexering."}),by:"members",label:message("Refresh source index",{nl:"Bronindex vernieuwen"}),inputs:{revision:{type:"knowledge.Revision"}}},
    "knowledge.ask":{handler:"ask",description:message("Count a durable question before sending; a lost response never earns an unproven budget refund.",{nl:"Tel een duurzame vraag vóór verzending; een verloren antwoord geeft nooit een onbewezen budgetteruggave."}),by:"members",result:{type:"knowledge.Question"},label:message("Ask a private question",{nl:"Privévraag stellen"}),inputs:{topic:{type:"knowledge.Topic"},question:{type:"std.KnowledgeRequest.question"}}},
    "knowledge.read_answer":{handler:"read_answer",description:message("Return only a currently disclosable grounded value; its shared view distinguishes current from historical scope.",{nl:"Geef alleen een nu toonbaar onderbouwd antwoord terug; de gedeelde weergave onderscheidt actuele en historische bronselectie."}),by:"members",read:true,result:{type:"knowledge.Handbook.Answer",nullable:true},label:message("Read sourced answer",{nl:"Antwoord met bronnen lezen"}),inputs:{question:{type:"knowledge.Question"}}},
    "knowledge.stop":{handler:"stop",description:message("Request cancellation of this one question; keep uncertainty and its consumed request slot visible.",{nl:"Vraag annulering van deze ene vraag aan; houd onzekerheid en de verbruikte plek zichtbaar."}),by:"members",label:message("Stop answer",{nl:"Antwoord stoppen"}),inputs:{question:{type:"knowledge.Question"}}},
    "knowledge.reconcile":{handler:"reconcile",description:message("Reconcile the original question without creating another model request.",{nl:"Controleer de oorspronkelijke vraag zonder een nieuw modelverzoek te maken."}),by:"members",label:message("Check answer outcome",{nl:"Antwoordresultaat controleren"}),inputs:{question:{type:"knowledge.Question"}}},
    "knowledge.release_skipped":{handler:"release_skipped",description:message("Release only a proved undispatched question from the two-question concurrency bound.",{nl:"Haal alleen een bewezen niet-verzonden vraag uit de limiet van twee gelijktijdige vragen."}),by:"members",label:message("Release unsent question",{nl:"Niet-verzonden vraag vrijgeven"}),inputs:{question:{type:"knowledge.Question"}}},
    "knowledge.escalate":{handler:"escalate",description:message("Share the exact question and your explanation with the topic's accountable expert and successors.",{nl:"Deel de exacte vraag en je uitleg met de verantwoordelijke onderwerpexpert en opvolgers."}),by:"members",label:message("Ask the expert",{nl:"Expert inschakelen"}),inputs:{question:{type:"knowledge.Question"},reason:{type:"text"},share:{type:"bool",label:message("Share this question with the topic expert",{nl:"Deze vraag delen met de onderwerpexpert"})}}},
    "knowledge.resolve":{handler:"resolve",description:message("Resolve with current published guidance the requester can read, or close with an attributable explanation.",{nl:"Los op met actuele gepubliceerde uitleg die de vragensteller mag lezen, of sluit met een herleidbare uitleg."}),by:"members",label:message("Record expert resolution",{nl:"Expertoplossing vastleggen"}),inputs:{issue:{type:"knowledge.Escalation"},revision:{type:"knowledge.Revision",nullable:true},note:{type:"text"}}},
  },
  handlers:{"knowledge.progressed":{handler:"progressed",on:"knowledge.Handbook.answer.progressed"}},
  pages:[knowledgeDescriptor,editorDescriptor,expertDescriptor,settingsDescriptor],
  disabled:["knowledge.Topic.delete","knowledge.Audience.delete","knowledge.Document.create","knowledge.Document.update","knowledge.Document.delete","knowledge.Revision.create","knowledge.Revision.update","knowledge.Revision.delete","knowledge.Publication.create","knowledge.Publication.update","knowledge.Publication.delete","knowledge.DailyUsage.create","knowledge.DailyUsage.update","knowledge.DailyUsage.delete","knowledge.Question.create","knowledge.Question.update","knowledge.Question.delete","knowledge.Escalation.create","knowledge.Escalation.update","knowledge.Escalation.delete"],
};

async function readership(c,person,topic){return active_member(c,person,c.team) && (same(topic.expert,person) || await any(records(c,"knowledge.Audience",{parent:topic}),grant=>same(grant.account,person)&&grant.active));}
function editorial(c,person,document){return hasRole(c,"knowledge.knowledge_reviewer",person)||same(document.owner,person)||same(document.parent.expert,person);}
async function live(c,revision){return revision.parent.active && revision.parent.parent.active && await any(records(c,"knowledge.Publication",{parent:revision.parent}),publication=>publication.active&&same(publication.revision,revision));}
export function canApp(){
 const crudWhen={Topic:(c,row)=>active_member(c,row.expert,c.team),Audience:(c,row)=>!row.active||active_member(c,row.account,c.team)};
 return {
  readership,editorial,live,crudWhen,
  read:{
   "Topic.read.1":c=>hasRole(c,"members"),"Audience.read.1":(c,r)=>hasRole(c,"knowledge.knowledge_manager")||same(r.account,c.actor),
   "Document.read.1":async(c,r)=>hasRole(c,"members")&&(editorial(c,c.actor,r)||(r.active&&r.parent.active&&await readership(c,c.actor,r.parent))),
   "Document.read.2":c=>hasRole(c,"knowledge.knowledge_manager"),
   "Revision.read.1":async(c,r)=>hasRole(c,"members")&&(editorial(c,c.actor,r.parent)||(await live(c,r)&&await readership(c,c.actor,r.parent.parent))),
   "Publication.read.1":(c,r)=>hasRole(c,"members")&&editorial(c,c.actor,r.parent),
   "Publication.read.2":async(c,r)=>hasRole(c,"members")&&r.active&&await readership(c,c.actor,r.parent.parent),
   "Publication.read.3":c=>hasRole(c,"knowledge.knowledge_manager"),
   "DailyUsage.read.1":(c,r)=>hasRole(c,"knowledge.knowledge_manager")||same(r.account,c.actor),
   "Question.read.1":(c,r)=>hasRole(c,"members")&&same(r.account,c.actor),
   "Question.read.2":async(c,r)=>hasRole(c,"members")&&same(r.parent.expert,c.actor)&&await count(records(c,"knowledge.Escalation",{parent:r}))>0n,
   "Escalation.read.1":(c,r)=>hasRole(c,"members")&&same(r.parent.parent.expert,c.actor),
   "Escalation.read.2":(c,r)=>hasRole(c,"members")&&same(r.parent.account,c.actor),
   "Escalation.read.3":async(c,r)=>hasRole(c,"members")&&same(r.parent.account,c.actor)&&(r.state==="dismissed"||(r.resolution!==null&&await live(c,r.resolution)&&await readership(c,c.actor,r.parent.parent))),
  },
  invariants:{
   "Topic.require.1":(c,r)=>r.duration>=1000n&&r.duration<=600000n,
   "Revision.require.1":async(c,r)=>trim(r.body)!==""||await count(r.attachments)>0n,
   "Publication.require.1":(c,r)=>same(r.revision.parent,r.parent)&&!same(r.reviewer,r.revision.author),
   "Publication.require.2":(c,r)=>(r.withdrawn_at===null)===r.active&&(r.withdrawn_by===null)===r.active&&(r.withdrawal===null)===r.active,
   "Escalation.require.1":(c,r)=>(r.state==="resolved")===(r.resolution!==null)&&(r.state==="open")===(r.resolved_by===null)&&(r.state==="open")===(r.resolved_at===null)&&(r.state==="open")===(r.note===null),
  },
  locks:{
   "Audience.lock.1":{fields:["parent","account"]},"Document.lock.1":{fields:["parent"]},
   "Revision.lock.1":{fields:["parent","number","title","body","attachments","author","authored"]},
   "Publication.lock.1":{fields:["parent","revision","reason","reviewer","reviewed"]},"Publication.lock.2":{fields:["active","withdrawal","withdrawn_by","withdrawn_at"],when:(c,r)=>!r.active},
   "DailyUsage.lock.1":{fields:["parent","account","day"]},"Question.lock.1":{fields:["parent","account","request_value","request"]},
   "Escalation.lock.1":{fields:["parent","reason"]},"Escalation.lock.2":{fields:["state","resolution","note","resolved_by","resolved_at"],when:(c,r)=>r.state!=="open"},
  },
  derives:{
   "Document.current":async(c,r)=>(await first(records(c,"knowledge.Publication",{parent:r,where:p=>p.active})))?.revision??null,
   "Revision.index":(c,r)=>corpusStatus(c,"knowledge.Handbook",r),
   "Question.state":async(c,r)=>(await delivery(c,{record:r,field:"request"},["progress.state"]))?.progress?.state??null,
   "Question.coverage":async(c,r)=>(await delivery(c,{record:r,field:"request"},["progress.coverage"]))?.progress?.coverage??null,
   "Question.answer":async(c,r)=>(await delivery(c,{record:r,field:"request"},["progress.answer"]))?.progress?.answer??null,
   "Question.used":async(c,r)=>(await delivery(c,{record:r,field:"request"},["progress.used_tokens"]))?.progress?.used_tokens??null,
   "Question.transport":async(c,r)=>(await delivery(c,{record:r,field:"request"},["status"]))?.status??null,
  },
  async createTopic(c,input){check(hasRole(c,"knowledge.knowledge_manager"),"forbidden");return create(c,"knowledge.Topic",input,{when:crudWhen.Topic});},
  async updateTopic(c,{record,changes}){check(hasRole(c,"knowledge.knowledge_manager"),"forbidden");return set(c,record,changes,{when:crudWhen.Topic});},
  async createAudience(c,input){check(hasRole(c,"knowledge.knowledge_manager"),"forbidden");return create(c,"knowledge.Audience",input,{when:crudWhen.Audience});},
  async updateAudience(c,{record,changes}){check(hasRole(c,"knowledge.knowledge_manager"),"forbidden");return set(c,record,changes,{when:crudWhen.Audience});},
  async create_document(c,{topic,name}){check(hasRole(c,"knowledge.knowledge_author"),"forbidden");check(topic.active&&await readership(c,c.actor,topic)&&trim(name)!=="");const document=await create(c,"knowledge.Document",{parent:topic,name});return document;},
  async revise(c,{document,title,body,attachments=[]}){check(hasRole(c,"knowledge.knowledge_author"),"forbidden");check(same(document.owner,c.actor)&&document.active&&document.parent.active&&await count(records(c,"knowledge.Revision",{parent:document}))<100n&&trim(title)!==""&&(trim(body)!==""||await count(attachments)>0n)&&await count(attachments)<=4n);const revision=await create(c,"knowledge.Revision",{parent:document,number:int64(await count(records(c,"knowledge.Revision",{parent:document}))+1n),title,body,attachments});return revision;},
  async publish(c,{revision,reason}){check(hasRole(c,"knowledge.knowledge_reviewer"),"forbidden");check(!same(revision.author,c.actor)&&revision.parent.active&&revision.parent.parent.active&&trim(reason)!==""&&!await any(records(c,"knowledge.Publication",{parent:revision.parent}),p=>same(p.revision,revision)));for(const publication of await records(c,"knowledge.Publication",{parent:revision.parent,where:r=>r.active,limit:1n}))await set(c,publication,{active:false,withdrawal:reason,withdrawn_by:c.actor,withdrawn_at:c.now});const publication=await create(c,"knowledge.Publication",{parent:revision.parent,revision,reason});},
  async withdraw(c,{publication,reason}){check(hasRole(c,"knowledge.knowledge_reviewer"),"forbidden");check(publication.active&&trim(reason)!=="");await set(c,publication,{active:false,withdrawal:reason,withdrawn_by:c.actor,withdrawn_at:c.now});},
  async assign_author(c,{document,account}){check(hasRole(c,"knowledge.knowledge_manager"),"forbidden");check(hasRole(c,"knowledge.knowledge_author",account));await set(c,document,{owner:account});},
  async document_status(c,{document,active}){check(hasRole(c,"knowledge.knowledge_reviewer"),"forbidden");await set(c,document,{active});},
  async reindex(c,{revision}){check(hasRole(c,"members"),"forbidden");check(editorial(c,c.actor,revision.parent)&&await live(c,revision));const request=await send(c,"knowledge.Handbook.refresh",{record:revision});},
  async ask(c,{topic,question}){
   check(hasRole(c,"members"),"forbidden");check(topic.active&&await readership(c,c.actor,topic)&&await count(records(c,"knowledge.Question",{where:r=>same(r.account,c.actor)&&r.unfinished}))<2n);
   const day=local_date(c.now,"UTC");const usage=await first(records(c,"knowledge.DailyUsage",{parent:topic,where:r=>same(r.account,c.actor)&&r.day===day}));check(usage===null||usage.requests<topic.daily_limit);
   if(usage===null){const counted=await create(c,"knowledge.DailyUsage",{parent:topic,account:c.actor,day,requests:1n});}else await set(c,usage,{requests:int64(usage.requests+1n)});
   const value={source:c.operation.id,revision:1n,question,profile:topic.profile,policy_revision:topic.policy_revision,max_input_tokens:topic.input_tokens,max_output_tokens:topic.output_tokens,max_duration:topic.duration};
   const asked=await create(c,"knowledge.Question",{parent:topic,request_value:value});const request=await send(c,"knowledge.Handbook.answer",{scope:topic,value},{when:async()=>topic.active&&await readership(c,asked.account,topic)&&!asked.stop_requested});await set(c,asked,{request});return asked;
  },
  async read_answer(c,{question}){check(hasRole(c,"members"),"forbidden");check(same(question.account,c.actor));const answer=(await delivery(c,{record:question,field:"request"},["progress.answer"]))?.progress?.answer??null;if(await groundedAvailable(c,answer))return answer;return null;},
  async stop(c,{question}){check(hasRole(c,"members"),"forbidden");check(same(question.account,c.actor)&&question.unfinished&&!question.stop_requested);await set(c,question,{stop_requested:true});const cancellation=await send(c,"knowledge.Handbook.cancel",{source:question.request_value.source,revision:question.request_value.revision});await set(c,question,{cancellation});},
  async reconcile(c,{question}){check(hasRole(c,"members"),"forbidden");check(same(question.account,c.actor)&&question.checks<3n&&(question.reconciliation===null||(await delivery(c,{record:question,field:"reconciliation"},["status"]))?.status!=="pending"));const reconciliation=await send(c,"knowledge.Handbook.reconcile",{source:question.request_value.source,revision:question.request_value.revision});await set(c,question,{reconciliation,checks:int64(question.checks+1n)});},
  async release_skipped(c,{question}){check(hasRole(c,"members"),"forbidden");check(same(question.account,c.actor)&&(await delivery(c,{record:question,field:"request"},["status"]))?.status==="skipped");await set(c,question,{unfinished:false});},
  async progressed(c,{event}){for(const question of await records(c,"knowledge.Question",{where:async r=>(await delivery(c,{record:r,field:"request"},["id"]))?.id===event.delivery_id,limit:1n})){if(question.unfinished&&["succeeded","failed","cancelled"].includes(question.state))await set(c,question,{unfinished:false});}},
  async escalate(c,{question,reason,share}){check(hasRole(c,"members"),"forbidden");check(same(question.account,c.actor)&&share&&trim(reason)!==""&&active_member(c,question.parent.expert,c.team)&&!await any(records(c,"knowledge.Escalation",{parent:question}),issue=>issue.state==="open"));const issue=await create(c,"knowledge.Escalation",{parent:question,reason});},
  async resolve(c,{issue,revision,note}){check(hasRole(c,"members"),"forbidden");check(same(issue.parent.parent.expert,c.actor)&&issue.state==="open"&&trim(note)!=="");check(revision===null||(same(revision.parent.parent,issue.parent.parent)&&await live(c,revision)&&await readership(c,issue.parent.account,issue.parent.parent)));if(revision===null)await set(c,issue,{state:"dismissed",note,resolved_by:c.actor,resolved_at:c.now});else await set(c,issue,{state:"resolved",resolution:revision,note,resolved_by:c.actor,resolved_at:c.now});},
 };
}

export async function knowledgePage(c,bindings){return renderPage(c,knowledgeDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, badge, status, collapse, alert, checkbox, select, textarea. */
 breadcrumbs({context:c}),
 table({context:c,model:"knowledge.Topic",columns:["name","expert"],filter:["active"],defaults:{active:true},display:"split",empty:message("No topics available",{nl:"Geen onderwerpen beschikbaar"}),renderRow:(topic,view)=>[
  pagination({context:view}),
  text({context:view,values:[topic.active,topic.daily_limit,topic.input_tokens,topic.output_tokens]}),
  form({context:view,operation:"knowledge.ask",arguments:{topic},children:[textarea({context:view,field:"question"})]}),
  table({context:view,model:"knowledge.Document",parent:topic,columns:["name","current"],display:"split",empty:message("No procedures in this topic",{nl:"Geen procedures in dit onderwerp"}),renderRow:async(document,docView)=>[
   pagination({context:docView}),
   ...(document.current!==null&&(editorial(docView,docView.actor,document)||await readership(docView,docView.actor,topic))?[collapse({context:docView,caption:message("Current publication",{nl:"Actuele publicatie"}),children:[badge({context:docView,value:document.current.index.state}),text({context:docView,values:[document.current.title]}),content({context:docView,value:document.current.body}),text({context:docView,values:[document.current.index.checked,document.current.index.detail]}),text({context:docView,values:[document.current.attachments]})]})]:[]),
  ]}),
  table({context:view,model:"knowledge.Question",parent:topic,where:q=>same(q.account,view.actor),columns:["request_value.question","state","coverage","transport","unfinished"],display:"split",empty:message("No questions yet",{nl:"Nog geen vragen"}),renderRow:async(question,qView)=>same(question.account,qView.actor)?[
   pagination({context:qView}),
   badge({context:qView,value:question.state}),status({context:qView,value:question.transport}),
   text({context:qView,values:[question.coverage,question.unfinished,question.used,question.stop_requested,(await delivery(qView,{record:question,field:"request"},["error"]))?.error??null,(await delivery(qView,{record:question,field:"request"},["progress.detail"]))?.progress?.detail??null]}),
   content({context:qView,value:question.answer}),
   alert({context:qView,value:message("Historical answers keep their original scope. Ask again for current guidance; changed or revoked used sources hide the answer.",{nl:"Historische antwoorden behouden hun oorspronkelijke bronselectie. Stel opnieuw een vraag voor actuele uitleg; gewijzigde of ingetrokken gebruikte bronnen verbergen het antwoord."})}),
   actions({context:qView,operations:["knowledge.stop","knowledge.reconcile","knowledge.release_skipped"],boundArgs:{question}}),
   form({context:qView,operation:"knowledge.escalate",arguments:{question},children:[textarea({context:qView,field:"reason"}),checkbox({context:qView,field:"share"})]}),
   list({context:qView,model:"knowledge.Escalation",parent:question,empty:message("No expert requests",{nl:"Geen expertverzoeken"}),renderRow:async(issue,issueView)=>[
    pagination({context:issueView}),
    badge({context:issueView,value:issue.state}),
    text({context:issueView,values:[issue.reason,issue.resolved_by,issue.resolved_at]}),
    ...(issue.state==="dismissed"?[collapse({context:issueView,caption:message("Closure explanation",{nl:"Uitleg bij afsluiting"}),children:[text({context:issueView,values:[issue.note]})]})]:[]),
    list({context:issueView,model:"knowledge.Revision",where:async guidance=>same(guidance,issue.resolution)&&await live(issueView,guidance)&&await readership(issueView,issueView.actor,topic),empty:message("No published resolution available",{nl:"Geen gepubliceerde oplossing beschikbaar"}),renderRow:(guidance,guidanceView)=>[
     pagination({context:guidanceView}),
     collapse({context:guidanceView,caption:message("Published resolution",{nl:"Gepubliceerde oplossing"}),children:[text({context:guidanceView,values:[issue.note,guidance.title]}),content({context:guidanceView,value:guidance.body}),text({context:guidanceView,values:[guidance.attachments]})]})]}),
   ]}),
  ]:[]}),
 ]}),
]);}
export async function editorPage(c,bindings){return renderPage(c,editorDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, badge, button, modal, slot, select, input, textarea, checkbox. */
 breadcrumbs({context:c}),
 form({context:c,operation:"knowledge.create_document",children:[select({context:c,field:"topic"}),input({context:c,field:"name"})]}),
 table({context:c,model:"knowledge.Document",where:document=>editorial(c,c.actor,document),columns:["name","parent","owner","active","current"],display:"split",empty:message("No procedures to edit",{nl:"Geen procedures om te bewerken"}),renderRow:(document,view)=>[
  pagination({context:view}),
  text({context:view,values:[document.name,document.parent,document.owner,document.active,document.current]}),
  form({context:view,operation:"knowledge.revise",arguments:{document},children:[input({context:view,field:"title"}),textarea({context:view,field:"body"})]}),
  button({context:view,opens:"assign_author_detail"}),
  modal({context:view,caption:message("Assign author",{nl:"Auteur aanwijzen"}),id:"assign_author_detail",children:[slot({context:view,name:"content",children:[form({context:view,operation:"knowledge.assign_author",arguments:{document},display:"inline"})]})]}),
  button({context:view,opens:"document_status_detail"}),
  modal({context:view,caption:message("Set procedure availability",{nl:"Beschikbaarheid procedure instellen"}),id:"document_status_detail",children:[slot({context:view,name:"content",children:[form({context:view,operation:"knowledge.document_status",arguments:{document},display:"inline",children:[checkbox({context:view,field:"active"})]})]})]}),
  table({context:view,model:"knowledge.Revision",parent:document,columns:["number","title","author","authored","index"],display:"split",empty:message("No revisions yet",{nl:"Nog geen revisies"}),renderRow:(revision,revView)=>[
   pagination({context:revView}),
   badge({context:revView,value:revision.index.state}),
   content({context:revView,value:revision.body}),text({context:revView,values:[revision.attachments]}),
   form({context:revView,operation:"knowledge.publish",arguments:{revision},children:[textarea({context:revView,field:"reason"})]}),
   form({context:revView,operation:"knowledge.reindex",arguments:{revision}})]}),
  table({context:view,model:"knowledge.Publication",parent:document,columns:["revision","reviewer","reviewed","active"],display:"split",empty:message("No publication decisions",{nl:"Geen publicatiebesluiten"}),renderRow:(publication,pubView)=>[
   pagination({context:pubView}),
   text({context:pubView,values:[publication.reason,publication.withdrawal,publication.withdrawn_by,publication.withdrawn_at]}),
   form({context:pubView,operation:"knowledge.withdraw",arguments:{publication},children:[textarea({context:pubView,field:"reason"})]}),
   history({context:pubView,record:publication})]}),
 ]}),
]);}
export async function expertPage(c,bindings){return renderPage(c,expertDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, badge, select, textarea. */
 breadcrumbs({context:c}),
 table({context:c,model:"knowledge.Escalation",where:issue=>same(issue.parent.parent.expert,c.actor),columns:["parent","state","created"],filter:["state"],display:"split",empty:message("No questions for you",{nl:"Geen vragen voor jou"}),renderRow:(issue,view)=>[
  pagination({context:view}),
  badge({context:view,value:issue.state}),
  text({context:view,values:[issue.parent.request_value.question,issue.parent.account,issue.reason]}),
  form({context:view,operation:"knowledge.resolve",arguments:{issue},children:[select({context:view,field:"revision"}),textarea({context:view,field:"note"})]}),
  text({context:view,values:[issue.resolution,issue.note,issue.resolved_by,issue.resolved_at]})]}),
]);}
export async function settingsPage(c,bindings){return renderPage(c,settingsDescriptor,()=>[
 /* desired-unimplemented: breadcrumbs, pagination, fieldset, input, checkbox, progress. */
 breadcrumbs({context:c}),
 form({context:c,operation:"knowledge.Topic.create",children:[
  fieldset({context:c,caption:message("Topic",{nl:"Onderwerp"}),children:[input({context:c,field:"name"}),checkbox({context:c,field:"active"})]}),
  fieldset({context:c,caption:message("Model profile",{nl:"Modelprofiel"}),children:[input({context:c,field:"profile"}),input({context:c,field:"policy_revision"}),input({context:c,field:"input_tokens"}),input({context:c,field:"output_tokens"}),input({context:c,field:"duration"})]}),
  fieldset({context:c,caption:message("Budget",{nl:"Budget"}),children:[input({context:c,field:"daily_limit"})]})]}),
 table({context:c,model:"knowledge.Topic",columns:["name","expert","profile","active","daily_limit"],display:"split",empty:message("No topics configured",{nl:"Geen onderwerpen ingesteld"}),renderRow:(topic,view)=>[
  pagination({context:view}),
  text({context:view,values:[topic.name,topic.expert,topic.profile,topic.active,topic.daily_limit]}),
  edit({context:view,operation:"knowledge.Topic.update",record:topic}),
  form({context:view,operation:"knowledge.Audience.create",arguments:{parent:topic},children:[checkbox({context:view,field:"active"})]}),
  table({context:view,model:"knowledge.Audience",parent:topic,columns:["account","active"],empty:message("No readers yet",{nl:"Nog geen lezers"}),renderRow:(audience,aView)=>[pagination({context:aView}),text({context:aView,values:[audience.account,audience.active]}),edit({context:aView,operation:"knowledge.Audience.update",record:audience})]}),
  table({context:view,model:"knowledge.Document",parent:topic,columns:["name","owner","active"],empty:message("No procedures in this topic",{nl:"Geen procedures in dit onderwerp"}),renderRow:(document,docView)=>[pagination({context:docView}),form({context:docView,operation:"knowledge.assign_author",arguments:{document}})]}),
  table({context:view,model:"knowledge.DailyUsage",parent:topic,columns:["account","day","requests"],order:["-day"],empty:message("No usage recorded",{nl:"Geen verbruik geregistreerd"}),renderRow:(usage,usageView)=>[pagination({context:usageView}),progress({context:usageView,value:usage.requests,max:topic.daily_limit})]})]}),
]);}

export const exampleImports=[];
export function exampleFixtures({self,other}){
 const manager={dependencies:[],user:async()=>({roles:["knowledge.knowledge_manager"]})};
 const writer={dependencies:[],user:async()=>({roles:["knowledge.knowledge_author"]})};
 const reviewer={dependencies:[],user:async()=>({roles:["knowledge.knowledge_reviewer"]})};
 const expert={dependencies:[],user:async()=>({roles:[]})};
 const topic={model:"knowledge.Topic",dependencies:[expert],value:async(c,s)=>({name:"People procedures",expert:s.expert,profile:"company-grounded-v1",policy_revision:"grounding-1"})};
 const reader={model:"knowledge.Audience",dependencies:[topic],value:async(c,s)=>({parent:s.topic,account:self})};
 const writer_access={model:"knowledge.Audience",dependencies:[topic,writer],value:async(c,s)=>({parent:s.topic,account:s.writer})};
 const procedure={model:"knowledge.Document",dependencies:[topic,writer],value:async(c,s)=>({parent:s.topic,name:"Leave requests",owner:s.writer})};
 const revision={model:"knowledge.Revision",dependencies:[procedure,writer],value:async(c,s)=>({parent:s.procedure,number:1n,title:"Leave requests",body:"Request leave early.",author:s.writer})};
 const next_revision={model:"knowledge.Revision",dependencies:[procedure,writer],value:async(c,s)=>({parent:s.procedure,number:2n,title:"Leave requests",body:"Request leave before booking travel.",author:s.writer})};
 const published={model:"knowledge.Publication",dependencies:[procedure,revision,reviewer],value:async(c,s)=>({parent:s.procedure,revision:s.revision,reason:"Reviewed procedure",reviewer:s.reviewer})};
 const used_today={model:"knowledge.DailyUsage",dependencies:[topic],value:async(c,s)=>({parent:s.topic,account:self,day:local_date(c.now,"UTC"),requests:20n})};
 const text_file={dependencies:[writer],file:async(c,s)=>({type:"text/plain",owner:s.writer})};
 const foreign_file={dependencies:[],file:async()=>({type:"text/plain",owner:other})};
 const pending_question={model:"knowledge.Question",dependencies:[topic],value:async(c,s)=>({parent:s.topic,account:self,request_value:{source:"question-1",revision:1n,question:"How do I request leave?",profile:"company-grounded-v1",policy_revision:"grounding-1",max_input_tokens:8192n,max_output_tokens:2048n,max_duration:120000n}})};
 // Test-only typed wire witness: the corpus normalizer validates real seeded
 // source/readership/publication and mints the opaque value. No opaque constructor.
 const answered={delivery:"knowledge.Handbook.answer",dependencies:[topic,revision],values:async(c,s)=>({request:{scope:s.topic,value:{source:"question-proof",revision:1n,question:"How do I request leave?",profile:"company-grounded-v1",policy_revision:"grounding-1",max_input_tokens:8192n,max_output_tokens:2048n,max_duration:120000n}},status:"succeeded",result:{source:"question-proof",revision:1n,sequence:1n,state:"succeeded",coverage:"complete",answer:{context:[s.revision],statements:[{text:"Request leave early.",citations:[1n]}],citations:[{id:1n,record:s.revision,field:"body",file:null,page:null,from:0n,until:20n,quote:"Request leave early."}]},used_tokens:120n,detail:null}})};
 const answered_question={model:"knowledge.Question",dependencies:[topic,answered],value:async(c,s)=>({parent:s.topic,account:self,request_value:{source:"question-proof",revision:1n,question:"How do I request leave?",profile:"company-grounded-v1",policy_revision:"grounding-1",max_input_tokens:8192n,max_output_tokens:2048n,max_duration:120000n},request:s.answered,unfinished:false})};
 const issue={model:"knowledge.Escalation",dependencies:[pending_question],value:async(c,s)=>({parent:s.pending_question,reason:"Please clarify the current leave procedure"})};
 return {fixtures:{manager,writer,reviewer,expert,topic,reader,writer_access,procedure,revision,next_revision,published,used_today,text_file,foreign_file,pending_question,answered,answered_question,issue},examples:[
  {operation:"knowledge.revise",dependencies:[procedure],inputs:async(c,s)=>({document:s.procedure,title:"Leave requests",body:"Request leave early.",attachments:[]}),selectors:["as"],observations:[async(c,s)=>await count(records(c,"knowledge.Revision",{parent:s.document}))],rows:[
   {dependencies:[writer],values:async(c,s)=>[s.writer],expected:async()=>[1n]},
   {dependencies:[reviewer],values:async(c,s)=>[s.reviewer],error:"forbidden"},
   {dependencies:[],values:async()=>[self],error:"forbidden"},
  ]},
  {operation:"knowledge.revise",dependencies:[procedure],inputs:async(c,s)=>({document:s.procedure,title:"Attachment procedure",body:""}),selectors:["as","attachments"],observations:[async(c,s)=>await count(records(c,"knowledge.Revision",{parent:s.document}))],rows:[
   {dependencies:[writer,text_file],values:async(c,s)=>[s.writer,[s.text_file]],expected:async()=>[1n]},
   {dependencies:[writer,foreign_file],values:async(c,s)=>[s.writer,[s.foreign_file]],error:"forbidden"},
  ]},
  {operation:"knowledge.publish",dependencies:[revision],inputs:async(c,s)=>({revision:s.revision,reason:"Reviewed procedure"}),selectors:["as","revision.author"],observations:[async(c,s)=>await count(records(c,"knowledge.Publication",{parent:s.procedure})),async(c,s)=>s.procedure.current],rows:[
   {dependencies:[reviewer,writer],values:async(c,s)=>[s.reviewer,s.writer],expected:async(c,s)=>[1n,s.revision]},
   {dependencies:[reviewer],values:async(c,s)=>[s.reviewer,s.reviewer],error:"rule_failed"},
   {dependencies:[writer],values:async(c,s)=>[s.writer,s.writer],error:"forbidden"},
  ]},
  {operation:"knowledge.withdraw",dependencies:[published],inputs:async(c,s)=>({publication:s.published,reason:"Procedure needs correction"}),selectors:["as"],observations:[async(c,s)=>s.publication.active,async(c,s)=>s.procedure.current],rows:[
   {dependencies:[reviewer],values:async(c,s)=>[s.reviewer],expected:async()=>[false,null]},
   {dependencies:[],values:async()=>[self],error:"forbidden"},
  ]},
  {operation:"knowledge.ask",dependencies:[reader,used_today,topic],inputs:async(c,s)=>({topic:s.topic,question:"How do I request leave?"}),selectors:["as","used_today.requests","topic.active","reader.active"],observations:[async(c,s)=>await count(records(c,"knowledge.Question",{parent:s.topic})),async(c,s)=>s.used_today.requests],rows:[
   {dependencies:[],values:async()=>[self,0n,true,true],expected:async()=>[1n,1n]},
   {dependencies:[],values:async()=>[self,20n,true,true],error:"rule_failed"},
   {dependencies:[],values:async()=>[self,0n,false,true],error:"rule_failed"},
   {dependencies:[],values:async()=>[self,0n,true,false],error:"rule_failed"},
   {dependencies:[],values:async()=>[other,0n,true,true],error:"rule_failed"},
   {dependencies:[],values:async()=>["public",0n,true,true],error:"forbidden"},
  ]},
  {operation:"knowledge.read_answer",dependencies:[reader,published,answered_question,manager],sequence:[
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"visible"},
   {observations:async(c,s,b)=>[b.visible!==null],expected:async()=>[true],types:["bool"]},
   {operation:"knowledge.Audience.update",by:async(c,s)=>s.manager,inputs:async(c,s)=>({record:s.reader,changes:{active:false}})},
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"hidden"},
   {observations:async(c,s,b)=>[b.hidden===null],expected:async()=>[true],types:["bool"]},
  ]},
  {operation:"knowledge.read_answer",dependencies:[reader,published,answered_question,reviewer],sequence:[
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"visible"},
   {observations:async(c,s,b)=>[b.visible!==null],expected:async()=>[true],types:["bool"]},
   {operation:"knowledge.withdraw",by:async(c,s)=>s.reviewer,inputs:async(c,s)=>({publication:s.published,reason:"Procedure withdrawn"})},
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"hidden"},
   {observations:async(c,s,b)=>[b.hidden===null],expected:async()=>[true],types:["bool"]},
  ]},
  {operation:"knowledge.read_answer",dependencies:[reader,published,answered_question,next_revision,reviewer],sequence:[
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"visible"},
   {observations:async(c,s,b)=>[b.visible!==null],expected:async()=>[true],types:["bool"]},
   {operation:"knowledge.publish",by:async(c,s)=>s.reviewer,inputs:async(c,s)=>({revision:s.next_revision,reason:"Reviewed replacement"})},
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"hidden"},
   {observations:async(c,s,b)=>[b.hidden===null,s.procedure.current],expected:async(c,s)=>[true,s.next_revision],types:["bool","knowledge.Revision?"]},
  ]},
  {operation:"knowledge.read_answer",dependencies:[reader,writer_access,published,answered_question,writer,reviewer],sequence:[
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"initial"},
   {observations:async(c,s,b)=>[b.initial!==null],expected:async()=>[true],types:["bool"]},
   {operation:"knowledge.create_document",by:async(c,s)=>s.writer,inputs:async(c,s)=>({topic:s.topic,name:"Travel guidance"}),bind:"additional_document"},
   {operation:"knowledge.revise",by:async(c,s)=>s.writer,inputs:async(c,s,b)=>({document:b.additional_document,title:"Travel guidance",body:"Keep travel receipts.",attachments:[]}),bind:"additional_revision"},
   {operation:"knowledge.publish",by:async(c,s)=>s.reviewer,inputs:async(c,s,b)=>({revision:b.additional_revision,reason:"Reviewed additional guidance"})},
   {operation:"knowledge.read_answer",by:async()=>self,inputs:async(c,s)=>({question:s.answered_question}),bind:"historical"},
   {observations:async(c,s,b)=>[b.historical!==null],expected:async()=>[true],types:["bool"]},
  ]},
  {operation:"knowledge.stop",dependencies:[pending_question],inputs:async(c,s)=>({question:s.pending_question}),selectors:["as"],observations:[async(c,s)=>s.question.stop_requested,async(c,s)=>s.question.unfinished],rows:[
   {dependencies:[],values:async()=>[self],expected:async()=>[true,true]},
   {dependencies:[],values:async()=>[other],error:"rule_failed"},
  ]},
  {operation:"knowledge.reconcile",dependencies:[pending_question],inputs:async(c,s)=>({question:s.pending_question}),selectors:["as","question.checks","topic.active"],observations:[async(c,s)=>s.question.checks],rows:[
   {dependencies:[],values:async()=>[self,0n,false],expected:async()=>[1n]},
   {dependencies:[],values:async()=>[self,3n,true],error:"rule_failed"},
   {dependencies:[],values:async()=>[other,0n,true],error:"rule_failed"},
  ]},
  {operation:"knowledge.progressed",dependencies:[reader,published,answered,answered_question],inputs:async(c,s)=>({event:{delivery_id:s.answered.id}}),selectors:["answered_question.unfinished"],observations:[async(c,s)=>s.answered_question.unfinished,async(c,s)=>s.answered_question.used],rows:[
   {dependencies:[],values:async()=>[true],expected:async()=>[false,120n]},
   {dependencies:[],values:async()=>[false],expected:async()=>[false,120n]},
  ]},
  {operation:"knowledge.escalate",dependencies:[pending_question],inputs:async(c,s)=>({question:s.pending_question,reason:"Please clarify",share:true}),selectors:["as","share"],observations:[async(c,s)=>await count(records(c,"knowledge.Escalation",{parent:s.question}))],rows:[
   {dependencies:[],values:async()=>[self,true],expected:async()=>[1n]},
   {dependencies:[],values:async()=>[self,false],error:"rule_failed"},
   {dependencies:[],values:async()=>[other,true],error:"rule_failed"},
  ]},
  {operation:"knowledge.resolve",dependencies:[reader,published,issue,revision],inputs:async(c,s)=>({issue:s.issue,revision:s.revision,note:"See the current procedure"}),selectors:["as","revision"],observations:[async(c,s)=>s.issue.state,async(c,s)=>s.issue.resolution],rows:[
   {dependencies:[expert,revision],values:async(c,s)=>[s.expert,s.revision],expected:async(c,s)=>["resolved",s.revision]},
   {dependencies:[expert,next_revision],values:async(c,s)=>[s.expert,s.next_revision],error:"rule_failed"},
   {dependencies:[expert],values:async(c,s)=>[s.expert,null],expected:async()=>["dismissed",null]},
   {dependencies:[revision],values:async(c,s)=>[self,s.revision],error:"rule_failed"},
  ]},
 ]};
}
