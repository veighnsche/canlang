//! Desk derived-bool `unassigned` vertical slice: exact sealed
//! admission plus runtime proof (replaces the old derived-negative).
//!
//! The compiler admits ONLY the exact `desk.Ticket.unassigned`
//! derive (`row.assignee==null` over the owned stored `assignee`)
//! with a source marker bound to the checked census at emission.
//! The runtime chain drives the REAL host preparer (validated
//! bool selections become a sealed condition), the REAL UI
//! where-composer (exactly that marker becomes the guarded State
//! `derived_bool` expansion carrying the descriptor source tuple),
//! the REAL State predicate validator/tuple, and the REAL State
//! query engine over memory storage.
//!
//! Proven here: true/false/clear selections, no-filter default,
//! saved-default handling, per-row backing-field grant refusal for
//! a support+own-email caller outside `can_work` (both branches),
//! hidden-row exclusion, denied callers, pre-pagination partitions
//! and counts, forged-marker refusals at every layer, nested
//! (or/not) refusals, secret-backing-field refusal, and compiler
//! mutants (altered body, wrong field, overdue, packageless).
//! `overdue` keeps refusing: its exact seals are future work.
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn codes(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect()
}

/// Full UI pipeline: check, IR build, then JS lowering of every page render
/// node (catches factory-table and prop-admission gaps too).
fn emit_all(source: &str) -> Vec<String> {
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.to_owned());
    let (checked, check_diags) = check_program(&db, &[file], None);
    let mut out: Vec<String> = codes(&check_diags);
    if !check_diags.is_empty() {
        return out;
    }
    let (program, build_diags) = ir::build(&checked, &db, None);
    out.extend(codes(&build_diags));
    if !build_diags.is_empty() {
        return out;
    }
    for module in &program.modules {
        for page in &module.pages {
            for node in &page.render {
                let mut emitter = js::Emitter::new(&program);
                let _ = emitter.lower_ui(node);
                let (diags, _, _, _) = emitter.finish();
                out.extend(codes(&diags));
            }
        }
    }
    out
}

fn assert_lowers(source: &str) {
    let diags = emit_all(source);
    assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");
}

/// A rejected defaults profile leaves no page-gate receipt
/// (REVIEW 187): the sealed columns decode, but `defaults` names
/// an undeclared selector, so the collection does not lower and no
/// receipt may describe it. The refusal must surface at IR build
/// (after column decode), not earlier, for this to prove the fix.
#[test]
fn desk_unassigned_rejected_defaults_leave_no_receipt() {
    let source = UNASSIGNED_PROBE.replace(
        "defaults={state=preferences.state,priority=preferences.priority}",
        "defaults={bogus=preferences.state}",
    );
    assert!(source != UNASSIGNED_PROBE, "mutant must differ");
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source);
    let (checked, check_diags) = check_program(&db, &[file], None);
    assert!(
        check_diags.is_empty(),
        "mutant must pass check so the IR profile gate is exercised: {:?}",
        codes(&check_diags)
    );
    let (program, build_diags) = ir::build(&checked, &db, None);
    assert!(
        !build_diags.is_empty(),
        "rejected defaults must refuse at IR build"
    );
    assert!(
        program.derived_bool_receipts.is_empty(),
        "rejected profile must leave no derived receipt"
    );
}

fn assert_refuses(source: &str, code: &str, fragment: &str) {
    let diags = emit_all(source);
    assert!(
        diags.iter().any(|d| d.starts_with(&format!("{code}:")))
            && diags.iter().any(|d| d.contains(fragment)),
        "expected {code} containing {fragment:?}, got: {diags:?}"
    );
}

/// Lowered page-render JS for one source (panics on any diagnostic, so
/// the returned text is the admitted emission).
fn emit_js(source: &str) -> String {
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.to_owned());
    let (checked, check_diags) = check_program(&db, &[file], None);
    assert!(
        check_diags.is_empty(),
        "unexpected check diagnostics: {:?}",
        codes(&check_diags)
    );
    let (program, build_diags) = ir::build(&checked, &db, None);
    assert!(
        build_diags.is_empty(),
        "unexpected IR diagnostics: {:?}",
        codes(&build_diags)
    );
    let mut out = String::new();
    for module in &program.modules {
        for page in &module.pages {
            for node in &page.render {
                let mut emitter = js::Emitter::new(&program);
                out.push_str(&emitter.lower_ui(node));
                let (diags, _, _, _) = emitter.finish();
                assert!(
                    diags.is_empty(),
                    "unexpected lowering diagnostics: {:?}",
                    codes(&diags)
                );
            }
        }
    }
    out
}

/// Exact sealed-shape probe: package `desk` so the canonical
/// `desk.Ticket.unassigned` identity matches the real CanDesk derive;
/// any other package keeps refusing (no generic admission).
const UNASSIGNED_PROBE: &str = "app CanDesk uses=[desk]\npackage desk\n Given\n  Location { name:text }\n  Ticket { location:Location, subject:text, category:text, queue:text, priority:enum(low,normal,urgent)=normal, state:enum(open,resolved)=open, assignee:user? }\n  derive Ticket.unassigned:bool = row.assignee==null\n  policy Ticket read=public\n When\n Then\n  preferences { state:Ticket.state?, priority:Ticket.priority? }\n  page /support title=\"S\"\n   list Ticket columns=subject,queue,priority,state,assignee filter=location,state,priority,assignee,unassigned,category,queue defaults={state=preferences.state,priority=preferences.priority}\n    pagination\n";

/// The admitted unassigned triage shape lowers: the sealed
/// descriptor carries the pinned expansion and declaration source.
#[test]
fn desk_unassigned_sealed_shape_lowers() {
    assert_lowers(UNASSIGNED_PROBE);
    let lowered = emit_js(UNASSIGNED_PROBE);
    for fragment in [
        "field:\"unassigned\"",
        "type:\"derived-bool\"",
        "expansion:\"unassigned\"",
        "source:{",
    ] {
        assert!(
            lowered.contains(fragment),
            "missing sealed descriptor part {fragment:?}"
        );
    }
}

/// An altered derive body keeps the exact stored-profile refusal:
/// `!=` is not the admitted `==null` shape.
#[test]
fn desk_unassigned_altered_body_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, assignee:user? }\n  derive Ticket.unassigned:bool = row.assignee!=null\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=unassigned\n    pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A derive over a different stored field keeps refusing (here at
/// check time: non-nullable text is never null).
#[test]
fn desk_unassigned_wrong_field_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, assignee:user? }\n  derive Ticket.unassigned:bool = row.subject==null\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=unassigned\n    pagination\n",
        "E3002",
        "never null",
    );
}

/// Exact overdue probe: package `desk` so the canonical
/// `desk.Ticket.overdue` identity matches the real CanDesk derive,
/// with the exact three-conjunct body and owned state/due fields.
const OVERDUE_PROBE: &str = "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime? }\n  derive Ticket.overdue:bool = row.state!=resolved and row.due!=null and row.due<now\n  policy Ticket read=public\n When\n Then\n  preferences { state:Ticket.state? }\n  page /support title=\"S\"\n   list Ticket columns=subject,state,due filter=state,overdue defaults={state=preferences.state}\n    pagination\n";

