//! Lane E: exact checked Desk filter profile.
//!
//! The Desk triage list filters on stored finite-choice fields
//! (`location`, `state`, `priority`), a nullable-user reference
//! (`assignee`) and plain text (`category`, `queue`), with enum defaults
//! behind saved preference reads. Derived-bool selectors (`unassigned`,
//! `overdue`) keep refusing: derived values are absent from stored rows
//! and State projections, so a State `eq` on one resolves missing and
//! matches nothing (proved by `desk_filter_chain_runtime` below) —
//! admitting them at the compiler gate alone would render a filter that
//! silently returns zero rows. Sound derived-bool execution needs
//! post-serve derived-cell evaluation in the Cloudflare page path with
//! pagination/count consequences, which is a broader interface change
//! proposed to the coordinator instead of made here.
//!
//! Pipeline legs are catalog-free (check -> IR build -> per-page JS UI
//! lowering in process). The runtime leg drives the REAL filter chain
//! source-direct under bun: the compiler-emitted descriptor feeds the
//! real host preparer, the real UI where-composer, the real State
//! predicate validator and the real State query engine over real memory
//! storage (no dist build; only the identity/row test data is hand-built
//! at the seams, never the chain units).
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
    let file = db.add("probe.can".into(), source.into());
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
    let file = db.add("probe.can".into(), source.into());
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

/// Recorded CanDesk triage shape (stored selectors only): enum + reference
/// + text filters with matching owned preference defaults lower.
#[test]
fn desk_stored_selectors_with_matching_defaults_lower() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Ticket { location:Location, subject:text, category:text, queue:text, priority:enum(low,normal,urgent)=normal, state:enum(open,resolved)=open }\n policy Ticket read=public\nWhen\nThen\n preferences { state:Ticket.state?, priority:Ticket.priority? }\n page /s title=\"S\"\n  list Ticket columns=subject,queue,priority,state filter=location,state,priority,category,queue defaults={state=preferences.state,priority=preferences.priority}\n   pagination\n",
    );
}

/// A nullable-user selector lowers beside the stored selectors. The
/// descriptor carries the opaque `user` type with no case inventory
/// (cleared means no restriction), exactly like a non-nullable `user`.
#[test]
fn desk_nullable_user_assignee_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Ticket { location:Location, subject:text, category:text, queue:text, priority:enum(low,normal,urgent)=normal, state:enum(open,resolved)=open, assignee:user? }\n policy Ticket read=public\nWhen\nThen\n preferences { state:Ticket.state?, priority:Ticket.priority? }\n page /s title=\"S\"\n  list Ticket columns=subject,queue,priority,state,assignee filter=location,state,priority,assignee,category,queue defaults={state=preferences.state,priority=preferences.priority}\n   pagination\n",
    );
}

/// The admitted triage descriptor names each selector kind: model
/// references as `ref:<target>`, enums as `enum:<owner>.<field>`, the
/// nullable user as opaque `user`, text as `text` — references and text
/// with empty value labels, enums with their case spellings.
#[test]
fn desk_admitted_triage_filter_descriptor_shapes() {
    let js = emit_js(TRIAGE_PROBE);
    for (field, ty) in [
        ("location", "ref:Probe.Location"),
        ("state", "enum:Probe.Ticket.state"),
        ("priority", "enum:Probe.Ticket.priority"),
        ("assignee", "user"),
        ("category", "text"),
        ("queue", "text"),
    ] {
        assert!(
            js.contains(&format!("field:\"{field}\"")) && js.contains(&format!("type:\"{ty}\"")),
            "missing descriptor for {field} as {ty}, got: {js}"
        );
    }
}

