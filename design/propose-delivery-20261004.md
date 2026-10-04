# CanPropose typed delivery correspondence — 2026-10-04

This bounded application uses the existing [association contract](delivery-association-20261004.md), [leaf observation contract](delivery-leaf-grants-20261004.md) and [safe completion contract](delivery-error-20261004.md). The owning app remains [CanPropose.can](../draft/CanPropose.can); its [requirements](../draft/CanPropose.md) and composition are retained. CanPropose has no owning `.mjs` target. The excerpt below describes only affected metadata, handlers and examples of the future single owning registry. It is not a second app assembly or a complete generated target. Imports and helpers are proposed, unimplemented contracts.

## Requirement and source correspondence

| Required outcome | Owning source and desired lowering | Focused evidence |
| --- | --- | --- |
| Failed notices leave prices and agreement intact | Store Mail.send's protected handle in notice; derive nullable status, remove the callback that merely copied transport status | Document table observes null and all five notice statuses with unchanged total and sent/accepted/declined state. Succeeded is transport success, not proof the recipient read or agreed |
| Printable quote retains the frozen revision | Document sends the unchanged Revision.snapshot plus immutable source ID and commercial number, under the existing caller/state guard | Two independently identified PDF receipt recipes retain the complete declared request; their explicit Item dependency precedes snapshot evaluation, and whole initial-envelope cells vary outcomes |
| A stale attempt or wrong revision cannot attach the current PDF | Completion selects the current associated ID, then requires succeeded/non-null result and matching source/number | Superseded and null associations leave version/state/file unchanged; wrong source/number leave transport succeeded but document outcome unknown |
| Delivery failure does not erase an existing file or decide the quote | Failed/skipped/unknown change only document_state; successful validated completion sets pdf and ready | Three failure/uncertainty cases retain the original file, accepted quote and exact EUR 100 total; valid success also works for a declined readable quote |
| Current authority and stale-input checks apply | Original salesperson/location or authenticated verified addressed recipient guards remain; ordinary expected-version admission remains | Public forbidden, wrong addressed account rule_failed, withdrawn rule_failed and stale input conflict. These are declared isolated cases, not executed authorization tests |
| Repeated user requests select the current attempt | Ordinary association set joins the one transaction; replacement does not cancel an older attempt | Five-statement sequence makes two real document calls, captures the first ID, checks a distinct second current ID and versions 2 then 3 while prices/state remain frozen |
| Staff/recipient feedback separates business from transport | Existing pages add document_delivery_state beside document_state/PDF; notice_state becomes the standard nullable transport enum projection | Shared status captions and existing scalar English/Dutch field labels; null uses the shared not-requested presentation |

Receipt progress changes neither domain version nor model hooks. An explicit association replacement or business completion write still changes the domain record normally. Mutable status observations join the shared receipt observation fence; immutable stored ID observations use the same checked locator without that mutable fence. Every stored observation below uses `delivery(c,{record,field},[selectedProperties])`; a local send result is stored directly without casting an ID. Completion envelopes use immutable isolated receipt-fixture IDs, not an alternative stored lookup.

Revision's existing full-field policies grant scoped salespeople and verified addressed recipients the association and derived dependencies; no additional grant or authority bypass is introduced. The PDF handler still runs as the trusted typed completion source with actor=null. Its file attachment requires canonical receiving-app finalization and current destination checks; neither the transport result nor a fixture creates arbitrary file ownership. Source policies, locks, decision/booking/hold behavior, current pages and action bindings remain in the owning app.

Legacy text IDs require verified original owner, team and bound-target correlation before a migration can associate them. A text cast or structural handle cannot do that. This note supplies no migration or runtime implementation.

## Partial desired JavaScript

The excerpt intentionally omits unchanged app metadata, CRUD, rule maps, other handlers and page functions. Its Revision metadata entries supplement the existing model; its affected canApp entries belong in the single owning registry. Snapshot lowering is included to make full request and fixture correspondence reviewable. No runtime or provider stubs are supplied.

