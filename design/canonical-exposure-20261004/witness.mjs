import {any,call,count,create,deleteRecord,first,hasRole,records,require as check,same,set} from "@canlang/stdlib";
import {actions,card,edit,form,history,message,renderPage,table,text} from "@canlang/ui";

/* Standalone handwritten desired output, not an implementation.
 * All imports are proposed unimplemented contracts. Exposure metadata below is
 * a new draft contract, independent of enabled lifecycle and normal call admission.
 * The one registry supplies UI/MCP/routes/internal calls; no wrapper or parallel
 * operation manifest is introduced. Test callbacks are not executed by this file.
 */
const pageDescriptor={
  owner:"ArchiveExposure",path:"/",title:message("Your requests"),
  admit:async(c)=>{check(hasRole(c,"members"),"forbidden");return {};},
  render:requestsPage,
};
export const appDefinition={
  id:"ArchiveExposure",uses:["ArchiveExposure"],
  packages:{ArchiveExposure:{}},
  models:{
    "ArchiveExposure.Employee":{
      readGrants:[{rule:"Employee.read.1"}],locks:["Employee.lock.1"],
      fields:{user:{type:"user",unique:true},department:{type:"enum",cases:["A","B"]},enabled:{type:"bool",default:true}},
    },
    "ArchiveExposure.Request":{
      readGrants:[{rule:"Request.read.1"}],invariants:["Request.require.1","Request.require.2"],locks:["Request.lock.1","Request.lock.2"],
      fields:{
        title:{type:"text",trim:true,min:1n},submitted_by:{type:"user",server:"actor"},
        department:{type:"ArchiveExposure.Employee.department",nullable:true,server:async(c)=>(await first(records(c,"ArchiveExposure.Employee",{where:e=>same(e.user,c.actor)&&e.enabled})))?.department??null},
        archive_reason:{type:"text",nullable:true,default:null,trim:true,min:1n},
      },
    },
  },
  operations:{
    "ArchiveExposure.Request.create":{handler:"createRequest",kind:"create",model:"ArchiveExposure.Request",by:"members",read:false,inputs:{fields:["title"]},when:"Request"},
    "ArchiveExposure.Request.update":{handler:"updateRequest",kind:"update",model:"ArchiveExposure.Request",by:"members",read:false,inputs:{record:{type:"ArchiveExposure.Request"},changes:{fields:["title"]}},when:"Request"},
    // Enabled canonical deletion remains registered once. Only publication is false.
    "ArchiveExposure.Request.delete":{handler:"deleteRequest",kind:"delete",model:"ArchiveExposure.Request",by:"members",read:false,inputs:{record:{type:"ArchiveExposure.Request"}},when:"Request",mode:"archive",expose:false},
    "ArchiveExposure.archive":{handler:"archive",by:"members",read:false,description:message("Archive your open request with a reason, retaining owner and department evidence."),inputs:{request:{type:"ArchiveExposure.Request"},reason:{type:"text"}}},
  },
  pages:[pageDescriptor],
};
export function handlers(){
  const crudWhen={Request:async(c,row)=>same(row.submitted_by,c.actor)&&row.archived_at===null&&await any(records(c,"ArchiveExposure.Employee"),e=>same(e.user,c.actor)&&e.enabled)};
  return {
    crudWhen,
    read:{"Employee.read.1":(c,row)=>hasRole(c,"members")&&same(row.user,c.actor),"Request.read.1":(c,row)=>hasRole(c,"members")&&same(row.submitted_by,c.actor)},
    invariants:{"Request.require.1":(c,row)=>row.department!==null,"Request.require.2":(c,row)=>row.archived_at===null||row.archive_reason!==null},
    locks:{"Employee.lock.1":{fields:["user"]},"Request.lock.1":{fields:["submitted_by","department"]},"Request.lock.2":{fields:["archive_reason"],when:(c,row)=>row.archive_reason!==null}},
    async createRequest(c,input){check(hasRole(c,"members"),"forbidden");await create(c,"ArchiveExposure.Request",input,{when:crudWhen.Request});},
    async updateRequest(c,{record,changes}){check(hasRole(c,"members"),"forbidden");await set(c,record,changes,{when:crudWhen.Request});},
    async deleteRequest(c,{record}){check(hasRole(c,"members"),"forbidden");check(await crudWhen.Request(c,record));await deleteRecord(c,record,{mode:"archive"});},
    async archive(c,{request,reason}){
      check(hasRole(c,"members"),"forbidden");
      check(same(request.submitted_by,c.actor)&&request.archived_at===null);
      check(reason.trim()!=="");
      await set(c,request,{archive_reason:reason.trim()});
      await call(c,"ArchiveExposure.Request.delete",{record:request});
    },
  };
}
export async function requestsPage(c,bindings){
  return renderPage(c,pageDescriptor,()=>[
    form({context:c,operation:"ArchiveExposure.Request.create"}),
    table({context:c,model:"ArchiveExposure.Request",archived:"include",columns:["title","department","archive_reason","archived_at"],renderRow:(row,view)=>[
      text({context:view,values:[row.submitted_by]}),history({context:view,record:row}),
      ...(row.archived_at===null?[card({context:view,title:message("Manage your open request"),children:[
        edit({context:view,operation:"ArchiveExposure.Request.update",record:row}),
        actions({context:view,operations:["ArchiveExposure.archive"],boundArgs:{request:row}}),
      ]})]:[]),
    ]}),
  ]);
}