/// A derived-bool selector keeps refusing: derives are not owned stored
/// fields, and no execution path evaluates them in State `where`
/// (see `desk_filter_chain_runtime`).
#[test]
fn desk_derived_bool_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, assignee:user? }\n derive Ticket.unassigned:bool = row.assignee==null\n policy Ticket read=public\nWhen\nThen\n page /s title=\"S\"\n  list Ticket columns=subject filter=unassigned\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// The full eight-selector Desk shape refuses while the derived selectors
/// stay admitted-nowhere: no silent partial profile.
#[test]
fn desk_full_shape_with_derived_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Ticket { location:Location, subject:text, category:text, queue:text, priority:enum(low,normal,urgent)=normal, state:enum(open,resolved)=open, assignee:user?, due:datetime? }\n derive Ticket.overdue:bool = row.state!=resolved and row.due!=null\n derive Ticket.unassigned:bool = row.assignee==null\n policy Ticket read=public\nWhen\nThen\n preferences { state:Ticket.state?, priority:Ticket.priority? }\n page /s title=\"S\"\n  list Ticket columns=subject,queue,priority,state,assignee,overdue filter=location,state,priority,assignee,unassigned,overdue,category,queue defaults={state=preferences.state,priority=preferences.priority}\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Duplicate selectors keep refusing.
#[test]
fn desk_duplicate_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, state:enum(open,resolved)=open, assignee:user? }\n policy Ticket read=public\nWhen\nThen\n preferences { state:Ticket.state? }\n page /s title=\"S\"\n  list Ticket columns=subject filter=state,assignee,assignee defaults={state=preferences.state}\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A default for an undeclared control keeps refusing.
#[test]
fn desk_undeclared_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, state:enum(open,resolved)=open, assignee:user? }\n policy Ticket read=public\nWhen\nThen\n preferences { state:Ticket.state? }\n page /s title=\"S\"\n  list Ticket columns=subject filter=state,assignee defaults={state=preferences.state,priority=preferences.state}\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A non-bool derive keeps refusing as a filter selector.
#[test]
fn desk_non_bool_derive_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, state:enum(open,resolved)=open }\n derive Ticket.owner_label:text = \"x\"\n policy Ticket read=public\nWhen\nThen\n page /s title=\"S\"\n  list Ticket columns=subject filter=owner_label\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A nullable member selector keeps refusing: Lane E admits only the
/// nullable stored `user?` shape — no symmetry generalization to
/// nullable `member`, nullable enums, or any other nullable shape.
#[test]
fn desk_nullable_member_still_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, handler:member? }\n policy Ticket read=public\nWhen\nThen\n page /s title=\"S\"\n  list Ticket columns=subject filter=handler\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A nullable-bool stored field keeps refusing: only plain bool toggles
/// lower (recorded `active`/`done` profile, unchanged by Lane E).
#[test]
fn desk_nullable_bool_still_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, active:bool? }\n policy Ticket read=public\nWhen\nThen\n page /s title=\"S\"\n  list Ticket columns=subject filter=active\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A user-typed default keeps refusing: reference filters admit only a
/// direct saved read or null, and no literal user spelling exists. The
/// recorded Desk profile carries no `assignee` default.
#[test]
fn desk_user_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { subject:text, assignee:user? }\n policy Ticket read=public\nWhen\nThen\n preferences { handler:user? }\n page /s title=\"S\"\n  list Ticket columns=subject filter=assignee defaults={assignee=preferences.handler}\n   pagination\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded Desk-like triage probe shared by the descriptor test and the
/// runtime chain below (label-free so the emitted descriptor is pure
/// data; labels are display-only and travel the same descriptor path).
const TRIAGE_PROBE: &str = "app Probe\nGiven\n Location { name:text }\n Ticket { location:Location, subject:text, category:text, queue:text, priority:enum(low,normal,urgent)=normal, state:enum(open,resolved)=open, assignee:user? }\n policy Ticket read=public\nWhen\nThen\n preferences { state:Ticket.state?, priority:Ticket.priority? }\n page /s title=\"S\"\n  list Ticket columns=subject,queue,priority,state,assignee filter=location,state,priority,assignee,category,queue defaults={state=preferences.state,priority=preferences.priority}\n   pagination\n";

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

