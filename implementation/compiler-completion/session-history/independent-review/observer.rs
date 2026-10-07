//! Independent public callback/model controls; no private Server access.
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::lint::driver::{LintConfig, collect_fixes, lint_program};
use canlang_compiler::lsp::server::*;
use canlang_compiler::lsp::transport;
use canlang_compiler::source::{SourceDb, SourceId};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Doc { text: String, version: i32, generation: u64 }
#[derive(Default)]
struct Model {
    docs: BTreeMap<String, Doc>,
    queue: Vec<(String, i32, u64)>,
    generation: u64,
    owner: u64,
    views: usize,
    diagnostics: usize,
    callbacks: Vec<String>,
    methods: BTreeMap<String, usize>,
    old: Option<(u64, CheckedProgram)>,
    refused: usize,
    admitted: usize,
}
struct Observer(Arc<Mutex<Model>>);
impl Observer {
    fn view(&self, db: &SourceDb, id: SourceId, method: &str) {
        let mut m = self.0.lock().unwrap();
        let mut expected: Vec<_> = m.docs.iter().collect();
        expected.sort_by_key(|(_, d)| d.generation);
        let actual: Vec<_> = db.iter().collect();
        assert_eq!(actual.len(), expected.len(), "one source per live URI");
        for ((_, source), (uri, doc)) in actual.iter().zip(&expected) {
            assert_eq!(source.path, uri_to_path(uri));
            assert_eq!(source.text, doc.text);
        }
        for (uri, _) in &expected {
            let path = uri_to_path(uri);
            let latest = expected.iter().rposition(|(u, _)| uri_to_path(u) == path).unwrap();
            assert_eq!(db.lookup(&path), Some(actual[latest].0), "latest live alias wins path lookup");
        }
        let current = db.get(id).unwrap();
        let current_uri = expected[actual.iter().position(|(source, _)| *source == id).unwrap()].0.clone();
        assert_eq!(current.text, m.docs[&current_uri].text);
        if let Some((owner, checked)) = &m.old {
            let codes: Vec<_> = ir::build(checked, db, None).1.iter().map(|d| d.code).collect();
            if *owner == m.owner {
                assert!(!codes.contains(&"E6011"));
                m.admitted += 1;
            } else {
                assert_eq!(codes, ["E6011"]);
                m.refused += 1;
            }
        }
        m.old = Some((m.owner, check_program(db, &[id], None).0));
        m.views += 1;
        *m.methods.entry(method.into()).or_default() += 1;
        if method == "diagnostics" { m.diagnostics += 1; m.callbacks.push(current_uri); }
    }
}
impl LanguageAnalysis for Observer {
    fn diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic> { self.view(db, id, "diagnostics"); vec![] }
    fn hover(&self, db: &SourceDb, id: SourceId, _: TextPos) -> Option<String> { self.view(db, id, "hover"); None }
    fn completions(&self, db: &SourceDb, id: SourceId, _: TextPos) -> Vec<CompletionItem> { self.view(db, id, "completions"); vec![] }
    fn definition(&self, db: &SourceDb, id: SourceId, _: &str, _: TextPos) -> Vec<DocLocation> { self.view(db, id, "definition"); vec![] }
    fn references(&self, db: &SourceDb, id: SourceId, _: &str, _: TextPos) -> Vec<DocLocation> { self.view(db, id, "references"); vec![] }
    fn rename(&self, db: &SourceDb, id: SourceId, _: TextPos, _: &str) -> Vec<TextEdit> { self.view(db, id, "rename"); vec![] }
    fn semantic_tokens(&self, db: &SourceDb, id: SourceId) -> Vec<u32> { self.view(db, id, "semantic_tokens"); vec![] }
    fn code_actions(&self, db: &SourceDb, id: SourceId, _: &str, _: LspRange) -> Vec<CodeAction> { self.view(db, id, "code_actions"); vec![] }
}
fn send(s: &mut Server<Observer>, v: Value) -> Vec<Value> {
    s.handle_json(&transport::parse(&v.to_string()).unwrap()).into_iter().map(|s| serde_json::from_str(&s).unwrap()).collect()
}
fn prune(m: &mut Model) {
    m.queue.retain(|(uri, version, generation)| m.docs.get(uri).is_some_and(|d| d.version == *version && d.generation == *generation));
}
fn edit(s: &mut Server<Observer>, model: &Arc<Mutex<Model>>, uri: &str, version: i32, text: &str, open: bool) {
    {
        let mut m = model.lock().unwrap();
        if open || m.docs.contains_key(uri) {
            let changed = m.docs.get(uri).is_none_or(|d| d.text != text);
            let generation = if changed { m.generation += 1; m.owner += 1; m.generation } else { m.docs[uri].generation };
            m.docs.insert(uri.into(), Doc { text: text.into(), version, generation });
            m.queue.push((uri.into(), version, generation));
            if changed { prune(&mut m); }
        }
    }
    let params = if open { json!({"textDocument":{"uri":uri,"languageId":"can","version":version,"text":text}}) }
        else { json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}) };
    assert!(send(s, json!({"jsonrpc":"2.0","method":if open {"textDocument/didOpen"} else {"textDocument/didChange"},"params":params})).is_empty());
}
fn close(s: &mut Server<Observer>, model: &Arc<Mutex<Model>>, uri: &str) {
    let removed = {
        let mut m = model.lock().unwrap();
        let removed = m.docs.remove(uri);
        m.queue.retain(|(u, _, _)| u != uri);
        if removed.is_some() { m.owner += 1; prune(&mut m); }
        removed
    };
    let output = send(s, json!({"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":uri}}}));
    if let Some(doc) = removed {
        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["params"]["uri"], uri);
        assert_eq!(output[0]["params"]["version"], doc.version);
        assert_eq!(output[0]["params"]["diagnostics"], json!([]));
    } else { assert!(output.is_empty()); }
}
fn pump(s: &mut Server<Observer>, model: &Arc<Mutex<Model>>) {
    let expected = {
        let mut m = model.lock().unwrap(); prune(&mut m); m.callbacks.clear();
        std::mem::take(&mut m.queue)
    };
    let output: Vec<Value> = s.pump().into_iter().map(|s| serde_json::from_str(&s).unwrap()).collect();
    assert_eq!(output.len(), expected.len());
    for (v, (uri, version, _)) in output.iter().zip(&expected) {
        assert_eq!(v["params"]["uri"], *uri);
        assert_eq!(v["params"]["version"], *version);
        assert_eq!(v["params"]["diagnostics"], json!([]));
    }
    assert_eq!(model.lock().unwrap().callbacks, expected.iter().map(|(u, _, _)| u.clone()).collect::<Vec<_>>());
    assert_eq!(s.pending_count(), 0);
}
fn text(n: usize) -> String { format!("app Observer\nGiven\n Record {{value:text}}\nWhen\nThen\n## variant {n}\n") }
fn main() {
    let model = Arc::new(Mutex::new(Model::default()));
    let mut s = Server::new(Observer(Arc::clone(&model)));
    assert!(send(&mut s, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}))[0]["result"]["capabilities"].is_object());
    let uris = ["file:///tmp/alias.can", "file:///tmp/%61lias.can", "untitled:b", "untitled:c", "untitled:d"];
    // New bytes under reused versions, old byte reversion, unaffected FIFO, and alias recency.
    edit(&mut s, &model, uris[0], 7, &text(0), true);
    edit(&mut s, &model, uris[2], 9, &text(2), true);
    edit(&mut s, &model, uris[1], 7, &text(1), true);
    edit(&mut s, &model, uris[0], 7, &text(3), false);
    edit(&mut s, &model, uris[0], 7, &text(0), false);
    assert_eq!(s.pending_count(), 3);
    pump(&mut s, &model);
    assert_eq!(model.lock().unwrap().callbacks, [uris[2], uris[1], uris[0]]);
    // Equal version/equal text remains the prior API's duplicate publication semantics.
    edit(&mut s, &model, uris[0], 7, &text(0), false);
    edit(&mut s, &model, uris[0], 7, &text(0), false);
    pump(&mut s, &model);
    assert_eq!(model.lock().unwrap().callbacks.len(), 2);
    let mut rng = 0x9753_2468_abcd_u64;
    for i in 0..1800 {
        rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
        let uri = uris[(rng as usize / 16) % uris.len()];
        let version = ((rng >> 23) % 4) as i32;
        let t = text(((rng >> 19) % 5) as usize);
        match rng % 10 {
            0..=2 => edit(&mut s, &model, uri, version, &t, true),
            3..=5 => edit(&mut s, &model, uri, version, &t, false),
            6 => close(&mut s, &model, uri),
            7 => pump(&mut s, &model),
            _ => {
                let chosen = { let m = model.lock().unwrap(); if m.docs.contains_key(uri) { Some(uri.to_string()) } else { m.docs.keys().next().cloned() } };
                let Some(uri) = chosen else { continue };
                let method = ["textDocument/hover", "textDocument/completion", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/semanticTokens/full", "textDocument/codeAction"][i % 7];
                let mut params = json!({"textDocument":{"uri":uri},"position":{"line":0,"character":0},"newName":"X","context":{"includeDeclaration":true,"diagnostics":[]},"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}}});
                if method == "textDocument/semanticTokens/full" { params = json!({"textDocument":{"uri":uri}}); }
                let reply = send(&mut s, json!({"jsonrpc":"2.0","id":i+10,"method":method,"params":params}));
                assert!(reply[0].get("error").is_none(), "{method}: {reply:?}");
            }
        }
    }
    pump(&mut s, &model);
    for uri in uris { close(&mut s, &model, uri); }
    pump(&mut s, &model);
    let before = model.lock().unwrap().views;
    send(&mut s, json!({"jsonrpc":"2.0","id":3000,"method":"textDocument/completion","params":{"textDocument":{"uri":uris[0]},"position":{"line":0,"character":0}}}));
    assert_eq!(model.lock().unwrap().views, before, "closed URI must never dispatch analysis");
    edit(&mut s, &model, uris[0], 0, &text(4), true);
    pump(&mut s, &model);
    edit(&mut s, &model, uris[0], 0, &text(0), false);
    send(&mut s, json!({"jsonrpc":"2.0","id":3001,"method":"shutdown","params":null}));
    assert_eq!(s.pending_count(), 0);
    assert!(s.pump().is_empty());
    assert_eq!(model.lock().unwrap().views, before + 1);
    let m = model.lock().unwrap();
    for method in ["diagnostics", "hover", "completions", "definition", "references", "rename", "semantic_tokens", "code_actions"] { assert!(m.methods.get(method).is_some_and(|n| *n > 0)); }
    let observation = json!({"transitions":1800,"callback_methods":m.methods,"callback_views":m.views,"diagnostic_callbacks":m.diagnostics,"fresh_owner_refusals":m.refused,"same_owner_admissions":m.admitted,"closed_and_shutdown_publications":0,"accepted":"all live URI texts and latest-live path alias checked at every callback; FIFO compared to generation-based oracle; all seven request callback kinds exercised"});
    drop(m);
    // Valid held IDs remain immutable; public findings/fixes include exact nonzero selections and duplicates.
    let description = "app Selected\nGiven\n #\n Item {name:text}\nWhen\nThen\n";
    let mut db = SourceDb::new();
    let old = db.add("repeat.can".into(), description.into());
    db.add("metadata.can".into(), description.replace("Selected", "Metadata"));
    let selected = db.add("repeat.can".into(), description.replace("Selected", "First"));
    db.add("excluded.can".into(), description.replace("Selected", "Excluded"));
    let last = db.add("last.can".into(), description.replace("Selected", "Last"));
    let checked = check_program(&db, &[last, selected, last], None).0;
    let old_text = db.get(old).unwrap().text.clone();
    let selected_text = db.get(selected).unwrap().text.clone();
    for i in 0..80 { db.add("repeat.can".into(), text(i)); }
    assert_eq!(db.get(old).unwrap().text, old_text);
    assert_eq!(db.get(selected).unwrap().text, selected_text);
    assert_eq!(checked.checked_files(), &[last, selected, last]);
    let findings: Vec<_> = lint_program(&checked, &db, &LintConfig::default()).into_iter().map(|d| (d.primary.file.0, d.code)).collect();
    assert_eq!(findings, [(selected.0, "I1003"), (last.0, "I1003"), (last.0, "I1003")]);
    assert!(!ir::build(&checked, &db, None).1.iter().any(|d| d.code == "E6011"));
    let mut foreign = SourceDb::new(); foreign.add("repeat.can".into(), description.into());
    assert_eq!(ir::build(&checked, &foreign, None).1.iter().map(|d| d.code).collect::<Vec<_>>(), ["E6011"]);
    let fixable = "app Fixer\nGiven\n Row {name:text}\nWhen\n scenario get(row:Row) -> text by=members\n  do\n   return row?.name\nThen\n";
    let mut fix_db = SourceDb::new();
    fix_db.add("fix.can".into(), fixable.into());
    let f = fix_db.add("fix.can".into(), format!("{fixable}## selected immutable bytes\n"));
    fix_db.add("elsewhere.can".into(), fixable.replace("Fixer", "Elsewhere"));
    let p = check_program(&fix_db, &[f, f], None).0;
    fix_db.add("fix.can".into(), text(1));
    let fixes = collect_fixes(&p, &fix_db, &LintConfig { fix: true, ..LintConfig::default() });
    assert_eq!(fixes.len(), 2);
    for fix in &fixes { assert_eq!(fix.file, f); assert_eq!(fix.expected_sha256, fix_db.get(f).unwrap().sha256); }
    println!("{}", json!({"session":observation,"standalone":{"retained_sources":db.len(),"checked_order":checked.checked_files().iter().map(|id|id.0).collect::<Vec<_>>(),"finding_order":findings,"duplicate_fix_files":fixes.iter().map(|f|f.file.0).collect::<Vec<_>>(),"same_owner_admitted":true,"fresh_owner_codes":["E6011"],"valid_held_ids_immutable":true},"scope":"Pinned compiled library public API; no full-source freeze, RSS, GUI, cross-file-analysis or check-time-invalid-ID lint-admission claim"}));
}
