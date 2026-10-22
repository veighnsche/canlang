//! Outcome-12 hook lowering (CAN18-v1 Lane C): native hook runners bind
//! `($candidate, $hookCtx, c)` through the complete owner-policy plan, so
//! hook queries lower over `event.after`/`event.before` with the trigger's
//! author/clock, `now` binds the owner clock, derives run with the ambient
//! context, and emit effects stage in guard order.
//!
//! TEST-ONLY: artifacts are produced under the explicit test-only
//! incomplete-analysis acknowledgment with a hermetic catalog, exactly like
//! the T31 suite in `codegen.rs`. Nothing here claims runtime success
//! beyond the bun-driven engine checks, which import workspace sources
//! directly (always current, no dist staleness).
//!
//! Failing-first: each class pins one recorded original24 occurrence shape
//! (spans in `historical diagnostic snapshot (removed)`). On the base plan they
//! report the regrouped `E6008`s; after the repair they lower.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::PathBuf;

/// Span in the single fixture source.
fn sp(start: u32, end: u32) -> Span {
    Span::new(SourceId(0), start, end)
}

fn unique_temp_path(stem: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("can-hook-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    dir.join(format!("{stem}-{n}.json"))
}

/// Hermetic catalog: the golden builtins plus the pure temporal builtins
/// the recorded hooks use (`local_instant`, `local_date`, `max`), with
/// their real signatures/effects.
fn hook_catalog() -> (Catalog, PathBuf) {
    let path = unique_temp_path("hook-catalog");
    let dir = path.parent().expect("temp dir").to_path_buf();
    std::fs::write(
        &path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[
{"id":"count","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"first","kind":"builtin","signature":"first(domain:C<T>)->T?","effects":"state-read","availability":"implemented","owner":"lane-02"},
{"id":"max","kind":"builtin","signature":"max(domain:C<O>)->O?; max(domain:nonempty C<O>)->O","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"local_instant","kind":"builtin","signature":"local_instant(date:date,time:text,zone:timezone,fold:enum(earlier,later))->datetime","effects":"pure","availability":"implemented","owner":"lane-02"},
{"id":"local_date","kind":"builtin","signature":"local_date(value:datetime,zone:timezone)->date","effects":"pure","availability":"implemented","owner":"lane-02"}
]}"#,
    )
    .expect("write hook catalog");
    let primary = Span::new(SourceId(0), 0, 0);
    let request = CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: dir.as_path(),
        primary,
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "hook catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

fn check_hook(src: &str, catalog: &Catalog) -> (SourceDb, CheckedProgram, DiagnosticResult) {
    let mut db = SourceDb::new();
    let id = db.add("hook.can".to_string(), src.to_string());
    let (program, diags) = check_program(&db, &[id], Some(catalog));
    let mut result = DiagnosticResult::new("test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.diagnostics = diags;
    result.complete = false;
    result.finish();
    (db, program, result)
}

fn emit_hook(
    program: &CheckedProgram,
    db: &SourceDb,
    result: &DiagnosticResult,
    catalog: &Catalog,
) -> (canlang_compiler::codegen::artifact::CompileArtifact, Vec<Diagnostic>) {
    let sources = EmitSources {
        db,
        result,
        catalog: Some(catalog),
        options: EmitOptions::test_only(),
    };
    emit(program, &sources)
}

fn hook_js(src: &str) -> (String, Vec<Diagnostic>, PathBuf) {
    let (catalog, path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hook source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let js = artifact.modules[0].js.clone();
    (js, diags, path)
}

fn codes(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect()
}

/// (Outcome 12, `now` class.) The recorded `due > now` hook shape
/// (CanSuccess `arm`/`reschedule`, CanMaintain/CanContract timers) binds
/// the owner clock through the native runner instead of reporting the
/// owner-policy-plan gap.
#[test]
fn hook_now_binds_native_owner_clock() {
    let src = "app T\nGiven\n M { due:datetime, timer:text }\n event Tick { s:text }\nWhen\n scenario arm on=M.create\n  do\n   if event.after.due>now\n    schedule event.after.id at=event.after.due event=Tick {s=\"tick\"}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "now hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(js.contains("c.now"), "owner clock read:\n{js}");
    assert!(
        js.contains("$hookCtx.schedule"),
        "timer stages through the hook context:\n{js}"
    );
}

/// (Outcome 12, derive class.) The recorded `resource_evidence(resource)`
/// shape (CanRent snapshots, `plan_eligible(event.after)`) invokes the
/// checked derive with the ambient context on native runners.
#[test]
fn hook_derive_call_uses_ambient_context() {
    let src = "app T\nGiven\n M { t:text }\n N in M { u:text }\n derive label(v:text):text = v\nWhen\n scenario snap on=M.create\n  do\n   let resource=event.after\n   create N {parent=resource,u=label(resource.t)} as snap\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "derive hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(
        js.contains("(c,"),
        "derive invoked with ambient context:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.stage"),
        "snapshot stages through the hook context:\n{js}"
    );
}

/// (Outcome 12, value class.) Pure temporal shapes around `now`
/// (`max([now, due])`, `??`, `now + 1ms`) lower on native runners with no
/// plan gap.
#[test]
fn hook_datetime_max_and_coalesce_lower() {
    let src = "app T\nGiven\n M { due:datetime, timer:text, tz:text? }\n event Tick { s:text }\nWhen\n scenario arm on=M.create\n  do\n   let at=max([now,event.after.due])\n   let zone=event.after.tz??\"UTC\"\n   if event.after.due>now\n    schedule event.after.id at=at event=Tick {s=zone}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "temporal hook lowers: {diags:?}");
    assert!(js.contains("c.now"), "owner clock read:\n{js}");
}

/// (Outcome 12, emit class.) The recorded change-notification shape
/// (CanEmployee `changed`): same-model field comparisons gate an emit
/// carrying the snapshot plus carried references on the native runner.
#[test]
fn hook_emit_change_notification() {
    let src = "app T\nGiven\n L { tz:text }\n E { home:L, active:bool, start:date, end:date?, role:text }\n event Changed { employee:E, home:L, active:bool }\nWhen\n scenario changed on=E.update\n  do\n   if event.before.home!=event.after.home or event.before.active!=event.after.active or event.before.start!=event.after.start or event.before.end!=event.after.end or event.before.role!=event.after.role\n    emit Changed {employee=event.after,home=event.after.home,active=event.after.active}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "change hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await emit(c,\"T.Changed\",{employee:event.after,home:event.after.home,active:event.after.active});"),
        "deferred emit with snapshot and carried references:\n{js}"
    );
}

/// (Outcome 12, emit class.) The recorded roster-notification shape
/// (CanShift `availability_created`): an unconditional emit with null
/// paths and parent linkage lowers on the native runner.
#[test]
fn hook_emit_null_paths_and_parent_linkage() {
    let src = "app T\nGiven\n R { t:text }\n A in R { employee:text, from:datetime }\n event Review { employee:text, roster:R, account:text? }\nWhen\n scenario created on=A.create\n  do\n   emit Review {employee=event.after.employee,roster=event.after.parent,account=null}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "roster hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await emit(c,\"T.Review\",{employee:event.after.employee,roster:event.after.parent,account:null});"),
        "null paths and parent linkage preserved:\n{js}"
    );
}

/// (Outcome 12, emit class.) The recorded revision shape (CanMaintain
/// `revise_plan`): a staged row is created, emitted by binding, then
/// cancelled by staged id — all through the native runner.
#[test]
fn hook_emit_staged_binding_payload() {
    let src = "app T\nGiven\n Q { t:text }\n P in Q { rev:int }\n X in Q { r:int }\n event Step { cancellation:X }\nWhen\n scenario revise on=P.update\n  do\n   create X {parent=event.after.parent,r=event.before.rev+1} as change\n   emit Step {cancellation=change}\n   cancel change.id\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "revision hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await emit(c,\"T.Step\",{cancellation:$can$l$"),
        "emit carries the staged binding:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.cancel($can$l$"),
        "cancel addresses the staged id:\n{js}"
    );
}