/// The admitted overdue shape lowers: the sealed descriptor carries
/// the pinned expansion and declaration source, exactly like the
/// unassigned vertical slice.
#[test]
fn desk_overdue_sealed_shape_lowers() {
    assert_lowers(OVERDUE_PROBE);
    let lowered = emit_js(OVERDUE_PROBE);
    for fragment in [
        "field:\"overdue\"",
        "type:\"derived-bool\"",
        "expansion:\"overdue\"",
        "source:{",
    ] {
        assert!(
            lowered.contains(fragment),
            "missing sealed descriptor part {fragment:?}"
        );
    }
}

/// A dropped conjunct keeps the exact stored-profile refusal: the
/// two-remaining shape is not the admitted three-conjunct body.
#[test]
fn desk_overdue_missing_conjunct_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime? }\n  derive Ticket.overdue:bool = row.state!=resolved and row.due!=null\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=overdue\n    pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// An extra conjunct is not the exact body: admission never widens.
#[test]
fn desk_overdue_extra_conjunct_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime? }\n  derive Ticket.overdue:bool = row.state!=resolved and row.due!=null and row.due<now and row.state!=open\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=overdue\n    pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Swapped `now` sides are not the admitted comparison shape.
#[test]
fn desk_overdue_swapped_now_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime? }\n  derive Ticket.overdue:bool = row.state!=resolved and row.due!=null and now>row.due\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=overdue\n    pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// `==` on the state case is not the admitted `!=` shape.
#[test]
fn desk_overdue_state_eq_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime? }\n  derive Ticket.overdue:bool = row.state==resolved and row.due!=null and row.due<now\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=overdue\n    pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A reordered body keeps the refusal even though it names the same
/// three comparisons: the checker rejects ordering a nullable
/// `due` before the null guard narrows it, so short-circuit null
/// handling cannot silently change (here at check time).
#[test]
fn desk_overdue_reordered_body_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime? }\n  derive Ticket.overdue:bool = row.due<now and row.due!=null and row.state!=resolved\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=overdue\n    pagination\n",
        "E3002",
        "cannot order datetime? with datetime",
    );
}

/// A non-nullable `due` cannot satisfy the null-guard conjunct (here
/// at check time, like the unassigned never-null negative).
#[test]
fn desk_overdue_nonnullable_due_refuses() {
    assert_refuses(
        "app Probe uses=[desk]\npackage desk\n Given\n  Ticket { subject:text, state:enum(open,resolved)=open, due:datetime }\n  derive Ticket.overdue:bool = row.state!=resolved and row.due!=null and row.due<now\n  policy Ticket read=public\n When\n Then\n  page /support title=\"S\"\n   list Ticket columns=subject filter=overdue\n    pagination\n",
        "E3002",
        "never null",
    );
}

/// A packageless probe keeps refusing: the seal is source-bound to
/// the exact `desk` canonical identity, never to a spelling alone.
#[test]
fn desk_unassigned_packageless_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, assignee:user? }\n derive Ticket.unassigned:bool = row.assignee==null\n policy Ticket read=public\nWhen\nThen\n page /support title=\"S\"\n  list Ticket columns=subject filter=unassigned\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Scan one balanced bracket run starting at `open_at` (which must hold
/// `open_ch`), honouring quotes and backslash escapes. Fails closed on
/// any imbalance so extraction never silently truncates.
fn extract_balanced(js: &str, open_at: usize, open_ch: char, close_ch: char) -> String {
    let bytes = js.as_bytes();
    assert!(
        bytes[open_at] as char == open_ch,
        "expected {open_ch} at {open_at}"
    );
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut end = open_at;
    for (i, &b) in bytes.iter().enumerate().skip(open_at) {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == q {
                quote = None;
            }
            continue;
        }
        if b == b'"' || b == b'\'' || b == b'`' {
            quote = Some(b);
        } else if b as char == open_ch {
            depth += 1;
        } else if b as char == close_ch {
            depth -= 1;
            if depth == 0 {
                end = i;
                break;
            }
        }
        let _ = end;
    }
    assert!(depth == 0, "unbalanced {open_ch}{close_ch} from {open_at}");
    js[open_at..=end].to_string()
}

/// Pull the compiler-emitted collection profile (occurrence, `filter`
/// descriptor literal, `defaults` expression literal) out of lowered page
/// JS. Exactly one of each must exist; anything else fails the test
/// instead of guessing.
fn extract_filter_profile(js: &str) -> (String, String, String) {
    let occurrence_key = "occurrence:\"";
    let occurrence_at = js.find(occurrence_key).expect("missing occurrence");
    let name_start = occurrence_at + occurrence_key.len();
    let name_end = js[name_start..].find('"').expect("unterminated occurrence");
    let occurrence = js[name_start..name_start + name_end].to_string();

    let filter_key = "filter:[";
    assert_eq!(
        js.matches(filter_key).count(),
        1,
        "expected exactly one filter descriptor"
    );
    let filter_at = js.find(filter_key).expect("missing filter descriptor") + "filter:".len();
    let filter_src = extract_balanced(js, filter_at, '[', ']');
    assert!(
        !filter_src.contains('('),
        "filter descriptor must be pure data, got: {filter_src}"
    );

    let defaults_key = "defaults:{";
    assert_eq!(
        js.matches(defaults_key).count(),
        1,
        "expected exactly one defaults expression"
    );
    let defaults_at = js.find(defaults_key).expect("missing defaults") + "defaults:".len();
    let defaults_src = extract_balanced(js, defaults_at, '{', '}');
    for forbidden in ["=>", ";", "Function", "eval", "import", "require", "`"] {
        assert!(
            !defaults_src.contains(forbidden),
            "defaults expression must stay a pure preference read, got: {defaults_src}"
        );
    }
    (occurrence, filter_src, defaults_src)
}

/// Runtime-backed chain: the REAL compiler-emitted sealed descriptor
/// feeds the REAL host preparer (true/false/clear selections become a
/// sealed condition), the REAL UI where-composer (exactly that marker
/// becomes the guarded State `derived_bool` expansion), the REAL State
/// predicate validator and the REAL State query engine over memory
/// storage — unassigned partitions, partial-grant refusal on both
/// branches, hidden/denied rows, matched sets before page assembly,
/// serial commit fencing, forgery refusals, and nested/shape negatives.
///
/// The runner executes workspace TypeScript sources directly under bun
/// (no mocks, no dist build); the test fails loudly when bun is absent.
/// Build the exact sealed probe into a real artifact envelope
/// through the public library path (`check` -> `ir::build` ->
/// `codegen::emit` -> `artifact::to_json`) with a hermetic
/// fixture catalog (no workspace dist file needed). The gate leg consumes its
/// `derivedBoolReceipts` + `sources` + `pages`; every stage must be
/// diagnostic-free. No prebuilt binary or dist file is assumed.
fn compile_probe_artifact(scratch: &std::path::Path, source: &str, name: &str) {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    use canlang_compiler::source::Span;
    // Same db path as the in-process descriptor leg so the sealed
    // marker path matches the artifact census entry exactly.
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.to_owned());
    // Emission pins producer capabilities, so a checked catalog is
    // required. This hermetic fixture catalog (codegen.rs pattern)
    // carries exactly the builtins the sealed probe needs and no
    // workspace dist file, so the test is self-contained on a clean
    // checkout. `scratch` is already a unique tempdir per test.
    let catalog_path = scratch.join("fixture-catalog.json");
    std::fs::write(
        &catalog_path,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[]}"#,
    )
    .expect("write fixture catalog");
    let (catalog, catalog_diags) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch,
        primary: Span::new(file, 0, 0),
    });
    assert!(
        catalog_diags.is_empty(),
        "catalog load diagnostics: {catalog_diags:?}"
    );
    let catalog = catalog.expect("checked catalog failed to load");
    let (checked, check_diags) = check_program(&db, &[file], Some(&catalog));
    assert!(
        check_diags.is_empty(),
        "unexpected check diagnostics: {:?}",
        codes(&check_diags)
    );
    let mut result = DiagnosticResult::new("desk-derived-bool", "1.0", 1);
    result.add_sources(&db);
    result.finish();
    let (artifact, emit_diags) = emit(
        &checked,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(
        emit_diags.is_empty(),
        "unexpected emit diagnostics: {:?}",
        codes(&emit_diags)
    );
    std::fs::write(scratch.join(name), to_json(&artifact)).unwrap();
}

