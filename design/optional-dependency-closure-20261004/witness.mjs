// Desired output only. available, when admission/presentation and optionalBindings
// below are explicit new proposals; every import/runtime API is unimplemented.
import {available,date,delivery,hasRole,money,require as check,set,send} from '@canlang/stdlib';
import {page,list,text,form} from '@canlang/ui';
const invoiceReady=async(c,probe)=>!(probe.invoice_fee&&probe.fee.minor>0n)||available(c,'probe.Billing');
const queueWhen=async(c,{probe})=>invoiceReady(c,probe);
const probePageDescriptor={owner:'probe',path:'/probe',order:1n,title:'Dependency probe',admit:async(c)=>{check(hasRole(c,'members'),'forbidden');return {};},render:probePage};
export const appDefinition={
 app:'OptionalProbe',includes:['probe'],
 context:{optionalBindings:['deployment.billing']},
 compositions:{FullProbe:{includes:['probe'],context:{}}},
 bindings:{'probe.Billing':{capability:'invoice.BillingV1',from:'deployment.billing'},'probe.Mail':{capability:'std.EmailV1',from:'deployment.mail'}},
 // These IDs resolve the existing extracted owning interface schemas/labels.
 // No copied Charge/capability/role definition or invoice executable import.
 types:{Charge:{type:'invoice.Charge'}},
 models:{'probe.Probe':{readGrants:[{rule:'Probe.read'}],invariants:['Probe.require'],locks:[{fields:['source','recipient','invoice_fee','fee'],when:'Probe.lock'}],fields:{source:{type:'text',unique:true},recipient:{type:'email'},invoice_fee:{type:'bool',default:false,label:'Invoice fee'},fee:{type:'money'},state:{type:'enum',values:['open','queued'],default:'open',label:{text:'State',values:{open:'Open',queued:'Queued'}}},notice:{type:'delivery',operation:'probe.Mail.send',nullable:true},charge_delivery:{type:'delivery',operation:'probe.Billing.charge',nullable:true}}}},
 pure:{invoice_ready:{params:{probe:{type:'probe.Probe'}},returns:{type:'bool'}}},
 scenarios:{queue:{by:'members',when:'queue.when',handler:'queue',params:{probe:{type:'probe.Probe'}}}},
 pages:[probePageDescriptor],
};
export function canApp(){return {
 read:{'Probe.read':c=>hasRole(c,'members')},
 require:{'Probe.require':(_c,row)=>row.fee.minor>=0n},
 lock:{'Probe.lock':(_c,row)=>row.state==='queued'},
 invoice_ready:invoiceReady,
 when:{'queue.when':queueWhen},
 async queue(c,{probe}){
  check(hasRole(c,'members'),'forbidden');
  check(await queueWhen(c,{probe}));
  check(probe.state==='open');
  await set(c,probe,{state:'queued'});
  const notice=await send(c,'probe.Mail.send',{to:probe.recipient,subject:'Request recorded',body:'Manual processing remains separate from invoicing.'});
  await set(c,probe,{notice});
  if(probe.invoice_fee&&probe.fee.minor>0n){
   const charge=await send(c,'probe.Billing.charge',{value:{source:probe.source,customer:'fixture-customer',location:'fixture-location',description:'Frozen fee',amount:probe.fee,due:date('2090-01-01')}});
   await set(c,probe,{charge_delivery:charge});
  }
 },
};}
export async function probePage(c){return page({context:c,children:[list({context:c,model:'probe.Probe',row:async(view,row)=>[text({context:view,values:[row.source,row.state,row.fee]}),form({context:view,operation:'probe.queue',arguments:{probe:row}})]})]});}
export function exampleFixtures(){
 const candidate={model:'probe.Probe',dependencies:[],value:async()=>({source:'probe-one',recipient:'recipient@example.test',fee:money(5n,'EUR')})};
 return {candidate,examples:[{operation:'probe.queue',dependencies:[candidate],inputs:async(c,s)=>({probe:s.candidate}),selectors:['as','probe.invoice_fee','probe.fee','probe.state'],observations:[async(c,s)=>s.probe.state,async(c,s)=>(await delivery(c,{record:s.probe,field:'notice'},['status']))?.status??null,async(c,s)=>(await delivery(c,{record:s.probe,field:'charge_delivery'},['status']))?.status??null,async(c,s)=>s.probe.version],rows:[
  {dependencies:[],values:async(c,s)=>[s.self,false,money(5n,'EUR'),'open'],expected:async()=>['queued','pending',null,2n]},
  {dependencies:[],values:async(c,s)=>[s.self,false,money(0n,'EUR'),'open'],expected:async()=>['queued','pending',null,2n]},
  {dependencies:[],values:async(c,s)=>[s.self,true,money(0n,'EUR'),'open'],expected:async()=>['queued','pending',null,2n]},
  {dependencies:[],values:async()=>['public',false,money(5n,'EUR'),'open'],error:'forbidden'},
  {dependencies:[],values:async(c,s)=>[s.self,false,money(5n,'EUR'),'queued'],error:'rule_failed'},
 ]}]};
}
// Installation acceptance specifications, not executable deployment/test code.
// absent Billing never fabricates a receipt or domain success; required Mail
// remains required. Completed receipts retain their original schema/namespace.
export const installationCases=[
 {app:'OptionalProbe',bindings:['deployment.mail'],invoice_fee:false,fee:'EUR 5',expected:{deploy:'accepted',queue:'accepted',state:'queued',notice:'pending',charge:null,version:2n}},
 {app:'OptionalProbe',bindings:['deployment.mail'],invoice_fee:true,fee:'EUR 5',expected:{deploy:'accepted',queue:'rule_failed',control:'unavailable',state:'open',domainWrites:0,intents:0,version:1n}},
 {app:'OptionalProbe',bindings:['deployment.mail'],invoice_fee:true,fee:'EUR 0',expected:{deploy:'accepted',queue:'accepted',charge:null,version:2n}},
 {app:'OptionalProbe',bindings:['deployment.mail','deployment.billing'],invoice_fee:true,fee:'EUR 5',expected:{deploy:'accepted',queue:'accepted',state:'queued',notice:'pending',charge:'pending',version:2n}},
 {app:'FullProbe',bindings:['deployment.mail'],expected:{deploy:'blocked_missing_required_binding'}},
 {app:'OptionalProbe',bindings:[],expected:{deploy:'blocked_missing_required_binding'}},
 {app:'OptionalProbe',bindings:['deployment.mail'],oldWork:'accepted_or_unknown_billing_delivery',expected:{deploy:'blocked_old_work'}},
 {app:'OptionalProbe',bindings:['deployment.mail'],oldWork:'scheduled_billing_reconciliation',expected:{deploy:'blocked_old_work'}},
 {app:'OptionalProbe',bindings:['deployment.mail'],oldWork:'completed_billing_receipt',expected:{deploy:'accepted_after_inventory',retain:'original_identity_schema_and_safe_outcome'}},
];