/// (Outcome 12, emit class.) Emit effects keep source order with the
/// hook's guards, staged writes and cancellation: guards reject first,
/// effects stage atomically, and timers coexist in one runner.
#[test]
fn hook_emit_keeps_guard_and_effect_order() {
    let src = "app T\nGiven\n M { t:text }\n C in M { m:text }\n event Done { s:text }\nWhen\n scenario h on=M.create\n  do\n   require event.after.t!=\"x\"\n   create C {parent=event.after,m=\"note\"} as staged\n   emit Done {s=event.after.t}\n   cancel \"old\"\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "ordered hook lowers: {diags:?}");
    let guard = js.find("check(").expect("guard lowers");
    let staged = js.find("$hookCtx.stage").expect("staged write lowers");
    let emitted = js.find("await emit(c,").expect("emit lowers");
    let cancelled = js.find("$hookCtx.cancel").expect("cancel lowers");
    assert!(
        guard < staged && staged < emitted && emitted < cancelled,
        "guards, staged writes, emit, cancel keep source order:\n{js}"
    );
}

/// (Outcome 12, C27.) Declared parent fields read through the linkage
/// (`event.after.parent.active`) via the transitive parent load: the
/// consuming-site mode rides inside the scope object
/// (`openScope("decision")` for hook firing/guard/decision expressions
/// including `if` conditions, `"value"` for body copies; helpers inherit
/// the site), while `transitive.load(scope,model,id)` arity and all
/// scope/fence/source checks are unchanged. No raw modeless load exists.
#[test]
fn hook_parent_content_loads_declared_field() {
    let src = "app T\nGiven\n M { active:bool }\n C in M { t:text }\nWhen\n scenario arm on=C.create\n  do\n   if event.after.parent.active\n    set event.after {t=\"armed\"}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "parent hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(
        js.contains("openScope(\"decision\")"),
        "guard consumption threads decision mode:\n{js}"
    );
    assert!(
        js.contains("transitive.load($hookScope,\"T.M\","),
        "parent loads through the existing transitive scope/load:\n{js}"
    );
    assert!(
        !js.contains("has no lowering"),
        "no fail-closed placeholder:\n{js}"
    );
}

/// (Outcome 12, negative.) Undeclared parent fields stay loud: only
/// declared leaf/carried fields load; anything else keeps the exact
/// `E6008` instead of reading `undefined` off the linkage.
#[test]
fn hook_parent_undeclared_stays_refused() {
    let src = "app T\nGiven\n M { active:bool }\n C in M { t:text }\nWhen\n scenario arm on=C.create\n  do\n   if event.after.parent.nope\n    set event.after {t=\"armed\"}\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    if !result.diagnostics.is_empty() {
        assert!(
            result.diagnostics.iter().any(|d| d.code.starts_with("E")),
            "checker refuses unknown field: {:?}",
            result.diagnostics
        );
        return;
    }
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let js = artifact.modules[0].js.clone();
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook parent content")),
        "undeclared parent content refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(
        js.contains("has no lowering"),
        "fail-closed placeholder:\n{js}"
    );
}

/// (Outcome 12, C27 hp-alias, engine proof.) A native child-create hook
/// reading parent content through an alias (`let p=event.after.parent`;
/// `if p.active` decides, `let n=p.tag` copies) drives the REAL owning
/// pipeline: the guard threads `"decision"`, the body copy threads
/// `"value"` (both via scope-carried transitive loads, same
/// `load(scope,model,id)` arity), and committed parents gate + supply the
/// staged child. Active parent arms with the parent's own tag (not a
/// hardcoded literal); inactive parent leaves the child untouched.
#[test]
fn hook_hp_alias_parent_load_drives_owner_pipeline() {
    let src = "app T\nGiven\n M { active:bool, tag:text }\n C in M { t:text }\nWhen\n scenario arm on=C.create\n  do\n   let p=event.after.parent\n   if p.active\n    let n=p.tag\n    set event.after {t=n}\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hp-alias source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(
        js.contains("openScope(\"decision\")"),
        "guard threads decision mode:\n{js}"
    );
    assert!(
        js.contains("openScope(\"value\")"),
        "body copy threads value mode:\n{js}"
    );
    assert!(
        !js.contains("has no lowering"),
        "no fail-closed placeholder:\n{js}"
    );
    let policies = serde_json::to_string(
        &artifact
            .model_policies
            .as_ref()
            .expect("native owner-policy descriptors"),
    )
    .expect("policies serialize");
    let dir = stage_dir("hp-alias-engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    std::fs::write(dir.join("policies.json"), &policies).unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let bindings = root.join("packages/state/src/mutation/model-policies.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &bindings, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp } from './emitted.mjs';
import { readFileSync } from 'node:fs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { bindOwnerModelPolicies } from '@@BINDINGS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const registry = canApp();
  const descriptors = JSON.parse(readFileSync('./policies.json', 'utf8'));
  const table = buildModelTable([
    modelDef('T.M', { fields: { active: field(), tag: field() } }),
    modelDef('T.C', { fields: { t: field() } }),
  ]);
  const policies = bindOwnerModelPolicies({ table, descriptors, bindings: registry.modelPolicyBindings });
  const { store } = createTestMemoryStorage();
  await seedRow(store, asModel('T.M'), { id: 'p-on', data: { active: true, tag: 'armed-on' } });
  await seedRow(store, asModel('T.M'), { id: 'p-off', data: { active: false, tag: 'armed-off' } });
  async function createChild(id, parentId) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.C.create' }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    await session.stage({ op: 'create', model: asModel('T.C'), id: asId(id),
      parent: { model: asModel('T.M'), id: asId(parentId) }, data: { t: 'new' } },
      { cause: 'crud', input: { t: 'new' } });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  await createChild('c-on', 'p-on');
  await createChild('c-off', 'p-off');
  const on = await store.load(asModel('T.C'), asId('c-on'));
  const off = await store.load(asModel('T.C'), asId('c-off'));
  verdict.on = on === null ? null : on.data;
  verdict.off = off === null ? null : off.data;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@BINDINGS@@", &bindings.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict
            .get("on")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("armed-on"),
        "active parent arms with the parent tag copy: {stdout}"
    );
    assert_eq!(
        verdict
            .get("off")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("new"),
        "inactive parent leaves the child untouched: {stdout}"
    );
}

/// (Outcome 12, C27 hp-helper, engine proof.) A native child-create hook
/// calling a checked helper with parent content plus the ambient clock
/// (`gated(parent.active, now)`, same `await s$gated(c,…)` equivalence as
/// outside hooks) drives the REAL owning pipeline: the parent arg inherits
/// the guard's `"decision"` site, the helper runs with the ambient context
/// (a missing `c` would throw on `c.now` instead), and committed parents
/// gate the staged child. No rewritten helper, no Boolean-result privilege.
#[test]
fn hook_hp_helper_parent_load_with_ambient_drives_owner_pipeline() {
    let src = "app T\nGiven\n M { active:bool }\n C in M { t:text }\n derive gated(v:bool, at:datetime):bool = v\nWhen\n scenario arm on=C.create\n  do\n   if gated(event.after.parent.active,now)\n    set event.after {t=\"armed\"}\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hp-helper source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(
        js.contains("openScope(\"decision\")"),
        "helper parent arg inherits the guard decision site:\n{js}"
    );
    assert!(
        js.contains("(c,"),
        "helper invoked with ambient context (same equivalence as outside hooks):\n{js}"
    );
    assert!(
        js.contains("c.now"),
        "ambient clock read:\n{js}"
    );
    assert!(
        !js.contains("has no lowering"),
        "no fail-closed placeholder:\n{js}"
    );
    let policies = serde_json::to_string(
        &artifact
            .model_policies
            .as_ref()
            .expect("native owner-policy descriptors"),
    )
    .expect("policies serialize");
    let dir = stage_dir("hp-helper-engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    std::fs::write(dir.join("policies.json"), &policies).unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let bindings = root.join("packages/state/src/mutation/model-policies.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &bindings, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp } from './emitted.mjs';