/// Runtime-backed chain: the REAL compiler-emitted descriptor feeds the
/// REAL host preparer, the REAL UI where-composer, the REAL State
/// predicate validator and the REAL State query engine over memory
/// storage — selected-user filtering, stored-selector filtering, hidden
/// rows, denied authority, serial commit fencing, forgery refusals, and
/// the derived-negative that keeps derived-bool refused.
///
/// The runner executes workspace TypeScript sources directly under bun
/// (no mocks, no dist build); the test fails loudly when bun is absent.
#[test]
fn desk_filter_chain_runtime() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let js = emit_js(TRIAGE_PROBE);
    let (occurrence, filter_src, defaults_src) = extract_filter_profile(&js);
    let scratch = tempfile::tempdir().unwrap();

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
        "where composition ok",
        "forgery refusals ok",
        "engine match/hidden ok",
        "commit fence ok",
        "derived-negative ok",
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
const { evalPredicateForRow, buildPolicyTable } = await import(`${ROOT}/packages/state/src/policy/grants.ts`);
const { createMemoryStorage } = await import(`${ROOT}/packages/state/src/storage/memory.ts`);
const { makeRow, makeBatch, asModel, asId } = await import(`${ROOT}/packages/state/test/invocation/fixtures.ts`);

const occurrence: string = plan.occurrence;
assert.ok(typeof occurrence === 'string' && occurrence.length > 0, 'occurrence binds the request params');
assert.ok(!(plan.filterSrc as string).includes('('), 'descriptor stays pure data');
const filter = eval(plan.filterSrc);
assert.ok(Array.isArray(filter) && filter.length === 6, 'six admitted selectors');
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