// Test-only canonical admission descriptors, not public-interface registration.
export function exampleFixtures({self,other,imported}){
  const employee={model:"ArchiveExposure.Employee",dependencies:[],value:async(c,s)=>({user:s.self,department:"A"})};
  const mine={model:"ArchiveExposure.Request",dependencies:[],value:async(c,s)=>({title:"Monitor",submitted_by:s.self,department:"A"})};
  return {employee,mine,examples:[
    {operation:"ArchiveExposure.archive",dependencies:[employee],sequence:[
      {operation:"ArchiveExposure.Request.create",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({title:"Monitor"})},
      {let:"opened",value:async(c,s,b)=>await first(records(c,"ArchiveExposure.Request",{where:row=>same(row.submitted_by,s.self),order:["id"]}))},
      {observations:async(c,s,b)=>[b.opened!==null],expected:async(c,s,b)=>[true],types:["bool"]},
      {operation:"ArchiveExposure.archive",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({request:b.opened,reason:"  No longer needed  "})},
      {let:"archived",value:async(c,s,b)=>await first(records(c,"ArchiveExposure.Request",{archived:"include",where:row=>same(row.submitted_by,s.self),order:["id"]}))},
      {observations:async(c,s,b)=>[b.archived!==null],expected:async(c,s,b)=>[true],types:["bool"]},
      {observations:async(c,s,b)=>[b.archived.archived_at!==null,b.archived.title,b.archived.submitted_by,b.archived.department,b.archived.archive_reason,b.archived.version],expected:async(c,s,b)=>[true,"Monitor",s.self,"A","No longer needed",2n],types:["bool","text","user","ArchiveExposure.Employee.department?","text?","int"]},
      {operation:"ArchiveExposure.archive",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({request:b.archived,reason:"Different reason"}),error:"rule_failed"},
      {let:"retained",value:async(c,s,b)=>await first(records(c,"ArchiveExposure.Request",{archived:"include",where:row=>same(row.submitted_by,s.self),order:["id"]}))},
      {observations:async(c,s,b)=>[b.retained!==null],expected:async(c,s,b)=>[true],types:["bool"]},
      {observations:async(c,s,b)=>[b.retained.archive_reason,b.retained.version,await count(records(c,"ArchiveExposure.Request",{archived:"include"}))],expected:async(c,s,b)=>["No longer needed",2n,1n],types:["text?","int","int"]},
    ]},
    {operation:"ArchiveExposure.Request.delete",kind:"delete",seed:[employee],dependencies:[mine,employee],inputs:async(c,s)=>({record:s.mine}),selectors:["as","record.archive_reason","request.record.version"],observations:[async(c,s)=>s.mine.archived_at!==null,async(c,s)=>s.mine.archive_reason,async(c,s)=>s.mine.version],rows:[
      {dependencies:[],values:async(c,s)=>[s.self,null,1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>[s.self,"Previously recorded",1n],expected:async(c,s)=>[true,"Previously recorded",2n]},
      {dependencies:[],values:async(c,s)=>[s.other,"Previously recorded",1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>[s.self,"Previously recorded",0n],error:"conflict"},
    ]},
    {operation:"ArchiveExposure.archive",seed:[employee],dependencies:[mine,employee],inputs:async(c,s)=>({request:s.mine}),selectors:["as","reason","employee.enabled","request.request.version"],observations:[async(c,s)=>s.mine.archived_at!==null,async(c,s)=>s.mine.title,async(c,s)=>s.mine.submitted_by,async(c,s)=>s.mine.department,async(c,s)=>s.mine.archive_reason,async(c,s)=>s.mine.version],rows:[
      {dependencies:[],values:async(c,s)=>[s.self,"  No longer needed  ",true,1n],expected:async(c,s)=>[true,"Monitor",s.self,"A","No longer needed",2n]},
      {dependencies:[],values:async(c,s)=>[s.self,"   ",true,1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>[s.self,"No longer needed",true,0n],error:"conflict"},
      {dependencies:[],values:async(c,s)=>[s.other,"No longer needed",true,1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>[s.self,"No longer needed",false,1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>["public","No longer needed",true,1n],error:"forbidden"},
    ]},
  ]};
}