import { readFileSync } from 'node:fs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { bindOwnerModelPolicies } from '@@BINDINGS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const registry = canApp();
  const descriptors = JSON.parse(readFileSync('./policies.json', 'utf8'));
  const table = buildModelTable([
    modelDef('T.M', { fields: { active: field() } }),
    modelDef('T.C', { fields: { t: field() } }),
  ]);
  const policies = bindOwnerModelPolicies({ table, descriptors, bindings: registry.modelPolicyBindings });
  const { store } = createTestMemoryStorage();
  await seedRow(store, asModel('T.M'), { id: 'p-on', data: { active: true } });
  await seedRow(store, asModel('T.M'), { id: 'p-off', data: { active: false } });
  async function createChild(id, parentId) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.C.create' }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    await session.stage({ op: 'create', model: asModel('T.C'), id: asId(id),
      parent: { model: asModel('T.M'), id: asId(parentId) }, data: { t: 'new' } },
      { cause: 'crud', input: { t: 'new' } });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  await createChild('c-on', 'p-on');
  await createChild('c-off', 'p-off');
  const on = await store.load(asModel('T.C'), asId('c-on'));
  const off = await store.load(asModel('T.C'), asId('c-off'));
  verdict.on = on === null ? null : on.data;
  verdict.off = off === null ? null : off.data;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@BINDINGS@@", &bindings.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict
            .get("on")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("armed"),
        "active parent arms through the helper with ambient clock: {stdout}"
    );
    assert_eq!(
        verdict
            .get("off")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("new"),
        "inactive parent leaves the child untouched: {stdout}"
    );
}

/// (Outcome 12, C26-record-helper, engine proof.) A native child-create
/// hook calling record-typed helpers over the bare parent linkage
/// (`isActive(event.after.parent)`, same `h$…(c,site,…)` equivalence as
/// inline parent loads) drives the REAL owning pipeline: the If-condition
/// and Require inherit the guard's `"decision"` site through the helper
/// (`c.transitive` on the adapted ambient context), while a body-value
/// copy through the same helper shape inherits `"value"` and refuses
/// precisely in a direct State frame (no caller grant authority there —
/// the host viewer projection authorizes granted copies). No rewritten
/// helper, no Boolean-result privilege, no new carrier.
#[test]
fn hook_hp_record_helper_linkage_drives_owner_pipeline() {
    let src = "app T\nGiven\n M { active:bool, tag:text }\n C in M { t:text }\n D in M { t:text }\n derive isActive(loc:M):bool = loc.active\n derive pick(loc:M):text = loc.tag\nWhen\n scenario arm on=C.create\n  do\n   if isActive(event.after.parent)\n    require isActive(event.after.parent)\n    set event.after {t=\"armed\"}\n scenario copy on=D.create\n  do\n   let t=pick(event.after.parent)\n   set event.after {t=t}\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hp-record-helper source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(
        js.contains("async function $can$hook$"),
        "record helpers dual-emit their hook variant:\n{js}"
    );
    assert!(
        js.contains("c.transitive.openScope($hookSite)"),
        "hook variant loads through the ambient transitive path:\n{js}"
    );
    assert!(
        js.contains("\"decision\",event.after.parent"),
        "guard helper call inherits the decision site:\n{js}"
    );
    assert!(
        js.contains("\"value\",event.after.parent"),
        "body helper call inherits the value site:\n{js}"
    );
    assert!(
        !js.contains("has no lowering"),
        "no fail-closed placeholder:\n{js}"
    );
    let policies = serde_json::to_string(
        &artifact
            .model_policies
            .as_ref()
            .expect("native owner-policy descriptors"),
    )
    .expect("policies serialize");
    let dir = stage_dir("hp-record-helper-engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    std::fs::write(dir.join("policies.json"), &policies).unwrap();
    // The emitted hook imports the stdlib check/set surface (`require`
    // lowers to `check`); stage the same recording stub the codegen
    // engine suite uses so the driver resolves it from its temp dir.
    let stub_dir = dir.join("node_modules").join("@canlang").join("stdlib");
    std::fs::create_dir_all(&stub_dir).unwrap();
    std::fs::write(
        stub_dir.join("package.json"),
        "{\"name\":\"@canlang/stdlib\",\"version\":\"0.0.0-test\",\"type\":\"module\",\"main\":\"index.mjs\"}",
    )
    .unwrap();
    std::fs::write(
        stub_dir.join("index.mjs"),
        "export const __calls = [];\n\
         const rec = (name) => (...args) => { __calls.push([name, ...args]); return {}; };\n\
         export const require = (cond, code) => { if (!cond) throw new Error(\"check:\" + code); };\n\
         export const create = rec(\"create\");\n\
         export const deleteRecord = rec(\"deleteRecord\");\n\
         export const hasRole = () => true;\n\
         export const set = rec(\"set\");\n",
    )
    .unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let bindings = root.join("packages/state/src/mutation/model-policies.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &bindings, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp } from './emitted.mjs';
import { readFileSync } from 'node:fs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { bindOwnerModelPolicies } from '@@BINDINGS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const registry = canApp();
  const descriptors = JSON.parse(readFileSync('./policies.json', 'utf8'));
  const table = buildModelTable([
    modelDef('T.M', { fields: { active: field(), tag: field() } }),
    { ...modelDef('T.C', { fields: { t: field() } }), containment: { parent: asModel('T.M') } },
    { ...modelDef('T.D', { fields: { t: field() } }), containment: { parent: asModel('T.M') } },
  ]);
  const policies = bindOwnerModelPolicies({ table, descriptors, bindings: registry.modelPolicyBindings });
  const { store } = createTestMemoryStorage();
  await seedRow(store, asModel('T.M'), { id: 'p-on', data: { active: true, tag: 'armed-on' } });
  await seedRow(store, asModel('T.M'), { id: 'p-off', data: { active: false, tag: 'armed-off' } });
  async function createChild(model, id, parentId) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: `T.${model}.create` }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    await session.stage({ op: 'create', model: asModel(`T.${model}`), id: asId(id),
      parent: { model: asModel('T.M'), id: asId(parentId) }, data: { t: 'new' } },
      { cause: 'crud', input: { t: 'new' } });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  await createChild('C', 'c-on', 'p-on');
  await createChild('C', 'c-off', 'p-off');
  const on = await store.load(asModel('T.C'), asId('c-on'));
  const off = await store.load(asModel('T.C'), asId('c-off'));
  verdict.on = on === null ? null : on.data;
  verdict.off = off === null ? null : off.data;
  // A body-value copy through a record helper inherits `value`: with no
  // caller grant authority in a direct State frame it refuses precisely
  // (the host viewer projection authorizes granted copies).
  try {
    await createChild('D', 'd-on', 'p-on');
    verdict.value = 'served';
  } catch (error) {
    verdict.value = String(error?.message ?? error);
  }
  const d = await store.load(asModel('T.D'), asId('d-on'));
  verdict.dRow = d === null ? null : d.data;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@BINDINGS@@", &bindings.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict
            .get("on")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("armed"),
        "active parent arms through the record helper: {stdout}"
    );
    assert_eq!(
        verdict
            .get("off")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("new"),
        "inactive parent leaves the child untouched: {stdout}"
    );
    assert_eq!(
        verdict.get("value").and_then(|v| v.as_str()),
        Some("Record field is not readable."),
        "direct-frame value copy refuses precisely: {stdout}"
    );
    assert_eq!(
        verdict.get("dRow"),
        Some(&serde_json::Value::Null),
        "refused value copy stages nothing: {stdout}"
    );
}

