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
    let datetime_source = source.replace("at:int", "at:datetime");
    let (output, response) = invoke("descending-datetime", &datetime_source, "check");
    assert!(output.status.success(), "{response}");
    let (output, response) = invoke("descending-datetime", &datetime_source, "compile");
    assert_eq!(output.status.code(), Some(10), "{response}");
    let diagnostics = response["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1, "{response}");
    assert_eq!(diagnostics[0]["code"], "E6008", "{response}");
    assert_eq!(
        diagnostics[0]["message"], "cannot lower expression query order: no §13 lowering exists",
        "{response}"
    );
    assert!(response.get("modules").is_none(), "{response}");
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
fn production_model_query_order_preserves_direct_alias_fields_and_refuses_expressions() {
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
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let diagnostics = response["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{name}: {diagnostics:?}");
        assert_eq!(diagnostics[0]["code"], "E6008", "{name}: {diagnostics:?}");
        assert_eq!(
            diagnostics[0]["message"],
            "cannot lower expression query order: no §13 lowering exists",
            "{name}: {diagnostics:?}"
        );
        assert!(
            response.get("modules").is_none(),
            "{name}: refused query must not publish modules"
        );
    }
}

#[test]
fn first_query_orders_checked_owning_metadata_without_admitting_other_expressions() {
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
        assert_eq!(output.status.code(), Some(10), "{name}: {artifact}");
        let diagnostics = artifact["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{name}: {artifact}");
        assert_eq!(diagnostics[0]["code"], "E6008", "{name}: {artifact}");
        assert_eq!(
            diagnostics[0]["message"],
            "cannot lower expression query order: no §13 lowering exists",
            "{name}: {artifact}"
        );
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
    }
}

#[test]
fn created_metadata_orders_real_native_rows_with_id_ties_and_viewer_grants() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::Builder::new()
        .prefix("metadata-order-")
        .tempdir_in(root.join("compiler/target"))
        .unwrap();
    let source = r#"app MetadataOrder
Given
 Entry {label:text}
 policy Entry read=members
When
 scenario ascending() read=true -> text[] by=public
  do return Entry as entry order=entry.created select entry.label
 scenario descending() read=true -> text[] by=public
  do return Entry as entry order=-entry.created select entry.label
Then
"#;
    let compile = |text: &str| {
        let path = scratch.path().join("metadata.can");
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
    let (output, artifact) = compile(source);
    assert!(output.status.success(), "{artifact}");
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
const artifact=__ARTIFACT__,sourcePath=__SOURCE__;
const worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,
 script:'export default {fetch(){return new Response(null,{status:404})}}',d1Databases:['DB']});
try {
 const database=await worker.getD1Database('DB');await ensureSchema(database);
 const store=createD1Storage(database), model=asModel('MetadataOrder.Entry');
 const memberships=createMemoryIdentityStore(), member=await seedMember(memberships,{isOwner:false});
 const identity=makeIdentity({membership:member.membership,email:member.user.email});
 const anonymous=makeIdentity({actor:null,team:null,membership:null});
 for(const [sequence,created,label] of [[1,FIXED_NOW+1000,'late-a'],[2,FIXED_NOW,'early-b'],[3,FIXED_NOW,'early-c']]) {
  await seedRow(store,model,{id:uuidv7(FIXED_NOW,sequence),created,updated:created,data:{label}});
 }
 const asm=await assembleModules({artifact,sourcePath},{workDir:__WORK__,
  stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
 const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW+2000});
 const revision=await store.readRevision(),before=await store.query({model,authority:'owner'});
 for(const [operation,expected] of [['ascending',['early-b','early-c','late-a']],['descending',['late-a','early-b','early-c']]]) {
  const result=await invoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},identity);
  assert.ok('result' in result,JSON.stringify(result));assert.deepEqual(result.result,{result:expected,revision});
  const hidden=await invoker.invokeRead({operation:'MetadataOrder.'+operation,inputs:{}},anonymous);
  assert.ok('result' in hidden,JSON.stringify(hidden));assert.deepEqual(hidden.result,{result:[],revision});
 }
 assert.equal(await store.readRevision(),revision);
 assert.deepEqual(await store.query({model,authority:'owner'}),before);
} finally {await worker.dispose();}
"#.replace("__ARTIFACT__",String::from_utf8_lossy(&output.stdout).trim())
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
    for invalid in [
        source
            .replace("ascending()", "ascending(other:Entry)")
            .replacen("order=entry.created", "order=other.created", 1),
        source.replacen("order=entry.created", "order=entry.created+1h", 1),
    ] {
        let (output, refusal) = compile(&invalid);
        assert_eq!(output.status.code(), Some(10), "{refusal}");
        assert!(
            refusal["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "E6008"
                    && d["message"]
                        == "cannot lower expression query order: no §13 lowering exists"),
            "{refusal}"
        );
        assert!(refusal.get("modules").is_none(), "{refusal}");
    }
}
