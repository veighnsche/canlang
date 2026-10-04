/* Desired lowering only. No compiler, fixture planner, delivery helper or runner is implemented. */
import {delivery,require as check,hasRole,same} from "@canlang/stdlib";
export const FilesV1="delivery_recipe_witness.FilesV1";
export const appDefinition={
  id:"DeliveryRecipeWitness",uses:["delivery_recipe_witness"],packages:{delivery_recipe_witness:{}},
  capabilities:{[FilesV1]:{exported:true,version:1n,operations:{produce:{inputs:{source:{type:"text"}},result:"file"}}}},
  bindings:{"delivery_recipe_witness.Mail":{capability:"std.EmailV1",from:"deployment.mail"},"delivery_recipe_witness.Files":{capability:FilesV1,from:"deployment.files"}},
  models:{"delivery_recipe_witness.Item":{
    readGrants:[{rule:"Item.read.1"}],locks:["Item.lock.1"],
    fields:{owner:{type:"user",server:"actor"},decision:{type:"enum",cases:["approved","rejected"],default:"approved"},notice:{type:"delivery",operation:"delivery_recipe_witness.Mail.send",nullable:true},artifact:{type:"delivery",operation:"delivery_recipe_witness.Files.produce",nullable:true}},
  }},
  operations:{
    "delivery_recipe_witness.notice_status":{handler:"notice_status",by:"members",read:true,result:"std.DeliveryResult.status?",inputs:{item:{type:"delivery_recipe_witness.Item"}}},
    "delivery_recipe_witness.artifact_result":{handler:"artifact_result",by:"members",read:true,result:"file?",inputs:{item:{type:"delivery_recipe_witness.Item"}}},
  },
};
export function canApp(){return {
  read:{"Item.read.1":(c,row)=>hasRole(c,"members")&&same(row.owner,c.actor)},
  locks:{"Item.lock.1":{fields:["decision"]}},
  async notice_status(c,{item}){check(hasRole(c,"members"),"forbidden");check(same(item.owner,c.actor));return (await delivery(c,{record:item,field:"notice"},["status"]))?.status??null;},
  async artifact_result(c,{item}){check(hasRole(c,"members"),"forbidden");check(same(item.owner,c.actor));return (await delivery(c,{record:item,field:"artifact"},["result"]))?.result??null;},
};}
export function exampleFixtures(){
  const mail_attempt={dependencies:[],delivery:"delivery_recipe_witness.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Decision",body:"Approved"}})};
  const file_attempt={dependencies:[],delivery:"delivery_recipe_witness.Files.produce",values:async(c,s)=>({request:{source:"fixed-document"}})};
  const document={dependencies:[],file:async(c,s)=>({})};
  const item={dependencies:[mail_attempt,file_attempt],model:"delivery_recipe_witness.Item",value:async(c,s)=>({notice:s.mail_attempt,artifact:s.file_attempt})};
  return {mail_attempt,file_attempt,document,item,examples:[
    {operation:"delivery_recipe_witness.notice_status",dependencies:[item],inputs:async(c,s)=>({item:s.item}),
      selectors:["mail_attempt.status","mail_attempt.result","mail_attempt.error"],
      observations:[async(c,s)=>s.result,async(c,s)=>s.item.decision],rows:[
        {dependencies:[],values:async(c,s)=>["pending",null,null],expected:async(c,s)=>["pending","approved"]},
        {dependencies:[],values:async(c,s)=>["succeeded",{reference:"accepted-mail"},null],expected:async(c,s)=>["succeeded","approved"]},
        {dependencies:[],values:async(c,s)=>["failed",null,{code:"provider",message:"Rejected"}],expected:async(c,s)=>["failed","approved"]},
        {dependencies:[],values:async(c,s)=>["unknown",null,null],expected:async(c,s)=>["unknown","approved"]},
        {dependencies:[],values:async(c,s)=>["unknown",null,{code:"timeout",message:"Acceptance uncertain"}],expected:async(c,s)=>["unknown","approved"]},
        {dependencies:[],values:async(c,s)=>["skipped",null,null],expected:async(c,s)=>["skipped","approved"]},
      ]},
    {operation:"delivery_recipe_witness.notice_status",dependencies:[item],inputs:async(c,s)=>({item:s.item}),selectors:["item.notice"],observations:[async(c,s)=>s.result,async(c,s)=>s.item.decision],rows:[{dependencies:[],values:async(c,s)=>[null],expected:async(c,s)=>[null,"approved"]}]},
    {operation:"delivery_recipe_witness.artifact_result",dependencies:[item],inputs:async(c,s)=>({item:s.item}),selectors:["file_attempt.status","file_attempt.result","file_attempt.error"],observations:[async(c,s)=>s.result,async(c,s)=>s.item.decision],rows:[
      {dependencies:[document],values:async(c,s)=>["succeeded",s.document,null],expected:async(c,s)=>[s.document,"approved"]},
      {dependencies:[],values:async(c,s)=>["failed",null,{code:"provider",message:"Rejected"}],expected:async(c,s)=>[null,"approved"]},
      {dependencies:[],values:async(c,s)=>["unknown",null,null],expected:async(c,s)=>[null,"approved"]},
    ]},
  ]};
}