/// (Outcome 12, C26-record-helper negative.) A staged binding is an `{id}`
/// identity, not the row a record helper reads: admission refuses and
/// lowering stays loud (`E6008`), exactly like before.
#[test]
fn hook_record_helper_staged_linkage_refused_loud() {
    let src = "app T\nGiven\n M { active:bool }\n C in M { t:text }\n derive isActive(loc:M):bool = loc.active\nWhen\n scenario arm on=C.create\n  do\n   create M {active=true} as m\n   if isActive(m)\n    set event.after {t=\"armed\"}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook derive call")),
        "staged linkage refuses loud: {}",
        codes(&diags).join("\n")
    );
    assert!(
        js.contains("has no lowering"),
        "fail-closed placeholder:\n{js}"
    );
}

/// (CAN18-v1 C26-reference, file 14 `Account.location` first shape.)
/// Direct snapshot stored-reference reads (`event.after.<ref>.<leaf>`
/// with a declared singular stored reference and allowed leaf scalar)
/// lower through the defining-owner reference loader
/// (`transitive.loadReference`, never through `loadParent`'s ancestor
/// fence) at the consuming decision/value site. Deeper chains
/// (`parent.<ref>`, `<ref>.<leaf>.<x>`) and staged content keep their
/// refusal pins below — only this direct shape changed, with positive
/// State/host/joint consumers proving the admitted behavior.
#[test]
fn hook_reference_traversal_refused_loud() {
    let src = "app T\nGiven\n L { tz:text }\n M { loc:L, due:datetime }\nWhen\n scenario arm on=M.create\n  do\n   if event.after.due>now\n    set event.after {due=event.after.due}\n   require event.after.loc.tz!=\"\"\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().all(|d| d.code != "E6008"),
        "direct reference traversal lowers (no E6008): {}",
        codes(&diags).join("\n")
    );
    assert!(
        js.contains("transitive.loadReference"),
        "reference loader, never the ancestor fence:\n{js}"
    );
    assert!(
        js.contains("transitive.openScope(\"decision\")"),
        "decision-site scope:\n{js}"
    );
    assert!(
        !js.contains("has no lowering"),
        "no fail-closed placeholder for the admitted shape:\n{js}"
    );
}

/// (Outcome 12, null path.) Nullable comparisons in hooks use the
/// null-safe equality (CanEmployee `end` change detection): `null`
/// compares directly instead of reaching a scalar comparator that would
/// throw on absent values.
#[test]
fn hook_nullable_date_equality_null_safe() {
    let src = "app T\nGiven\n M { start:date, end:date? }\nWhen\n scenario changed on=M.update\n  do\n   if event.before.end!=event.after.end\n    set event.after {start=event.before.start}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "nullable hook lowers: {diags:?}");
    assert!(
        js.contains("equalValue"),
        "null-safe equality:\n{js}"
    );
    assert!(
        !js.contains("compareDate"),
        "no throwing scalar comparator on nulls:\n{js}"
    );
}

/// (Outcome 12, negative.) Widening the native plan never weakens the
/// staged-write bars: a hook creating its own trigger model still refuses
/// at checking with the exact same-model code.
#[test]
fn hook_same_model_staging_still_barred() {
    let (catalog, path) = hook_catalog();
    let src = "app T\nGiven\n M { t:text }\nWhen\n scenario h on=M.create\n  do\n   create M {t=\"x\"} as m\nThen\n";
    let (_db, _program, result) = check_hook(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "E4052"),
        "same-model bar intact: {:?}",
        result.diagnostics
    );
}

/// Workspace root above the compiler package under test.
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf()
}

