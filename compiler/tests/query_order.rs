//! Production CLI query-order qualification on the actual owning Cloudflare
//! source fixture. Native authorized D1 execution stays with its consumer.
#![cfg(unix)]

use std::path::Path;
use std::process::Command;

#[test]
fn ui_order_aliases_and_descending_datetime_keys_keep_their_owning_domain() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = "app Orders uses=[shop]\npackage shop\n Given\n  Entry { at:int, values:int[] }\n  policy Entry read=members\n When\n  crud Entry by=members fields=at,values delete=none\n  scenario latest() by=members read=true -> Entry?\n   do\n    return first(Entry as item order=-item.at)\n Then\n  page / title=\"Orders\"\n   list Entry as item order=-item.at\n    text row.at\n    list Entry as inner order=inner.at\n     text row.at\n";
    let invoke = |name: &str, source: &str, command: &str| {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .current_dir(root)
            .output()
            .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)));
        (output, response)
    };
    let (output, artifact) = invoke("owning-order", source, "compile");
    assert!(output.status.success(), "{artifact}");
    let generated = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(generated.contains("order:[\"-at\"]"), "{generated}");
    assert!(generated.contains("order:[\"at\"]"), "{generated}");
    assert!(!generated.contains("order:[\"-item.at\"]"), "{generated}");
    assert!(!generated.contains("order:[\"inner.at\"]"), "{generated}");
    for temporal in ["date", "datetime", "datetime?"] {
        let temporal_source = source.replace("at:int", &format!("at:{temporal}"));
        let (output, response) = invoke("descending-temporal", &temporal_source, "compile");
        assert!(output.status.success(), "{temporal}: {response}");
        assert!(
            response["modules"]
                .as_array()
                .unwrap()
                .iter()
                .any(|module| module["js"].as_str().unwrap().contains("order:[\"-at\"]")),
            "{response}"
        );
    }
    for (name, source, code) in [
        (
            "foreign-alias",
            source.replace("order=-item.at\n    text", "order=-other.at\n    text"),
            "E2013",
        ),
        (
            "outer-alias",
            source.replace("order=inner.at", "order=item.at"),
            "E2013",
        ),
        (
            "missing-field",
            source.replace("order=inner.at", "order=inner.missing"),
            "E2013",
        ),
        (
            "unordered",
            source.replace("order=inner.at", "order=inner.values"),
            "E3006",
        ),
        (
            "reference-path",
            source
                .replace(
                    "Entry { at:int",
                    "Location { name:text }\n  Entry { location:Location?, at:int",
                )
                .replace("order=inner.at", "order=location.name"),
            "E2013",
        ),
    ] {
        let (output, response) = invoke(name, &source, "check");
        assert_eq!(output.status.code(), Some(10), "{name}: {response}");
        assert!(
            response["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == code),
            "{name}: {response}"
        );
    }
    let table = source.replace("list Entry as item order=-item.at\n    text row.at\n    list Entry as inner order=inner.at\n     text row.at", "table Entry as item columns=at order=item.at");
    let (output, response) = invoke("table-order", &table, "compile");
    assert!(output.status.success(), "{response}");
    assert!(
        response["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|module| module["js"]
                .as_str()
                .unwrap()
                .contains("({context:c,model:\"shop.Entry\",columns:[\"at\"],order:[\"at\"]})")),
        "{response}"
    );
}

#[test]
fn production_model_query_order_preserves_aliases_and_checked_expression_comparators() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let source_path = root.join("packages/cloudflare/test/fixtures/typed-authorized-reads.can");
    let source = std::fs::read_to_string(&source_path).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let compile = |path: &Path| {
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .current_dir(&root)
            .output()
            .unwrap();
        let response: serde_json::Value =
            serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
                panic!(
                    "CLI JSON: {e}: {}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
            });
        (output, response)
    };
    let (output, artifact) = compile(&source_path);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let modules = artifact["modules"].as_array().unwrap();
    let generated = modules
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for (id, order) in [
        ("TypedAuthorizedReads.ascending", "count"),
        ("TypedAuthorizedReads.descending", "-count"),
    ] {
        assert!(
            artifact["callables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|callable| callable["id"] == id),
            "actual authored callable missing: {id}"
        );
        let records = format!("records(c,\"TypedAuthorizedReads.Entry\",{{order:[\"{order}\"]}})");
        assert_eq!(
            generated.matches(&records).count(),
            1,
            "one authored native order selector for {id}:\n{generated}"
        );
    }
    let authored = "order=entry.count select entry.count";
    assert_eq!(
        source.matches(authored).count(),
        1,
        "unique ascending source anchor"
    );
    for (name, refused_source) in [
        (
            "arithmetic",
            source.replacen(authored, "order=entry.count+1 select entry.count", 1),
        ),
        (
            "foreign-root",
            source
                .replacen(
                    "scenario ascending()",
                    "scenario ascending(entryRecord:Entry)",
                    1,
                )
                .replacen(authored, "order=entryRecord.count select entry.count", 1),
        ),
    ] {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, refused_source).unwrap();
        let (output, response) = compile(&path);
        assert!(output.status.success(), "{name}: {response}");
        let code = response["modules"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|module| module["js"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("order:{by:"), "{name}: {code}");
        assert!(code.contains("compare:"), "{name}: {code}");
    }
}