```javascript
import {addMoney,app_url,collect,compareInstant,count,datetime,delivery,format,hasRole,money,multiplyMoney,records,require as check,set,send,subtractMoney,sum} from "@canlang/stdlib";
import {message} from "@canlang/ui";
import {can_work} from "./employee.mjs";

// Partial desired target only. All imports are proposed/unimplemented contracts.
// Insert these field/derive entries into the owning Revision metadata; this is
// neither a complete appDefinition nor an alternate production registry.
const revisionDeliveryMetadata={
  fields:{notice:{type:"delivery",operation:"propose.Mail.send",nullable:true},document:{type:"delivery",operation:"propose.Documents.quote",nullable:true,label:message("Document request",{nl:"Documentaanvraag"})}},
  derived:{
    notice_state:{type:"std.DeliveryResult.status",nullable:true,handler:"Revision.notice_state",label:message("Offer notice",{nl:"Offertebericht"})},
    document_delivery_state:{type:"std.DeliveryResult.status",nullable:true,handler:"Revision.document_delivery_state",label:message("Document delivery",{nl:"Documentbezorging"})},
  },
};
// The existing snapshot derive is unchanged, explicitly lowered here for request
// and fixture correspondence. Its reads retain their caller evaluation authority.
async function revisionSnapshot(c,row){
  return {issuer:row.issuer_snapshot,customer:row.customer_snapshot,resource:row.resource,quantity:row.quantity,attendees:row.seats,recipient:row.recipient_email,title:row.title_snapshot,location:row.location_snapshot,from:row.from,until:row.until,intervals:row.intervals,terms:row.terms,refund_before:row.refund_before,expires:row.expires,
    lines:(await collect(records(c,"propose.Item",{parent:row}))).map(item=>({title:item.title,quantity:item.quantity,unit:item.unit,price:item.price,tax:item.tax,discount:item.discount})),total:row.total};
}
// Affected entries of the future single canApp registry; all other entries remain
// required by the owning source and are deliberately omitted from this excerpt.
export function canApp(){
  return {
    derives:{
      "Revision.snapshot":revisionSnapshot,
      "Revision.notice_state":async(c,row)=>(await delivery(c,{record:row,field:"notice"},["status"]))?.status??null,
      "Revision.document_delivery_state":async(c,row)=>(await delivery(c,{record:row,field:"document"},["status"]))?.status??null,
    },
    async send_offer(c,{revision}){
      check(hasRole(c,"propose.salesperson"),"forbidden");
      check(await can_work(c,c.actor,revision.parent.location)&&revision.state==="draft"&&await count(records(c,"propose.Item",{parent:revision}))>0n&&compareInstant(revision.expires,c.now)>0);
      await set(c,revision,{total:await sum(records(c,"propose.Item",{parent:revision}),item=>subtractMoney(addMoney(multiplyMoney(item.price,item.quantity),item.tax),item.discount),revision.parent.currency),state:"sent"});
      const notice=await send(c,"propose.Mail.send",{to:revision.recipient_email,subject:revision.parent.title,body:format(c,message("Review the frozen offer at {link}. Sign in with your verified recipient email.",{nl:"Bekijk de vastgelegde offerte via {link}. Meld je aan met je geverifieerde e-mailadres als ontvanger."},{link:{type:"url",value:app_url(format(c,"/offers/respond/{id}",{id:revision.id}))}}),{locale:null})});
      await set(c,revision,{notice});
    },
    async document(c,{revision}){
      check(hasRole(c,"propose.salesperson")||hasRole(c,"authenticated"),"forbidden");
      check(["sent","accepted","declined"].includes(revision.state)&&((hasRole(c,"propose.salesperson")&&await can_work(c,c.actor,revision.parent.location))||(c.actor.email_verified&&c.actor.email===revision.recipient_email)));
      const attempt=await send(c,"propose.Documents.quote",{source:revision.id,revision:revision.number,snapshot:await revisionSnapshot(c,revision)});
      await set(c,revision,{document:attempt,document_state:"pending"});
    },
    async document_result(c,{event}){
      for await(const revision of records(c,"propose.Revision",{where:async(row)=>(await delivery(c,{record:row,field:"document"},["id"]))?.id===event.delivery_id,limit:1n})){
        if(event.status==="succeeded"&&event.result!==null&&event.result.source===revision.id&&event.result.revision===revision.number)
          await set(c,revision,{pdf:event.result.document,document_state:"ready"});
        else if(event.status==="failed")await set(c,revision,{document_state:"failed"});
        else if(event.status==="skipped")await set(c,revision,{document_state:"skipped"});
        else await set(c,revision,{document_state:"unknown"});
      }
    },
  };
}
// The same existing bound targets/operation schemas supply send, completion and
// fixture types. No Mail.notice_result entry remains; there is no implicit hook.
export const exampleImports=[
  {provider:"customer",member:"test_company",alias:"test_company"},
  {provider:"customer",member:"test_contact",alias:"test_contact"},
  {provider:"rent_catalog",member:"test_site",alias:"test_site"},
];
export function exampleFixtures({self,other,imported}){
  const {test_company,test_contact,test_site}=imported;
  const offer={model:"propose.Proposal",dependencies:[test_company,test_contact,test_site],value:async(c,s)=>({parent:s.test_company,location:s.test_site,recipient:s.test_contact,issuer:"Operator",title:"Office",currency:"EUR",current:1n})};
  const current_offer={model:"propose.Revision",dependencies:[offer],value:async(c,s)=>({parent:s.offer,number:1n,issuer_snapshot:"Operator",title_snapshot:"Office",location_snapshot:"Main",customer_snapshot:"Example company",recipient_email:c.actor.email,expires:datetime("2099-01-01T00:00:00Z"),terms:"No reservation",refund_before:datetime("2099-01-02T09:00:00Z"),from:datetime("2099-01-02T09:00:00Z"),until:datetime("2099-01-02T10:00:00Z"),total:money(100n,"EUR"),state:"sent"})};
  const priced_item={model:"propose.Item",dependencies:[current_offer],value:async(c,s)=>({parent:s.current_offer,title:"Office",quantity:"1",unit:"day",price:money(100n,"EUR"),tax:money(0n,"EUR"),discount:money(0n,"EUR")})};
  const original_pdf={dependencies:[],file:async(c,s)=>({})};
  const generated_pdf={dependencies:[],file:async(c,s)=>({})};
  const notice_attempt={delivery:"propose.Mail.send",dependencies:[current_offer],values:async(c,s)=>({request:{to:s.current_offer.recipient_email,subject:s.current_offer.title_snapshot,body:"Frozen offer notice"}})};
  const attempt={delivery:"propose.Documents.quote",dependencies:[current_offer,priced_item],values:async(c,s)=>({request:{source:s.current_offer.id,snapshot:await revisionSnapshot(c,s.current_offer),revision:s.priced_item.parent.number}})};
  const pending_document={delivery:"propose.Documents.quote",dependencies:[current_offer,priced_item],values:async(c,s)=>({request:{source:s.current_offer.id,snapshot:await revisionSnapshot(c,s.current_offer),revision:s.priced_item.parent.number}})};
  return {offer,current_offer,priced_item,original_pdf,generated_pdf,notice_attempt,attempt,pending_document,examples:[
    {operation:"propose.document",seed:[priced_item,notice_attempt],dependencies:[current_offer,priced_item,notice_attempt],inputs:async(c,s)=>({revision:s.current_offer}),selectors:["as", "revision.state", "revision.notice", "request.revision.version", "notice_attempt.status", "notice_attempt.result", "notice_attempt.error"],observations:[async(c,s)=>(await delivery(c,{record:s.revision,field:"notice"},["status"]))?.status??null,async(c,s)=>s.revision.document_state,async(c,s)=>(await delivery(c,{record:s.revision,field:"document"},["status"]))?.status??null,async(c,s)=>s.revision.state,async(c,s)=>s.revision.total,async(c,s)=>s.revision.pdf,async(c,s)=>s.revision.version],rows:[
          {dependencies:[],values:async(c,s)=>[s.self, "sent", null, 1n, "pending", null, null],expected:async(c,s)=>[null,"pending","pending","sent",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "sent", s.notice_attempt, 1n, "pending", null, null],expected:async(c,s)=>["pending","pending","pending","sent",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "sent", s.notice_attempt, 1n, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["succeeded","pending","pending","sent",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "sent", s.notice_attempt, 1n, "failed", null, {code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed","pending","pending","sent",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "sent", s.notice_attempt, 1n, "unknown", null, null],expected:async(c,s)=>["unknown","pending","pending","sent",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "sent", s.notice_attempt, 1n, "skipped", null, null],expected:async(c,s)=>["skipped","pending","pending","sent",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "accepted", s.notice_attempt, 1n, "failed", null, {code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed","pending","pending","accepted",money(100n,"EUR"),null,2n]},
          {dependencies:[notice_attempt],values:async(c,s)=>[s.self, "declined", s.notice_attempt, 1n, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["succeeded","pending","pending","declined",money(100n,"EUR"),null,2n]},
          {dependencies:[],values:async(c,s)=>[s.self, "withdrawn", null, 1n, "pending", null, null],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>["public", "sent", null, 1n, "pending", null, null],error:"forbidden"},
          {dependencies:[],values:async(c,s)=>["outsider", "sent", null, 1n, "pending", null, null],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.self, "sent", null, 2n, "pending", null, null],error:"conflict"}
        ]},
    {operation:"propose.document_result",seed:[priced_item],dependencies:[current_offer,generated_pdf,attempt,priced_item],inputs:async(c,s)=>({event:{delivery_id:s.attempt.id,status:"succeeded",result:{source:s.current_offer.id,revision:1n,document:s.generated_pdf},error:null}}),selectors:["current_offer.document", "current_offer.document_state", "current_offer.pdf", "event.delivery_id", "event.status", "event.result", "event.error", "current_offer.state", "attempt.status", "attempt.result", "attempt.error"],observations:[async(c,s)=>s.current_offer.document_state,async(c,s)=>s.current_offer.pdf,async(c,s)=>(await delivery(c,{record:s.current_offer,field:"document"},["status"]))?.status??null,async(c,s)=>s.current_offer.state,async(c,s)=>s.current_offer.total,async(c,s)=>s.current_offer.version],rows:[
          {dependencies:[current_offer,generated_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", null, s.attempt.id, "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null, "sent", "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null],expected:async(c,s)=>["ready",s.generated_pdf,"succeeded","sent",money(100n,"EUR"),2n]},
          {dependencies:[current_offer,generated_pdf,pending_document,attempt],values:async(c,s)=>[s.pending_document, "pending", null, s.attempt.id, "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null, "sent", "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null],expected:async(c,s)=>["pending",null,"pending","sent",money(100n,"EUR"),1n]},
          {dependencies:[current_offer,generated_pdf,attempt],values:async(c,s)=>[null, "none", null, s.attempt.id, "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null, "sent", "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null],expected:async(c,s)=>["none",null,null,"sent",money(100n,"EUR"),1n]},
          {dependencies:[generated_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", null, s.attempt.id, "succeeded", {source:"another-revision",revision:1n,document:s.generated_pdf}, null, "sent", "succeeded", {source:"another-revision",revision:1n,document:s.generated_pdf}, null],expected:async(c,s)=>["unknown",null,"succeeded","sent",money(100n,"EUR"),2n]},
          {dependencies:[current_offer,generated_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", null, s.attempt.id, "succeeded", {source:s.current_offer.id,revision:2n,document:s.generated_pdf}, null, "sent", "succeeded", {source:s.current_offer.id,revision:2n,document:s.generated_pdf}, null],expected:async(c,s)=>["unknown",null,"succeeded","sent",money(100n,"EUR"),2n]},
          {dependencies:[original_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", s.original_pdf, s.attempt.id, "failed", null, {code:"provider",message:"Document generation rejected"}, "accepted", "failed", null, {code:"provider",message:"Document generation rejected"}],expected:async(c,s)=>["failed",s.original_pdf,"failed","accepted",money(100n,"EUR"),2n]},
          {dependencies:[original_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", s.original_pdf, s.attempt.id, "unknown", null, null, "accepted", "unknown", null, null],expected:async(c,s)=>["unknown",s.original_pdf,"unknown","accepted",money(100n,"EUR"),2n]},
          {dependencies:[original_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", s.original_pdf, s.attempt.id, "skipped", null, null, "accepted", "skipped", null, null],expected:async(c,s)=>["skipped",s.original_pdf,"skipped","accepted",money(100n,"EUR"),2n]},
          {dependencies:[current_offer,generated_pdf,attempt],values:async(c,s)=>[s.attempt, "pending", null, s.attempt.id, "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null, "declined", "succeeded", {source:s.current_offer.id,revision:1n,document:s.generated_pdf}, null],expected:async(c,s)=>["ready",s.generated_pdf,"succeeded","declined",money(100n,"EUR"),2n]}
        ]},
    {operation:"propose.document",dependencies:[priced_item],sequence:[
      {operation:"propose.document",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({revision:s.current_offer})},
      {let:"first_request",value:async(c,s,b)=>(await delivery(c,{record:s.current_offer,field:"document"},["id"]))?.id??null},
      {observations:async(c,s,b)=>[b.first_request!==null&&s.current_offer.version===2n],expected:async(c,s,b)=>[true],types:["bool"]},
      {operation:"propose.document",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({revision:s.current_offer})},
      {observations:async(c,s,b)=>[((await delivery(c,{record:s.current_offer,field:"document"},["id"]))?.id??null)!==b.first_request,s.current_offer.document_state,s.current_offer.state,s.current_offer.total,s.current_offer.version],expected:async(c,s,b)=>[true,"pending","sent",money(100n,"EUR"),3n],types:["bool","propose.Revision.document_state","propose.Revision.state","money","int"]},
    ]},
  ]};
}
```