fn stage_dir(stem: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "can-hook-{}-{}-{stem}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// (Outcome 12, engine proof.) A native hook using `now`, a derive call,
/// staged writes and timers drives the REAL owner pipeline through the
/// checked policy bindings: the runner receives the owning invocation
/// context as `c` (the schedule lands exactly on the owner clock — a
/// missing `c` would throw instead), the staged child commits atomically
/// once with the trigger, cancellation removes the doomed timer, and a
/// stale fence plus a foreign model refuse without touching the commit.
#[test]
fn hook_native_runner_drives_owner_pipeline() {
    let src = "app T\nGiven\n M { t:text, done:bool }\n C in M { m:text }\n event Due { s:text }\n derive mark():text = \"hooked\"\nWhen\n scenario h on=M.update\n  do\n   if event.after.done==false\n    let tagged=mark()\n    set event.after {t=tagged}\n    create C {parent=event.after,m=tagged} as staged\n    cancel \"deadline:old\"\n    schedule event.after.id at=now event=Due {s=tagged}\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hook source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    for line in js.lines() {
        assert!(
            !line.trim_start().starts_with("import "),
            "emitted hook must import nothing: {line}"
        );
    }
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    let policies = serde_json::to_string(
        &artifact
            .model_policies
            .as_ref()
            .expect("native owner-policy descriptors"),
    )
    .expect("policies serialize");
    let dir = stage_dir("native-engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    std::fs::write(dir.join("policies.json"), &policies).unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let bindings = root.join("packages/state/src/mutation/model-policies.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &bindings, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp } from './emitted.mjs';
import { readFileSync } from 'node:fs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, FIXED_NOW, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { bindOwnerModelPolicies } from '@@BINDINGS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const registry = canApp();
  const descriptors = JSON.parse(readFileSync('./policies.json', 'utf8'));
  const table = buildModelTable([
    modelDef('T.M', { fields: { t: field(), done: field() } }),
    modelDef('T.C', { fields: { m: field() } }),
  ]);
  const policies = bindOwnerModelPolicies({ table, descriptors, bindings: registry.modelPolicyBindings });
  const { store } = createTestMemoryStorage();
  await seedRow(store, asModel('T.M'), { id: 'u-1', data: { t: 'new', done: false } });
  await seedRow(store, asModel('T.M'), { id: 'u-2', data: { t: 'new', done: false } });
  {
    const rev = await store.readRevision();
    await store.commit(makeBatch(rev, { schedules: [
      { op: 'replace', key: 'deadline:old', at: FIXED_NOW, event: 'T.Due', payload: {} },
    ] }));
  }
  const rev0 = await store.readRevision();
  const opId = '01999999-0000-7000-8000-0000000000e0';
  const childId = 'u-1/staged/' + opId + '/T.h/0';
  const session = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'T.M.update', operationId: opId }),
    bounds: { maxWork: 1000, maxRows: 20 }, policies });
  await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data: { t: 'go' } },
    { cause: 'crud', input: { t: 'go' } });
  const output = await session.finalize();
  await store.commit(makeBatch(rev0, { writes: output.writes, history: output.history,
    schedules: output.schedules,
    uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  verdict.status = 'committed';
  verdict.revisionDelta = (await store.readRevision()) - rev0;
  const m = await store.load(asModel('T.M'), asId('u-1'));
  verdict.mVersion = m.version;
  verdict.mData = m.data;
  const c = await store.load(asModel('T.C'), asId(childId));
  verdict.child = c === null ? null : { version: c.version, parent: c.parent, data: c.data };
  verdict.timer = await store.scheduleGet('u-1');
  verdict.oldSchedule = await store.scheduleGet('deadline:old');
  verdict.now = FIXED_NOW;
  // NOTE (finding for the hook-engine owner): re-running the SAME trigger
  // under the SAME operation identity stages the same deterministic staged
  // id (the child above), which now exists, so the stale path below drives
  // a fresh row to isolate the revision-fence refusal from staged-id
  // identity.
  const late = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'T.M.update' }),
    bounds: { maxWork: 1000, maxRows: 20 }, policies });
  await late.stage({ op: 'update', model: asModel('T.M'), id: asId('u-2'), data: { t: 'stale' } },
    { cause: 'crud', input: { t: 'stale' } });
  const lateOut = await late.finalize();
  let staleRefused = false;
  try {
    await store.commit(makeBatch(rev0, { writes: lateOut.writes, history: lateOut.history,
      schedules: lateOut.schedules,
      uniqueClaims: lateOut.uniqueClaims, uniqueReleases: lateOut.uniqueReleases }));
  } catch { staleRefused = true; }
  verdict.staleRefused = staleRefused;
  const foreign = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'T.M.update' }),
    bounds: { maxWork: 1000, maxRows: 20 }, policies });
  let foreignRefused = false;
  try {
    await foreign.stage({ op: 'update', model: asModel('T.Nope'), id: asId('x'), data: {} },
      { cause: 'crud', input: {} });
  } catch { foreignRefused = true; }
  verdict.foreignRefused = foreignRefused;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@BINDINGS@@", &bindings.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict.get("status").and_then(|v| v.as_str()),
        Some("committed"),
        "{stdout}"
    );
    assert_eq!(
        verdict.get("revisionDelta").and_then(|v| v.as_i64()),
        Some(1),
        "one fenced batch: {stdout}"
    );
    assert_eq!(
        verdict.get("mVersion").and_then(|v| v.as_i64()),
        Some(2),
        "{stdout}"
    );
    assert_eq!(
        verdict
            .get("mData")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "derive ran inside the hook: {stdout}"
    );
    let child = verdict.get("child").expect("staged child: {stdout}");
    assert_eq!(
        child.get("version").and_then(|v| v.as_i64()),
        Some(1),
        "{stdout}"
    );
    assert_eq!(
        child
            .get("parent")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str()),
        Some("u-1"),
        "{stdout}"
    );
    assert_eq!(
        child
            .get("data")
            .and_then(|v| v.get("m"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "{stdout}"
    );
    let timer = verdict.get("timer").expect("timer: {stdout}");
    assert_eq!(
        timer.get("at").and_then(|v| v.as_i64()),
        verdict.get("now").and_then(|v| v.as_i64()),
        "hook `now` is the owner clock: {stdout}"
    );
    assert_eq!(
        timer
            .get("payload")
            .and_then(|v| v.get("s"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "{stdout}"
    );
    assert_eq!(
        verdict.get("oldSchedule"),
        Some(&serde_json::Value::Null),
        "cancelled: {stdout}"
    );
    assert_eq!(
        verdict.get("staleRefused").and_then(|v| v.as_bool()),
        Some(true),
        "stale fence refuses: {stdout}"
    );
    assert_eq!(
        verdict.get("foreignRefused").and_then(|v| v.as_bool()),
        Some(true),
        "foreign model refuses: {stdout}"
    );
}

/// (Outcome 12, repeat class, C21.) A source hook creating a revision/audit
/// child on update: two distinct admitted updates of one parent must EACH
/// create the authored child (distinct staged identities), while replaying
/// ONE operation stages its same deterministic id and stays once-only (the
/// re-stage is refused; no extra child appears).
#[test]
fn hook_repeat_update_stages_distinct_children() {
    let src = "app T\nGiven\n M { t:text, done:bool }\n C in M { m:text }\n event Due { s:text }\n derive mark():text = \"hooked\"\nWhen\n scenario h on=M.update\n  do\n   if event.after.done==false\n    let tagged=mark()\n    set event.after {t=tagged}\n    create C {parent=event.after,m=tagged} as staged\n    cancel \"deadline:old\"\n    schedule event.after.id at=now event=Due {s=tagged}\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hook source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    let policies = serde_json::to_string(
        &artifact
            .model_policies
            .as_ref()
            .expect("native owner-policy descriptors"),
    )
    .expect("policies serialize");
    let dir = stage_dir("repeat-engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    std::fs::write(dir.join("policies.json"), &policies).unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let bindings = root.join("packages/state/src/mutation/model-policies.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &bindings, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp } from './emitted.mjs';
import { readFileSync } from 'node:fs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, FIXED_NOW, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { bindOwnerModelPolicies } from '@@BINDINGS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const registry = canApp();
  const descriptors = JSON.parse(readFileSync('./policies.json', 'utf8'));
  const table = buildModelTable([
    modelDef('T.M', { fields: { t: field(), done: field() } }),
    modelDef('T.C', { fields: { m: field() } }),
  ]);
  const policies = bindOwnerModelPolicies({ table, descriptors, bindings: registry.modelPolicyBindings });
  const { store } = createTestMemoryStorage();
  await seedRow(store, asModel('T.M'), { id: 'u-1', data: { t: 'new', done: false } });
  // Two DISTINCT admitted operation identities driving updates of one parent.
  const opA = '01999999-0000-7000-8000-00000000000a';
  const opB = '01999999-0000-7000-8000-00000000000b';
  async function admittedUpdate(operationId, data) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.update', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data },
      { cause: 'crud', input: data });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  async function replayRefused(operationId, data) {
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.update', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    try {
      await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data },
        { cause: 'crud', input: data });
      return 'staged';
    } catch (error) {
      return String(error?.message ?? error);
    }
  }
  async function childAt(id) {
    const c = await store.load(asModel('T.C'), asId(id));
    return c === null ? null : { version: c.version, parent: c.parent, data: c.data };
  }
  const baseA = 'u-1/staged/' + opA + '/T.h/0';
  const baseB = 'u-1/staged/' + opB + '/T.h/0';
  await admittedUpdate(opA, { t: 'go' });
  verdict.childA = await childAt(baseA);
  verdict.replayA1 = await replayRefused(opA, { t: 'go' });
  verdict.childAAfterReplay = await childAt(baseA + '/1');
  await admittedUpdate(opB, { t: 'go2' });
  verdict.childB = await childAt(baseB);
  const m = await store.load(asModel('T.M'), asId('u-1'));
  verdict.mVersion = m.version;
  verdict.mData = m.data;
  verdict.timer = await store.scheduleGet('u-1');
  verdict.replayA2 = await replayRefused(opA, { t: 'go' });
  verdict.childAfterReplays = await childAt(baseB + '/1');
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@BINDINGS@@", &bindings.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    let child_a = verdict.get("childA").expect("first child: {stdout}");
    assert_eq!(
        child_a.get("version").and_then(|v| v.as_i64()),
        Some(1),
        "first update creates its child: {stdout}"
    );
    assert_eq!(
        child_a
            .get("parent")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str()),
        Some("u-1"),
        "exact parent: {stdout}"
    );
    assert_eq!(
        child_a
            .get("data")
            .and_then(|v| v.get("m"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "authored child content: {stdout}"
    );
    assert!(
        verdict
            .get("replayA1")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("Record already exists")),
        "replay of one operation stays once-only: {stdout}"
    );
    assert_eq!(
        verdict.get("childAAfterReplay"),
        Some(&serde_json::Value::Null),
        "replay creates no extra child: {stdout}"
    );
    let child_b = verdict.get("childB").expect("second child: {stdout}");
    assert_eq!(
        child_b.get("version").and_then(|v| v.as_i64()),
        Some(1),
        "second update creates its own child: {stdout}"
    );
    assert_eq!(
        child_b
            .get("parent")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str()),
        Some("u-1"),
        "exact parent: {stdout}"
    );
    assert_eq!(
        child_b
            .get("data")
            .and_then(|v| v.get("m"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "authored child content: {stdout}"
    );
    assert_eq!(
        verdict.get("mVersion").and_then(|v| v.as_i64()),
        Some(3),
        "both updates applied: {stdout}"
    );
    let timer = verdict.get("timer").expect("timer: {stdout}");
    assert_eq!(
        timer
            .get("payload")
            .and_then(|v| v.get("s"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "ordered schedule preserved across the repeat: {stdout}"
    );
    assert!(
        verdict
            .get("replayA2")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("Record already exists")),
        "late replay stays once-only: {stdout}"
    );
    assert_eq!(
        verdict.get("childAfterReplays"),
        Some(&serde_json::Value::Null),
        "replays create no extra children: {stdout}"
    );
}

/// (Outcome 12, two-hook class, C22.) Two DISTINCT authored hooks on the
/// SAME update each create the same child model: one admitted update must
/// commit BOTH children (distinct staged identities per hook), while
/// replaying that operation restages its same ids and stays once-only.
#[test]
fn hook_distinct_hooks_same_update_stage_distinct_children() {
    let src_a = "app T\nGiven\n M { t:text, done:bool }\n C in M { m:text }\n derive mark():text = \"hooked\"\nWhen\n scenario h1 on=M.update\n  do\n   if event.after.done==false\n    let tagged=mark()\n    set event.after {t=tagged}\n    create C {parent=event.after,m=tagged} as staged\nThen\n";
    let src_b = "app T\nGiven\n M { t:text, done:bool }\n C in M { m:text }\n derive mark():text = \"hooked\"\nWhen\n scenario h2 on=M.update\n  do\n   if event.after.done==false\n    let tagged=mark()\n    set event.after {t=tagged}\n    create C {parent=event.after,m=tagged} as staged\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let compile_one = |src: &str| {
        let (db, program, result) = check_hook(src, &catalog);
        assert!(
            result.diagnostics.is_empty(),
            "hook source checks clean: {:?}",
            result.diagnostics
        );
        let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
        assert!(diags.is_empty(), "{diags:?}");
        artifact.modules[0].js.clone()
    };
    let js_a = compile_one(src_a);
    let js_b = compile_one(src_b);
    let _ = std::fs::remove_file(&catalog_path);
    let dir = stage_dir("distinct-hooks-engine");
    std::fs::write(dir.join("emittedA.mjs"), &js_a).unwrap();
    std::fs::write(dir.join("emittedB.mjs"), &js_b).unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp as canAppA } from './emittedA.mjs';
import { canApp as canAppB } from './emittedB.mjs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, FIXED_NOW, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const descA = canAppA().hooks['T.M.update'];
  const descB = canAppB().hooks['T.M.update'];
  verdict.siteA = descA.name;
  verdict.siteB = descB.name;
  // Two separately authored + compiled hooks registered on one trigger.
  const table = buildModelTable([
    modelDef('T.M', { fields: { t: field(), done: field() }, hooks: [
      { name: descA.name, ops: ['update'], run: (candidate, ctx) => descA.run(candidate, ctx, ctx.context) },
      { name: descB.name, ops: ['update'], run: (candidate, ctx) => descB.run(candidate, ctx, ctx.context) },
    ] }),
    modelDef('T.C', { fields: { m: field() } }),
  ]);
  const { store } = createTestMemoryStorage();
  await seedRow(store, asModel('T.M'), { id: 'u-1', data: { t: 'new', done: false } });
  const opA = '01999999-0000-7000-8000-0000000000a1';
  const baseA = 'u-1/staged/' + opA + '/' + descA.name + '/0';
  const baseB = 'u-1/staged/' + opA + '/' + descB.name + '/0';
  async function admittedUpdate(operationId, data) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.update', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 } });
    await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data },
      { cause: 'crud', input: data });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  async function replayRefused(operationId, data) {
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.update', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 } });
    try {
      await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data },
        { cause: 'crud', input: data });
      return 'staged';
    } catch (error) {
      return String(error?.message ?? error);
    }
  }
  async function childAt(id) {
    const c = await store.load(asModel('T.C'), asId(id));
    return c === null ? null : { version: c.version, parent: c.parent, data: c.data };
  }
  await admittedUpdate(opA, { t: 'go' });
  verdict.childA = await childAt(baseA);
  verdict.childB = await childAt(baseB);
  verdict.replayA = await replayRefused(opA, { t: 'go' });
  verdict.extraA = await childAt(baseA + '/1');
  verdict.extraB = await childAt(baseB + '/1');
  const m = await store.load(asModel('T.M'), asId('u-1'));
  verdict.mVersion = m.version;
  verdict.mData = m.data;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert_eq!(
        verdict.get("siteA").and_then(|v| v.as_str()),
        Some("T.h1"),
        "first authored hook site: {stdout}"
    );
    assert_eq!(
        verdict.get("siteB").and_then(|v| v.as_str()),
        Some("T.h2"),
        "second authored hook site: {stdout}"
    );
    for key in ["childA", "childB"] {
        let child = verdict.get(key).expect("staged child: {stdout}");
        assert_eq!(
            child.get("version").and_then(|v| v.as_i64()),
            Some(1),
            "{key} created: {stdout}"
        );
        assert_eq!(
            child
                .get("parent")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str()),
            Some("u-1"),
            "{key} exact parent: {stdout}"
        );
        assert_eq!(
            child
                .get("data")
                .and_then(|v| v.get("m"))
                .and_then(|v| v.as_str()),
            Some("hooked"),
            "{key} authored content: {stdout}"
        );
    }
    assert!(
        verdict
            .get("replayA")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("Record already exists")),
        "replay of one operation stays once-only: {stdout}"
    );
    assert_eq!(
        verdict.get("extraA"),
        Some(&serde_json::Value::Null),
        "no extra child from the first hook: {stdout}"
    );
    assert_eq!(
        verdict.get("extraB"),
        Some(&serde_json::Value::Null),
        "no extra child from the second hook: {stdout}"
    );
    assert_eq!(
        verdict.get("mVersion").and_then(|v| v.as_i64()),
        Some(2),
        "trigger update applied: {stdout}"
    );
    assert_eq!(
        verdict
            .get("mData")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "hook adjustment applied: {stdout}"
    );
}

