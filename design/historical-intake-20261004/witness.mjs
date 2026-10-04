// Proposed lowering of the isolated expense-owner excerpt. No implementation claim.
import {any, collect, count, create, datetime, date, hasRole, money, records, same, set, require as check} from "@canlang/stdlib";
import {can_work} from "./employee.mjs";

export const retain_legacy = "expense.retain_legacy";
export const legacy_matches = "expense.legacy_matches";
export const link_legacy = "expense.link_legacy";

export const ownerDefinition = {
  owner: "expense",
  contracts: {
    "expense.LegacyClaim": {fields: {
      actor:{type:"text",nullable:true}, reviewer:{type:"text",nullable:true},
      decision_time_original:{type:"text",nullable:true}, decided_at:{type:"datetime",nullable:true},
      paid:{type:"date",nullable:true}, status:{type:"text",nullable:true},
      purpose:{type:"text",nullable:true}, amount:{type:"money",nullable:true},
      receipt:{type:"file",nullable:true}, receipt_issue:{type:"text",nullable:true},
    }},
  },
  models: {
    "expense.LegacyExpense": {
      fields: {
        source:{type:"text",trim:true,min:1n}, external_id:{type:"text",min:1n},
        location:{type:"rent_catalog.Location"}, claim:{type:"expense.LegacyClaim"},
        source_evidence:{type:"file"}, attestation:{type:"text",trim:true,min:1n},
        claimant:{type:"user",nullable:true}, access_reason:{type:"text",nullable:true}, imported_by:{type:"user",server:"actor"},
        imported_at:{type:"datetime",server:"now"},
      },
      unique:[{fields:["source","external_id"]}],
      locks:["LegacyExpense.lock.1"], invariants:["LegacyExpense.invariant.1"],
      readGrants:[{rule:"LegacyExpense.read.1"},{rule:"LegacyExpense.read.2",fields:["source","external_id","location","claim"]}],
    },
  },
  operations: {
    [retain_legacy]: {handler:"retain_legacy",by:"expense.finance",read:false,result:"expense.LegacyExpense",inputs:{
      source:{type:"text"},external_id:{type:"text"},location:{type:"rent_catalog.Location"},
      claim:{type:"expense.LegacyClaim"},source_evidence:{type:"file"},attestation:{type:"text"},
    }},
    [legacy_matches]: {handler:"legacy_matches",by:"expense.finance",read:true,result:"expense.LegacyExpense[]",inputs:{
      source:{type:"text"},external_id:{type:"text"},location:{type:"rent_catalog.Location"},
    }},
    [link_legacy]: {handler:"link_legacy",by:"expense.finance",read:false,inputs:{
      entry:{type:"expense.LegacyExpense"},claimant:{type:"user",nullable:true},reason:{type:"text"},
    }},
  },
};

export function canApp() {
  return {
    read: {
      "LegacyExpense.read.1":async(c,row)=>hasRole(c,"expense.finance") && await can_work(c,c.actor,row.location),
      "LegacyExpense.read.2":async(c,row)=>hasRole(c,"authenticated") && same(row.claimant,c.actor),
    },
    invariants: {
      "LegacyExpense.invariant.1":(c,row)=>(row.claim.receipt!==null && row.claim.receipt_issue===null) ||
        (row.claim.receipt===null && (row.claim.receipt_issue??"").trim()!==""),
    },
    locks: {
      "LegacyExpense.lock.1":{fields:["source","external_id","location","claim","source_evidence","attestation","imported_by","imported_at"]},
    },
    async retain_legacy(c,{source,external_id,location,claim,source_evidence,attestation}) {
      check(hasRole(c,"expense.finance"),"forbidden");
      check(await can_work(c,c.actor,location) && source.trim()!=="" && external_id.trim()!=="" && attestation.trim()!=="");
      check(!await any(records(c,"expense.LegacyExpense",{archived:"include"}),entry=>entry.source===source.trim() && entry.external_id===external_id));
      const entry=await create(c,"expense.LegacyExpense",{source:source.trim(),external_id,location,claim,source_evidence,attestation:attestation.trim()});
      return entry;
    },
    async legacy_matches(c,{source,external_id,location}) {
      check(hasRole(c,"expense.finance"),"forbidden");
      check(await can_work(c,c.actor,location));
      return collect(records(c,"expense.LegacyExpense",{where:entry=>entry.source===source.trim() && entry.external_id===external_id}));
    },
    async link_legacy(c,{entry,claimant,reason}) {
      check(hasRole(c,"expense.finance"),"forbidden");
      check(await can_work(c,c.actor,entry.location) && reason.trim()!=="");
      check(claimant===null || await any(records(c,"employee.Employee",{archived:"include"}),worker=>same(worker.user,claimant) && (same(worker.home,entry.location) || worker.locations.some(location=>same(location,entry.location)))));
      await set(c,entry,{claimant,access_reason:reason.trim()});
    },
  };
}

