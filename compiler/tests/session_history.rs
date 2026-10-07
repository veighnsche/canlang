//! Public session ownership, selected lint, and real stdio controls.
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::lint::driver::{LintConfig, collect_fixes, lint_program};
use canlang_compiler::lsp::server::{
    CodeAction, CompletionItem, DocLocation, LanguageAnalysis, LspRange, RealAnalysis, Server,
    TextEdit, TextPos, uri_to_path,
};
use canlang_compiler::lsp::transport;
use canlang_compiler::source::{SourceDb, SourceId};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[allow(dead_code)]
#[path = "common/lsp_driver.rs"]
mod lsp_driver;

const TEXT: &str = "app Shop\nGiven\n Item {title:text}\nWhen\nThen\n";

#[derive(Debug)]
struct Observation {
    current: String,
    path: String,
    sources: Vec<(SourceId, String, String)>,
    latest_path_id: SourceId,
    owner_codes: Vec<&'static str>,
}
struct Observed {
    real: RealAnalysis,
    observations: Arc<Mutex<Vec<Observation>>>,
    checked: Mutex<Option<CheckedProgram>>,
}
impl LanguageAnalysis for Observed {
    fn diagnostics(&self, db: &SourceDb, id: SourceId) -> Vec<Diagnostic> {
        let source = db.get(id).unwrap();
        let owner_codes = self
            .checked
            .lock()
            .unwrap()
            .as_ref()
            .map(|program| {
                ir::build(program, db, None)
                    .1
                    .iter()
                    .map(|d| d.code)
                    .collect()
            })
            .unwrap_or_default();
        *self.checked.lock().unwrap() = Some(check_program(db, &[id], None).0);
        self.observations.lock().unwrap().push(Observation {
            current: source.text.clone(),
            path: source.path.clone(),
            sources: db
                .iter()
                .map(|(id, s)| (id, s.path.clone(), s.text.clone()))
                .collect(),
            latest_path_id: db.lookup(&source.path).unwrap(),
            owner_codes,
        });
        self.real.diagnostics(db, id)
    }
    fn hover(&self, db: &SourceDb, id: SourceId, p: TextPos) -> Option<String> {
        self.real.hover(db, id, p)
    }
    fn completions(&self, db: &SourceDb, id: SourceId, p: TextPos) -> Vec<CompletionItem> {
        self.real.completions(db, id, p)
    }
    fn definition(&self, db: &SourceDb, id: SourceId, uri: &str, p: TextPos) -> Vec<DocLocation> {
        self.real.definition(db, id, uri, p)
    }
    fn references(&self, db: &SourceDb, id: SourceId, uri: &str, p: TextPos) -> Vec<DocLocation> {
        self.real.references(db, id, uri, p)
    }
    fn rename(&self, db: &SourceDb, id: SourceId, p: TextPos, name: &str) -> Vec<TextEdit> {
        self.real.rename(db, id, p, name)
    }
    fn semantic_tokens(&self, db: &SourceDb, id: SourceId) -> Vec<u32> {
        self.real.semantic_tokens(db, id)
    }
    fn code_actions(&self, db: &SourceDb, id: SourceId, uri: &str, r: LspRange) -> Vec<CodeAction> {
        self.real.code_actions(db, id, uri, r)
    }
}
fn send(server: &mut Server<Observed>, value: Value) -> Vec<Value> {
    server
        .handle_json(&transport::parse(&value.to_string()).unwrap())
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","method":method,"params":params})
}
fn open(uri: &str, version: i32, text: &str) -> Value {
    notification(
        "textDocument/didOpen",
        json!({"textDocument":{"uri":uri,"languageId":"can","version":version,"text":text}}),
    )
}
fn change(uri: &str, version: i32, text: &str) -> Value {
    notification(
        "textDocument/didChange",
        json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}),
    )
}
fn close(uri: &str) -> Value {
    notification("textDocument/didClose", json!({"textDocument":{"uri":uri}}))
}
fn session() -> (Server<Observed>, Arc<Mutex<Vec<Observation>>>) {
    let observations = Arc::new(Mutex::new(Vec::new()));
    let mut server = Server::new(Observed {
        real: RealAnalysis::new(None),
        observations: Arc::clone(&observations),
        checked: Mutex::new(None),
    });
    let response = send(
        &mut server,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}),
    );
    assert!(response[0]["result"]["capabilities"].is_object());
    (server, observations)
}