## Initial recipe normalization

Twelve complete receipts become three: `notice_attempt`, `attempt` and a separate pending `pending_document`. One recipe covers each distinct request, plus the independent current-versus-superseded document identity. Pending/null/null defaults are omitted. Direct whole status/result/error selectors initialize the selected recipe as one valid envelope before provisioning; production receipt properties stay read-only. The 12 request rows and nine completion rows retain every original expected value/error verbatim, as does the five-step/two-call sequence.

`current_offer` declares no receipt back-edge; both associations start null. Both document recipes keep explicit `priced_item` closure before their snapshot is frozen. The callback table's common successful event references `generated_pdf`, so common baseline closure retains that file in all rows even when an overridden event result is null. Initial result cells do not weaken finalized receiving-owner/delivery/result-path provenance. Event and recipe completion envelopes remain explicitly repeated in the rows; sharing a structural fixture value is a separate contract question, not new syntax in this application.

Normalization alone reduces the captured Can source from 42,241 to 41,199 UTF-8 bytes (1,042 bytes). Production Can after erasing fixtures/examples and the partial JavaScript prefix before test declarations compare byte-for-byte unchanged; every target expected callback/error is preserved. The source retains 14 total tables/64 cases; only the two existing delivery tables/21 cases are represented in this partial target. Recipe counts alone are not token-efficiency evidence.