/// (Outcome 12, birth class, C22.) A create-hook stages a child at the
/// parent's birth, then the FIRST update-hook on the same parent must stage
/// a DISTINCT child (no birth-create discount zeroes the first update),
/// while replaying either operation restages its same id and stays
/// once-only.
#[test]
fn hook_create_then_update_stages_distinct_children() {
    let src = "app T\nGiven\n M { t:text, done:bool }\n C in M { m:text }\n derive mark():text = \"hooked\"\nWhen\n scenario c on=M.create\n  do\n   if event.after.done==false\n    let tagged=mark()\n    create C {parent=event.after,m=tagged} as staged\n scenario u on=M.update\n  do\n   if event.after.done==false\n    let tagged=mark()\n    set event.after {t=tagged}\n    create C {parent=event.after,m=tagged} as staged\nThen\n";
    let (catalog, catalog_path) = hook_catalog();
    let (db, program, result) = check_hook(src, &catalog);
    assert!(
        result.diagnostics.is_empty(),
        "hook source checks clean: {:?}",
        result.diagnostics
    );
    let (artifact, diags) = emit_hook(&program, &db, &result, &catalog);
    let _ = std::fs::remove_file(&catalog_path);
    assert!(diags.is_empty(), "{diags:?}");
    let js = &artifact.modules[0].js;
    let policies = serde_json::to_string(
        &artifact
            .model_policies
            .as_ref()
            .expect("native owner-policy descriptors"),
    )
    .expect("policies serialize");
    let dir = stage_dir("birth-engine");
    std::fs::write(dir.join("emitted.mjs"), js).unwrap();
    std::fs::write(dir.join("policies.json"), &policies).unwrap();
    let root = workspace_root();
    let fixtures = root.join("packages/state/test/mutation/fixtures.ts");
    let invocation_fixtures = root.join("packages/state/test/invocation/fixtures.ts");
    let memory = root.join("packages/state/src/storage/memory.ts");
    let models = root.join("packages/state/src/mutation/models.ts");
    let bindings = root.join("packages/state/src/mutation/model-policies.ts");
    let pipeline = root.join("packages/state/src/mutation/pipeline.ts");
    for path in [&fixtures, &invocation_fixtures, &memory, &models, &bindings, &pipeline] {
        assert!(path.exists(), "engine source: {}", path.display());
    }
    let driver = r##"
import { canApp } from './emitted.mjs';
import { readFileSync } from 'node:fs';
import { seedRow, makeBatch, asId, asModel } from '@@INVOCATION@@';
import { modelDef, field, FIXED_NOW, pipelineContext } from '@@FIXTURES@@';
import { createTestMemoryStorage } from '@@MEMORY@@';
import { buildModelTable } from '@@MODELS@@';
import { bindOwnerModelPolicies } from '@@BINDINGS@@';
import { beginOwnerMutation } from '@@PIPELINE@@';
const verdict = {};
try {
  const registry = canApp();
  const descriptors = JSON.parse(readFileSync('./policies.json', 'utf8'));
  const table = buildModelTable([
    modelDef('T.M', { fields: { t: field(), done: field() } }),
    modelDef('T.C', { fields: { m: field() } }),
  ]);
  const policies = bindOwnerModelPolicies({ table, descriptors, bindings: registry.modelPolicyBindings });
  const hooks = policies.hooks.get(asModel('T.M'));
  verdict.sites = hooks.map((hook) => hook.name + ':' + hook.ops.join('+'));
  const { store } = createTestMemoryStorage();
  const opC = '01999999-0000-7000-8000-0000000000c1';
  const opU = '01999999-0000-7000-8000-0000000000d1';
  const nameC = hooks.find((hook) => hook.ops.includes('create')).name;
  const nameU = hooks.find((hook) => hook.ops.includes('update')).name;
  const baseC = 'u-1/staged/' + opC + '/' + nameC + '/0';
  const baseU = 'u-1/staged/' + opU + '/' + nameU + '/0';
  async function admittedCreate(operationId, data) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.create', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    await session.stage({ op: 'create', model: asModel('T.M'), id: asId('u-1'), data },
      { cause: 'crud', input: data });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  async function admittedUpdate(operationId, data) {
    const rev = await store.readRevision();
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.update', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data },
      { cause: 'crud', input: data });
    const output = await session.finalize();
    await store.commit(makeBatch(rev, { writes: output.writes, history: output.history,
      schedules: output.schedules, uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases }));
  }
  async function replayCreate(operationId, data) {
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.create', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    try {
      await session.stage({ op: 'create', model: asModel('T.M'), id: asId('u-1'), data },
        { cause: 'crud', input: data });
      return 'staged';
    } catch (error) {
      return String(error?.message ?? error);
    }
  }
  async function replayUpdate(operationId, data) {
    const session = await beginOwnerMutation({ table, store,
      context: pipelineContext({ operation: 'T.M.update', operationId }),
      bounds: { maxWork: 1000, maxRows: 20 }, policies });
    try {
      await session.stage({ op: 'update', model: asModel('T.M'), id: asId('u-1'), data },
        { cause: 'crud', input: data });
      return 'staged';
    } catch (error) {
      return String(error?.message ?? error);
    }
  }
  async function childAt(id) {
    const c = await store.load(asModel('T.C'), asId(id));
    return c === null ? null : { version: c.version, parent: c.parent, data: c.data };
  }
  await admittedCreate(opC, { t: 'new', done: false });
  verdict.childC = await childAt(baseC);
  await admittedUpdate(opU, { t: 'go' });
  verdict.childU = await childAt(baseU);
  verdict.replayC = await replayCreate(opC, { t: 'new', done: false });
  verdict.replayU = await replayUpdate(opU, { t: 'go' });
  verdict.extraC = await childAt(baseC + '/1');
  verdict.extraU = await childAt(baseU + '/1');
  const m = await store.load(asModel('T.M'), asId('u-1'));
  verdict.mVersion = m.version;
  verdict.mData = m.data;
  verdict.ok = true;
} catch (error) {
  verdict.ok = false;
  verdict.error = String(error?.stack ?? error);
}
console.log(JSON.stringify(verdict));
"##
    .replace("@@INVOCATION@@", &invocation_fixtures.display().to_string())
    .replace("@@FIXTURES@@", &fixtures.display().to_string())
    .replace("@@MEMORY@@", &memory.display().to_string())
    .replace("@@MODELS@@", &models.display().to_string())
    .replace("@@BINDINGS@@", &bindings.display().to_string())
    .replace("@@PIPELINE@@", &pipeline.display().to_string());
    std::fs::write(dir.join("driver.ts"), driver).unwrap();
    let out = std::process::Command::new("bun")
        .arg("driver.ts")
        .current_dir(&dir)
        .output()
        .expect("spawn bun driver");
    assert!(
        out.status.success(),
        "driver failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let verdict: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("verdict parses");
    assert_eq!(
        verdict.get("ok").and_then(|v| v.as_bool()),
        Some(true),
        "verdict: {stdout}"
    );
    assert!(
        verdict
            .get("sites")
            .and_then(|v| v.as_array())
            .is_some_and(|sites| sites.len() == 2),
        "create-hook and update-hook both bound: {stdout}"
    );
    for key in ["childC", "childU"] {
        let child = verdict.get(key).expect("staged child: {stdout}");
        assert_eq!(
            child.get("version").and_then(|v| v.as_i64()),
            Some(1),
            "{key} created: {stdout}"
        );
        assert_eq!(
            child
                .get("parent")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str()),
            Some("u-1"),
            "{key} exact parent: {stdout}"
        );
        assert_eq!(
            child
                .get("data")
                .and_then(|v| v.get("m"))
                .and_then(|v| v.as_str()),
            Some("hooked"),
            "{key} authored content: {stdout}"
        );
    }
    assert!(
        verdict
            .get("replayC")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("Record already exists")),
        "birth replay stays once-only: {stdout}"
    );
    assert!(
        verdict
            .get("replayU")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.contains("Record already exists")),
        "update replay stays once-only: {stdout}"
    );
    assert_eq!(
        verdict.get("extraC"),
        Some(&serde_json::Value::Null),
        "birth creates no extra child: {stdout}"
    );
    assert_eq!(
        verdict.get("extraU"),
        Some(&serde_json::Value::Null),
        "update creates no extra child: {stdout}"
    );
    assert_eq!(
        verdict.get("mVersion").and_then(|v| v.as_i64()),
        Some(2),
        "create then update applied: {stdout}"
    );
    assert_eq!(
        verdict
            .get("mData")
            .and_then(|v| v.get("t"))
            .and_then(|v| v.as_str()),
        Some("hooked"),
        "update-hook adjustment applied: {stdout}"
    );
}