#[test]
fn live_documents_bound_history_and_keep_uri_aliases_distinct() {
    let (mut server, observations) = session();
    let uris = [
        "file:///tmp/shared.can",
        "file:///tmp/%73hared.can",
        "untitled:other",
    ];
    assert_eq!(uri_to_path(uris[0]), uri_to_path(uris[1]));
    for (i, uri) in uris.iter().enumerate() {
        send(&mut server, open(uri, 1, &format!("{TEXT}## live {i}\n")));
    }
    assert_eq!(server.pump().len(), 3);
    for version in 2..=49 {
        let text = format!("{TEXT}## revision {version} {}\n", "x".repeat(1024));
        send(&mut server, change(uris[0], version, &text));
        assert_eq!(server.pump().len(), 1);
        let values = observations.lock().unwrap();
        let last = values.last().unwrap();
        assert_eq!(last.current, text);
        assert_eq!(last.sources.len(), 3);
        assert_eq!(
            last.sources
                .iter()
                .filter(|(_, path, _)| path == &last.path)
                .count(),
            2
        );
        assert_eq!(last.sources.last().unwrap().0, last.latest_path_id);
        assert_eq!(last.sources.last().unwrap().2, text);
        assert_eq!(last.owner_codes, ["E6011"]);
    }
    let latest = observations.lock().unwrap().last().unwrap().current.clone();
    send(&mut server, change(uris[0], 50, &latest));
    send(&mut server, change(uris[0], 51, &latest));
    assert_eq!(server.pending_count(), 2);
    assert_eq!(server.pump().len(), 1);
    assert!(
        observations
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .owner_codes
            .is_empty()
    );
    let clear = send(&mut server, close(uris[0]));
    assert_eq!(clear[0]["params"]["version"], 51);
    assert_eq!(clear[0]["params"]["diagnostics"], json!([]));
    // Closing an alias retains the other URI and restores its path lookup.
    send(
        &mut server,
        change(uris[1], 2, &format!("{TEXT}## remaining\n")),
    );
    assert_eq!(server.pump().len(), 1);
    assert_eq!(
        observations.lock().unwrap().last().unwrap().sources.len(),
        2
    );
    send(&mut server, close(uris[1]));
    send(&mut server, close(uris[2]));
    assert!(server.pump().is_empty());
    send(&mut server, open(uris[0], 1, TEXT));
    assert_eq!(server.pump().len(), 1);
    let values = observations.lock().unwrap();
    let last = values.last().unwrap();
    assert_eq!(
        last.sources,
        [(SourceId(0), uri_to_path(uris[0]), TEXT.to_string())]
    );
    assert_eq!(last.owner_codes, ["E6011"]);
}

#[test]
fn remapped_queued_work_keeps_current_fifo_and_cannot_revive_stale_ids() {
    let (mut server, observations) = session();
    send(&mut server, open("untitled:a", 1, TEXT));
    send(&mut server, open("untitled:b", 4, &format!("{TEXT}## B\n")));
    send(
        &mut server,
        change("untitled:a", 2, &format!("{TEXT}## changed\n")),
    );
    // Reusing a client version and old bytes cannot reactivate its old task
    // after fresh owners have reused numeric source IDs.
    send(&mut server, change("untitled:a", 1, TEXT));
    let publications: Vec<Value> = server
        .pump()
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(publications.len(), 2);
    assert_eq!(publications[0]["params"]["uri"], "untitled:b");
    assert_eq!(publications[0]["params"]["version"], 4);
    assert_eq!(publications[1]["params"]["uri"], "untitled:a");
    assert_eq!(publications[1]["params"]["version"], 1);
    assert_eq!(observations.lock().unwrap().last().unwrap().current, TEXT);
    send(
        &mut server,
        change("untitled:a", 5, &format!("{TEXT}## closed\n")),
    );
    send(&mut server, close("untitled:a"));
    send(&mut server, open("untitled:a", 5, TEXT));
    assert_eq!(server.pump().len(), 1);
    send(&mut server, change("untitled:b", 6, TEXT));
    send(
        &mut server,
        json!({"jsonrpc":"2.0","id":99,"method":"shutdown","params":null}),
    );
    assert_eq!(server.pending_count(), 0);
    assert!(server.pump().is_empty());
}

