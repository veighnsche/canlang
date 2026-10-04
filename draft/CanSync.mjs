import { addDuration, choose, count, create, delivery, equalValue, first, hasRole, int64, records, require as check, same, schedule, cancel, send, set, trim } from "@canlang/stdlib";
import { actions, details, edit, form, history, message, renderPage, table, text } from "@canlang/ui";

// Handwritten desired output. All imports are proposed contracts, not implementations.
// DESIGN §13 supplies authority, typed values, atomic effects and example conventions.
// Provider outcomes are evidence; no adapter, transport or UI renderer is implemented here.
export const AccountsV1 = "sync.AccountsV1";
const page = {
  owner: "sync", path: "/sync", poll: 5000n,
  title: message("CRM synchronization", {nl:"CRM-synchronisatie"}),
  description: message("Inspect observations, approve exact corrections and retain unresolved provider outcomes.", {nl:"Bekijk waarnemingen, keur exacte correcties goed en bewaar onopgeloste externe uitkomsten."}),
  admit: async c => { check(hasRole(c,"sync.operator") || hasRole(c,"sync.reviewer"),"forbidden"); return {}; },
  render: syncPage,
};
export const appDefinition = {
  id: "CanSync", uses: ["sync"],
  description: message("Review bounded CRM corrections while preserving remote edits and uncertain write evidence.",{nl:"Beoordeel begrensde CRM-correcties met behoud van externe wijzigingen en onzeker schrijfbewijs."}),
  packages: {sync:{label:message("CRM synchronization",{nl:"CRM-synchronisatie"}),roles:{
    operator:{id:"sync.operator",label:message("Sync operator",{nl:"Synchronisatiemedewerker"})},
    reviewer:{id:"sync.reviewer",label:message("Correction reviewer",{nl:"Correctiebeoordelaar"})},
  }}},
  bindings:{"sync.Remote":{capability:"sync.AccountsV1",from:"deployment.accounts"}},
  contracts:{
    "sync.Values":{fields:{name:{type:"text",trim:true,min:1n,max:255n},phone:{type:"text",nullable:true,max:80n},website:{type:"url",nullable:true}}},
    "sync.Snapshot":{fields:{id:{type:"text",min:1n,max:100n},revision:{type:"text",min:1n,max:1000n},values:{type:"sync.Values"}}},
    "sync.Observation":{fields:{missing:{type:"bool"},snapshot:{type:"sync.Snapshot",nullable:true}}},
    "sync.WriteResult":{fields:{state:{type:"enum",cases:["applied","conflict","missing","rejected"]},detail:{type:"text",nullable:true}}},
  },
  capabilities:{"sync.AccountsV1":{exported:true,version:1n,operations:{
    read:{inputs:{id:{type:"sync.Snapshot.id"}},result:{type:"sync.Observation"}},
    replace:{inputs:{id:{type:"sync.Snapshot.id"},expected:{type:"sync.Snapshot.revision"},value:{type:"sync.Values"}},result:{type:"sync.WriteResult"}},
  }}},
  models:{
    "sync.Link":{label:message("Linked account",{nl:"Gekoppelde account"}),readGrants:[{rule:"Link.read.1"}],invariants:["Link.invariant.1"],locks:["Link.lock.1"],fields:{remote:{type:"sync.Snapshot.id",unique:true},owner:{type:"user",server:"actor"},enabled:{type:"bool",default:true},period:{type:"duration",default:3600000n},epoch:{type:"int",default:1n},current:{type:"sync.ReadAttempt",nullable:true},latest:{type:"sync.ReadAttempt",nullable:true},pending:{type:"sync.Proposal",nullable:true}}},
    "sync.ReadAttempt":{parent:"sync.Link",label:message("Account observation",{nl:"Accountwaarneming"}),readGrants:[{rule:"ReadAttempt.read.1"}],invariants:["ReadAttempt.invariant.1"],locks:["ReadAttempt.lock.1","ReadAttempt.lock.2"],fields:{request:{type:"delivery",operation:"sync.Remote.read",nullable:true},value:{type:"sync.Observation",nullable:true},applied:{type:"bool",default:false}}},
    "sync.Proposal":{parent:"sync.Link",derived:{outcome:{handler:"Proposal.outcome",type:"sync.WriteResult.state",nullable:true,label:message("Confirmed write result",{nl:"Bevestigd schrijfresultaat"})}},label:message("Reviewed correction",{nl:"Beoordeelde correctie"}),readGrants:[{rule:"Proposal.read.1"}],invariants:["Proposal.invariant.1"],locks:["Proposal.lock.1","Proposal.lock.2"],fields:{before:{type:"sync.Snapshot"},desired:{type:"sync.Values"},submitted_by:{type:"user",server:"actor"},decision:{type:"enum",cases:["draft","approved","rejected","closed"],default:"draft"},reviewed_by:{type:"user",nullable:true},reason:{type:"text",nullable:true},current:{type:"sync.WriteAttempt",nullable:true},observed_match:{type:"sync.ReadAttempt",nullable:true}}},
    "sync.WriteAttempt":{parent:"sync.Proposal",label:message("Conditional write",{nl:"Voorwaardelijke wijziging"}),readGrants:[{rule:"WriteAttempt.read.1"}],invariants:["WriteAttempt.invariant.1"],locks:["WriteAttempt.lock.1"],fields:{baseline:{type:"sync.Snapshot"},value:{type:"sync.Values"},request:{type:"delivery",operation:"sync.Remote.replace",nullable:true}}},
  },
  events:{"sync.RefreshDue":{fields:{link:{type:"sync.Link"},epoch:{type:"int"}}}},
  preferences:{sync:{fields:{view:{type:"enum",cases:["active","paused"],default:"active"}}}},
  pure:{
    "sync.editable":{handler:"editable",inputs:{proposal:{type:"sync.Proposal"}},result:{type:"bool"}},
    "sync.settled":{handler:"settled",inputs:{attempt:{type:"sync.WriteAttempt"}},result:{type:"bool"}},
    "sync.safe_rebase":{handler:"safe_rebase",inputs:{proposal:{type:"sync.Proposal"},current:{type:"sync.Snapshot"}},result:{type:"bool"}},
    "sync.rebased":{handler:"rebased",inputs:{proposal:{type:"sync.Proposal"},current:{type:"sync.Snapshot"}},result:{type:"sync.Values"}},
  },
  operations:{
    "sync.Link.create":{handler:"createLink",kind:"create",model:"sync.Link",by:"sync.operator",inputs:{fields:["remote","period"]}},
    "sync.Link.update":{handler:"updateLink",kind:"update",model:"sync.Link",by:"sync.operator",inputs:{record:{type:"sync.Link"},changes:{fields:["period"]}}},
    "sync.refresh":{handler:"refresh",by:["sync.operator","sync.reviewer"],inputs:{link:{type:"sync.Link"}},label:message("Refresh remote account",{nl:"Externe account verversen"}),description:message("Refresh one account; reads do not authorize a provider write.",{nl:"Ververs één account; lezen verleent geen toestemming voor een externe wijziging."})},
    "sync.propose":{handler:"propose",by:"sync.operator",inputs:{link:{type:"sync.Link"},value:{type:"sync.Values"}},label:message("Prepare correction",{nl:"Correctie voorbereiden"}),description:message("Freeze the exact intended correction against the visible provider version.",{nl:"Leg de exacte bedoelde correctie vast tegenover de zichtbare externe versie."})},
    "sync.approve":{handler:"approve",by:"sync.reviewer",inputs:{proposal:{type:"sync.Proposal"}},label:message("Approve correction",{nl:"Correctie goedkeuren"}),description:message("A different reviewer approves the frozen delta; the provider revision fences the write.",{nl:"Een andere beoordelaar keurt de vastgelegde wijziging goed; de externe versie begrenst de schrijfactie."})},
    "sync.rebase":{handler:"rebase",by:"sync.reviewer",inputs:{proposal:{type:"sync.Proposal"}},label:message("Retry nonconflicting correction",{nl:"Niet-conflicterende correctie herhalen"}),description:message("Rebase the already approved fields at most twice, preserving unrelated remote edits.",{nl:"Herbaseer de al goedgekeurde velden maximaal tweemaal met behoud van overige externe wijzigingen."})},
    "sync.acknowledge":{handler:"acknowledge",by:"sync.reviewer",inputs:{proposal:{type:"sync.Proposal"}},label:message("Record observed match",{nl:"Waargenomen overeenkomst vastleggen"}),description:message("Observe convergence without claiming which request caused it; uncertain writes retain their hold.",{nl:"Stel overeenstemming vast zonder de oorzaak te claimen; onzekere schrijfacties houden hun blokkade."})},
    "sync.close":{handler:"close",by:"sync.reviewer",inputs:{proposal:{type:"sync.Proposal"},reason:{type:"text"}},label:message("Close reviewed correction",{nl:"Beoordeelde correctie sluiten"}),description:message("Finish a definitively ended attempt or reject an unsubmitted proposal, keeping all evidence.",{nl:"Sluit een definitief beëindigde poging of wijs een niet-ingediend voorstel af met behoud van bewijs."})},
    "sync.pause":{handler:"pause",by:"sync.operator",inputs:{link:{type:"sync.Link"}},label:message("Pause link",{nl:"Koppeling pauzeren"}),description:message("Pause future work without claiming an in-flight remote write was cancelled.",{nl:"Pauzeer toekomstig werk zonder te claimen dat een lopende externe wijziging is geannuleerd."})},
    "sync.resume":{handler:"resume",by:"sync.operator",inputs:{link:{type:"sync.Link"}},label:message("Resume link",{nl:"Koppeling hervatten"}),description:message("Resume with a new timer generation and a fresh read; old proposals stay frozen.",{nl:"Hervat met een nieuwe timer en verse lezing; oude voorstellen blijven ongewijzigd."})},
  },
  handlers:{
    "sync.linked":{on:"sync.Link.created",handler:"linked",description:message("Start the per-account refresh schedule without scanning the population.",{nl:"Start het verversschema per account zonder alle accounts te doorlopen."})},
    "sync.due":{on:"sync.RefreshDue",handler:"due",description:message("Recurrence retains its original owner and discards obsolete epochs.",{nl:"Herhaling behoudt de oorspronkelijke eigenaar en negeert verouderde versies."})},
    "sync.observed":{on:"sync.Remote.read.completed",handler:"observed",description:message("Retain successful observations; only the selected read may become latest.",{nl:"Bewaar geslaagde waarnemingen; alleen de geselecteerde lezing mag de nieuwste worden."})},
  },
  pages:[page],
  disabled:["sync.Link.delete","sync.ReadAttempt.create","sync.ReadAttempt.update","sync.ReadAttempt.delete","sync.Proposal.create","sync.Proposal.update","sync.Proposal.delete","sync.WriteAttempt.create","sync.WriteAttempt.update","sync.WriteAttempt.delete"],
};

