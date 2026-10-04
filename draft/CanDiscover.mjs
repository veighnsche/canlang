/* Handwritten desired target for CanDiscover.can. No compiler, stdlib, adapter or
 * example runner is implemented. Typed provider/page/model fixtures are isolated.
 * Source text is untrusted data; canonical owner admission remains authoritative. */
import {any,all,collect,count,first,group,records,create,set,send,schedule,cancel,call,delivery,hasRole,same,contains,trim,add_days,local_date,date,money,datetime,int64,addDuration,subtractDuration,compareInstant,require as check} from '@canlang/stdlib';
import {message,renderPage,tabs,tab,table,form,actions,history} from '@canlang/ui';
import {can_work} from './employee.mjs';
import {promote_research} from './crm.mjs';
const researcher='discover.researcher', reviewer='discover.reviewer';
async function settings(c,p) {return {ted_query:p.ted_query,grants_query:p.grants_query,from:add_days(local_date(c.now,'UTC'),int64(-p.lookback_days)),until:add_days(local_date(c.now,'UTC'),1n),criteria:p.criteria,max_pages:p.max_pages,max_documents:p.max_documents,max_analysis:p.max_analysis,output_tokens:p.output_tokens};}
async function settled(c,r) {const passes=await collect(records(c,'discover.SourcePass',{parent:r}));return BigInt(passes.length)===2n && passes.every(p=>['exhausted','capped','attention','cancelled'].includes(p.state));}
async function eligible(c,r) {return same(r.parent.current,r) && !r.stopped && r.parent.active && hasRole(c,researcher,r.initiator) && await can_work(c,r.initiator,r.parent.location);}
const descriptor={owner:'discover',path:'/discover',title:message('Opportunity research',{nl:'Kansenonderzoek'}),description:message('Research plans and source coverage with reviewable evidence.',{nl:'Onderzoeksplannen en brondekking met beoordeelbaar bewijs.'}),admit:async(c)=>{check(hasRole(c,researcher)||hasRole(c,reviewer),'forbidden');return {};},render:discoverPage};
export function canApp(){return {
 async createPlan(c,input){check(hasRole(c,researcher),'forbidden');return await create(c,'discover.Plan',input,{when:async(c,row)=>can_work(c,c.actor,row.location)});},
 async updatePlan(c,{record,changes}){check(hasRole(c,researcher),'forbidden');await set(c,record,changes,{when:async(c,row)=>can_work(c,c.actor,row.location)});},
 async start(c,{plan}){check(hasRole(c,'discover.researcher'),'forbidden');
  check(await can_work(c,c.actor,plan.location) && plan.active && (plan.current===null||plan.current.stopped||await settled(c,plan.current)));
  const run=await create(c,'discover.Run',{parent:plan,settings:await settings(c,plan),initiator:c.actor,plan_revision:plan.revision});
  const ted=await create(c,'discover.SourcePass',{parent:run,source:'ted',query:run.settings.ted_query});
  const grants=await create(c,'discover.SourcePass',{parent:run,source:'grants_gov',query:run.settings.grants_query});
  await set(c,plan,{current:run});
  await schedule(c,ted.id,c.now,'discover.PageDue',{pass:ted});await schedule(c,grants.id,c.now,'discover.PageDue',{pass:grants});
  await schedule(c,plan.id,addDuration(c.now,plan.period),'discover.PlanDue',{plan,revision:plan.revision});return run;
 },
 async configure(c,{plan,ted_query,grants_query,criteria,period,lookback_days,max_pages,max_documents,max_analysis,output_tokens}){check(hasRole(c,'discover.researcher'),'forbidden');
  check(await can_work(c,c.actor,plan.location) && trim(ted_query)!=='' && trim(grants_query)!=='' && trim(criteria)!=='');
  await set(c,plan,{ted_query,grants_query,criteria,period,lookback_days,max_pages,max_documents,max_analysis,output_tokens,revision:int64(plan.revision+1n)});
  if(plan.active)await schedule(c,plan.id,addDuration(c.now,plan.period),'discover.PlanDue',{plan,revision:plan.revision});
 },
 async pause(c,{plan}){check(hasRole(c,'discover.researcher'),'forbidden');check(await can_work(c,c.actor,plan.location));await set(c,plan,{active:false,revision:int64(plan.revision+1n)});await cancel(c,plan.id);if(plan.current!==null&&!plan.current.stopped){await set(c,plan.current,{stopped:true});const passes=await collect(records(c,'discover.SourcePass',{parent:plan.current}));check(passes.length<=2);for(const pass of passes){await cancel(c,pass.id);await set(c,pass,{state:"cancelled"});}}},
 async take_over(c,{plan}){check(hasRole(c,'discover.researcher'),'forbidden');check(await can_work(c,c.actor,plan.location));await set(c,plan,{owner:c.actor,revision:int64(plan.revision+1n)});if(plan.active)await schedule(c,plan.id,addDuration(c.now,plan.period),'discover.PlanDue',{plan,revision:plan.revision});},
 async resume(c,{plan}){check(hasRole(c,'discover.researcher'),'forbidden');check(await can_work(c,c.actor,plan.location) && hasRole(c,researcher,plan.owner) && await can_work(c,plan.owner,plan.location));await set(c,plan,{active:true,revision:int64(plan.revision+1n)});await schedule(c,plan.id,c.now,'discover.PlanDue',{plan,revision:plan.revision});},
 async recurring(c,{event}){
  const plan=event.plan;
  if(plan.active && plan.revision===event.revision && hasRole(c,researcher,plan.owner) && await can_work(c,plan.owner,plan.location)){
   if(plan.current===null||plan.current.stopped||await settled(c,plan.current)){
    const run=await create(c,'discover.Run',{parent:plan,settings:await settings(c,plan),initiator:plan.owner,plan_revision:plan.revision});
    const ted=await create(c,'discover.SourcePass',{parent:run,source:'ted',query:run.settings.ted_query});
    const grants=await create(c,'discover.SourcePass',{parent:run,source:'grants_gov',query:run.settings.grants_query});
    await set(c,plan,{current:run});await schedule(c,ted.id,c.now,'discover.PageDue',{pass:ted});await schedule(c,grants.id,c.now,'discover.PageDue',{pass:grants});
   }
   await schedule(c,plan.id,addDuration(c.now,plan.period),'discover.PlanDue',{plan,revision:plan.revision});
  }
 },
 async fetch_page(c,{event}){
  const pass=event.pass,run=pass.parent;
  if(pass.state==='ready' && await eligible(c,run)){
   if(pass.requests<run.settings.max_pages && run.document_slots<run.settings.max_documents){
    const remaining=int64(run.settings.max_documents-run.document_slots),take=remaining<20n?remaining:20n;
    const attempt=await create(c,'discover.PageAttempt',{parent:pass,cursor:pass.cursor,take});
    const request=await send(c,'discover.Sources.page',{source:pass.source,query:pass.query,from:run.settings.from,until:run.settings.until,cursor:pass.cursor,take},{when:async()=>await eligible(c,run)&&same(pass.current,attempt)});
    await set(c,attempt,{request});await set(c,pass,{current:attempt,state:'fetching',requests:int64(pass.requests+1n)});await set(c,run,{document_slots:int64(run.document_slots+take)});
   }else await set(c,pass,{state:'capped',detail:'Page or document reservation cap reached; coverage is partial'});
  }
 },
 async page_result(c,{event}){
  const attempt=await first(records(c,'discover.PageAttempt',{where:async row=>(await delivery(c,{record:row,field:'request'},['id']))?.id===event.delivery_id}));
  if(attempt!==null && !attempt.applied){
   const pass=attempt.parent,run=pass.parent;
   if(!same(pass.current,attempt)||!await eligible(c,run))await set(c,attempt,{late:true,detail:'Retained request result is outside the current admitted continuation'});
   else if(event.status==='succeeded' && event.result!==null){
    const result=event.result;
    if(BigInt(result.documents.length)<=attempt.take && ((result.terminal && result.next_cursor===null)||(!result.terminal && result.next_cursor!==null && result.next_cursor!==attempt.cursor)) && (await count(await group(result.documents,d=>d.key)))===BigInt(result.documents.length)){
     check(result.documents.length<=20); // Same reject-on-overflow loop bound; no slice/truncation.
     for(const doc of result.documents){
      const old=await first(records(c,'discover.Opportunity',{parent:run.parent,where:item=>item.source===pass.source && item.key===doc.key}));
      if(old===null){
       const found=await create(c,'discover.Opportunity',{parent:run.parent,source:pass.source,key:doc.key,canonical_url:doc.url,identity_conflict:await any(records(c,'discover.Opportunity',{parent:run.parent}),item=>item.canonical_url===doc.url)});
       const evidence=await create(c,'discover.Evidence',{parent:found,ordinal:1n,document:doc,run,page:attempt});
      }else{
       const previous=await first(records(c,'discover.Evidence',{parent:old,where:item=>item.document.revision===doc.revision}));
       if(previous===null){const evidence=await create(c,'discover.Evidence',{parent:old,ordinal:int64((old.latest?.ordinal??0n)+1n),document:doc,run,page:attempt});await set(c,old,{identity_conflict:old.identity_conflict||old.canonical_url!==doc.url});}
       else if(previous.document.key!==doc.key||previous.document.url!==doc.url||previous.document.title!==doc.title||previous.document.body!==doc.body||previous.document.deadline_original!==doc.deadline_original||previous.document.deadline_zone!==doc.deadline_zone){await create(c,'discover.Conflict',{parent:old,document:doc,run,page:attempt});await set(c,old,{identity_conflict:true});}
      }
     }
     await set(c,attempt,{applied:true,next_cursor:result.next_cursor,terminal:result.terminal,traversal:result.traversal,observed:c.now,source_as_of:result.source_as_of,detail:result.detail});
     await set(c,pass,{cursor:result.next_cursor,state:'ready',detail:result.detail});
     if(result.terminal)await set(c,pass,{state:'exhausted'});else await schedule(c,pass.id,c.now,'discover.PageDue',{pass});
    }else await set(c,pass,{state:'attention',detail:'Invalid cursor, duplicate identity or oversized page'});
   }else await set(c,pass,{state:'attention',detail:'Source request did not yield an accepted page; coverage remains partial'});
  }
 },
 async retry(c,{pass}){check(hasRole(c,'discover.researcher'),'forbidden');check(await can_work(c,c.actor,pass.parent.parent.location) && await eligible(c,pass.parent) && pass.state==='attention' && pass.requests<pass.parent.settings.max_pages && pass.parent.document_slots<pass.parent.settings.max_documents);await set(c,pass,{state:'ready'});await schedule(c,pass.id,c.now,'discover.PageDue',{pass});},
 async stop(c,{run}){check(hasRole(c,'discover.researcher'),'forbidden');check(await can_work(c,c.actor,run.parent.location));await set(c,run,{stopped:true});const passes=await collect(records(c,'discover.SourcePass',{parent:run}));check(passes.length<=2);for(const pass of passes){await cancel(c,pass.id);await set(c,pass,{state:'cancelled'});}},
 async analyse(c,{evidence}){check(hasRole(c,'discover.researcher'),'forbidden');
  check(await can_work(c,c.actor,evidence.parent.parent.location) && same(evidence.parent.latest,evidence) && !evidence.parent.identity_conflict && await eligible(c,evidence.run) && evidence.run.analysis_slots<evidence.run.settings.max_analysis);check(evidence.analysis===null);
  const request=await send(c,'discover.Analysis.extract',{document:evidence.document,criteria:evidence.run.settings.criteria,output_tokens:evidence.run.settings.output_tokens},{when:async()=>await eligible(c,evidence.run)&&same(evidence.parent.latest,evidence)&&!evidence.parent.identity_conflict});await set(c,evidence,{analysis:request});await set(c,evidence.run,{analysis_slots:int64(evidence.run.analysis_slots+1n)});
 },
 async analyse_new(c,{event}){
  const evidence=event.after;
  if(await eligible(c,evidence.run) && !evidence.parent.identity_conflict && evidence.run.analysis_slots<evidence.run.settings.max_analysis){const request=await send(c,'discover.Analysis.extract',{document:evidence.document,criteria:evidence.run.settings.criteria,output_tokens:evidence.run.settings.output_tokens},{when:async()=>await eligible(c,evidence.run)&&same(evidence.parent.latest,evidence)&&!evidence.parent.identity_conflict});await set(c,evidence,{analysis:request});await set(c,evidence.run,{analysis_slots:int64(evidence.run.analysis_slots+1n)});}
 },
 async analysis_result(c,{event}){
  const evidence=await first(records(c,'discover.Evidence',{where:async row=>(await delivery(c,{record:row,field:'analysis'},['id']))?.id===event.delivery_id}));
  if(evidence!==null && evidence.claims===null){
   if(event.status==='succeeded' && event.result!==null && await eligible(c,evidence.run) && same(evidence.parent.latest,evidence)){
    const claims=event.result;
    if(claims.citations.length>0 && claims.citations.every(cite=>contains(evidence.document.body,cite.quote)) && (claims.deadline===null||(claims.deadline_zone!==null&&!claims.deadline_uncertain&&claims.citations.some(cite=>cite.field==='deadline'))))await set(c,evidence,{claims});
    else await set(c,evidence,{analysis_issue:'Claims or deadline citations could not be validated; review the original manually'});
   }else await set(c,evidence,{analysis_issue:'No current accepted analysis; source evidence remains available for manual review'});
  }
 },
 async review(c,{evidence,title,summary,deadline,deadline_zone,deadline_note,quotes}){check(hasRole(c,'discover.reviewer'),'forbidden');
  check(await can_work(c,c.actor,evidence.parent.parent.location) && same(evidence.parent.latest,evidence) && !evidence.parent.needs_identity_review && evidence.parent.duplicate_of===null);
  return await create(c,'discover.Review',{parent:evidence.parent,evidence,title,summary,deadline,deadline_zone,deadline_note,quotes});
 },
 async duplicate(c,{opportunity,canonical,reason}){check(hasRole(c,'discover.reviewer'),'forbidden');check(await can_work(c,c.actor,opportunity.parent.location) && same(opportunity.parent,canonical.parent) && !same(opportunity,canonical) && opportunity.deal===null && canonical.duplicate_of===null && trim(reason)!=='');await set(c,opportunity,{duplicate_of:canonical,identity_conflict:false,identity_note:reason});},
 async accept_identity(c,{opportunity,reason}){check(hasRole(c,'discover.reviewer'),'forbidden');check(await can_work(c,c.actor,opportunity.parent.location)&&opportunity.latest!==null&&opportunity.deal===null&&opportunity.duplicate_of===null&&trim(reason)!=='');check(!await any(records(c,'discover.Opportunity',{parent:opportunity.parent}),other=>!same(other,opportunity)&&other.canonical_url===opportunity.latest.document.url&&!same(other.duplicate_of,opportunity)));await set(c,opportunity,{canonical_url:opportunity.latest.document.url,identity_conflict:false,identity_note:reason});},
 async promote(c,{review,customer,contact,value}){check(hasRole(c,'discover.reviewer'),'forbidden');
  check(await can_work(c,c.actor,review.parent.parent.location) && same(review.parent.latest,review.evidence) && !review.parent.needs_identity_review && review.parent.duplicate_of===null && (review.deadline===null||compareInstant(c.now,review.deadline)<0));
  const deal=await call(c,promote_research,{source:'discover:'+review.parent.id,input:{customer,contact,location:review.parent.parent.location,title:review.title,value,notes:review.summary+'\nEvidence: '+review.evidence.document.url+'\nRevision: '+review.evidence.document.revision+'\nDeadline: '+review.deadline_note}});
  await set(c,review.parent,{deal});return deal;
 },
settings,settled,eligible,
 crudWhen:{Plan:(c,row)=>can_work(c,c.actor,row.location)},
 read:{"Plan.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.location),"Run.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.location),"SourcePass.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.parent.location),"PageAttempt.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.parent.parent.location),"Opportunity.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.location),"Evidence.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.parent.location),"Review.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.parent.location),"Conflict.read.1":async(c,r)=>(hasRole(c,"discover.researcher")||hasRole(c,"discover.reviewer"))&&await can_work(c,c.actor,r.parent.parent.location)},
 locks:{"Plan.lock.1":{"fields":["location"]},"Run.lock.1":{"fields":["settings","initiator","plan_revision","started"]},"SourcePass.lock.1":{"fields":["source","query"]},"PageAttempt.lock.1":{"fields":["cursor","take"]},"Evidence.lock.1":{"fields":["ordinal","document","run","page"]},"Evidence.lock.2":{"fields":["claims"],"when":(c,row)=>row.claims!==null},"Conflict.lock.1":{"fields":["document","run","page","observed"]},"Review.lock.1":{"fields":["evidence","title","summary","deadline","deadline_zone","deadline_note","quotes","reviewed_by","reviewed_at"]}},
 invariants:{"Plan.invariant.1":(c,r)=>r.period>=86400000n&&r.lookback_days>=1n&&r.lookback_days<=90n&&r.max_pages>=1n&&r.max_pages<=20n&&r.max_documents>=1n&&r.max_documents<=400n&&r.max_analysis>=0n&&r.max_analysis<=100n&&r.output_tokens>=1n&&r.output_tokens<=4000n,
 "Review.invariant.1":(c,r)=>same(r.evidence.parent,r.parent)&&r.quotes.every(q=>trim(q)!==''&&contains(r.evidence.document.body,q))&&(r.deadline===null||r.deadline_zone!==null)},
 derives:{
 "Run.complete":async(c,row)=>{const passes=await collect(records(c,'discover.SourcePass',{parent:row}));if(passes.length!==2)return false;for(const pass of passes){const attempts=await collect(records(c,'discover.PageAttempt',{parent:pass,where:a=>a.applied}));if(pass.state!=='exhausted'||attempts.length===0||attempts.some(a=>a.traversal!=='snapshot'||a.source_as_of===null||compareInstant(a.source_as_of,attempts[0].source_as_of)!==0))return false;}return true;},
 "Opportunity.latest":(c,row)=>first(records(c,'discover.Evidence',{parent:row,order:{by:r=>r.ordinal,direction:"desc"}})),
 "Opportunity.expired":(c,row)=>any(records(c,'discover.Review',{parent:row}),r=>same(r.evidence,row.latest)&&r.deadline!==null&&compareInstant(r.deadline,c.now)<=0),
 "Opportunity.needs_identity_review":async(c,row)=>row.identity_conflict||(row.duplicate_of===null&&await any(records(c,'discover.Opportunity',{parent:row.parent}),other=>!same(other,row)&&other.canonical_url===row.canonical_url&&!same(other.duplicate_of,row)))
 },discoverPage
};}
export async function discoverPage(c,b){return renderPage(c,descriptor,()=>[tabs({context:c,children:[
 tab({context:c,caption:message('Plans',{nl:'Plannen'}),children:[form({context:c,operation:'discover.Plan.create'}),table({context:c,model:'discover.Plan',columns:['name','location','active','revision'],renderRow:(row,view)=>[
  actions({context:view,operations:['discover.start','discover.pause','discover.resume','discover.take_over'],boundArgs:{plan:row}}),form({context:view,operation:'discover.configure',arguments:{plan:row}}),
  table({context:view,model:'discover.Run',parent:row,columns:['started','complete','stopped','document_slots','analysis_slots'],renderRow:(run,rv)=>[actions({context:rv,operations:['discover.stop'],boundArgs:{run}}),table({context:rv,model:'discover.SourcePass',parent:run,columns:['source','state','requests','detail'],renderRow:(pass,pv)=>[actions({context:pv,operations:['discover.retry'],boundArgs:{pass}}),table({context:pv,model:'discover.PageAttempt',parent:pass,columns:['cursor','take','applied','late','traversal','detail','request']})]})]})]})]}),
 tab({context:c,caption:message('Evidence and review',{nl:'Bewijs en beoordeling'}),children:[table({context:c,model:'discover.Opportunity',columns:['source','key','canonical_url','needs_identity_review','expired','duplicate_of','deal'],renderRow:(row,view)=>[form({context:view,operation:'discover.duplicate',arguments:{opportunity:row}}),form({context:view,operation:'discover.accept_identity',arguments:{opportunity:row}}),table({context:view,model:'discover.Evidence',parent:row,columns:['document','claims','analysis_issue'],renderRow:(e,ev)=>[actions({context:ev,operations:['discover.analyse'],boundArgs:{evidence:e}}),form({context:ev,operation:'discover.review',arguments:{evidence:e}})]}),table({context:view,model:'discover.Conflict',parent:row,columns:['document','observed']}),table({context:view,model:'discover.Review',parent:row,columns:['title','deadline','deadline_note','reviewed_by','reviewed_at'],renderRow:(review,rv)=>[form({context:rv,operation:'discover.promote',arguments:{review}})]}),history({context:view,record:row})]})]}),
]})]);}

