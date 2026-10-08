//! Actual saved comparison handlers through compiled CLI artifacts and native callables.
//! Approval/hiring use minimal owning contexts and an explicitly published native
//! membership host; installed catalog refusal and full-app gaps remain separate.
#![cfg(unix)]

use std::{path::Path, process::Command};

fn handler_body(packet: &Path, domain: &str, variant: &str) -> String {
    let source =
        std::fs::read_to_string(packet.join(format!("{domain}/{variant}-handler.can"))).unwrap();
    // Only fixture-dependent examples are omitted from the isolated contexts.
    source
        .lines()
        .take_while(|line| !line.trim_start().starts_with("examples "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn owning_context(packet: &Path, domain: &str, variant: &str) -> String {
    let handler = handler_body(packet, domain, variant);
    if domain == "generation" {
        return format!(
            "app Generation\nGiven\n Job {{status:enum(idle,queued,generating,ready,failed)=idle}}\n policy Job read=members\nWhen\n{handler}\nThen\n"
        );
    }
    let (app, owner, models) = match domain {
        "approval" => (
            "CanApprove",
            "approve",
            "  role coordinator\n  role reviewer\n  Document {location:Location?,submitter:user}\n  Submission in Document {reviewer:user,state:enum(pending,approved,rejected,withdrawn)=pending}\n",
        ),
        "ordinary" => (
            "CanHire",
            "hire",
            "  role recruiter\n  Vacancy {location:Location}\n  Candidate in Vacancy {stage:enum(applied,interview,offer,hired,rejected,withdrawn)=applied}\n",
        ),
        _ => unreachable!(),
    };
    let shadow = if domain == "approval" {
        "  scenario role_shadow(coordinator:bool) read=true -> bool by=members\n   do\n    if coordinator\n     let coordinator=false\n     return coordinator\n    else\n     return true\n"
    } else {
        ""
    };
    format!(
        "app {app} uses=[{owner}]\npackage rent_catalog\n Given\n  export Location {{name:text}}\n When\n Then\npackage employee\n use rent_catalog {{Location}}\n Given\n  export Employee {{user:user unique,home:Location,locations:Location[],operator_wide:bool=false,active:bool=true}}\n When\n Then\npackage {owner}\n use rent_catalog {{Location}}\n use employee {{Employee}}\n Given\n{models} When\n{handler}\n{shadow} Then\n"
    )
}

#[test]
fn saved_enum_handlers_preserve_captions_and_original_admission() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let packet = root.join("implementation/capability-roadmap-20261008/enum-comparison");
    let scratch = tempfile::tempdir().unwrap();
    let installed_catalog = root.join("packages/values/dist/catalog.json");
    let mut host_catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&installed_catalog).unwrap()).unwrap();
    let membership = host_catalog["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "active_member")
        .unwrap();
    assert_eq!(membership["effects"], "state-read");
    assert_eq!(membership["availability"], "external");
    membership["availability"] = "implemented".into();
    membership["owner"] = "bounded-native-host".into();
    membership["notes"] = "Async current membership adapter supplied by this native host; no installed host qualification.".into();
    let host_catalog_path = scratch.path().join("host-catalog.json");
    std::fs::write(
        &host_catalog_path,
        serde_json::to_vec(&host_catalog).unwrap(),
    )
    .unwrap();
    let compile = |name: &str, source: &str, catalog: &Path| {
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(catalog)
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    // The same source still refuses the installed external builtin. Only
    // the host which supplies its actual implementation publishes availability.
    let installed = compile(
        "installed-membership-refusal",
        &owning_context(&packet, "approval", "proposed-match"),
        &installed_catalog,
    );
    assert_eq!(installed.status.code(), Some(10));
    let installed: serde_json::Value = serde_json::from_slice(&installed.stdout).unwrap();
    assert!(installed.get("modules").is_none());
    assert!(
        installed["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| {
                d["code"] == "E6007" && d["message"].as_str().unwrap().contains("active_member")
            }),
        "{installed}"
    );
    for domain in ["generation", "approval", "ordinary"] {
        for variant in ["proposed-match", "current-if"] {
            // All three sources qualify the saved callable body and owning
            // domain. Full application/page qualification is independent.
            let source = owning_context(&packet, domain, variant);
            let name = format!("{domain}-{variant}");
            let output = compile(&name, &source, &host_catalog_path);
            assert!(
                output.status.success(),
                "{name}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            std::fs::write(scratch.path().join(format!("{name}.json")), output.stdout).unwrap();
        }
        // These mismatches alter the owning domain, leaving the saved match
        // handler unchanged. They do not repeat generic pattern/scope controls.
        let source = owning_context(&packet, domain, "proposed-match");
        let (original, added, removed) = match domain {
            "generation" => (
                "enum(idle,queued,generating,ready,failed)",
                "enum(idle,queued,generating,ready,failed,paused)",
                "enum(idle,queued,ready,failed)",
            ),
            "approval" => (
                "enum(pending,approved,rejected,withdrawn)",
                "enum(pending,approved,rejected,withdrawn,deferred)",
                "enum(pending,approved,withdrawn)",
            ),
            "ordinary" => (
                "enum(applied,interview,offer,hired,rejected,withdrawn)",
                "enum(applied,interview,offer,hired,rejected,withdrawn,screening)",
                "enum(applied,interview,hired,rejected,withdrawn)",
            ),
            _ => unreachable!(),
        };
        assert!(source.contains(original));
        for (change, replacement) in [("added", added), ("removed", removed)] {
            let name = format!("{domain}-{change}-owner-case");
            let output = compile(
                &name,
                &source.replacen(original, replacement, 1),
                &host_catalog_path,
            );
            assert_eq!(output.status.code(), Some(10), "{name}");
            let output: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(output.get("modules").is_none(), "{name}");
            assert!(
                output["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|finding| finding["code"] == "E3001"),
                "{name}: {output}"
            );
        }
    }

    let packages = scratch.path().join("node_modules/@canlang");
    let stdlib = packages.join("stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    let native_stdlib = serde_json::to_string(
        &root
            .join("packages/stdlib/dist/src/index.js")
            .display()
            .to_string(),
    )
    .unwrap();
    std::fs::write(stdlib.join("index.mjs"), format!(r#"
import assert from 'node:assert/strict';
export * from {native_stdlib};
// Only external state reads are supplied here. Emitted do guards and native
// first/reference equality/role/require helpers perform the decisions.
export async function records(context,model,options){{
 const host=globalThis.enumHost;assert.equal(context,host.context);assert.equal(model,'employee.Employee');assert.deepEqual(Object.keys(options),['where']);
 host.events.push('records');await Promise.resolve();
 return context.employees.filter(record=>record.teamId===context.team.id && options.where(record));
}}
export async function active_member(person,team){{
 const host=globalThis.enumHost;assert.equal(team,host.context.team);
 host.events.push('active_member');await Promise.resolve();
 const active=host.context.activeMembers.includes(person.id);
 host.afterMembershipRead?.(person,team,active);
 return active;
}}
"#)).unwrap();
    std::os::unix::fs::symlink(root.join("node_modules/@canlang/ui"), packages.join("ui")).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname),handlers={},roleShadows=[];
const operationIds={generation:'Generation.status_text',approval:'approve.review_state_text',ordinary:'hire.stage_text'};
for(const domain of ['generation','approval','ordinary']){
 handlers[domain]=[];
 for(const variant of ['proposed-match','current-if']){
  const name=`${domain}-${variant}`,artifact=JSON.parse(readFileSync(resolve(base,`${name}.json`),'utf8'));
  for(const module of artifact.modules){const path=resolve(base,name,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
  const descriptor=artifact.callables.find(item=>item.id===operationIds[domain]);assert(descriptor,name);
  const entry=await import(pathToFileURL(resolve(base,name,descriptor.module))),registry=entry.canApp();
  let callable=registry;for(const part of descriptor.member)callable=callable[part];assert.equal(typeof callable,'function');
  handlers[domain].push(callable);
  if(domain==='approval'){
   const shadow=artifact.callables.find(item=>item.id==='approve.role_shadow');assert(shadow);
   let fn=registry;for(const part of shadow.member)fn=fn[part];roleShadows.push(fn);
  }
 }
}
const user=id=>({kind:'user',id}),location=id=>({kind:'ref',model:'rent_catalog.Location',id,version:1n});
const actor=user('actor'),other=user('other'),site=location('site'),away=location('away');
const employee={kind:'ref',model:'employee.Employee',id:'worker',version:1n,teamId:'team',user:actor,home:site,locations:[],operator_wide:false,active:true};
function context(overrides={}){return {actor,team:{id:'team'},memberships:['members'],employees:[employee],activeMembers:['actor'],...overrides};}
for(const fn of roleShadows){
 assert.equal(await fn(context({memberships:['members','approve.coordinator']}),{coordinator:true}),false);
 assert.equal(await fn(context(),{coordinator:false}),true);
}
let reads=0;
function selected(field,state,rest={}){return {...rest,get [field](){reads++;return state;}};}
async function caption(domain,c,input,want,expectedReads=1,expectedEvents=[]){
 for(const fn of handlers[domain]){globalThis.enumHost={context:c,events:[]};reads=0;assert.equal(await fn(c,input),want);assert.equal(reads,expectedReads,`${domain} subject/guard reads`);assert.deepEqual(globalThis.enumHost.events,expectedEvents);}
}
async function refused(domain,c,input,expectedEvents){
 for(const fn of handlers[domain]){globalThis.enumHost={context:c,events:[]};await assert.rejects(fn(c,input),error=>error.constructor.name==='AuthoredRequireFailure');if(expectedEvents)assert.deepEqual(globalThis.enumHost.events,expectedEvents);}
}
for(const [state,want]of [['idle','Ready to queue'],['queued','Queued for generation'],['generating','Generating'],['ready','Generation complete'],['failed','Generation failed']]){
 await caption('generation',context(),{job:selected('status',state)},want);
}
await refused('generation',context({memberships:[]}),{job:selected('status','idle')});
const submission=(state,rest={})=>selected('state',state,{parent:{submitter:actor,location:site},reviewer:other,...rest});
for(const [state,want]of [['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['withdrawn','Withdrawn']]){
 await caption('approval',context(),{submission:submission(state)},want);
}
const reviewContext=context({memberships:['members','approve.reviewer']});
for(const [state,want]of [['pending','Pending'],['approved','Approved'],['rejected','Rejected']]){
 await caption('approval',reviewContext,{submission:submission(state,{parent:{submitter:other,location:site},reviewer:actor})},want,2,['records','active_member']);
}
// Current assignment, withdrawal, role and current employment/membership each
// preserve the original admission guard in both saved handler implementations.
await refused('approval',reviewContext,{submission:submission('pending',{parent:{submitter:other,location:site},reviewer:other})},[]);
await refused('approval',reviewContext,{submission:submission('withdrawn',{parent:{submitter:other,location:site},reviewer:actor})},[]);
await refused('approval',context(),{submission:submission('pending',{parent:{submitter:other,location:site},reviewer:actor})});
await refused('approval',context({memberships:[]}),{submission:submission('pending')});
const assigned=submission('pending',{parent:{submitter:other,location:site},reviewer:actor});
for(const overrides of [{employees:[{...employee,active:false}]},{activeMembers:[]},{employees:[{...employee,user:other}]},{team:{id:'other-team'}},{employees:[{...employee,home:away}]}]){
 await refused('approval',context({memberships:['members','approve.reviewer'],...overrides}),{submission:assigned});
}
const coordinated=submission('withdrawn',{parent:{submitter:other,location:site}});
await caption('approval',context({memberships:['members','approve.coordinator']}),{submission:coordinated},'Withdrawn',1,['records','active_member']);
const noLocation=submission('pending',{parent:{submitter:other,location:null},reviewer:actor});
await caption('approval',context({memberships:['members','approve.reviewer'],employees:[],activeMembers:[]}),{submission:noLocation},'Pending',2);
const candidate=state=>selected('stage',state,{parent:{location:site}});
const recruiter=context({memberships:['members','hire.recruiter']});
for(const [state,want]of [['applied','Applied'],['interview','Interview'],['offer','Offer'],['hired','Hired'],['rejected','Rejected'],['withdrawn','Withdrawn']]){
 await caption('ordinary',recruiter,{candidate:candidate(state)},want,1,['records','active_member']);
}
await refused('ordinary',context(),{candidate:candidate('applied')},[]);
for(const overrides of [{employees:[{...employee,active:false}]},{activeMembers:[]},{employees:[{...employee,user:other}]},{team:{id:'other-team'}},{employees:[{...employee,home:away}]}]){
 await refused('ordinary',context({memberships:['members','hire.recruiter'],...overrides}),{candidate:candidate('applied')});
}
for(const allowed of [{...employee,home:away,locations:[site]},{...employee,home:away,operator_wide:true}]){
 await caption('ordinary',context({memberships:['members','hire.recruiter'],employees:[allowed]}),{candidate:candidate('offer')},'Offer',1,['records','active_member']);
}
await refused('ordinary',context({memberships:['members','hire.recruiter'],employees:[]}),{candidate:candidate('offer')},['records']);
for(const fn of handlers.ordinary){
 const c=context({memberships:['members','hire.recruiter']});const host={context:c,events:[]};globalThis.enumHost=host;
 Object.defineProperty(c,'actor',{get(){host.events.push('actor');return actor;}});
 const vacancy={get location(){host.events.push('location');return site;}};
 reads=0;assert.equal(await fn(c,{candidate:selected('stage','offer',{parent:vacancy})}),'Offer');assert.equal(reads,1);
 assert.deepEqual(host.events,['actor','location','records','active_member']);
}
// A failed coordinator attempt must still evaluate the original reviewer
// fallback, including a fresh membership check after its assignment/state gate.
for(const fn of handlers.approval){
 const c=context({memberships:['members','approve.coordinator','approve.reviewer'],activeMembers:[]});let membershipReads=0;
 const host={context:c,events:[],afterMembershipRead(person,team,active){membershipReads++;if(membershipReads===1){assert.equal(active,false);c.activeMembers.push(person.id);}else assert.equal(active,true);}};globalThis.enumHost=host;
 const document={submitter:other,get location(){host.events.push('location');return site;}};
 reads=0;assert.equal(await fn(c,{submission:submission('pending',{parent:document,reviewer:actor})}),'Pending');assert.equal(reads,2);
 assert.deepEqual(host.events,['location','location','records','active_member','location','records','active_member']);
 assert.equal(membershipReads,2);
}
console.log('saved generation/approval/hiring handlers: native captions, once selection, parity, original admission and work controls passed');
"#).unwrap();
    let output = Command::new("node").arg(runner).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