/// (Outcome 12, query class.) The recorded snapshot shape (CanRent
/// `snapshot_Resource_create`, CanMaintain `report_window` hooks):
/// `count` over a contained child collection plus a derive of the
/// snapshot parent lower on the native runner with the trigger clock.
#[test]
fn hook_contained_count_and_snapshot_create() {
    let src = "app T\nGiven\n M { t:text }\n N in M { seq:int, u:text }\n derive label(v:text):text = v\nWhen\n scenario snap on=M.create\n  do\n   let resource=event.after\n   create N {parent=resource,seq=count(resource.N)+1,u=label(resource.t)} as snap\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "snapshot hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await records(c,"),
        "contained read through the query engine:\n{js}"
    );
    assert!(js.contains("count("), "aggregate:\n{js}");
    assert!(
        js.contains("$hookCtx.stage"),
        "snapshot stages atomically:\n{js}"
    );
}

/// (Outcome 12, query class.) The recorded projection shape (Locations
/// `snapshot_Location_create`): a contained `select` over child rows
/// collects into the staged snapshot input on the native runner.
#[test]
fn hook_contained_select_projection() {
    let src = "app T\nGiven\n M { t:text }\n D in M { day:text }\n N in M { days:text[] }\nWhen\n scenario snap on=M.update\n  do\n   let location=event.after\n   create N {parent=location,days=location.D as d select d.day} as snap\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "select hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await records(c,"),
        "contained read through the query engine:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.stage"),
        "snapshot stages atomically:\n{js}"
    );
}

