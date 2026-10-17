// Partial desired target for value_probe; no compiler/runtime implementation.
// Canonical schema extraction resolves invoice.Charge and its reachable value
// types/labels once from source. No invoice executable module is imported.
import {date,hasRole,money,require as check} from '@canlang/stdlib';
const finance='invoice.finance';
const Charge='invoice.Charge';
export const appDefinition={
 app:'ValuesOnly',includes:['value_probe'],
 models:{'value_probe.Preview':{readGrants:[{rule:'Preview.read'}],invariants:['Preview.require'],fields:{charge:{type:Charge}}}},
 pure:{inspect:{by:finance,params:{preview:{type:'value_probe.Preview'}},returns:{type:Charge}}},
 // This excerpt omits the ordinary page descriptor/renderer; it establishes the
 // source/import/permission boundary rather than another complete app target.
};
export function canApp(){return {
 read:{'Preview.read':c=>hasRole(c,finance)},
 require:{'Preview.require':(_c,row)=>row.charge.amount.minor>=0n},
 async inspect(c,{preview}){check(hasRole(c,finance),'forbidden');return preview.charge;},
};}
export function exampleFixtures(){
 const finance_user={dependencies:[],user:async()=>({roles:[finance]})};
 const ordinary_user={dependencies:[],user:async()=>({})};
 const quoted={model:'value_probe.Preview',dependencies:[],value:async()=>({charge:{source:'value-probe',customer:'fixture-customer',location:'fixture-location',description:'Recorded fee',amount:money(5n,'EUR'),due:date('2090-01-01')}})};
 return {finance_user,ordinary_user,quoted,examples:[{operation:'value_probe.inspect',dependencies:[quoted],inputs:async(c,s)=>({preview:s.quoted}),selectors:['as'],observations:[async(c,s)=>s.result.amount],rows:[
  {dependencies:[finance_user],values:async(c,s)=>[s.finance_user],expected:async()=>[money(5n,'EUR')]},
  {dependencies:[ordinary_user],values:async(c,s)=>[s.ordinary_user],error:'forbidden'},
  {dependencies:[],values:async()=>['public'],error:'forbidden'},
 ]}]};
}
// live_probe's value type contains customer.Customer, not a serialized snapshot.
// Its model metadata remains {value:{type:'record_values.CustomerLink'}}; schema
// traversal must include Customer's executable owner and normal read/admission
// routing. This is an inclusion requirement, not a new lookup or remote DTO.