## Checks and remaining boundaries

- Node syntax checking passes on the exact extracted JavaScript fence. Descriptor-factory construction resolves all eight local model/file/receipt recipes and their dependencies, including three typed receipts; no callback or business operation is executed.
- Lexical comparison checks all 21 source row inputs, expected typed values and exact error codes against the two partial-target tables (12 request rows, nine completion rows). Manual correspondence additionally traces the two headers, guards/evaluation order, complete request/result shapes, two derives, current-attempt/source/commercial-number selection, attachment writes, scalar labels and five sequence steps/two calls.
- Normalization byte comparison keeps every production declaration/scenario body, policy, invariant, unique/lock and Revision.snapshot unchanged, together with the partial desired production JavaScript. The preceding association migration removed the pure transport notice callback while retaining document_result business correlation; normalization adds no further behavior changes. Existing booking/release receipt fields remain outside this application.
- The actual source is rejected by the prototype parser at the first delivery(Target) field. Replacing just the two association field type spellings with text and omitting just the new attached sequence allows the surrounding declarations/tables to parse. This compatibility projection validates neither the actual typed fields nor sequence grammar. There is no symbol/type checker, generated full app target, provider/fixture runner or receipt observation implementation here.

The completion table's setup explicitly represents a prior finalized file or quote decision where needed; those rows do not demonstrate an executed accept or previous PDF generation. The separate sequence demonstrates genuine repeat-request calls only. Test file fixtures model finalized isolated files, not content/MIME production or delivery provenance execution. No provider network effects, live file finalization, role/privacy execution, concurrency, performance or complete application execution is claimed.