export function canApp() {
  const editable = (c,proposal) => proposal.parent.enabled && same(proposal.parent.pending,proposal) && hasRole(c,"sync.operator",proposal.submitted_by) && proposal.reviewed_by!==null && hasRole(c,"sync.reviewer",proposal.reviewed_by);
  const settled = async(c,attempt) => {const receipt=await delivery(c,{record:attempt,field:"request"},["status","result"]);return receipt!==null && (receipt.status==="skipped" || (receipt.status==="succeeded" && receipt.result!==null));};
  const safe_rebase = (c,proposal,current) => current.id===proposal.before.id &&
    (proposal.desired.name===proposal.before.values.name || [proposal.before.values.name,proposal.desired.name].includes(current.values.name)) &&
    (proposal.desired.phone===proposal.before.values.phone || [proposal.before.values.phone,proposal.desired.phone].includes(current.values.phone)) &&
    (proposal.desired.website===proposal.before.values.website || [proposal.before.values.website,proposal.desired.website].includes(current.values.website));
  const rebased = (c,proposal,current) => ({
    name:choose(proposal.desired.name===proposal.before.values.name,current.values.name,proposal.desired.name),
    phone:choose(proposal.desired.phone===proposal.before.values.phone,current.values.phone,proposal.desired.phone),
    website:choose(proposal.desired.website===proposal.before.values.website,current.values.website,proposal.desired.website),
  });
  return {
    editable,settled,safe_rebase,rebased,
    derives:{"Proposal.outcome":async(c,row)=>row.current===null ? null : (await delivery(c,{record:row.current,field:"request"},["result.state"]))?.result?.state ?? null},
    read:{
      "Link.read.1":c=>hasRole(c,"sync.operator") || hasRole(c,"sync.reviewer"),
      "ReadAttempt.read.1":c=>hasRole(c,"sync.operator") || hasRole(c,"sync.reviewer"),
      "Proposal.read.1":c=>hasRole(c,"sync.operator") || hasRole(c,"sync.reviewer"),
      "WriteAttempt.read.1":c=>hasRole(c,"sync.operator") || hasRole(c,"sync.reviewer"),
    },
    invariants:{
      "Link.invariant.1":(c,row)=>row.period>=900000n && row.period<=604800000n && (row.pending===null || same(row.pending.parent,row)) && (row.current===null || same(row.current.parent,row)) && (row.latest===null || same(row.latest.parent,row)),
      "ReadAttempt.invariant.1":(c,row)=>row.value===null || (row.value.missing && row.value.snapshot===null) || (!row.value.missing && row.value.snapshot!==null && row.value.snapshot.id===row.parent.remote),
      "Proposal.invariant.1":(c,row)=>row.before.id===row.parent.remote && !equalValue(c,"sync.Values",row.desired,row.before.values) && (row.current===null || same(row.current.parent,row)) && (row.observed_match===null || same(row.observed_match.parent,row.parent)),
      "WriteAttempt.invariant.1":(c,row)=>row.baseline.id===row.parent.parent.remote,
    },
    locks:{
      "Link.lock.1":{fields:["remote","owner"]},
      "ReadAttempt.lock.1":{fields:["request"]},
      "ReadAttempt.lock.2":{fields:["value"],when:(c,row)=>row.applied},
      "Proposal.lock.1":{fields:["before","desired","submitted_by"]},
      "Proposal.lock.2":{fields:["reviewed_by"],when:(c,row)=>row.reviewed_by!==null},
      "WriteAttempt.lock.1":{fields:["baseline","value","request"]},
    },
    async createLink(c,input) {check(hasRole(c,"sync.operator"),"forbidden"); await create(c,"sync.Link",input);},
    async updateLink(c,{record,changes}) {check(hasRole(c,"sync.operator"),"forbidden"); await set(c,record,changes);},
    async linked(c,{event}) {const link=await first(records(c,"sync.Link",{where:row=>row.id===event.id}));if(link!==null && link.enabled && link.epoch===1n) await schedule(c,link.id,c.now,"sync.RefreshDue",{link,epoch:link.epoch});},
    async refresh(c,{link}) {
      check(hasRole(c,"sync.operator") || hasRole(c,"sync.reviewer"),"forbidden"); check(link.enabled);
      const attempt=await create(c,"sync.ReadAttempt",{parent:link});
      const request=await send(c,"sync.Remote.read",{id:link.remote},{when:async()=>link.enabled});
      await set(c,attempt,{request}); await set(c,link,{current:attempt});
    },
    async due(c,{event}) {
      const link=event.link;
      if(link.enabled && link.epoch===event.epoch && hasRole(c,"sync.operator",link.owner)) {
        const attempt=await create(c,"sync.ReadAttempt",{parent:link});
        const request=await send(c,"sync.Remote.read",{id:link.remote},{when:async()=>link.enabled && hasRole(c,"sync.operator",link.owner)});
        await set(c,attempt,{request}); await set(c,link,{current:attempt});
        await schedule(c,link.id,addDuration(c.now,link.period),"sync.RefreshDue",{link,epoch:link.epoch});
      }
    },
    async observed(c,{event}) {
      for(const attempt of await records(c,"sync.ReadAttempt",{where:async row=>(await delivery(c,{record:row,field:"request"},["id"]))?.id===event.delivery_id,limit:1n})) {
        if(!attempt.applied && event.status==="succeeded" && event.result!==null) {
          await set(c,attempt,{value:event.result,applied:true});
          if(same(attempt.parent.current,attempt)) await set(c,attempt.parent,{latest:attempt});
        }
      }
    },
    async propose(c,{link,value}) {
      check(hasRole(c,"sync.operator"),"forbidden");
      check(link.enabled && link.pending===null && link.latest!==null && link.latest.value!==null && !link.latest.value.missing && link.latest.value.snapshot!==null);
      check(!equalValue(c,"sync.Values",value,link.latest.value.snapshot.values));
      const proposal=await create(c,"sync.Proposal",{parent:link,before:link.latest.value.snapshot,desired:value});
      await set(c,link,{pending:proposal});
    },
    async approve(c,{proposal}) {
      check(hasRole(c,"sync.reviewer"),"forbidden");
      check(proposal.parent.enabled && same(proposal.parent.pending,proposal) && proposal.decision==="draft" && !same(proposal.submitted_by,c.actor) && hasRole(c,"sync.operator",proposal.submitted_by));
      await set(c,proposal,{decision:"approved",reviewed_by:c.actor});
      const attempt=await create(c,"sync.WriteAttempt",{parent:proposal,baseline:proposal.before,value:proposal.desired});
      const request=await send(c,"sync.Remote.replace",{id:proposal.parent.remote,expected:attempt.baseline.revision,value:attempt.value},{when:async()=>editable(c,proposal)});
      await set(c,attempt,{request}); await set(c,proposal,{current:attempt});
    },
    async rebase(c,{proposal}) {
      check(hasRole(c,"sync.reviewer"),"forbidden");
      check(editable(c,proposal) && same(proposal.reviewed_by,c.actor) && proposal.current!==null && (await delivery(c,{record:proposal.current,field:"request"},["status"]))?.status==="succeeded" && (await delivery(c,{record:proposal.current,field:"request"},["result.state"]))?.result?.state==="conflict" && await count(records(c,"sync.WriteAttempt",{parent:proposal}))<3n);
      check(proposal.parent.latest!==null && proposal.parent.latest.value!==null && !proposal.parent.latest.value.missing && proposal.parent.latest.value.snapshot!==null);
      const current=proposal.parent.latest.value.snapshot;
      check(current.revision!==proposal.current.baseline.revision && safe_rebase(c,proposal,current));
      const value=rebased(c,proposal,current); check(!equalValue(c,"sync.Values",value,current.values));
      const attempt=await create(c,"sync.WriteAttempt",{parent:proposal,baseline:current,value});
      const request=await send(c,"sync.Remote.replace",{id:proposal.parent.remote,expected:current.revision,value},{when:async()=>editable(c,proposal)});
      await set(c,attempt,{request}); await set(c,proposal,{current:attempt});
    },
    async acknowledge(c,{proposal}) {
      check(hasRole(c,"sync.reviewer"),"forbidden");
      check(same(proposal.parent.pending,proposal) && proposal.decision==="approved" && !same(proposal.submitted_by,c.actor) && proposal.current!==null);
      check(proposal.parent.latest!==null && proposal.parent.latest.value!==null && proposal.parent.latest.value.snapshot!==null);
      const current=proposal.parent.latest.value.snapshot;
      check(safe_rebase(c,proposal,current) && equalValue(c,"sync.Values",rebased(c,proposal,current),current.values));
      await set(c,proposal,{observed_match:proposal.parent.latest});
    },
    async close(c,{proposal,reason}) {
      check(hasRole(c,"sync.reviewer"),"forbidden");
      check(same(proposal.parent.pending,proposal) && !same(proposal.submitted_by,c.actor) && trim(reason)!=="");
      check(proposal.decision==="draft" || (proposal.current!==null && await settled(c,proposal.current)));
      await set(c,proposal,{decision:choose(proposal.decision==="draft","rejected","closed"),reason});
      await set(c,proposal.parent,{pending:null});
    },
    async pause(c,{link}) {check(hasRole(c,"sync.operator"),"forbidden"); await set(c,link,{enabled:false,epoch:int64(link.epoch+1n)}); await cancel(c,link.id);},
    async resume(c,{link}) {
      check(hasRole(c,"sync.operator"),"forbidden"); check(!link.enabled && hasRole(c,"sync.operator",link.owner));
      await set(c,link,{enabled:true,epoch:int64(link.epoch+1n)});
      await schedule(c,link.id,c.now,"sync.RefreshDue",{link,epoch:link.epoch});
    },
  };
}

