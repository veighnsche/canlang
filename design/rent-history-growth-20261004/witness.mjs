// Desired output for witness.can. Imports/runtime/BDD execution are not implemented.
import {create, set, records, first, collect, history as recordHistory, require as check, hasRole, sum, date} from '@canlang/stdlib';
import {can_work} from './employee.mjs'; // canonical generated owner import; not implemented here
const manager = c => hasRole(c, 'rent_history_witness.manager');
const scoped = async (c, resource) => manager(c) && await can_work(c, c.actor, resource.location);
export const historyMetadata = {
  'rent_history_witness.Resource': {type:'rent_history_witness.Capacity',fields:['capacity'],until:()=>null,read:async(c,row)=>scoped(c,row)},
  'rent_history_witness.Booking': {type:'rent_history_witness.SavedBooking',fields:['from','until','intervals','quantity','status','checked_in','checked_out'],until:()=>null,read:async(c,row)=>scoped(c,row.parent)},
};
export const handlers = {
  open: async(c,{location}) => { check(await can_work(c,c.actor,location)); return await create(c,'rent_history_witness.Resource',{location,capacity:2n}); },
  book: async(c,{resource,from,until}) => {
    check(await can_work(c,c.actor,resource.location) && from < until);
    const booking=await create(c,'rent_history_witness.Booking',{parent:resource,from,until,intervals:[{from,until}],quantity:1n,status:'confirmed',checked_in:c.now,checked_out:null});
    await set(c,booking,{quantity:2n}); return booking;
  },
  cancel_booking: async(c,{booking}) => {check(await can_work(c,c.actor,booking.parent.location) && booking.status==='confirmed'); await set(c,booking,{status:'cancelled'});},
  checkout: async(c,{booking}) => {check(await can_work(c,c.actor,booking.parent.location) && booking.checked_in!==null && booking.checked_out===null); await set(c,booking,{checked_out:c.now});},
  sample: async(c,{resource,point,until}) => {
    check(await can_work(c,c.actor,resource.location) && point<until);
    const resources=await recordHistory(c,{model:'rent_history_witness.Resource',record:resource,from:point,until});
    const bookings=await recordHistory(c,{model:'rent_history_witness.Booking',parent:resource,from:point,until});
    const covers=h=>h.coverage.some(span=>span.from<=point && point<span.until);
    const projected=point>=c.now;
    if (!projected && (!covers(resources)||!covers(bookings))) return {complete:false,provisional:false,booked:null,occupied:null,capacity:null};
    const policy=projected?resources.current[0]?.value:resources.entries.find(e=>e.from<=point && point<e.until)?.value; check(policy!==undefined);
    const active=projected?bookings.current.map(e=>e.value):bookings.entries.filter(e=>e.from<=point && point<e.until).map(e=>e.value);
    return {complete:true,provisional:projected,
      booked:await sum(active.filter(b=>b.status==='confirmed' && b.intervals.some(i=>i.from<=point && point<i.until)).map(b=>b.quantity)),
      occupied:await sum(active.filter(b=>b.checked_in!==null && b.checked_in<=point && point<(b.checked_out??c.now)).map(b=>b.quantity)),
      capacity:policy.capacity};
  },
};
// Ordinary operation registry still supplies by=manager, types, ownership/version admission,
// return disclosure and fixed per-admission context; these are not bypass-callable handlers.
export const operations = {
  open:{by:manager,returns:'rent_history_witness.Resource',handler:handlers.open},
  book:{by:manager,returns:'rent_history_witness.Booking',handler:handlers.book},
  cancel_booking:{by:manager,handler:handlers.cancel_booking},
  checkout:{by:manager,handler:handlers.checkout},
  sample:{by:manager,read:true,scope:'authority',returns:'rent_history_witness.Sample',handler:handlers.sample},
};
// Sequence lowering retains the existing call/let/assert representation and adds exactly:
export const clockStep = {advance: (_c,_s,_b)=>60_000n};
// The runner moves its isolated clock; this is not a handler or production API.

export const exampleImports=[{provider:'rent_catalog',member:'test_site',alias:'test_site'}];
export function exampleFixtures({self,other,imported}) {
 const {test_site}=imported;
 const hr_user={dependencies:[],user:async()=>({roles:['employee.hr']})};
 const operator={dependencies:[],user:async()=>({roles:['rent_history_witness.manager']})};
 const worker={model:'employee.Employee',dependencies:[operator,test_site],value:async(c,s)=>({user:s.operator,home:s.test_site,locations:[s.test_site],start:date('2026-10-01'),role:'Operator'})};
 const example = {operation:'rent_history_witness.sample',dependencies:[worker,hr_user],sequence:[
  {let:'t0',value:async(c)=>c.now},
  {operation:'rent_history_witness.open',by:async(c,s)=>s.operator,inputs:async(c,s)=>({location:s.test_site}),bind:'resource'},
  {operation:'rent_history_witness.book',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,from:b.t0,until:b.t0+240_000n}),bind:'booking'},
  {advance:async()=>60_000n},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0,until:c.now})},
  {observations:async(c,s)=>[s.result.complete,s.result.booked,s.result.occupied,s.result.capacity],expected:async()=>[true,2n,2n,2n],types:['bool','int?','int?','int?']},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:c.now+60_000n,until:c.now+120_000n})},
  {observations:async(c,s)=>[s.result.complete,s.result.provisional,s.result.booked,s.result.occupied],expected:async()=>[true,true,2n,0n],types:['bool','bool','int?','int?']},
  {operation:'rent_history_witness.cancel_booking',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({booking:b.booking})},
  {let:'cancelled',value:async(c,s,b)=>await first(records(c,'rent_history_witness.Booking',{parent:b.resource,where:row=>row.id===b.booking.id}))},
  {observations:async(c,s,b)=>[b.cancelled!==null],expected:async()=>[true],types:['bool']},
  {advance:async()=>60_000n},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0+60_000n,until:c.now})},
  {observations:async(c,s)=>[s.result.complete,s.result.booked,s.result.occupied],expected:async()=>[true,0n,2n],types:['bool','int?','int?']},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0,until:c.now})},
  {observations:async(c,s)=>[s.result.booked,s.result.occupied],expected:async()=>[2n,2n],types:['int?','int?']},
  {operation:'rent_history_witness.checkout',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({booking:b.cancelled})},
  {advance:async()=>60_000n},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0+120_000n,until:c.now})},
  {observations:async(c,s)=>[s.result.complete,s.result.booked,s.result.occupied],expected:async()=>[true,0n,0n],types:['bool','int?','int?']},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0-60_000n,until:b.t0})},
  {observations:async(c,s)=>[s.result.complete],expected:async()=>[false],types:['bool']},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.other,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0,until:c.now}),error:'forbidden'},
  {operation:'employee.deactivate',by:async(c,s)=>s.hr_user,inputs:async(c,s)=>({employee:s.worker,ended:date('2026-10-02')})},
  {operation:'rent_history_witness.sample',by:async(c,s)=>s.operator,inputs:async(c,s,b)=>({resource:b.resource,point:b.t0,until:c.now}),error:'rule_failed'},
]};

 return {hr_user,operator,worker,examples:[example]};
}