#[test]
fn first_query_order_supports_normal_comparators_without_claiming_native_receipts() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = "app MetadataOrders\nGiven\n Allowance { account:user }\n policy Allowance read=owner\nWhen\n scenario ascending() -> Allowance? by=owner\n  do return first(Allowance as row where row.account==actor order=row.id)\n scenario descending() -> Allowance? by=owner\n  do return first(Allowance as row where row.account==actor order=-row.id)\nThen\n";
    let invoke = |name: &str, source: &str, command: &str| {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .current_dir(root)
            .output()
            .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)));
        (output, response)
    };
    let (output, artifact) = invoke("owning-row-id", source, "compile");
    assert!(output.status.success(), "{artifact}");
    let generated = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for order in ["id", "-id"] {
        assert_eq!(
            generated.matches(&format!("order:[\"{order}\"]")).count(),
            1,
            "one normalized original selector: {generated}"
        );
    }
    assert!(
        !generated.contains("order:[\"row.id\"]") && !generated.contains("order:[\"-row.id\"]"),
        "an alias must not reach the native selector: {generated}"
    );
    for id in ["MetadataOrders.ascending", "MetadataOrders.descending"] {
        assert!(
            artifact["callables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|callable| callable["id"] == id),
            "original first-query callable missing: {id}"
        );
    }
    let metadata_source = source.replacen("order=row.id", "order=row.created", 1);
    let (output, artifact) = invoke("metadata-datetime", &metadata_source, "compile");
    assert!(output.status.success(), "{artifact}");
    assert!(
        artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|module| module["js"]
                .as_str()
                .unwrap()
                .contains("order:[\"created\"]")),
        "{artifact}"
    );
    let native = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(scratch.path().join("metadata-datetime.can"))
        .current_dir(root)
        .output()
        .unwrap();
    let refusal: serde_json::Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(native.status.code(), Some(10), "{refusal}");
    let key_position = metadata_source.find("order=row.created").unwrap();
    assert!(
        refusal["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["message"]
                == "cannot lower first query: original native query correspondence is unavailable"
                && diagnostic["primary"]["start"].as_u64().unwrap() <= key_position as u64
                && diagnostic["primary"]["end"].as_u64().unwrap() >= key_position as u64),
        "{refusal}"
    );
    assert!(refusal.get("modules").is_none(), "{refusal}");
    for (name, refused_source) in [
        (
            "computed-id",
            source.replacen("order=row.id", "order=lower(row.id)", 1),
        ),
        (
            "foreign-record-id",
            source
                .replacen(
                    "scenario ascending()",
                    "scenario ascending(other:Allowance)",
                    1,
                )
                .replacen("order=row.id", "order=other.id", 1),
        ),
    ] {
        let (output, checked) = invoke(name, &refused_source, "check");
        assert!(output.status.success(), "{name}: {checked}");
        let (output, artifact) = invoke(name, &refused_source, "compile");
        assert!(output.status.success(), "{name}: {artifact}");
        let code = artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|module| module["js"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("order:{by:"), "{name}: {code}");
        // Ordinary expression ordering has a comparator, but cannot claim an
        // authenticated native first-query receipt for these expressions.
        let native = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([
                "compile",
                "--format=json",
                "--native-scenario-receipts",
                "--catalog",
            ])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(scratch.path().join(format!("{name}.can")))
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(
            native.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&native.stdout)
        );
        let refused: serde_json::Value = serde_json::from_slice(&native.stdout).unwrap();
        assert!(refused.get("modules").is_none());
        assert!(
            refused["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E6008")
        );
    }
}

#[test]
fn metadata_and_temporal_fields_order_real_native_rows_with_id_ties_and_viewer_grants() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::Builder::new()
        .prefix("metadata-order-")
        .tempdir_in(root.join("compiler/target"))
        .unwrap();
    let source = r#"app MetadataOrder
Given
 Entry {label:text, day:date?, at:datetime?, privateAt:datetime?}
 policy Entry read=owner
 policy Entry read=members fields=label,day,at