export async function syncPage(c,bindings) {
  return renderPage(c,page,()=>[
    form({context:c,operation:"sync.Link.create"}),
    table({context:c,model:"sync.Link",where:link=>link.enabled===(c.preferences.sync.view==="active"),columns:["remote","enabled","period","latest.created","current.request.status"],renderRow:(link,view)=>[
      edit({context:view,operation:"sync.Link.update",record:link,fields:["period"]}),
      actions({context:view,operations:["sync.refresh","sync.pause","sync.resume"],boundArgs:{link}}),
      details({context:view,caption:message("Remote account and correction",{nl:"Externe account en correctie"}),display:"drawer",children:[
        text({context:view,values:[link.latest?.value??null,link.latest?.created??null]}),
        form({context:view,operation:"sync.propose",arguments:{link}}),
        table({context:view,model:"sync.Proposal",parent:link,columns:["created","submitted_by","decision","outcome","observed_match.created"],renderRow:(proposal,proposalView)=>[
          text({context:proposalView,values:[proposal.before,proposal.desired,proposal.reviewed_by,proposal.reason]}),
          actions({context:proposalView,operations:["sync.approve","sync.rebase","sync.acknowledge","sync.close"],boundArgs:{proposal}}),
          table({context:proposalView,model:"sync.WriteAttempt",parent:proposal,columns:["baseline","value","request.status","request.result","request.error"]}),
          history({context:proposalView,record:proposal}),
        ]}),
        table({context:view,model:"sync.ReadAttempt",parent:link,columns:["created","value","request.status","request.error"]}),
      ]}),
    ]}),
  ]);
}