#[test]
fn desk_unassigned_chain_runtime() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let lowered = emit_js(UNASSIGNED_PROBE);
    let (occurrence, filter_src, defaults_src) = extract_filter_profile(&lowered);
    assert!(
        filter_src.contains("expansion:\"unassigned\""),
        "sealed expansion missing from descriptor"
    );
    let overdue_lowered = emit_js(OVERDUE_PROBE);
    let (overdue_occurrence, overdue_filter_src, overdue_defaults_src) =
        extract_filter_profile(&overdue_lowered);
    assert!(
        overdue_filter_src.contains("expansion:\"overdue\""),
        "sealed overdue expansion missing from descriptor"
    );
    let scratch = tempfile::tempdir().unwrap();
    compile_probe_artifact(scratch.path(), UNASSIGNED_PROBE, "artifact.json");
    compile_probe_artifact(scratch.path(), OVERDUE_PROBE, "artifact-overdue.json");

    std::fs::write(
        scratch.path().join("tsconfig.json"),
        format!(
            r#"{{"extends": "{}/tsconfig.base.json","compilerOptions": {{"baseUrl": ".","paths": {{
"@canlang/contracts": ["{0}/packages/contracts/src/index.ts"],
"@canlang/contracts/*": ["{0}/packages/contracts/src/*.ts"],
"@canlang/values": ["{0}/packages/values/src/index.ts"],
"@canlang/files": ["{0}/packages/files/src/index.ts"],
"@canlang/work-kernel": ["{0}/packages/work-kernel/src/index.ts"]}}}}"#,
            root.display()
        ),
    )
    .unwrap();
    std::fs::write(
        scratch.path().join("plan.json"),
        serde_json_like(&occurrence, &filter_src, &defaults_src),
    )
    .unwrap();
    std::fs::write(
        scratch.path().join("plan-overdue.json"),
        serde_json_like(
            &overdue_occurrence,
            &overdue_filter_src,
            &overdue_defaults_src,
        ),
    )
    .unwrap();
    std::fs::write(
        scratch.path().join("run.ts"),
        CHAIN_RUNNER
            .replace("${ROOT}", &root.display().to_string())
            .replace("{ROOT}", &root.display().to_string()),
    )
    .unwrap();

    let executed = std::process::Command::new("bun")
        .arg("run.ts")
        .current_dir(scratch.path())
        .output()
        .expect("bun must be on PATH to drive the runtime chain");
    let stdout = String::from_utf8_lossy(&executed.stdout);
    let stderr = String::from_utf8_lossy(&executed.stderr);
    assert!(
        executed.status.success() && stdout.contains("CHAIN OK"),
        "runtime chain failed\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}"
    );
    for line in [
        "preparer selections ok",
        "preparer forgery refusals ok",
        "where composition ok",
        "tuple ok",
        "engine true/false/count ok",
        "partial grant refusal ok",
        "hidden/denied ok",
        "commit fence ok",
        "nested refusal ok",
        "secret refusal ok",
        "gate ok",
        "overdue preparer ok",
        "overdue where ok",
        "overdue tuple ok",
        "overdue substitution ok",
        "overdue pinned times ok",
        "overdue engine ok",
        "overdue grants ok",
        "overdue gate ok",
        "overdue chain ok",
    ] {
        assert!(stdout.contains(line), "missing leg {line:?}\n{stdout}");
    }
}

fn serde_json_like(occurrence: &str, filter_src: &str, defaults_src: &str) -> String {
    let escape = |value: &str| {
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    };
    format!(
        "{{\"occurrence\":\"{}\",\"filterSrc\":\"{}\",\"defaultsSrc\":\"{}\"}}",
        escape(occurrence),
        escape(filter_src),
        escape(defaults_src)
    )
}

/// Source-direct runtime chain (bun, no mocks): real preparer, real UI
/// composer, real State validator, real State engine over memory storage.
/// `{ROOT}` is the workspace root, baked in at write time.
const CHAIN_RUNNER: &str = r#"import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = '{ROOT}';
const plan = JSON.parse(readFileSync('./plan.json', 'utf8'));
const { buildPresentationContext } = await import(`${ROOT}/packages/interfaces/src/http/presentation.ts`);
const { prepareSourceFilters } = await import(`${ROOT}/packages/ui/src/collections.ts`);
const { collectionFilterName } = await import(`${ROOT}/packages/contracts/src/index.ts`);
const { viewerPagePredicateTuple, queryRecords } = await import(`${ROOT}/packages/state/src/query/engine.ts`);
const { buildPolicyTable } = await import(`${ROOT}/packages/state/src/policy/grants.ts`);
const { createMemoryStorage } = await import(`${ROOT}/packages/state/src/storage/memory.ts`);
const { makeRow, makeBatch, asModel, asId } = await import(`${ROOT}/packages/state/test/invocation/fixtures.ts`);

const occurrence: string = plan.occurrence;
assert.ok(typeof occurrence === 'string' && occurrence.length > 0, 'occurrence binds the request params');
assert.ok(!(plan.filterSrc as string).includes('('), 'descriptor stays pure data');
const filter = eval(plan.filterSrc);
assert.ok(Array.isArray(filter) && filter.length === 7, 'seven admitted selectors');
const sealed = filter.find((entry: any) => entry.field === 'unassigned');
assert.ok(sealed && sealed.type === 'derived-bool' && sealed.expansion === 'unassigned', 'sealed column present');
assert.ok(sealed.source && typeof sealed.source.path === 'string' && typeof sealed.source.sha256 === 'string' &&
  sealed.source.module === 'desk' && (typeof sealed.source.node?.start === 'number' || typeof sealed.source.node?.start === 'bigint') &&
  (typeof sealed.source.node?.end === 'number' || typeof sealed.source.node?.end === 'bigint'), 'sealed source marker present');
const defaultsSrc: string = plan.defaultsSrc;
for (const forbidden of ['=>', ';', 'Function', 'eval', 'import', 'require', '`']) {
  assert.ok(!defaultsSrc.includes(forbidden), 'defaults stay a pure preference read');
}