#[test]
fn standalone_immutable_ids_and_exact_lint_selection_survive_history() {
    let mut db = SourceDb::new();
    let description = "app T\nGiven\n #\n Item {title:text}\nWhen\nThen\n";
    let old = db.add("same.can".into(), description.into());
    let one = db.add("same.can".into(), description.into());
    db.add("unchecked.can".into(), description.into());
    let two = db.add("selected.can".into(), description.replace("app T", "app U"));
    let (program, _) = check_program(&db, &[two, one, two], None);
    assert_eq!(program.checked_files(), &[two, one, two]);
    db.add("same.can".into(), TEXT.into());
    assert_eq!(db.get(old).unwrap().text, description);
    assert_eq!(db.get(one).unwrap().text, description);
    let findings = lint_program(&program, &db, &LintConfig::default());
    assert_eq!(
        findings
            .iter()
            .map(|d| (d.primary.file, d.code))
            .collect::<Vec<_>>(),
        [(one, "I1003"), (two, "I1003"), (two, "I1003")]
    );
    assert!(
        ir::build(&program, &db, None)
            .1
            .iter()
            .all(|d| d.code != "E6011")
    );
    let mut replacement = SourceDb::new();
    replacement.add("same.can".into(), description.into());
    assert_eq!(
        ir::build(&program, &replacement, None)
            .1
            .iter()
            .map(|d| d.code)
            .collect::<Vec<_>>(),
        ["E6011"]
    );
    let fix_text = "app F\nGiven\n Todo {title:text}\nWhen\n scenario s(task:Todo) -> text by=members\n  do\n   return task?.title\nThen\n";
    let mut fixes_db = SourceDb::new();
    fixes_db.add("fix.can".into(), fix_text.into());
    let selected = fixes_db.add("fix.can".into(), fix_text.into());
    let (checked, _) = check_program(&fixes_db, &[selected], None);
    fixes_db.add("other.can".into(), fix_text.into());
    let fixes = collect_fixes(
        &checked,
        &fixes_db,
        &LintConfig {
            fix: true,
            ..LintConfig::default()
        },
    );
    assert_eq!(fixes.len(), 1);
    assert_eq!(fixes[0].file, selected);
    assert_eq!(
        fixes[0].expected_sha256,
        fixes_db.get(selected).unwrap().sha256
    );
}

#[test]
fn real_stdio_distinct_edits_close_and_reopen_use_current_text() {
    let mut child = lsp_driver::LspDriver::spawn().unwrap();
    assert!(child.initialize().unwrap().contains("capabilities"));
    let uri = "untitled:history-process";
    child
        .did_open(
            uri,
            1,
            "app Broken\nGiven\n Item {title:unknown}\nWhen\nThen\n",
        )
        .unwrap();
    child.completion(uri, 0, 0).unwrap();
    let first: Vec<Value> = child
        .take_notifications()
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(first.iter().any(|n| {
        n["params"]["version"] == 1
            && n["params"]["diagnostics"]
                .as_array()
                .is_some_and(|d| !d.is_empty())
    }));
    for version in 2..=25 {
        child
            .did_change(uri, version, &format!("{TEXT}## process edit {version}\n"))
            .unwrap();
    }
    child.completion(uri, 0, 0).unwrap();
    let repaired: Vec<Value> = child
        .take_notifications()
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(repaired.iter().any(|n| {
        n["params"]["version"] == 25
            && n["params"]["diagnostics"]
                .as_array()
                .is_some_and(|d| d.iter().all(|d| d["code"] == "E6002"))
    }));
    child
        .notify(
            "textDocument/didClose",
            &json!({"textDocument":{"uri":uri}}).to_string(),
        )
        .unwrap();
    child.completion(uri, 0, 0).unwrap();
    let closed: Vec<Value> = child
        .take_notifications()
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(closed.len(), 1);
    assert_eq!(
        closed[0]["params"],
        json!({"uri":uri,"version":25,"diagnostics":[]})
    );
    child.did_open(uri, 1, TEXT).unwrap();
    let response: Value = serde_json::from_str(&child.completion(uri, 2, 2).unwrap()).unwrap();
    assert!(
        response["result"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["label"] == "Item"))
    );
    let reopened: Vec<Value> = child
        .take_notifications()
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(reopened.len(), 1);
    assert_eq!(reopened[0]["params"]["version"], 1);
    assert!(child.shutdown().unwrap().success());
}