// Canonical UI target attributes; the containing existing Expense page owns admission.
export const intakeForm = {operation:retain_legacy,import:"csv",review:legacy_matches};
// No copied CSV schema, generic raw-write tool, source-system credential or file uploader.

export const exampleImports=[
  {provider:"rent_catalog",member:"test_site",alias:"test_site"},
  {provider:"employee",member:"test_worker",alias:"test_worker"},
];
export function exampleFixtures({self,other,imported}) {
  const {test_site,test_worker}=imported;
  const receipt={dependencies:[],file:async(c,s)=>({})};
  const source_evidence={dependencies:[],file:async(c,s)=>({})};
  const importedEntry={model:"expense.LegacyExpense",dependencies:[test_site,receipt,source_evidence],value:async(c,s)=>({
    source:"vendor-a",external_id:"old-17",location:s.test_site,
    claim:{actor:"Former employee 41",reviewer:"Reviewer 8",decision_time_original:"2021-05-12T09:00:00Z",decided_at:datetime("2021-05-12T09:00:00Z"),paid:date("2021-05-20"),status:"Paid",purpose:"Travel",amount:money(25n,"EUR"),receipt:s.receipt,receipt_issue:null},
    source_evidence:s.source_evidence,attestation:"Source fields transcribed; no live approval inferred",
  })};
  return {receipt,source_evidence,imported:importedEntry,examples:[
    {operation:retain_legacy,seed:[test_worker,importedEntry],dependencies:[test_worker,importedEntry,test_site,source_evidence,receipt],
      inputs:async(c,s)=>({source:"vendor-a",external_id:"old-18",location:s.test_site,source_evidence:s.source_evidence,attestation:"Transcribed from retained export",claim:{actor:"Former employee 41",reviewer:null,decision_time_original:null,decided_at:null,paid:null,status:"Unknown",purpose:"Travel",amount:money(25n,"EUR"),receipt:s.receipt,receipt_issue:null}}),
      selectors:["as","external_id","claim.receipt","claim.receipt_issue"],
      observations:[async(c,s)=>s.result.external_id,async(c,s)=>s.result.claim.actor,async(c,s)=>s.result.claim.status,async(c,s)=>s.result.claimant,async(c,s)=>s.result.imported_by],
      rows:[
        {dependencies:[],values:async(c,s)=>["expense.finance","old-18",s.receipt,null],expected:async(c,s)=>["old-18","Former employee 41","Unknown",null,self]},
        {dependencies:[],values:async(c,s)=>["expense.finance","old-18",null,"Original receipt missing from export"],expected:async(c,s)=>["old-18","Former employee 41","Unknown",null,self]},
        {dependencies:[],values:async(c,s)=>["expense.finance","old-17",s.receipt,null],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>["expense.finance","old-18",null,null],error:"rule_failed"},
        {dependencies:[],values:async(c,s)=>["members","old-18",s.receipt,null],error:"forbidden"},
      ],
    },
    {operation:legacy_matches,seed:[test_worker,importedEntry],dependencies:[test_worker,importedEntry,test_site],inputs:async(c,s)=>({source:"vendor-a",external_id:"old-17",location:s.test_site}),selectors:["as"],observations:[async(c,s)=>await count(s.result)],rows:[
      {dependencies:[],values:async(c,s)=>["expense.finance"],expected:async(c,s)=>[1n]},
      {dependencies:[],values:async(c,s)=>["members"],error:"forbidden"},
    ]},
    {operation:link_legacy,seed:[test_worker],dependencies:[test_worker,importedEntry],inputs:async(c,s)=>({entry:s.imported,claimant:self,reason:"Verified original personnel key against current account"}),selectors:["as","entry.claimant","claimant","reason","request.entry.version"],observations:[async(c,s)=>s.imported.claimant,async(c,s)=>s.imported.claim.actor,async(c,s)=>s.imported.claim.decided_at,async(c,s)=>s.imported.access_reason],rows:[
      {dependencies:[],values:async(c,s)=>["expense.finance",null,self,"Verified match",1n],expected:async(c,s)=>[self,"Former employee 41",datetime("2021-05-12T09:00:00Z"),"Verified match"]},
      {dependencies:[],values:async(c,s)=>["expense.finance",self,null,"Revoke mistaken access mapping",1n],expected:async(c,s)=>[null,"Former employee 41",datetime("2021-05-12T09:00:00Z"),"Revoke mistaken access mapping"]},
      {dependencies:[],values:async(c,s)=>["expense.finance",null,other,"No matching roster identity",1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>["expense.finance",null,self," ",1n],error:"rule_failed"},
      {dependencies:[],values:async(c,s)=>["expense.finance",null,self,"Verified match",2n],error:"conflict"},
      {dependencies:[],values:async(c,s)=>["members",null,self,"Verified match",1n],error:"forbidden"},
    ]},
  ]};
}