const principal = {
  actor: { user_id: 'u-support', email: 's@example.test', email_verified: true },
  team: { team_id: 't1', timezone: 'UTC', created_at: '2026-01-01T00:00:00.000Z' },
  membership: { membership_id: 'm1', team_id: 't1', user_id: 'u-support', is_owner: false, roles: [{ role: 'support' }], status: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  binding: { kind: 'none' },
  admitted_at: '2026-10-22T00:00:00.000Z',
};
function contextFor(params: Array<[string, string, boolean?]>) {
  const sp = new URLSearchParams();
  for (const [k, v, dup] of params) { if (dup) sp.append(k, v); else sp.set(k, v); }
  const qs = sp.toString();
  const request = new Request(`https://app.invalid/s${qs === '' ? '' : `?${qs}`}`);
  return buildPresentationContext({
    request, pathname: '/s', isPartial: false, appDefaultLocale: 'en',
    csrfToken: '', principal, query: async () => { throw new Error('must not query'); },
  });
}
const pname = (field: string) => collectionFilterName(occurrence, field);

// 1. validated bool selections become the sealed condition; clear means
// no restriction; saved boolean defaults validate like the toggle;
// saved enum defaults coexist with the sealed column.
{
  const preferences = { state: 'open', priority: null };
  const defaults = new Function('preferences', `return (${defaultsSrc});`)(preferences);
  assert.deepEqual(defaults, { state: 'open', priority: null });
  const ctx = contextFor([[pname('unassigned'), 'true']]);
  const conditions = ctx.prepareCollectionFilters(occurrence, filter, defaults);
  assert.deepEqual(conditions, Object.freeze([
    Object.freeze({ field: 'state', op: 'eq', value: 'open' }),
    Object.freeze({ field: 'unassigned', op: 'eq', value: true, derivedBool: Object.freeze({ expansion: 'unassigned' }) }),
  ]));
  const cleared = contextFor([[pname('unassigned'), '']]).prepareCollectionFilters(occurrence, filter, defaults);
  assert.deepEqual(cleared, Object.freeze([
    Object.freeze({ field: 'state', op: 'eq', value: 'open' }),
  ]));
  const ctxFalse = contextFor([[pname('unassigned'), 'false']]);
  const conditionsFalse = ctxFalse.prepareCollectionFilters(occurrence, filter, defaults);
  assert.equal(conditionsFalse.length, 2);
  assert.equal(conditionsFalse[1].value, false);
  assert.ok(conditionsFalse[1].derivedBool && conditionsFalse[1].derivedBool.expansion === 'unassigned');
  console.log('preparer selections ok');
}
// 2. forged request shapes and forged descriptor markers refuse loud.
{
  const ctx = (pairs: Array<[string, string, boolean?]>) => contextFor(pairs);
  for (const q of [
    [[pname('unassigned'), 'yes']],
    [[pname('unassigned'), 'true'], [pname('unassigned'), 'false', true]],
    [[pname('nope'), 'x']],
  ]) {
    assert.throws(() => ctx(q as Array<[string, string, boolean?]>).prepareCollectionFilters(occurrence, filter, {}), /.+/);
  }
  const forgedSwap = filter.map((entry: any) => entry.field === 'unassigned'
    ? { ...entry, expansion: 'overdue' } : entry);
  assert.throws(() => ctx([]).prepareCollectionFilters(occurrence, forgedSwap, {}), /.+/);
  const forgedModule = filter.map((entry: any) => entry.field === 'unassigned'
    ? { ...entry, source: { ...entry.source, module: 'evil' } } : entry);
  assert.throws(() => ctx([]).prepareCollectionFilters(occurrence, forgedModule, {}), /.+/);
  const forgedSha = filter.map((entry: any) => entry.field === 'unassigned'
    ? { ...entry, source: { ...entry.source, sha256: '' } } : entry);
  assert.throws(() => ctx([]).prepareCollectionFilters(occurrence, forgedSha, {}), /.+/);
  console.log('preparer forgery refusals ok');
}
// 3. the UI composes exactly the guarded expansion, carrying the
// descriptor source tuple to the Cloudflare page gate.
{
  const ctx = contextFor([[pname('unassigned'), 'true']]);
  const { conditions, where } = prepareSourceFilters(
    { context: ctx, occurrence, filter, defaults: {}, where: undefined }, 'list');
  assert.equal(conditions.length, 1);
  assert.equal(where.op, 'derived_bool');
  assert.equal(where.field, 'unassigned');
  assert.equal(where.value, true);
  assert.equal(where.expansion, 'unassigned');
  assert.ok(where.source && where.source.module === 'desk', 'predicate carries descriptor source');
  assert.equal(typeof where.source.node.start, 'number', 'predicate source positions are safe numbers');
  (globalThis as any).__whereTrue = where;
  // A mismatched sealed marker at the UI boundary refuses: the
  // marker names `state` while the expansion is `unassigned`.
  const stubContext = { prepareCollectionFilters: () => [
    { field: 'state', op: 'eq', value: 'open', derivedBool: { expansion: 'unassigned' } },
  ] };
  assert.throws(() => prepareSourceFilters(
    { context: stubContext, occurrence, filter, defaults: {}, where: undefined } as any, 'list'), /.+/);
  // A non-eq condition without any sealed marker keeps refusing.
  const stubPlain = { prepareCollectionFilters: () => [
    { field: 'assignee', op: 'is_null' },
  ] };
  assert.throws(() => prepareSourceFilters(
    { context: stubPlain, occurrence, filter, defaults: {}, where: undefined } as any, 'list'), /.+/);
  console.log('where composition ok');
}
// 4. the State tuple validator admits the exact five-key shape with a
// distinct canonical tuple; any other shape refuses.
{
  const ctx = contextFor([[pname('unassigned'), 'false']]);
  const { where } = prepareSourceFilters(
    { context: ctx, occurrence, filter, defaults: {}, where: undefined }, 'list');
  const tuple = viewerPagePredicateTuple(where);
  assert.deepEqual(tuple.slice(0, 4), ['derived_bool', 'unassigned', false, 'unassigned']);
  assert.equal(tuple.length, 9);
  (globalThis as any).__whereFalse = where;
  assert.throws(() => viewerPagePredicateTuple({ op: 'derived_bool', field: 'unassigned', value: true }), /.+/);
  assert.throws(() => viewerPagePredicateTuple(
    { op: 'derived_bool', field: 'unassigned', value: true, expansion: 'overdue', source: (where as any).source }), /.+/);
  console.log('tuple ok');
}
// 5-8. the engine partitions true/false over the complete
// authorized domain (this unpaged `queryRecords` leg proves the
// matched sets; the unchanged page assembler slices, counts, and
// advances cursors from that same filtered set), refuses partial-grant
// callers on either branch,
// excludes hidden/denied rows, and fences commits.
{
  const store = createMemoryStorage();
  const model = asModel('desk.Ticket');
  const userRef = (id: string) => ({ kind: 'user', id });
  const rows = [
    makeRow({ id: asId('t1'), data: { subject: 'Wi-Fi', state: 'open', priority: 'normal', assignee: userRef('u-alice'), category: 'Connectivity', queue: 'Reception', email: 'a@example.test' } }),
    makeRow({ id: asId('t2'), data: { subject: 'Billing', state: 'resolved', priority: 'normal', assignee: null, category: 'Billing', queue: 'Reception', email: 'b@example.test' } }),
    makeRow({ id: asId('t3'), data: { subject: 'VPN', state: 'open', priority: 'urgent', assignee: userRef('u-bob'), category: 'Connectivity', queue: 'Facilities', email: 'c@example.test' } }),
    makeRow({ id: asId('t4'), data: { subject: 'Hidden', state: 'open', priority: 'normal', assignee: null, category: 'Voice', queue: 'Archive', email: 'hidden@example.test' } }),
  ];
  await store.commit(makeBatch(await store.readRevision(), { writes: rows.map((row) => ({ kind: 'insert', model, row })) }));
  // REVIEW 161: the full grant is row-dependent (stands in for
  // `support and can_work(actor,row.location)`): rows outside the
  // supported queue set match no grant and stay hidden even from
  // support. The own-email partial grant overlaps on t2 for the
  // insider and is the only grant for the outsider.
  const policy = buildPolicyTable([{
    model, secretFields: [],
    grants: [
      { by: { role: 'support' }, fields: ['subject', 'state', 'priority', 'assignee', 'category', 'queue', 'email'], when: { op: 'ne', field: 'queue', value: 'Archive' } },
      { by: 'authenticated', fields: ['subject'], when: { op: 'eq', field: 'email', value: 'b@example.test' } },
    ],
  }]);
  const memberships = {
    findMembership: async (teamId: string, userId: string) =>
      userId === 'u-support' ? { membership_id: 'm1', team_id: teamId, user_id: userId, is_owner: false, roles: [{ role: 'support' }], status: 'active' } : null,
  };
  const run = (where: any, ctx: any) => queryRecords({ policy, model, where, authority: 'viewer', context: ctx, memberships, store } as any);
  const support = { actorUserId: 'u-support', teamId: 't1' };
  const outsider = { actorUserId: 'u-out', teamId: 't1' };
  const ids = (r: any) => r.records.map((row: any) => row.id).sort();
  const whereTrue = (globalThis as any).__whereTrue;
  const whereFalse = (globalThis as any).__whereFalse;
  // Hidden row t4 has no grant for either caller.
  let r = await run(whereTrue, support);
  assert.deepEqual(ids(r), ['t2']);
  assert.equal(r.records.length, 1);
  r = await run(whereFalse, support);
  assert.deepEqual(ids(r), ['t1', 't3']);
  assert.equal(r.records.length, 2);
  console.log('engine true/false/count ok');
  // A support+own-email caller outside the role grant sees only the
  // partial row unfiltered; either derived branch refuses outright.
  r = await run(undefined, outsider);
  assert.deepEqual(ids(r), ['t2']);
  assert.deepEqual(Object.keys(r.records[0].data).sort(), ['subject']);
  await assert.rejects(run(whereTrue, outsider), /.+/);
  await assert.rejects(run(whereFalse, outsider), /.+/);
  console.log('partial grant refusal ok');
  // Denied callers see nothing, with or without the filter.
  r = await run(undefined, { actorUserId: null, teamId: 't1' });
  assert.deepEqual(ids(r), []);
  await assert.rejects(run(whereTrue, { actorUserId: null, teamId: 't1' }), /.+/);
  console.log('hidden/denied ok');
  const revBefore = await store.readRevision();
  await store.commit(makeBatch(revBefore, { writes: [{ kind: 'insert', model,
    row: makeRow({ id: asId('t5'), data: { subject: 'Phone', state: 'open', priority: 'normal', assignee: null, category: 'Voice', queue: 'Reception', email: 'd@example.test' } }) }] }));
  r = await run(whereTrue, support);
  assert.deepEqual(ids(r), ['t2', 't5']);
  assert.equal(r.revision, revBefore + 1);
  console.log('commit fence ok');
  // 9. nested positions refuse: a forged or/not around the sealed
  // expansion is not a top-level conjunction.
  await assert.rejects(run({ op: 'not', arg: whereTrue }, support), /.+/);
  await assert.rejects(run({ op: 'or', args: [whereTrue, whereFalse] }, support), /.+/);
  console.log('nested refusal ok');
  // 10. a secret backing field can never be granted at all:
  // policy construction itself refuses, so no query (derived or
  // otherwise) can read it. The State matcher keeps its own
  // secret check as defense in depth for hand-built policies.
  assert.throws(() => buildPolicyTable([{
    model, secretFields: ['assignee'],
    grants: [{ by: { role: 'support' }, fields: ['subject', 'state', 'priority', 'assignee', 'category', 'queue', 'email'] }],
  }]), /secret/);
  console.log('secret refusal ok');
}
// 11. the Cloudflare host gate admits the exact sealed read and
// refuses every forgery: occurrence file/start/route, app scope,
// paged mode, source SHA/span, duplicate receipt/census, page
// owner. The artifact below is the exact worktree-compiled
// envelope; the gate is the real host function.
{
  const { assertSealedDerivedBoolPageGate } = await import(`${ROOT}/packages/cloudflare/src/runtime/invoke.ts`);
  const gateArtifact = JSON.parse(readFileSync('./artifact.json', 'utf8'));
  const receipts = gateArtifact.derivedBoolReceipts;
  assert.ok(Array.isArray(receipts) && receipts.length === 1, 'one sealed receipt in the artifact');
  const receipt = receipts[0];
  assert.equal(receipt.pagePath, '/support');
  assert.equal(receipt.model, 'desk.Ticket');
  const gateOccurrence = `can-collection-f${receipt.file}-s${receipt.start}-` + encodeURIComponent(JSON.stringify(['/support']));
  const gateBase = {
    model: 'desk.Ticket',
    artifact: { sources: gateArtifact.sources, pages: gateArtifact.pages, derivedBoolReceipts: receipts },
    occurrence: gateOccurrence,
    scope: { app: 'CanDesk', owner: 't1', ownerPackage: 'CanDesk' },
    page: true,
  };
  const gateWhere = (globalThis as any).__whereTrue;
  assert.equal(typeof gateWhere.source.node.start, 'number', 'predicate source is normalized');
  const gateOk = (name, fn) => { fn(); console.log('gate ok', name); };
  const gateNo = (name, fn, frag) => { assert.throws(fn, frag); console.log('gate ok', name); };
  gateOk('admit exact', () => assertSealedDerivedBoolPageGate(gateBase, gateWhere));
  gateOk('admit with data conjunction', () => assertSealedDerivedBoolPageGate(gateBase,
    { op: 'and', args: [gateWhere, { op: 'eq', field: 'state', value: 'open' }] }));
  gateNo('nested or refuses placement at the gate', () => assertSealedDerivedBoolPageGate(gateBase,
    { op: 'or', args: [gateWhere] }), /predicate placement/);
  gateNo('nested not refuses placement at the gate', () => assertSealedDerivedBoolPageGate(gateBase,
    { op: 'not', arg: gateWhere }), /predicate placement/);
  gateNo('deep and-or nesting refuses placement', () => assertSealedDerivedBoolPageGate(gateBase,
    { op: 'and', args: [{ op: 'eq', field: 'state', value: 'open' }, { op: 'or', args: [gateWhere] }] }), /predicate placement/);
  gateNo('forged occurrence start', () => assertSealedDerivedBoolPageGate(
    { ...gateBase, occurrence: gateOccurrence.replace(/-s\d+-/, '-s999999-') }, gateWhere), /no unique sealed derived receipt/);
  gateNo('forged occurrence route', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    occurrence: `can-collection-f${receipt.file}-s${receipt.start}-` + encodeURIComponent(JSON.stringify(['/evil'])) }, gateWhere), /not the exact triage list/);
  gateNo('non-canonical digits', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    occurrence: `can-collection-f00-s${receipt.start}-` + encodeURIComponent(JSON.stringify(['/support'])) }, gateWhere), /not canonical/);
  gateNo('alternate route encoding', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    occurrence: `can-collection-f${receipt.file}-s${receipt.start}-` + encodeURIComponent(JSON.stringify(['/support'])).replace('%2F', '/') }, gateWhere), /route encoding is not canonical/);
  gateNo('nested route elements', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    occurrence: `can-collection-f${receipt.file}-s${receipt.start}-` + encodeURIComponent(JSON.stringify(['/support', 'x'])) }, gateWhere), /not the exact triage list/);
  gateNo('wrong model', () => assertSealedDerivedBoolPageGate({ ...gateBase, model: 'desk.Other' }, gateWhere), /exact desk.Ticket/);
  gateNo('wrong app scope', () => assertSealedDerivedBoolPageGate(
    { ...gateBase, scope: { app: 'Evil', owner: 't1', ownerPackage: 'Evil' } }, gateWhere), /installed CanDesk/);
  gateNo('desk ownerPackage is not the app', () => assertSealedDerivedBoolPageGate(
    { ...gateBase, scope: { app: 'CanDesk', owner: 't1', ownerPackage: 'desk' } }, gateWhere), /installed CanDesk/);
  gateNo('unpaged read', () => assertSealedDerivedBoolPageGate({ ...gateBase, page: false }, gateWhere), /paginated/);
  gateNo('swapped sha', () => assertSealedDerivedBoolPageGate(gateBase,
    { ...gateWhere, source: { ...gateWhere.source, sha256: '0'.repeat(64) } }), /does not match/);
  gateNo('altered nodeStart', () => assertSealedDerivedBoolPageGate(gateBase,
    { ...gateWhere, source: { ...gateWhere.source, node: { start: gateWhere.source.node.start + 1, end: gateWhere.source.node.end } } }), /does not match/);
  gateNo('swapped expansion', () => assertSealedDerivedBoolPageGate(gateBase,
    { ...gateWhere, expansion: 'overdue' }), /predicate identity/);
  gateNo('nested forged or refuses placement first', () => assertSealedDerivedBoolPageGate(gateBase,
    { op: 'or', args: [{ ...gateWhere, source: { ...gateWhere.source, sha256: '0'.repeat(64) } }] }), /predicate placement/);
  gateNo('missing census', () => assertSealedDerivedBoolPageGate(
    { ...gateBase, artifact: { ...gateBase.artifact, sources: [] } }, gateWhere), /exactly one artifact census/);
  gateNo('duplicate census', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    artifact: { ...gateBase.artifact, sources: [...gateBase.artifact.sources, ...gateBase.artifact.sources] } }, gateWhere), /exactly one artifact census/);
  gateNo('duplicate receipt', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    artifact: { ...gateBase.artifact, derivedBoolReceipts: [receipt, receipt] } }, gateWhere), /no unique sealed/);
  gateNo('page owner mismatch', () => assertSealedDerivedBoolPageGate({ ...gateBase,
    artifact: { ...gateBase.artifact, pages: [{ owner: 'evil', path: '/support' }] } }, gateWhere), /uniquely the desk/);
  console.log('gate ok');
}
// 12. the overdue vertical slice end to end: sealed descriptor,
// validated selections, sentinel-carrying translation, host time
// substitution, guarded engine evaluation, and host gate.
{
  const plan2 = JSON.parse(readFileSync('./plan-overdue.json', 'utf8'));
  const occurrence2 = plan2.occurrence;
  const filter2 = eval(plan2.filterSrc);
  assert.ok(Array.isArray(filter2) && filter2.length === 2, 'two admitted overdue selectors');
  const sealed2 = filter2.find((entry) => entry.field === 'overdue');
  assert.ok(sealed2 && sealed2.type === 'derived-bool' && sealed2.expansion === 'overdue', 'sealed overdue column present');
  assert.ok(sealed2.source && sealed2.source.module === 'desk' && (typeof sealed2.source.node?.start === 'number' || typeof sealed2.source.node?.start === 'bigint') &&
    (typeof sealed2.source.node?.end === 'number' || typeof sealed2.source.node?.end === 'bigint'), 'sealed overdue source marker present');
  const { makeDatetime, encodeValue } = await import(`${ROOT}/packages/values/src/index.ts`);
  const { StateError } = await import(`${ROOT}/packages/state/src/errors.ts`);
  const { assertSealedDerivedBoolPageGate, resolveDerivedBoolNow } =
    await import(`${ROOT}/packages/cloudflare/src/runtime/invoke.ts`);
  const T0 = Date.parse('2026-06-01T00:00:00.000Z');
  const instant = (ms) => makeDatetime(BigInt(ms));
  const pname2 = (field) => collectionFilterName(occurrence2, field);
  // 12a. validated bool selections become the sealed overdue
  // condition; clear means no restriction; saved enum defaults
  // coexist with the sealed column.
  const ctx2 = (params) => contextFor(params.map(([k, v]) => [pname2(k), v]));
  const condTrue = ctx2([[ 'overdue', 'true' ]]).prepareCollectionFilters(occurrence2, filter2, {});
  assert.deepEqual(condTrue, Object.freeze([
    Object.freeze({ field: 'overdue', op: 'eq', value: true, derivedBool: Object.freeze({ expansion: 'overdue' }) }),
  ]));
  const condClear = ctx2([]).prepareCollectionFilters(occurrence2, filter2, {});
  assert.deepEqual(condClear, Object.freeze([]));
  const forgedMarker = filter2.map((entry) => entry.field === 'overdue'
    ? { ...entry, expansion: 'unassigned' } : entry);
  assert.throws(() => ctx2([['overdue', 'true']]).prepareCollectionFilters(occurrence2, forgedMarker, {}), /.+/);
  console.log('overdue preparer ok');
  // 12b. the UI translation carries the sentinel trusted instant,
  // never a caller clock; mismatched markers and plain null tests
  // refuse.
  const { where: whereOverTrue } = prepareSourceFilters(
    { context: ctx2([['overdue', 'true']]), occurrence: occurrence2, filter: filter2, defaults: {}, where: undefined }, 'list');
  assert.equal(whereOverTrue.op, 'derived_bool');
  assert.equal(whereOverTrue.field, 'overdue');
  assert.equal(whereOverTrue.value, true);
  assert.equal(whereOverTrue.expansion, 'overdue');
  assert.deepEqual(whereOverTrue.time, { kind: 'page-query-now' });
  assert.ok(Object.isFrozen(whereOverTrue.time), 'sentinel frozen at the adapter boundary');
  const stubOverdueMismatch = { prepareCollectionFilters: () => [
    { field: 'overdue', op: 'eq', value: true, derivedBool: { expansion: 'unassigned' } },
  ] };
  assert.throws(() => prepareSourceFilters(
    { context: stubOverdueMismatch, occurrence: occurrence2, filter: filter2, defaults: {}, where: undefined }, 'list'), /.+/);
  const stubOverduePlain = { prepareCollectionFilters: () => [
    { field: 'due', op: 'not_null' },
  ] };
  assert.throws(() => prepareSourceFilters(
    { context: stubOverduePlain, occurrence: occurrence2, filter: filter2, defaults: {}, where: undefined }, 'list'), /.+/);
  console.log('overdue where ok');
  // 12c. the sentinel never validates as a State tuple; the
  // host-substituted concrete instant validates with its
  // millisecond tail bound for the page digest.
  assert.throws(() => viewerPagePredicateTuple(whereOverTrue), /trusted host instant/);
  const concreteTrue = { ...whereOverTrue, time: instant(T0) };
  const tupleOver = viewerPagePredicateTuple(concreteTrue);
  assert.deepEqual(tupleOver.slice(0, 4), ['derived_bool', 'overdue', true, 'overdue']);
  assert.equal(tupleOver.length, 10);
  assert.equal(tupleOver[9], T0);
  assert.throws(() => viewerPagePredicateTuple({ ...concreteTrue, time: T0 }), /trusted host instant/);
  assert.throws(() => viewerPagePredicateTuple({ ...concreteTrue, time: 'tomorrow' }), /trusted host instant/);
  assert.throws(() => viewerPagePredicateTuple({ ...concreteTrue, time: { kind: 'page-query-now', extra: 1 } }), /trusted host instant/);
  // A smuggled clock on the unassigned route refuses at the tuple.
  const smuggled = { ...(globalThis).__whereTrue, time: instant(T0) };
  assert.throws(() => viewerPagePredicateTuple(smuggled), /.+/);
  console.log('overdue tuple ok');
  // 12d. host substitution maps exactly the sentinel to the
  // cursor-pinned instant, leaves unassigned alone, and refuses
  // forgeries even if the gate were bypassed.
  const subbed = resolveDerivedBoolNow(whereOverTrue, T0, StateError);
  assert.deepEqual(subbed.time, instant(T0));
  const subbedAnd = resolveDerivedBoolNow({ op: 'and', args: [whereOverTrue, { op: 'eq', field: 'state', value: 'open' }] }, T0, StateError);
  assert.deepEqual(subbedAnd.args[0].time, instant(T0));
  assert.deepEqual(resolveDerivedBoolNow((globalThis).__whereTrue, T0, StateError), (globalThis).__whereTrue);
  assert.throws(() => resolveDerivedBoolNow({ ...whereOverTrue, time: instant(T0) }, T0, StateError), /trusted host instant/);
  assert.throws(() => resolveDerivedBoolNow({ ...whereOverTrue, time: { kind: 'other' } }, T0, StateError), /trusted host instant/);
  console.log('overdue substitution ok');
  // 12d2. the full sentinel -> host resolver -> State path at two
  // distinct pinned times: the substituted predicate (never a
  // hand-built clock) validates and evaluates under each instant.
  const T1 = Date.parse('2020-06-01T00:00:00.000Z');
  const subT0 = resolveDerivedBoolNow(whereOverTrue, T0, StateError);
  const subT1 = resolveDerivedBoolNow(whereOverTrue, T1, StateError);
  assert.equal(viewerPagePredicateTuple(subT0)[9], T0);
  assert.equal(viewerPagePredicateTuple(subT1)[9], T1);
  console.log('overdue pinned times ok');
  // 12e. engine partitions true/false over the complete authorized
  // domain: past-due open rows only; resolved, null-due, future-due
  // and exactly-at-now rows are not overdue.
  // Persisted datetime wire (RFC 3339 millis), exactly what
  // production storage stringifies: memory storage JSON-copies on
  // commit, so native DatetimeValues cannot seed rows.
  const wire = (ms) => encodeValue('datetime', instant(ms));
  const past = wire(Date.parse('2020-01-01T00:00:00.000Z'));
  const future = wire(Date.parse('2030-01-01T00:00:00.000Z'));
  const store2 = createMemoryStorage();
  const model2 = asModel('desk.Ticket');
  const tref = (id) => ({ kind: 'user', id });
  const rows2 = [
    makeRow({ id: asId('o1'), data: { subject: 'Old', state: 'open', due: past, assignee: tref('u-a'), email: 'a@example.test' } }),
    makeRow({ id: asId('o2'), data: { subject: 'Soon', state: 'open', due: future, assignee: null, email: 'b@example.test' } }),
    makeRow({ id: asId('o3'), data: { subject: 'Unsched', state: 'open', due: null, assignee: null, email: 'c@example.test' } }),
    makeRow({ id: asId('o4'), data: { subject: 'Done', state: 'resolved', due: past, assignee: null, email: 'd@example.test' } }),
    makeRow({ id: asId('o5'), data: { subject: 'Edge', state: 'open', due: wire(T0), assignee: null, email: 'e@example.test' } }),
    makeRow({ id: asId('o6'), data: { subject: 'Mid', state: 'open', due: wire(Date.parse('2021-01-01T00:00:00.000Z')), assignee: null, email: 'f@example.test' } }),
    makeRow({ id: asId('h1'), data: { subject: 'Hidden', state: 'open', due: past, assignee: null, email: 'hidden@example.test' } }),
  ];
  await store2.commit(makeBatch(await store2.readRevision(), { writes: rows2.map((row) => ({ kind: 'insert', model: model2, row })) }));
  const store3 = createMemoryStorage();
  await store3.commit(makeBatch(await store3.readRevision(), { writes: [{ kind: 'insert', model: model2, row: makeRow({ id: asId('x1'), data: { subject: 'Corrupt', state: 'open', due: 'tomorrow-ish' } }) }] }));
  const run3 = (w, ctx) => queryRecords({ policy: policy2, model: model2, where: w, authority: 'viewer', context: ctx, memberships: memberships2, store: store3 });
  const policy2 = buildPolicyTable([{
    model: model2, secretFields: [],
    grants: [
      { by: { role: 'support' }, fields: ['subject', 'state', 'due', 'assignee', 'email'], when: { op: 'ne', field: 'subject', value: 'Hidden' } },
      { by: 'authenticated', fields: ['subject'], when: { op: 'eq', field: 'email', value: 'a@example.test' } },
    ],
  }]);
  const memberships2 = {
    findMembership: async (teamId, userId) =>
      userId === 'u-support' ? { membership_id: 'm1', team_id: teamId, user_id: userId, is_owner: false, roles: [{ role: 'support' }], status: 'active' } : null,
  };
  const run2 = (w, ctx) => queryRecords({ policy: policy2, model: model2, where: w, authority: 'viewer', context: ctx, memberships: memberships2, store: store2 });
  const support2 = { actorUserId: 'u-support', teamId: 't1' };
  const outsider2 = { actorUserId: 'u-out', teamId: 't1' };
  const ids2 = (r) => r.records.map((row) => row.id).sort();
  const whereOverFalse = { ...subT0, value: false };
  // The engine evaluates the host-substituted predicate, never a
  // hand-built clock: T0 marks o1+o6 overdue, while the earlier T1
  // marks only o1 (o6 due 2021 lies past T1).
  let r2 = await run2(subT0, support2);
  assert.deepEqual(ids2(r2), ['o1', 'o6']);
  r2 = await run2(whereOverFalse, support2);
  assert.deepEqual(ids2(r2), ['o2', 'o3', 'o4', 'o5']);
  assert.equal(r2.records.length, 4);
  const subT1False = { ...subT1, value: false };
  r2 = await run2(subT1, support2);
  assert.deepEqual(ids2(r2), ['o1']);
  r2 = await run2(subT1False, support2);
  assert.deepEqual(ids2(r2), ['o2', 'o3', 'o4', 'o5', 'o6']);
  console.log('overdue engine ok');
  // Partial grants and hidden/denied rows refuse on either branch;
  // the hidden past-due row never leaks into the true set.
  r2 = await run2(undefined, outsider2);
  assert.deepEqual(ids2(r2), ['o1']);
  await assert.rejects(run2(subT0, outsider2), /.+/);
  await assert.rejects(run2(whereOverFalse, outsider2), /.+/);
  await assert.rejects(run2(subT0, { actorUserId: null, teamId: 't1' }), /.+/);
  const noDuePolicy = buildPolicyTable([{
    model: model2, secretFields: [],
    grants: [{ by: { role: 'support' }, fields: ['subject', 'state', 'assignee'] }],
  }]);
  const runNoDue = (w, ctx) => queryRecords({ policy: noDuePolicy, model: model2, where: w, authority: 'viewer', context: ctx, memberships: memberships2, store: store2 });
  await assert.rejects(runNoDue(subT0, support2), /.+/);
  await assert.rejects(runNoDue(whereOverFalse, support2), /.+/);
  const noStatePolicy = buildPolicyTable([{
    model: model2, secretFields: [],
    grants: [{ by: { role: 'support' }, fields: ['subject', 'due', 'assignee'] }],
  }]);
  const runNoState = (w, ctx) => queryRecords({ policy: noStatePolicy, model: model2, where: w, authority: 'viewer', context: ctx, memberships: memberships2, store: store2 });
  await assert.rejects(runNoState(subT0, support2), /.+/);
  await assert.rejects(runNoState(whereOverFalse, support2), /.+/);
  assert.throws(() => buildPolicyTable([{
    model: model2, secretFields: ['due'],
    grants: [{ by: { role: 'support' }, fields: ['subject', 'state', 'due'] }],
  }]), /secret/);
  assert.throws(() => buildPolicyTable([{
    model: model2, secretFields: ['state'],
    grants: [{ by: { role: 'support' }, fields: ['subject', 'state', 'due'] }],
  }]), /secret/);
  // Forged clocks never evaluate, on either branch.
  for (const bad of [undefined, T0, 'tomorrow', { kind: 'page-query-now' }, { kind: 'page-query-now', extra: 1 }, null]) {
    await assert.rejects(run2({ ...subT0, time: bad }, support2), /.+/);
    await assert.rejects(run2({ ...whereOverFalse, time: bad }, support2), /.+/);
  }
  // A corrupt persisted due refuses on either branch, never classified.
  await assert.rejects(run3(subT0, support2), /.+/);
  // Unsupported nesting refuses before any scan: direct
  // children of top-level and are the only composed form.
  await assert.rejects(run2({ op: 'or', args: [subT0] }, support2), /conjunction/);
  await assert.rejects(run2({ op: 'not', arg: subT0 }, support2), /conjunction/);
  await assert.rejects(run2({ op: 'and', args: [{ op: 'eq', field: 'state', value: 'open' }, { op: 'or', args: [subT0] }] }, support2), /conjunction/);
  // Empty domains never reach the per-row matcher, so the
  // pre-scan placement rule must refuse nested or/not there too.
  const store4 = createMemoryStorage();
  const run4 = (w, ctx) => queryRecords({ policy: policy2, model: model2, where: w, authority: 'viewer', context: ctx, memberships: memberships2, store: store4 });
  r2 = await run4(subT0, support2);
  assert.deepEqual(ids2(r2), []);
  await assert.rejects(run4({ op: 'or', args: [subT0] }, support2), /conjunction/);
  await assert.rejects(run4({ op: 'not', arg: subT0 }, support2), /conjunction/);
  await assert.rejects(run3({ ...subT0, value: false }, support2), /.+/);
  console.log('overdue grants ok');
  // 12f. the Cloudflare gate admits the sentinel-bound read and
  // refuses forged clocks, swapped selectors, and census attacks.
  const gateArtifact2 = JSON.parse(readFileSync('./artifact-overdue.json', 'utf8'));
  const receipts2 = gateArtifact2.derivedBoolReceipts;
  assert.ok(Array.isArray(receipts2) && receipts2.length === 1, 'one sealed overdue receipt');
  const receipt2 = receipts2[0];
  assert.equal(receipt2.pagePath, '/support');
  assert.equal(receipt2.model, 'desk.Ticket');
  assert.equal(receipts2[0].columns[0].field, 'overdue');
  const gateOccurrence2 = `can-collection-f${receipt2.file}-s${receipt2.start}-` + encodeURIComponent(JSON.stringify(['/support']));
  const gateBase2 = {
    model: 'desk.Ticket',
    artifact: { sources: gateArtifact2.sources, pages: gateArtifact2.pages, derivedBoolReceipts: receipts2 },
    occurrence: gateOccurrence2,
    scope: { app: 'CanDesk', owner: 't1', ownerPackage: 'CanDesk' },
    page: true,
  };
  const gateOk2 = (name, fn) => { fn(); console.log('overdue gate ok', name); };
  const gateNo2 = (name, fn, frag) => { assert.throws(fn, frag); console.log('overdue gate ok', name); };
  gateOk2('admit sentinel', () => assertSealedDerivedBoolPageGate(gateBase2, whereOverTrue));
  gateOk2('admit with conjunction', () => assertSealedDerivedBoolPageGate(gateBase2,
    { op: 'and', args: [whereOverTrue, { op: 'eq', field: 'state', value: 'open' }] }));
  gateNo2('concrete instant forges clock', () => assertSealedDerivedBoolPageGate(gateBase2, concreteTrue), /time carrier/);
  gateNo2('altered sentinel', () => assertSealedDerivedBoolPageGate(gateBase2,
    { ...whereOverTrue, time: { kind: 'page-query-now', extra: 1 } }), /time carrier/);
  gateNo2('wrong sentinel kind', () => assertSealedDerivedBoolPageGate(gateBase2,
    { ...whereOverTrue, time: { kind: 'other' } }), /time carrier/);
  gateNo2('missing time', () => assertSealedDerivedBoolPageGate(gateBase2,
    (({ time, ...rest }) => rest)(whereOverTrue)), /time carrier/);
  gateNo2('nested or refuses placement', () => assertSealedDerivedBoolPageGate(gateBase2,
    { op: 'or', args: [whereOverTrue] }), /predicate placement/);
  gateNo2('nested not refuses placement', () => assertSealedDerivedBoolPageGate(gateBase2,
    { op: 'not', arg: whereOverTrue }), /predicate placement/);
  gateNo2('deep and-or nesting refuses placement', () => assertSealedDerivedBoolPageGate(gateBase2,
    { op: 'and', args: [{ op: 'eq', field: 'state', value: 'open' }, { op: 'or', args: [whereOverTrue] }] }), /predicate placement/);
  gateNo2('unassigned predicate has no overdue column', () => assertSealedDerivedBoolPageGate(gateBase2,
    (globalThis).__whereTrue), /does not match/);
  const gateArtifact1 = JSON.parse(readFileSync('./artifact.json', 'utf8'));
  gateNo2('overdue predicate against unassigned-only artifact', () => assertSealedDerivedBoolPageGate({
    model: 'desk.Ticket',
    artifact: { sources: gateArtifact1.sources, pages: gateArtifact1.pages, derivedBoolReceipts: gateArtifact1.derivedBoolReceipts },
    occurrence: gateOccurrence2,
    scope: { app: 'CanDesk', owner: 't1', ownerPackage: 'CanDesk' },
    page: true }, whereOverTrue), /no unique sealed/);
  gateNo2('swapped sha', () => assertSealedDerivedBoolPageGate(gateBase2,
    { ...whereOverTrue, source: { ...whereOverTrue.source, sha256: '0'.repeat(64) } }), /does not match/);
  console.log('overdue gate ok');
  console.log('overdue chain ok');
}
console.log('CHAIN OK');
"#;