When
 scenario ascending() read=true -> text[] by=public
  do return Entry as entry order=entry.created select entry.label
 scenario descending() read=true -> text[] by=public
  do return Entry as entry order=-entry.created select entry.label
 scenario dayAscending() read=true -> text[] by=public
  do return Entry as entry order=entry.day select entry.label
 scenario dayDescending() read=true -> text[] by=public
  do return Entry as entry order=-entry.day select entry.label
 scenario instantAscending() read=true -> text[] by=public
  do return Entry as entry order=entry.at select entry.label
 scenario instantDescending() read=true -> text[] by=public
  do return Entry as entry order=-entry.at select entry.label
 scenario privateAscending() read=true -> text[] by=public
  do return Entry as entry order=entry.privateAt select entry.label
 scenario badDate() read=true -> text[] by=public
  do return Entry as entry where entry.label=="bad" order=entry.day select entry.label
 scenario badInstant() read=true -> text[] by=public
  do return Entry as entry where entry.label=="bad" order=entry.at select entry.label
Then
"#;
    let compile = |text: &str, filename: &str| {
        let path = scratch.path().join(filename);
        std::fs::write(&path, text).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([
                "compile",
                "--format=json",
                "--native-scenario-receipts",
                "--catalog",
            ])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .current_dir(root)
            .output()
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        (output, value)
    };
    let (output, artifact) = compile(source, "metadata.can");
    assert!(output.status.success(), "{artifact}");
    // A second authored policy exposes rows through label alone, making the
    // anonymous forbidden-order-field checks reachable rather than filtered out.
    let public_source = source.replace(
        " policy Entry read=owner",
        " policy Entry read=public fields=label\n policy Entry read=owner",
    );
    let (public_output, public_artifact) = compile(&public_source, "public-label.can");
    assert!(public_output.status.success(), "{public_artifact}");
    let generated = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(generated.contains("order:[\"created\"]"), "{generated}");
    assert!(generated.contains("order:[\"-created\"]"), "{generated}");
    let script=r#"
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {Miniflare}=createRequire(import.meta.resolve('@canlang/cloudflare/worker/assembly'))('miniflare');
import {createD1Storage,ensureSchema} from '@canlang/state/storage/d1';
import {FIXED_NOW,asModel,createMemoryIdentityStore,makeIdentity,seedMember,seedRow,uuidv7} from '@canlang/state/testing/invocation/fixtures';
import {assembleModules} from '@canlang/cloudflare/runtime/modules';
import {buildInvoker} from '@canlang/cloudflare/worker/assembly';
import {datetime,encodeValue} from '@canlang/values';
const artifact=__ARTIFACT__,sourcePath=__SOURCE__,publicArtifact=__PUBLIC_ARTIFACT__,publicSource=__PUBLIC_SOURCE__;
const worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,
 script:'export default {fetch(){return new Response(null,{status:404})}}',d1Databases:['DB']});