export const appDefinition = {
  "id": "CanDiscover",
  "uses": ["discover"],
  "description": message("Monitor two declared opportunity sources and promote only staff-reviewed evidence.", {
    "nl": "Volg twee vastgelegde kansenbronnen en promoveer alleen door medewerkers beoordeeld bewijs."
  }),
  "packages": {
    "discover": {
      "label": message("Opportunity research", {
        "nl": "Kansenonderzoek"
      }),
      "description": message("Retain source coverage, uncertain claims and reviewed CRM handoffs.", {
        "nl": "Bewaar brondekking, onzekere claims en beoordeelde CRM-overdrachten."
      }),
      "roles": {
        "researcher": {
          "id": "discover.researcher",
          "label": message("Researcher", {
            "nl": "Onderzoeker"
          })
        },
        "reviewer": {
          "id": "discover.reviewer",
          "label": message("Research reviewer", {
            "nl": "Onderzoeksbeoordelaar"
          })
        }
      }
    }
  },
  "bindings": {
    "discover.Sources": {
      "capability": "discover.DiscoverySourceV1",
      "from": "deployment.discovery_sources"
    },
    "discover.Analysis": {
      "capability": "discover.DiscoveryAnalysisV1",
      "from": "deployment.discovery_analysis"
    }
  },
  "contracts": {
    "discover.Document": {
      "exported": true,
      "fields": {
        "key": {
          "type": "text",
          "min": 1n
        },
        "revision": {
          "type": "text",
          "min": 1n
        },
        "url": {
          "type": "url"
        },
        "title": {
          "type": "text"
        },
        "body": {
          "type": "text",
          "max": 60000n
        },
        "deadline_original": {
          "type": "text",
          "nullable": true
        },
        "deadline_zone": {
          "type": "timezone",
          "nullable": true
        },
        "retrieved": {
          "type": "datetime"
        }
      }
    },
    "discover.SourcePage": {
      "exported": true,
      "fields": {
        "documents": {
          "type": "discover.Document",
          "array": true,
          "max": 20n
        },
        "next_cursor": {
          "type": "text",
          "nullable": true
        },
        "terminal": {
          "type": "bool"
        },
        "source_as_of": {
          "type": "datetime",
          "nullable": true
        },
        "traversal": {
          "type": "enum",
          "cases": ["snapshot", "live", "uncertain"]
        },
        "detail": {
          "type": "text",
          "nullable": true
        }
      }
    },
    "discover.Query": {
      "exported": true,
      "fields": {
        "source": {
          "type": "enum",
          "cases": ["ted", "grants_gov"]
        },
        "take": {
          "type": "int",
          "min": 1n,
          "max": 20n
        }
      }
    },
    "discover.AnalysisLimit": {
      "exported": true,
      "fields": {
        "output_tokens": {
          "type": "int",
          "min": 1n,
          "max": 4000n
        }
      }
    },
    "discover.Citation": {
      "exported": true,
      "fields": {
        "field": {
          "type": "enum",
          "cases": ["title", "summary", "deadline", "fit"]
        },
        "quote": {
          "type": "text",
          "min": 1n
        }
      }
    },
    "discover.Claims": {
      "exported": true,
      "fields": {
        "title": {
          "type": "text",
          "min": 1n
        },
        "summary": {
          "type": "text"
        },
        "deadline": {
          "type": "datetime",
          "nullable": true
        },
        "deadline_original": {
          "type": "text",
          "nullable": true
        },
        "deadline_zone": {
          "type": "timezone",
          "nullable": true
        },
        "deadline_uncertain": {
          "type": "bool"
        },
        "citations": {
          "type": "discover.Citation",
          "array": true,
          "max": 20n
        },
        "fit": {
          "type": "decimal",
          "min": "0",
          "max": "1"
        },
        "confidence": {
          "type": "decimal",
          "min": "0",
          "max": "1"
        },
        "rationale": {
          "type": "text"
        }
      }
    },
    "discover.Settings": {
      "fields": {
        "ted_query": {
          "type": "text"
        },
        "grants_query": {
          "type": "text"
        },
        "from": {
          "type": "date"
        },
        "until": {
          "type": "date"
        },
        "criteria": {
          "type": "text"
        },
        "max_pages": {
          "type": "int"
        },
        "max_documents": {
          "type": "int"
        },
        "max_analysis": {
          "type": "int"
        },
        "output_tokens": {
          "type": "int"
        }
      }
    }
  },
  "models": {
    "discover.Plan": {
      "fields": {
        "name": {
          "type": "text",
          "trim": true,
          "min": 1n
        },
        "location": {
          "type": "rent_catalog.Location"
        },
        "owner": {
          "type": "user",
          "server": "actor"
        },
        "active": {
          "type": "bool",
          "default": true
        },
        "revision": {
          "type": "int",
          "default": 1n
        },
        "period": {
          "type": "duration",
          "default": 604800000n
        },
        "lookback_days": {
          "type": "int",
          "default": 7n
        },
        "ted_query": {
          "type": "text"
        },
        "grants_query": {
          "type": "text"
        },
        "criteria": {
          "type": "text"
        },
        "max_pages": {
          "type": "int",
          "default": 3n
        },
        "max_documents": {
          "type": "int",
          "default": 100n
        },
        "max_analysis": {
          "type": "int",
          "default": 20n
        },
        "output_tokens": {
          "type": "int",
          "default": 2000n
        },
        "current": {
          "type": "discover.Run",
          "nullable": true
        }
      },
      "readGrants": [{
        "rule": "Plan.read.1"
      }],
      "locks": ["Plan.lock.1"],
      "invariants": ["Plan.invariant.1"]
    },
    "discover.Run": {
      "derived": {"complete":{"handler":"Run.complete","type":"bool"}},
      "fields": {
        "settings": {
          "type": "discover.Settings"
        },
        "initiator": {
          "type": "user"
        },
        "plan_revision": {
          "type": "int"
        },
        "started": {
          "type": "datetime",
          "server": "now"
        },
        "stopped": {
          "type": "bool",
          "default": false
        },
        "document_slots": {
          "type": "int",
          "default": 0n
        },
        "analysis_slots": {
          "type": "int",
          "default": 0n
        }
      },
      "parent": "discover.Plan",
      "readGrants": [{
        "rule": "Run.read.1"
      }],
      "locks": ["Run.lock.1"]
    },
    "discover.SourcePass": {
      "fields": {
        "source": {
          "type": "discover.Query.source"
        },
        "query": {
          "type": "text"
        },
        "cursor": {
          "type": "text",
          "nullable": true
        },
        "requests": {
          "type": "int",
          "default": 0n
        },
        "state": {
          "type": "enum",
          "cases": ["ready", "fetching", "exhausted", "capped", "attention", "cancelled"],
          "default": "ready"
        },
        "current": {
          "type": "discover.PageAttempt",
          "nullable": true
        },
        "detail": {
          "type": "text",
          "nullable": true
        }
      },
      "parent": "discover.Run",
      "readGrants": [{
        "rule": "SourcePass.read.1"
      }],
      "unique": [{
        "fields": ["source"]
      }],
      "locks": ["SourcePass.lock.1"]
    },
    "discover.PageAttempt": {
      "fields": {
        "cursor": {
          "type": "text",
          "nullable": true
        },
        "take": {
          "type": "int"
        },
        "request": {
          "type": "delivery",
          "nullable": true,
          "operation": "discover.Sources.page"
        },
        "applied": {
          "type": "bool",
          "default": false
        },
        "late": {
          "type": "bool",
          "default": false
        },
        "next_cursor": {
          "type": "text",
          "nullable": true
        },
        "terminal": {
          "type": "bool",
          "default": false
        },
        "traversal": {
          "type": "discover.SourcePage.traversal",
          "nullable": true
        },
        "observed": {
          "type": "datetime",
          "nullable": true
        },
        "source_as_of": {
          "type": "datetime",
          "nullable": true
        },
        "detail": {
          "type": "text",
          "nullable": true
        }
      },
      "parent": "discover.SourcePass",
      "readGrants": [{
        "rule": "PageAttempt.read.1"
      }],
      "locks": ["PageAttempt.lock.1"]
    },
    "discover.Opportunity": {
      "derived": {"latest":{"handler":"Opportunity.latest","type":"discover.Evidence","nullable":true},"expired":{"handler":"Opportunity.expired","type":"bool"},"needs_identity_review":{"handler":"Opportunity.needs_identity_review","type":"bool"}},
      "fields": {
        "source": {
          "type": "discover.Query.source"
        },
        "key": {
          "type": "text"
        },
        "canonical_url": {
          "type": "url"
        },
        "identity_conflict": {
          "type": "bool",
          "default": false
        },
        "duplicate_of": {
          "type": "discover.Opportunity",
          "nullable": true
        },
        "identity_note": {
          "type": "text",
          "nullable": true
        },
        "deal": {
          "type": "crm.Deal",
          "nullable": true
        }
      },
      "parent": "discover.Plan",
      "readGrants": [{
        "rule": "Opportunity.read.1"
      }],
      "unique": [{
        "fields": ["source", "key"]
      }]
    },
    "discover.Evidence": {
      "fields": {
        "ordinal": {
          "type": "int",
          "min": 1n
        },
        "document": {
          "type": "discover.Document"
        },
        "run": {
          "type": "discover.Run"
        },
        "page": {
          "type": "discover.PageAttempt"
        },
        "analysis": {
          "type": "delivery",
          "nullable": true,
          "operation": "discover.Analysis.extract"
        },
        "claims": {
          "type": "discover.Claims",
          "nullable": true
        },
        "analysis_issue": {
          "type": "text",
          "nullable": true
        }
      },
      "parent": "discover.Opportunity",
      "readGrants": [{
        "rule": "Evidence.read.1"
      }],
      "unique": [{
        "fields": ["document.revision"]
      }, {
        "fields": ["ordinal"]
      }],
      "locks": ["Evidence.lock.1", "Evidence.lock.2"]
    },
    "discover.Conflict": {
      "fields": {
        "document": {
          "type": "discover.Document"
        },
        "run": {
          "type": "discover.Run"
        },
        "page": {
          "type": "discover.PageAttempt"
        },
        "observed": {
          "type": "datetime",
          "server": "now"
        }
      },
      "parent": "discover.Opportunity",
      "readGrants": [{
        "rule": "Conflict.read.1"
      }],
      "locks": ["Conflict.lock.1"]
    },
    "discover.Review": {
      "fields": {
        "evidence": {
          "type": "discover.Evidence"
        },
        "title": {
          "type": "text",
          "trim": true,
          "min": 1n
        },
        "summary": {
          "type": "text"
        },
        "deadline": {
          "type": "datetime",
          "nullable": true
        },
        "deadline_zone": {
          "type": "timezone",
          "nullable": true
        },
        "deadline_note": {
          "type": "text",
          "trim": true,
          "min": 1n
        },
        "quotes": {
          "type": "text",
          "array": true,
          "min": 1n,
          "max": 20n
        },
        "reviewed_by": {
          "type": "user",
          "server": "actor"
        },
        "reviewed_at": {
          "type": "datetime",
          "server": "now"
        }
      },
      "parent": "discover.Opportunity",
      "readGrants": [{
        "rule": "Review.read.1"
      }],
      "locks": ["Review.lock.1"],
      "invariants": ["Review.invariant.1"]
    }
  },
  "events": {
    "discover.PlanDue": {
      "fields": {
        "plan": {
          "type": "discover.Plan"
        },
        "revision": {
          "type": "int"
        }
      }
    },
    "discover.PageDue": {
      "fields": {
        "pass": {
          "type": "discover.SourcePass"
        }
      }
    }
  },
  "capabilities": {
    "discover.DiscoverySourceV1": {
      "exported": true,
      "version": 1n,
      "operations": {
        "page": {
          "inputs": {
            "source": {
              "type": "discover.Query.source"
            },
            "query": {
              "type": "text"
            },
            "from": {
              "type": "date"
            },
            "until": {
              "type": "date"
            },
            "cursor": {
              "type": "text",
              "nullable": true
            },
            "take": {
              "type": "int",
              "min": 1n,
              "max": 20n
            }
          },
          "result": {type:"discover.SourcePage"}
        }
      }
    },
    "discover.DiscoveryAnalysisV1": {
      "exported": true,
      "version": 1n,
      "operations": {
        "extract": {
          "inputs": {
            "document": {
              "type": "discover.Document"
            },
            "criteria": {
              "type": "text"
            },
            "output_tokens": {
              "type": "int",
              "min": 1n,
              "max": 4000n
            }
          },
          "result": {type:"discover.Claims"}
        }
      }
    }
  },
  "pure": {
    "discover.settings": {
      "handler": "settings",
      "inputs": {
        "plan": {
          "type": "discover.Plan"
        }
      },
      "result": {type:"discover.Settings"}
    },
    "discover.settled": {
      "handler": "settled",
      "inputs": {
        "run": {
          "type": "discover.Run"
        }
      },
      "result": {type:"bool"}
    },
    "discover.eligible": {
      "handler": "eligible",
      "inputs": {
        "run": {
          "type": "discover.Run"
        }
      },
      "result": {type:"bool"}
    }
  },
  "operations": {
    "discover.Plan.create": {
      "handler": "createPlan",
      "kind": "create",
      "model": "discover.Plan",
      "by": "discover.researcher",
      "inputs": {
        "fields": ["name", "location", "ted_query", "grants_query", "criteria"]
      },
      "when": "Plan"
    },
    "discover.Plan.update": {
      "handler": "updatePlan",
      "kind": "update",
      "model": "discover.Plan",
      "by": "discover.researcher",
      "inputs": {
        "record": {
          "type": "discover.Plan"
        },
        "changes": {
          "fields": ["name"]
        }
      },
      "when": "Plan"
    },
    "discover.start": {
      "handler": "start",
      "label": message("Run now", {
        "nl": "Nu uitvoeren"
      }),
      "description": message("Start a frozen research run and reserve one durable continuation for each source.", {
        "nl": "Start een vastgelegde onderzoeksronde met een duurzame voortzetting per bron."
      }),
      "by": "discover.researcher",
      "inputs": {
        "plan": {
          "type": "discover.Plan"
        }
      },
      "result": {type:"discover.Run"}
    },
    "discover.configure": {
      "handler": "configure",
      "description": message("Replace future settings; existing runs keep their original evidence and reservations.", {
        "nl": "Vervang toekomstige instellingen; bestaande rondes behouden hun bewijs en reserveringen."
      }),
      "by": "discover.researcher",
      "inputs": {
        "plan": {
          "type": "discover.Plan"
        },
        "ted_query": {
          "type": "text"
        },
        "grants_query": {
          "type": "text"
        },
        "criteria": {
          "type": "text"
        },
        "period": {
          "type": "duration"
        },
        "lookback_days": {
          "type": "int"
        },
        "max_pages": {
          "type": "int"
        },
        "max_documents": {
          "type": "int"
        },
        "max_analysis": {
          "type": "int"
        },
        "output_tokens": {
          "type": "int"
        }
      }
    },
    "discover.pause": {
      "handler": "pause",
      "description": message("Pause recurrence without pretending that an in-flight provider stopped or refunded work.", {
        "nl": "Pauzeer herhaling zonder te beweren dat lopend providerwerk is gestopt of terugbetaald."
      }),
      "by": "discover.researcher",
      "inputs": {
        "plan": {
          "type": "discover.Plan"
        }
      }
    },
    "discover.take_over": {
      "handler": "take_over",
      "description": message("Take responsibility for future recurring runs under your current work eligibility.", {
        "nl": "Neem verantwoordelijkheid voor toekomstige rondes binnen je actuele werkbevoegdheid."
      }),
      "by": "discover.researcher",
      "inputs": {
        "plan": {
          "type": "discover.Plan"
        }
      }
    },
    "discover.resume": {
      "handler": "resume",
      "description": message("Resume future runs after checking the current responsible researcher.", {
        "nl": "Hervat toekomstige rondes na controle van de verantwoordelijke onderzoeker."
      }),
      "by": "discover.researcher",
      "inputs": {
        "plan": {
          "type": "discover.Plan"
        }
      }
    },
    "discover.retry": {
      "handler": "retry",
      "description": message("Explicitly reserve another read attempt; earlier unknown attempts retain their cost reservation.", {
        "nl": "Reserveer expliciet een nieuwe leespoging; eerdere onzekere pogingen behouden hun kostenreservering."
      }),
      "by": "discover.researcher",
      "inputs": {
        "pass": {
          "type": "discover.SourcePass"
        }
      }
    },
    "discover.stop": {
      "handler": "stop",
      "description": message("Stop additional work and quarantine later results without claiming provider cancellation.", {
        "nl": "Stop nieuw werk en sluit latere resultaten uit zonder providerannulering te claimen."
      }),
      "by": "discover.researcher",
      "inputs": {
        "run": {
          "type": "discover.Run"
        }
      }
    },
    "discover.analyse": {
      "handler": "analyse",
      "description": message("Extract only from retained evidence; a score is advice, never a review or promotion.", {
        "nl": "Extraheer alleen uit bewaard bewijs; een score is advies en nooit een beoordeling of promotie."
      }),
      "by": "discover.researcher",
      "inputs": {
        "evidence": {
          "type": "discover.Evidence"
        }
      }
    },
    "discover.review": {
      "handler": "review",
      "description": message("Freeze corrected claims and cited evidence before any business handoff.", {
        "nl": "Leg gecorrigeerde claims en geciteerd bewijs vast vóór een zakelijke overdracht."
      }),
      "by": "discover.reviewer",
      "inputs": {
        "evidence": {
          "type": "discover.Evidence"
        },
        "title": {
          "type": "text"
        },
        "summary": {
          "type": "text"
        },
        "deadline": {
          "type": "datetime",
          "nullable": true
        },
        "deadline_zone": {
          "type": "timezone",
          "nullable": true
        },
        "deadline_note": {
          "type": "text"
        },
        "quotes": {
          "type": "text",
          "array": true
        }
      },
      "result": {type:"discover.Review"}
    },
    "discover.duplicate": {
      "handler": "duplicate",
      "description": message("Keep both source identities when a reviewer resolves a duplicate conflict.", {
        "nl": "Bewaar beide bronidentiteiten wanneer een beoordelaar een dubbel conflict oplost."
      }),
      "by": "discover.reviewer",
      "inputs": {
        "opportunity": {
          "type": "discover.Opportunity"
        },
        "canonical": {
          "type": "discover.Opportunity"
        },
        "reason": {
          "type": "text"
        }
      }
    },
    "discover.accept_identity": {
      "handler": "accept_identity",
      "description": message("Keep the selected retained revision after a documented identity conflict review.", {
        "nl": "Behoud de gekozen bewaarde revisie na een gedocumenteerde identiteitscontrole."
      }),
      "by": "discover.reviewer",
      "inputs": {
        "opportunity": {
          "type": "discover.Opportunity"
        },
        "reason": {
          "type": "text"
        }
      }
    },
    "discover.promote": {
      "handler": "promote",
      "description": message("Promote one reviewed revision through the canonical sales owner; research never overwrites a deal.", {
        "nl": "Promoveer één beoordeelde revisie via de canonieke verkoopeigenaar; onderzoek overschrijft nooit een verkoopkans."
      }),
      "by": "discover.reviewer",
      "inputs": {
        "review": {
          "type": "discover.Review"
        },
        "customer": {
          "type": "customer.Customer"
        },
        "contact": {
          "type": "customer.Contact"
        },
        "value": {
          "type": "money"
        }
      },
      "result": {type:"crm.Deal"}
    }
  },
  "handlers": {
    "discover.recurring": {
      "handler": "recurring",
      "on": "discover.PlanDue"
    },
    "discover.fetch_page": {
      "handler": "fetch_page",
      "on": "discover.PageDue"
    },
    "discover.page_result": {
      "handler": "page_result",
      "on": "discover.Sources.page.completed"
    },
    "discover.analyse_new": {
      "handler": "analyse_new",
      "on": "discover.Evidence.create"
    },
    "discover.analysis_result": {
      "handler": "analysis_result",
      "on": "discover.Analysis.extract.completed"
    }
  },
  "pages": [descriptor],
  "disabled": ["discover.Plan.delete", "discover.Run.create", "discover.Run.update", "discover.Run.delete", "discover.SourcePass.create", "discover.SourcePass.update", "discover.SourcePass.delete", "discover.PageAttempt.create", "discover.PageAttempt.update", "discover.PageAttempt.delete", "discover.Opportunity.create", "discover.Opportunity.update", "discover.Opportunity.delete", "discover.Evidence.create", "discover.Evidence.update", "discover.Evidence.delete", "discover.Conflict.create", "discover.Conflict.update", "discover.Conflict.delete", "discover.Review.create", "discover.Review.update", "discover.Review.delete"]
};