// 1. saved defaults plus URL selections become exact eq conditions: the
// nullable-user selection travels as an opaque `{id}` identity.
{
  const preferences = { state: 'open', priority: null };
  const defaults = new Function('preferences', `return (${defaultsSrc});`)(preferences);
  assert.deepEqual(defaults, { state: 'open', priority: null });
  const ctx = contextFor([[pname('assignee'), 'u-alice'], [pname('category'), 'Connectivity']]);
  const conditions = ctx.prepareCollectionFilters(occurrence, filter, defaults);
  assert.deepEqual(conditions, Object.freeze([
    Object.freeze({ field: 'state', op: 'eq', value: 'open' }),
    Object.freeze({ field: 'assignee', op: 'eq', value: Object.freeze({ id: 'u-alice' }) }),
    Object.freeze({ field: 'category', op: 'eq', value: 'Connectivity' }),
  ]));
  console.log('preparer selections ok');
}
// 2. the UI composes controls with the data where; the validator maps the
// opaque identity to a `ref` tuple the engine compares by target id only.
{
  const preferences = { state: null, priority: 'urgent' };
  const defaults = new Function('preferences', `return (${defaultsSrc});`)(preferences);
  const ctx = contextFor([[pname('assignee'), 'u-alice']]);
  const { conditions, where } = prepareSourceFilters(
    { context: ctx, occurrence, filter, defaults, where: undefined }, 'list');
  assert.equal(conditions.length, 2);
  assert.deepEqual(where, { op: 'and', args: [
    { op: 'eq', field: 'priority', value: 'urgent' },
    { op: 'eq', field: 'assignee', value: { id: 'u-alice' } },
  ]});
  const tuple = viewerPagePredicateTuple(where);
  assert.deepEqual(tuple, ['and', [['eq', 'priority', 'urgent'], ['eq', 'assignee', ['ref', 'u-alice']]]]);
  console.log('where composition ok');
}
// 3. forged request shapes refuse loud; clearing the user control is the
// only empty selection and means no restriction.
{
  const ctx = (pairs: Array<[string, string, boolean?]>) => contextFor(pairs);
  const prefs = {};
  for (const q of [
    [[pname('state'), 'bogus']],
    [[pname('nope'), 'x']],
    [['filter[state]', 'open']],
    [[pname('state'), 'open'], [pname('state'), 'resolved', true]],
  ]) {
    assert.throws(() => ctx(q as Array<[string, string, boolean?]>).prepareCollectionFilters(occurrence, filter, prefs), /.+/);
  }
  const cleared = ctx([[pname('assignee'), '']]).prepareCollectionFilters(occurrence, filter, prefs);
  assert.deepEqual(cleared, Object.freeze([]));
  console.log('forgery refusals ok');
}
// 4. the engine filters over memory storage: selected-user match only
// (unassigned rows excluded), hidden rows excluded, denied callers empty,
// and every read reports its fence revision.
{
  const store = createMemoryStorage();
  const model = asModel('Probe.Ticket');
  const userRef = (id: string) => ({ kind: 'user', id });
  const rows = [
    makeRow({ id: asId('t1'), data: { subject: 'Wi-Fi', state: 'open', priority: 'normal', assignee: userRef('u-alice'), category: 'Connectivity', queue: 'Reception', email: 'a@example.test' } }),
    makeRow({ id: asId('t2'), data: { subject: 'Billing', state: 'resolved', priority: 'normal', assignee: null, category: 'Billing', queue: 'Reception', email: 'b@example.test' } }),
    makeRow({ id: asId('t3'), data: { subject: 'VPN', state: 'open', priority: 'urgent', assignee: userRef('u-bob'), category: 'Connectivity', queue: 'Facilities', email: 'c@example.test' } }),
  ];
  await store.commit(makeBatch(await store.readRevision(), { writes: rows.map((row) => ({ kind: 'insert', model, row })) }));
  const policy = buildPolicyTable([{
    model, secretFields: [],
    grants: [
      { by: { role: 'support' }, fields: ['subject', 'state', 'priority', 'assignee', 'category', 'queue', 'email'] },
      { by: 'authenticated', fields: ['subject'], when: { op: 'eq', field: 'email', value: 'b@example.test' } },
    ],
  }]);
  const memberships = {
    findMembership: async (teamId: string, userId: string) =>
      userId === 'u-support' ? { membership_id: 'm1', team_id: teamId, user_id: userId, is_owner: false, roles: [{ role: 'support' }], status: 'active' } : null,
  };
  const run = (where: any, ctx: any) => queryRecords({ policy, model, where, authority: 'viewer', context: ctx, memberships, store } as any);
  const support = { actorUserId: 'u-support', teamId: 't1' };
  const ids = (r: any) => r.records.map((row: any) => row.id).sort();
  let r = await run({ op: 'eq', field: 'assignee', value: { id: 'u-alice' } }, support);
  assert.deepEqual(ids(r), ['t1']);
  r = await run({ op: 'eq', field: 'state', value: 'open' }, support);
  assert.deepEqual(ids(r), ['t1', 't3']);
  r = await run({ op: 'and', args: [{ op: 'eq', field: 'category', value: 'Connectivity' }, { op: 'eq', field: 'assignee', value: { id: 'u-bob' } }] }, support);
  assert.deepEqual(ids(r), ['t3']);
  r = await run(undefined, { actorUserId: 'u-b', teamId: 't1' });
  assert.deepEqual(ids(r), ['t2']);
  assert.deepEqual(Object.keys(r.records[0].data).sort(), ['subject']);
  r = await run(undefined, { actorUserId: null, teamId: 't1' });
  assert.deepEqual(ids(r), []);
  console.log('engine match/hidden ok, revision', r.revision);
  const revBefore = await store.readRevision();
  await store.commit(makeBatch(revBefore, { writes: [{ kind: 'insert', model,
    row: makeRow({ id: asId('t4'), data: { subject: 'Phone', state: 'open', priority: 'normal', assignee: userRef('u-alice'), category: 'Voice', queue: 'Reception', email: 'd@example.test' } }) }] }));
  r = await run({ op: 'eq', field: 'assignee', value: { id: 'u-alice' } }, support);
  assert.deepEqual(ids(r), ['t1', 't4']);
  assert.equal(r.revision, revBefore + 1);
  console.log('commit fence ok, revision', r.revision);
  // 5. derived-negative: State resolves an unevaluated (derived) field as
  // missing, and comparisons against missing are false either way — so a
  // derived-bool `where` would silently match nothing. This is exactly why
  // derived selectors stay refused at the compiler gate.
  assert.equal(evalPredicateForRow({ op: 'eq', field: 'unassigned', value: true }, rows[0]), false);
  assert.equal(evalPredicateForRow({ op: 'eq', field: 'unassigned', value: false }, rows[0]), false);
  console.log('derived-negative ok');
}
console.log('CHAIN OK');
"#;