/// (Outcome 12, query class.) The recorded contract-projection shape
/// (Locations `snapshot_Location_create`): a contained `select`
/// constructing contract values collects into the staged snapshot.
#[test]
fn hook_contained_select_contract_projection() {
    let src = "app T\nGiven\n M { t:text, active:bool }\n W in M { weekday:text, opens:text }\n contract Week { weekday:text, opens:text }\n N in M { active:bool, weeks:Week[] }\nWhen\n scenario snap on=M.update\n  do\n   let location=event.after\n   create N {parent=location,active=location.active,weeks=location.W as hours select Week {weekday=hours.weekday,opens=hours.opens}} as snap\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "contract select hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await records(c,"),
        "contained read through the query engine:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.stage"),
        "snapshot stages atomically:\n{js}"
    );
}

/// (Outcome 12, query class.) The recorded iteration shape (CanSuccess
/// `account_changed`): a bounded `for` over contained children stages
/// per-row updates plus cancel/schedule through the hook context.
#[test]
fn hook_for_loop_over_contained_children() {
    let src = "app T\nGiven\n A { t:text }\n F in A { due:datetime, done:bool }\n event Tick { s:text }\nWhen\n scenario changed on=A.update\n  do\n   for followup in event.after.F as item where not item.done limit=10\n    set followup {done=true}\n    cancel followup.id\n    schedule followup.id at=followup.due event=Tick {s=\"tick\"}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "for hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner:\n{js}"
    );
    assert!(
        js.contains("await records(c,"),
        "domain reads through the query engine:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.stage"),
        "per-row updates stage atomically:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.schedule") && js.contains("$hookCtx.cancel"),
        "timers stage through the hook context:\n{js}"
    );
}

/// (Outcome 12, out-of-scope.) Global scans stay refused in hooks: only
/// contained reads over `event.after`/`event.before` lower, so a hook
/// can never sweep a foreign model. The exact query code names it.
#[test]
fn hook_global_scan_stays_refused() {
    let src = "app T\nGiven\n M { t:text }\n N { u:text }\nWhen\n scenario h on=M.create\n  do\n   let n=count(N)\n   set event.after {t=\"x\"}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(
        diags.iter().any(|d| d.code == "E6008"
            && d.message.contains("hook query")),
        "global scan keeps its exact refusal: {}",
        codes(&diags).join("\n")
    );
    assert!(
        js.contains("has no lowering"),
        "fail-closed placeholder:\n{js}"
    );
}

/// (Outcome 12, narrowing class; Lane C.) The recorded CanSuccess
/// `account_created`/`account_changed` shape: a nullable snapshot field
/// read narrowed by `!=null` feeds a pure temporal builtin alongside a
/// chained stored-reference leaf. The narrowed read observes the same
/// declared storage, so the hook binds the native owner context (with
/// `now` on the owner clock) instead of reporting the owner-policy-plan
/// gap for every `now`, query, derive, and staged site.
#[test]
fn hook_narrowed_nullable_snapshot_read_binds_hook_context() {
    let src = "app T\nGiven\n L { tz:timezone }\n A { active:bool, renewal:date?, loc:L }\n event RenewalDue { account:A, revision:int }\n policy A read=members\n policy L read=members\nWhen\n crud A by=members fields=active,renewal\n scenario account_created on=A.create\n  do\n   if event.after.active and event.after.renewal!=null\n    let due=local_instant(event.after.renewal,\"00:00\",event.after.loc.tz,fold=earlier)\n    if due>now\n     schedule event.after.id at=due event=RenewalDue {account=event.after,revision=event.after.version}\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "narrowed hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(js.contains("c.now"), "owner clock read:\n{js}");
    assert!(
        js.contains("local_instant("),
        "narrowed date reaches the temporal builtin:\n{js}"
    );
    assert!(
        js.contains("transitive.loadReference"),
        "chained reference leaf loads through the genuine linkage:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.schedule"),
        "timer stages through the hook context:\n{js}"
    );
}

/// (Outcome 12, staged-data class; Lane C.) The recorded CanRent
/// `snapshot_Window_create`/`snapshot_Window_update` shape: a second
/// create carries a nullable contract value from a checked derive plus
/// the first create's staged sequence. Nullable contract fields write as
/// plain constructed data like their non-nullable siblings, so the hook
/// binds the native runner and pairs each staged id with its supplied
/// data instead of reporting the query/derive/staged gaps.
#[test]
fn hook_nullable_contract_create_input_stages_supplied_data() {
    let src = "app T\nGiven\n R { name:text }\n C in R { note:text }\n contract WinEv { note:text }\n ResourcePolicy in R { sequence:int, value:text }\n WindowEvidence in R { sequence:int, key:text, value:WinEv? }\n derive evidence(resource:R):text = resource.name\n derive report(child:C):WinEv = WinEv {note=child.note}\nWhen\n crud R by=members fields=name\n crud C by=members fields=note\n scenario snap on=C.create\n  do\n   let resource=event.after.parent\n   create ResourcePolicy {parent=resource,sequence=count(resource.ResourcePolicy)+1,value=evidence(resource)} as snap1\n   create WindowEvidence {parent=event.after.parent,sequence=snap1.sequence,key=event.after.id,value=report(event.after)} as ev1\nThen\n";
    let (js, diags, path) = hook_js(src);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "staged hook lowers: {diags:?}");
    assert!(
        js.contains("($candidate,$hookCtx,c)"),
        "native runner binds ambient context:\n{js}"
    );
    assert!(
        js.contains("$hookCtx.stage"),
        "snapshot stages through the hook context:\n{js}"
    );
    assert!(
        js.contains("count("),
        "contained count lowers over the query engine:\n{js}"
    );
    assert!(
        !js.contains("has no lowering"),
        "no fail-closed placeholder for the admitted shape:\n{js}"
    );
}

/// (Outcome 12, negative; Lane C.) Nullable unwrapping in the hook input
/// gate never admits stored model references: a hook create carrying a
/// stored linkage (nullable or not) stays on the legacy runner with no
/// native coverage, exactly like its non-nullable sibling.
#[test]
fn hook_nullable_stored_reference_input_stays_legacy() {
    for field in ["buddy:R", "buddy:R?"] {
        let src = format!("app T\nGiven\n R {{ name:text }}\n C in R {{ note:text }}\n Audit in R {{ note:text,{field} }}\nWhen\n crud R by=members fields=name\n crud C by=members fields=note\n scenario snap on=C.create\n  do\n   create Audit {{parent=event.after.parent,note=\"x\",buddy=event.after.parent}} as a2\nThen\n");
        let (js, diags, path) = hook_js(&src);
        let _ = std::fs::remove_file(&path);
        assert!(
            diags.iter().all(|d| d.code != "E6008"),
            "legacy linkage lowers without a gap: {}",
            codes(&diags).join("\n")
        );
        assert!(
            !js.contains("($candidate,$hookCtx,c)"),
            "stored references acquire no native coverage ({field}):\n{js}"
        );
    }
}

/// (Outcome 12, negative.) Cross-package mutation from a hook still
/// refuses at checking: hooks never acquire a foreign owner.
#[test]
fn hook_cross_package_mutation_still_barred() {
    let (catalog, path) = hook_catalog();
    let src = "app Shop\nGiven\n export Note { title:text }\nWhen\n scenario touch(n:Note) by=members\n  do\n   set n {title=\"t\"}\nThen\npackage Other\n use Shop {Note}\n Given\n  OM { t:text }\n When\n  scenario h on=OM.create\n   do\n    create Note {title=\"x\"} as n\n Then\n";
    let (_db, _program, result) = check_hook(src, &catalog);
    let _ = std::fs::remove_file(&path);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "E4001"),
        "foreign-owner bar intact: {:?}",
        result.diagnostics
    );
    let _ = sp(0, 0);
}