try {
 const database=await worker.getD1Database('DB');await ensureSchema(database);
 const store=createD1Storage(database), model=asModel('MetadataOrder.Entry');
 const memberships=createMemoryIdentityStore(), member=await seedMember(memberships,{isOwner:false});
 const identity=makeIdentity({membership:member.membership,email:member.user.email});
 const anonymous=makeIdentity({actor:null,team:null,membership:null});
 for(const [sequence,created,label,fields] of [
  [1,FIXED_NOW+1000,'late-a',{day:'2026-10-16',at:encodeValue('datetime',datetime('2026-10-16T03:00:00+02:00'))}],
  [2,FIXED_NOW,'early-b',{day:'2026-10-15',at:'2026-10-15T01:00:00.000Z'}],
  [3,FIXED_NOW,'early-c',{day:'2026-10-15',at:'2026-10-15T01:00:00.000Z'}],
  [4,FIXED_NOW+2000,'null',{day:null,at:null}],
  [5,FIXED_NOW+3000,'absent',{}],
 ]) {
  await seedRow(store,model,{id:uuidv7(FIXED_NOW,sequence),created,updated:created,data:{label,privateAt:'2026-10-15T01:00:00.000Z',...fields}});
 }
 const asm=await assembleModules({artifact,sourcePath},{workDir:__WORK__,
  stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
 const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW+2000});
 const revision=await store.readRevision(),before=await store.query({model,authority:'owner'});
 for(const [operation,expected] of [
  ['ascending',['early-b','early-c','late-a','null','absent']],
  ['descending',['absent','null','late-a','early-b','early-c']],
  ['dayAscending',['null','absent','early-b','early-c','late-a']],
  ['dayDescending',['late-a','early-b','early-c','null','absent']],
  ['instantAscending',['null','absent','early-b','early-c','late-a']],
  ['instantDescending',['late-a','early-b','early-c','null','absent']],
 ]) {
  const result=await invoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},identity);
  assert.ok('result' in result,JSON.stringify(result));assert.deepEqual(result.result,{result:expected,revision});
  const hidden=await invoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},anonymous);
  assert.ok('result' in hidden,JSON.stringify(hidden));
  assert.deepEqual(hidden.result,{result:[],revision},'unreadable rows are filtered before order fields are touched');
 }
 const denied=await invoker.invokeRead({operation:'MetadataOrder.privateAscending',inputs:{}},identity);
 assert.equal(denied.error?.code,'validation',JSON.stringify(denied));
 assert.equal(denied.error.message,'Query path "privateAt" is not granted to this caller.');
 assert.equal(await store.readRevision(),revision);
 assert.deepEqual(await store.query({model,authority:'owner'}),before);
 const publicAsm=await assembleModules({artifact:publicArtifact,sourcePath:publicSource},{workDir:__PUBLIC_WORK__,
  stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
 const publicInvoker=buildInvoker(publicArtifact,publicAsm,store,{memberships,now:()=>FIXED_NOW+2000});
 const visible=await publicInvoker.invokeRead({operation:'MetadataOrder.ascending',inputs:{}},anonymous);
 assert.ok('result' in visible,JSON.stringify(visible));
 assert.deepEqual(visible.result,{result:['early-b','early-c','late-a','null','absent'],revision},'anonymous caller has genuine label-only row grants');
 for(const operation of ['dayAscending','dayDescending','instantAscending','instantDescending']) {
  const hidden=await publicInvoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},anonymous);
  assert.equal(hidden.error?.code,'validation',JSON.stringify(hidden));
  const field=operation.startsWith('day')?'day':'at';
  assert.equal(hidden.error.message,'Query path "'+field+'" is not granted to this caller.');
 }
 assert.equal(await store.readRevision(),revision);
 assert.deepEqual(await store.query({model,authority:'owner'}),before);
 await seedRow(store,model,{id:uuidv7(FIXED_NOW,6),data:{label:'bad',day:'2026-02-30',at:'2026-10-15T01:00:00+00:00'}});
 const badRevision=await store.readRevision(),badBefore=await store.query({model,authority:'owner'});
 for(const operation of ['dayAscending','instantAscending']) {
  const failed=await invoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},identity);
  assert.equal(failed.error?.code,'rule_failed',JSON.stringify(failed));
  assert.equal(failed.error.message,'schema validation failed with 1 violation(s)');
 }
 // The authored predicate materializes the native row first: its schema failure
 // remains earlier than the order step, including this singleton selection.
 for(const operation of ['badDate','badInstant']) {
  const failed=await invoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},identity);
  assert.equal(failed.error?.code,'rule_failed',JSON.stringify(failed));
  assert.equal(failed.error.message,'schema validation failed with 1 violation(s)');
 }
 assert.equal(await store.readRevision(),badRevision);
 assert.deepEqual(await store.query({model,authority:'owner'}),badBefore);
} finally {await worker.dispose();}
"#.replace("__ARTIFACT__",String::from_utf8_lossy(&output.stdout).trim())
 .replace("__PUBLIC_ARTIFACT__",String::from_utf8_lossy(&public_output.stdout).trim())
 .replace("__PUBLIC_SOURCE__",&serde_json::to_string(&scratch.path().join("public-label.can")).unwrap())
 .replace("__PUBLIC_WORK__",&serde_json::to_string(&scratch.path().join("public-assembled")).unwrap())
 .replace("__SOURCE__",&serde_json::to_string(&scratch.path().join("metadata.can")).unwrap())
 .replace("__WORK__",&serde_json::to_string(&scratch.path().join("assembled")).unwrap());
    let runner = scratch.path().join("run.mjs");
    std::fs::write(&runner, script).unwrap();
    let native = Command::new("node")
        .arg(runner)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        native.status.success(),
        "{}",
        String::from_utf8_lossy(&native.stderr)
    );
    for expression in [
        source
            .replace("ascending()", "ascending(other:Entry)")
            .replacen("order=entry.created", "order=other.created", 1),
        source.replacen("order=entry.created", "order=entry.created+1h", 1),
    ] {
        let (output, artifact) = compile(&expression, "expression.can");
        assert!(output.status.success(), "{artifact}");
        let code = artifact["modules"][0]["js"].as_str().unwrap();
        assert!(
            code.contains("order:{by:") && code.contains("compare:"),
            "{code}"
        );
    }
}