export const exampleImports=[];
export function exampleFixtures({self,other,imported}) {
  const author={dependencies:[],user:async()=>({roles:["sync.operator"]})};
  const approver={dependencies:[],user:async()=>({roles:["sync.reviewer"]})};
  const both={dependencies:[],user:async()=>({roles:["sync.operator","sync.reviewer"]})};
  const account={model:"sync.Link",dependencies:[author],value:async(c,s)=>({remote:"account-1",owner:s.author})};
  const seen={model:"sync.ReadAttempt",dependencies:[account],value:async(c,s)=>({parent:s.account,value:{missing:false,snapshot:{id:"account-1",revision:"v1",values:{name:"Acme",phone:null,website:null}}},applied:true})};
  const proposal={model:"sync.Proposal",dependencies:[account,author],value:async(c,s)=>({parent:s.account,before:{id:"account-1",revision:"v1",values:{name:"Acme",phone:null,website:null}},desired:{name:"Acme Ltd",phone:null,website:null},submitted_by:s.author})};
  const writing={delivery:"sync.Remote.replace",values:async(c,s)=>({request:{id:"account-1",expected:"v1",value:{name:"Acme Ltd",phone:null,website:null}},status:"unknown"})};
  const uncertain={model:"sync.WriteAttempt",dependencies:[proposal,writing],value:async(c,s)=>({parent:s.proposal,baseline:s.proposal.before,value:s.proposal.desired,request:s.writing})};
  const matching={model:"sync.ReadAttempt",dependencies:[account],value:async(c,s)=>({parent:s.account,value:{missing:false,snapshot:{id:"account-1",revision:"v2",values:{name:"Acme Ltd",phone:null,website:null}}},applied:true})};
  const conflict_receipt={delivery:"sync.Remote.replace",values:async(c,s)=>({request:{id:"account-1",expected:"v1",value:{name:"Acme Ltd",phone:null,website:null}},status:"succeeded",result:{state:"conflict",detail:"Revision changed"}})};
  const conflicting={model:"sync.WriteAttempt",dependencies:[proposal,conflict_receipt],value:async(c,s)=>({parent:s.proposal,baseline:s.proposal.before,value:s.proposal.desired,request:s.conflict_receipt})};
  const fresh={model:"sync.ReadAttempt",dependencies:[account],value:async(c,s)=>({parent:s.account,value:{missing:false,snapshot:{id:"account-1",revision:"v2",values:{name:"Acme",phone:"+32 1234",website:null}}},applied:true})};
  const overlap={model:"sync.ReadAttempt",dependencies:[account],value:async(c,s)=>({parent:s.account,value:{missing:false,snapshot:{id:"account-1",revision:"v2",values:{name:"Other company",phone:null,website:null}}},applied:true})};
  return {fixtures:{author,approver,both,account,seen,proposal,writing,uncertain,matching,conflict_receipt,conflicting,fresh,overlap},examples:[
    {operation:"sync.propose",dependencies: [seen, account],inputs:async(c,s)=>({link:s.account,value:{name:"Acme Ltd",phone:null,website:null}}),selectors:["as","link.latest","link.enabled"],observations:[async(c,s)=>count(records(c,"sync.Proposal",{parent:s.link})),async(c,s)=>s.link.pending.desired.name],rows:[
      {dependencies:[author,seen],values:async(c,s)=>[s.author,s.seen,true],expected:async()=>[1n,"Acme Ltd"]},
      {dependencies:[author,seen],values:async(c,s)=>[s.author,s.seen,false],error:"rule_failed"},
      {dependencies:[author],values:async(c,s)=>[s.author,null,true],error:"rule_failed"},
      {dependencies:[seen],values:async(c,s)=>["members",s.seen,true],error:"forbidden"},
    ]},
    {operation:"sync.approve",dependencies:[proposal],inputs:async(c,s)=>({proposal:s.proposal}),selectors:["as","proposal.parent.pending","proposal.parent.enabled","proposal.submitted_by"],observations:[async(c,s)=>s.proposal.decision,async(c,s)=>count(records(c,"sync.WriteAttempt",{parent:s.proposal}))],rows:[
      {dependencies:[approver,proposal,author],values:async(c,s)=>[s.approver,s.proposal,true,s.author],expected:async()=>["approved",1n]},
      {dependencies:[approver,proposal,author],values:async(c,s)=>[s.approver,s.proposal,false,s.author],error:"rule_failed"},
      {dependencies:[approver,author],values:async(c,s)=>[s.approver,null,true,s.author],error:"rule_failed"},
      {dependencies:[author,proposal],values:async(c,s)=>[s.author,s.proposal,true,s.author],error:"forbidden"},
      {dependencies:[both,proposal],values:async(c,s)=>[s.both,s.proposal,true,s.both],error:"rule_failed"},
    ]},
    {operation:"sync.rebase",dependencies: [conflicting, fresh, overlap, proposal],inputs:async(c,s)=>({proposal:s.proposal}),selectors:["as","proposal.parent.pending","proposal.decision","proposal.reviewed_by","proposal.current","proposal.parent.latest"],observations:[async(c,s)=>count(records(c,"sync.WriteAttempt",{parent:s.proposal})),async(c,s)=>s.proposal.current.value.name,async(c,s)=>s.proposal.current.value.phone],rows:[
      {dependencies:[approver,proposal,conflicting,fresh],values:async(c,s)=>[s.approver,s.proposal,"approved",s.approver,s.conflicting,s.fresh],expected:async()=>[2n,"Acme Ltd","+32 1234"]},
      {dependencies:[approver,proposal,conflicting,overlap],values:async(c,s)=>[s.approver,s.proposal,"approved",s.approver,s.conflicting,s.overlap],error:"rule_failed"},
      {dependencies:[approver,proposal,conflicting,seen],values:async(c,s)=>[s.approver,s.proposal,"approved",s.approver,s.conflicting,s.seen],error:"rule_failed"},
      {dependencies:[approver,proposal,conflicting,fresh],values:async(c,s)=>["members",s.proposal,"approved",s.approver,s.conflicting,s.fresh],error:"forbidden"},
    ]},
    {operation:"sync.acknowledge",dependencies: [uncertain, matching, proposal],inputs:async(c,s)=>({proposal:s.proposal}),selectors:["as","proposal.parent.pending","proposal.decision","proposal.current","proposal.parent.latest"],observations:[async(c,s)=>same(s.proposal.observed_match,s.matching),async(c,s)=>same(s.proposal.parent.pending,s.proposal),async(c,s)=>(await delivery(c,{record:s.uncertain,field:"request"},["status"])).status],rows:[
      {dependencies:[approver,proposal,uncertain,matching],values:async(c,s)=>[s.approver,s.proposal,"approved",s.uncertain,s.matching],expected:async()=>[true,true,"unknown"]},
      {dependencies:[proposal,uncertain,matching],values:async(c,s)=>["members",s.proposal,"approved",s.uncertain,s.matching],error:"forbidden"},
    ]},
    {operation:"sync.close",dependencies: [uncertain, proposal],inputs:async(c,s)=>({proposal:s.proposal}),selectors:["as","proposal.parent.pending","proposal.decision","proposal.current","reason"],observations:[async(c,s)=>s.proposal.parent.pending],rows:[
      {dependencies:[approver,proposal],values:async(c,s)=>[s.approver,s.proposal,"draft",null,"Not needed"],expected:async()=>[null]},
      {dependencies:[approver,proposal,uncertain],values:async(c,s)=>[s.approver,s.proposal,"approved",s.uncertain,"Timeout is not proof"],error:"rule_failed"},
    ]},
    {operation:"sync.pause",dependencies:[account,author],sequence:[
      {operation:"sync.pause",inputs:async(c,s)=>({link:s.account}),by:async(c,s)=>s.author},
      {observations:async(c,s,b)=>[s.account.enabled,s.account.epoch],expected:async()=>[false,2n],types:["bool","int"]},
      {operation:"sync.refresh",inputs:async(c,s)=>({link:s.account}),by:async(c,s)=>s.author,error:"rule_failed"},
      {operation:"sync.resume",inputs:async(c,s)=>({link:s.account}),by:async(c,s)=>s.author},
      {observations:async(c,s,b)=>[s.account.enabled,s.account.epoch],expected:async()=>[true,3n],types:["bool","int"]},
    ]},
  ]};
}