// Test-only recipes and desired admission examples; no live provider dispatch.
export const exampleImports=[{provider:'rent_catalog',member:'test_site',alias:'test_site'},{provider:'employee',member:'test_worker',alias:'test_worker'},{provider:'customer',member:'test_company',alias:'test_company'},{provider:'customer',member:'test_contact',alias:'test_contact'}];
export function exampleFixtures({self,other,imported}){
 const {test_site,test_worker,test_company,test_contact}=imported;
 const analyst={dependencies:[],user:async()=>({roles:[researcher,reviewer,'crm.salesperson']})};
 const analyst_worker={model:'employee.Employee',dependencies:[analyst,test_site],value:async(c,s)=>({user:s.analyst,home:s.test_site,locations:[s.test_site],start:date('2026-10-01'),role:'Research'})};
 const plan={model:'discover.Plan',dependencies:[self,test_site],value:async(c,s)=>({name:'Public opportunities',location:s.test_site,owner:s.self,ted_query:'environment',grants_query:'environment',criteria:'Documented environmental services fit'})};
 const run={model:'discover.Run',dependencies:[plan,analyst],value:async(c,s)=>({parent:s.plan,settings:await settings(c,s.plan),initiator:s.analyst,plan_revision:1n})};
 const pass={model:'discover.SourcePass',dependencies:[run],value:async(c,s)=>({parent:s.run,source:'ted',query:'environment'})};
 const page={model:'discover.PageAttempt',dependencies:[pass],value:async(c,s)=>({parent:s.pass,cursor:null,take:1n})};
 const opportunity={model:'discover.Opportunity',dependencies:[plan],value:async(c,s)=>({parent:s.plan,source:'ted',key:'notice-1',canonical_url:'https://example.test/notice/1'})};
 const collision={model:'discover.Opportunity',dependencies:[plan,opportunity],value:async(c,s)=>({parent:s.plan,source:'grants_gov',key:'alternate-notice',canonical_url:s.opportunity.canonical_url,identity_conflict:true})};
 const evidence={model:'discover.Evidence',dependencies:[opportunity,run,page],value:async(c,s)=>({parent:s.opportunity,ordinal:1n,document:{key:'notice-1',revision:'v1',url:'https://example.test/notice/1',title:'Environmental work',body:'Environmental work. Deadline not specified.',deadline_original:null,deadline_zone:null,retrieved:c.now},run:s.run,page:s.page})};
 const pageResult=()=>({documents:[],next_cursor:'next-1',terminal:false,source_as_of:null,traversal:'live',detail:null});
 const page_receipt={delivery:'discover.Sources.page',dependencies:[run],values:async(c,s)=>({request:{source:'ted',query:'environment',from:s.run.settings.from,until:s.run.settings.until,cursor:null,take:1n},status:'succeeded',result:pageResult()})};
 const reviewed={model:'discover.Review',dependencies:[opportunity,evidence],value:async(c,s)=>({parent:s.opportunity,evidence:s.evidence,title:'Environmental work',summary:'Manual review',deadline:null,deadline_zone:null,deadline_note:'Source does not specify a deadline; verified before sales intake',quotes:['Environmental work.']})};
 const reviewInput=(s)=>({evidence:s.evidence,title:'Environmental work',summary:'Manual review',deadline:null,deadline_zone:null,deadline_note:'Deadline unknown; checked original',quotes:['Environmental work.']});
 const promotion=(s,review,value=100n)=>({review,customer:s.test_company,contact:s.test_contact,value:money(value,'EUR')});
 return {fixtures:{analyst,analyst_worker,plan,run,pass,page,opportunity,collision,evidence,page_receipt,reviewed},examples:[
  {operation:'discover.start',dependencies:[test_worker,plan],inputs:async(c,s)=>({plan:s.plan}),selectors:['as','plan.active'],observations:[async(c,s)=>count(await records(c,'discover.Run',{parent:s.plan})),async(c,s)=>count(await records(c,'discover.SourcePass',{parent:s.result}))],rows:[
   {dependencies:[],values:async()=>[researcher,true],expected:async()=>[1n,2n]},
   {dependencies:[],values:async()=>[researcher,false],error:'rule_failed'},
   {dependencies:[],values:async()=>['members',true],error:'forbidden'}]},
  {operation:'discover.start',dependencies:[analyst_worker,plan,other],sequence:[
   {operation:'discover.start',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({plan:s.plan}),bind:'started'},
   {observations:async(c,s,b)=>[count(await records(c,'discover.SourcePass',{parent:b.started})),b.started.stopped],expected:async()=>[2n,false],types:['int','bool']},
   {operation:'discover.pause',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({plan:s.plan})},
   {observations:async(c,s)=>[s.plan.active,s.plan.current.stopped,await all(records(c,'discover.SourcePass',{parent:s.plan.current}),p=>p.state==='cancelled')],expected:async()=>[false,true,true],types:['bool','bool','bool']},
   {operation:'discover.start',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({plan:s.plan}),error:'rule_failed'},
   {operation:'discover.take_over',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({plan:s.plan})},
   {operation:'discover.resume',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({plan:s.plan})},
   {operation:'discover.start',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({plan:s.plan}),bind:'replacement'},
   {observations:async(c,s,b)=>[count(await records(c,'discover.Run',{parent:s.plan})),b.replacement.stopped],expected:async()=>[2n,false],types:['int','bool']},
   {operation:'discover.stop',by:async(c,s)=>s.other,inputs:async(c,s,b)=>({run:b.replacement}),error:'forbidden'}]},
  {operation:'discover.page_result',dependencies:[analyst_worker,page,page_receipt],inputs:async(c,s)=>({event:{delivery_id:s.page_receipt.id,status:'succeeded',result:pageResult(),error:null}}),selectors:['plan.current','page.request','pass.current','pass.state','run.stopped'],observations:[async(c,s)=>s.page.applied,async(c,s)=>s.page.late,async(c,s)=>s.pass.state,async(c,s)=>s.pass.cursor],rows:[
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,s.page,'fetching',false],expected:async()=>[true,false,'ready','next-1']},
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,s.page,'fetching',true],expected:async()=>[false,true,'fetching',null]},
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,null,'fetching',false],expected:async()=>[false,true,'fetching',null]}]},
  {operation:'discover.page_result',dependencies:[analyst_worker,page,page_receipt],inputs:async(c,s)=>({event:{delivery_id:s.page_receipt.id,status:'succeeded',result:pageResult(),error:null}}),selectors:['plan.current','page.request','pass.current','pass.state','event.result','page_receipt.result'],observations:[async(c,s)=>s.page.applied,async(c,s)=>s.pass.state],rows:[
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,s.page,'fetching',{documents:[],next_cursor:null,terminal:false,source_as_of:null,traversal:'uncertain',detail:null},{documents:[],next_cursor:null,terminal:false,source_as_of:null,traversal:'uncertain',detail:null}],expected:async()=>[false,'attention']}]},
  {operation:'discover.page_result',dependencies:[analyst_worker,page,page_receipt],inputs:async(c,s)=>({event:{delivery_id:s.page_receipt.id,status:'unknown',result:null,error:null}}),selectors:['plan.current','page.request','pass.current','pass.state','page_receipt.status','page_receipt.result'],observations:[async(c,s)=>s.page.applied,async(c,s)=>s.pass.state],rows:[
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,s.page,'fetching','unknown',null],expected:async()=>[false,'attention']}]},
  {operation:'discover.page_result',dependencies:[analyst_worker,page,evidence,page_receipt],inputs:async(c,s)=>({event:{delivery_id:s.page_receipt.id,status:'succeeded',result:{documents:[s.evidence.document],next_cursor:null,terminal:true,source_as_of:c.now,traversal:'snapshot',detail:null},error:null}}),selectors:['plan.current','page.request','pass.current','pass.state','page_receipt.result'],observations:[async(c,s)=>count(records(c,'discover.Evidence',{parent:s.opportunity})),async(c,s)=>count(records(c,'discover.Conflict',{parent:s.opportunity})),async(c,s)=>s.page.applied,async(c,s)=>s.pass.state],rows:[
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,s.page,'fetching',{documents:[s.evidence.document],next_cursor:null,terminal:true,source_as_of:c.now,traversal:'snapshot',detail:null}],expected:async()=>[1n,0n,true,'exhausted']}]},
  {operation:'discover.page_result',dependencies:[analyst_worker,page,evidence,page_receipt],inputs:async(c,s)=>({event:{delivery_id:s.page_receipt.id,status:'succeeded',result:{documents:[{key:'notice-1',revision:'v1',url:'https://example.test/notice/1',title:'Environmental work',body:'Conflicting source bytes',deadline_original:null,deadline_zone:null,retrieved:c.now}],next_cursor:null,terminal:true,source_as_of:c.now,traversal:'snapshot',detail:null},error:null}}),selectors:['plan.current','page.request','pass.current','pass.state','page_receipt.result'],observations:[async(c,s)=>count(records(c,'discover.Evidence',{parent:s.opportunity})),async(c,s)=>count(records(c,'discover.Conflict',{parent:s.opportunity})),async(c,s)=>s.opportunity.identity_conflict],rows:[
   {dependencies:[],values:async(c,s)=>[s.run,s.page_receipt,s.page,'fetching',{documents:[{key:'notice-1',revision:'v1',url:'https://example.test/notice/1',title:'Environmental work',body:'Conflicting source bytes',deadline_original:null,deadline_zone:null,retrieved:c.now}],next_cursor:null,terminal:true,source_as_of:c.now,traversal:'snapshot',detail:null}],expected:async()=>[1n,1n,true]}]},
  {operation:'discover.stop',dependencies:[test_worker,pass,run],inputs:async(c,s)=>({run:s.run}),selectors:['as'],observations:[async(c,s)=>s.run.stopped,async(c,s)=>s.pass.state],rows:[
   {dependencies:[],values:async()=>[researcher],expected:async()=>[true,'cancelled']},{dependencies:[],values:async()=>['members'],error:'forbidden'}]},
  {operation:'discover.review',dependencies:[test_worker,evidence],inputs:async(c,s)=>({...reviewInput(s),summary:'Reviewed original source',deadline_note:'Deadline unknown; confirmed uncertainty'}),selectors:['as','opportunity.identity_conflict','quotes'],observations:[async(c,s)=>s.result.evidence],rows:[
   {dependencies:[],values:async()=>[reviewer,false,['Environmental work.']],expected:async(c,s)=>[s.evidence]},
   {dependencies:[],values:async()=>[reviewer,false,['Invented quotation']],error:'rule_failed'},
   {dependencies:[],values:async()=>[reviewer,true,['Environmental work.']],error:'rule_failed'}]},
  {operation:'discover.review',dependencies:[test_worker,evidence],inputs:async(c,s)=>({...reviewInput(s),summary:'Reviewed original source',deadline_note:'Unknown'}),selectors:['as','test_worker.active','request.evidence.version'],observations:[async(c,s)=>s.result.evidence],rows:[
   {dependencies:[],values:async()=>[reviewer,false,1n],error:'rule_failed'},
   {dependencies:[],values:async()=>[reviewer,true,2n],error:'conflict'}]},
  {operation:'discover.duplicate',dependencies:[analyst_worker,evidence,collision],sequence:[
   {operation:'discover.review',by:async(c,s)=>s.analyst,inputs:async(c,s)=>reviewInput(s),error:'rule_failed'},
   {operation:'discover.duplicate',by:async(c,s)=>s.analyst,inputs:async(c,s)=>({opportunity:s.collision,canonical:s.opportunity,reason:'Both keys identify the same published opportunity'})},
   {operation:'discover.review',by:async(c,s)=>s.analyst,inputs:async(c,s)=>reviewInput(s),bind:'checked'},
   {observations:async(c,s,b)=>[s.opportunity.needs_identity_review,same(s.collision.duplicate_of,s.opportunity),same(b.checked.evidence,s.evidence)],expected:async()=>[false,true,true],types:['bool','bool','bool']}]},
  {operation:'discover.promote',dependencies:[analyst_worker,reviewed,test_company,test_contact],inputs:async(c,s)=>promotion(s,s.reviewed),selectors:['as','opportunity.identity_conflict','review.deadline','review.deadline_zone'],observations:[async(c,s)=>s.result.source],rows:[
   {dependencies:[],values:async(c,s)=>[s.analyst,false,null,null],expected:async(c,s)=>['discover:'+s.opportunity.id]},
   {dependencies:[],values:async(c,s)=>[s.analyst,true,null,null],error:'rule_failed'},
   {dependencies:[],values:async(c,s)=>[s.analyst,false,subtractDuration(c.now,86400000n),'UTC'],error:'rule_failed'}]},
  {operation:'discover.promote',dependencies:[analyst_worker,evidence,test_company,test_contact,other],sequence:[
   {operation:'discover.review',by:async(c,s)=>s.analyst,inputs:async(c,s)=>reviewInput(s),bind:'checked'},
   {operation:'discover.promote',by:async(c,s)=>s.analyst,inputs:async(c,s,b)=>promotion(s,b.checked),bind:'first_deal'},
   {observations:async(c,s,b)=>[b.first_deal.source,same(s.opportunity.deal,b.first_deal)],expected:async(c,s)=>['discover:'+s.opportunity.id,true],types:['text','bool']},
   {operation:'discover.promote',by:async(c,s)=>s.analyst,inputs:async(c,s,b)=>promotion(s,b.checked),bind:'repeated'},
   {observations:async(c,s,b)=>[same(b.repeated,b.first_deal)],expected:async()=>[true],types:['bool']},
   {operation:'discover.promote',by:async(c,s)=>s.analyst,inputs:async(c,s,b)=>promotion(s,b.checked,101n),error:'rule_failed'},
   {operation:'discover.promote',by:async(c,s)=>s.other,inputs:async(c,s,b)=>promotion(s,b.checked),error:'forbidden'}]}
 ]};
}
