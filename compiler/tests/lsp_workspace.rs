//! Direct project protocol checks exercise discovery, overlays and edit guards.
use canlang_compiler::lsp::{
    server::{RealAnalysis, Server},
    transport,
};
use serde_json::{Value, json};
use std::path::Path;

const PROVIDER: &str =
    "package P\n Given\n  export Todo { title:text desc=\"Shared title.\" }\n When\n Then\n";
const CONSUMER: &str = "app Tasks\nuse P {Todo as Local}\nGiven\nWhen\n scenario s(task:Local) by=members\n  do\n   let caption=task.title\n   let detached=Local {title=caption}\nThen\n";
fn uri(path: &Path) -> String {
    url::Url::from_file_path(path).unwrap().to_string()
}
fn call(server: &mut Server<RealAnalysis>, message: Value) -> Vec<Value> {
    server
        .handle_json(&transport::parse(&message.to_string()).unwrap())
        .into_iter()
        .map(|text| serde_json::from_str(&text).unwrap())
        .collect()
}
fn request(server: &mut Server<RealAnalysis>, method: &str, params: Value) -> Value {
    call(
        server,
        json!({"jsonrpc":"2.0","id":10,"method":method,"params":params}),
    )
    .remove(0)["result"]
        .clone()
}
fn notify(server: &mut Server<RealAnalysis>, method: &str, params: Value) {
    call(
        server,
        json!({"jsonrpc":"2.0","method":method,"params":params}),
    );
}
fn server(roots: &[&Path]) -> Server<RealAnalysis> {
    let mut server = Server::new(RealAnalysis::new(None));
    request(
        &mut server,
        "initialize",
        json!({"processId":null,"rootUri":roots.first().map(|root|uri(root)),"workspaceFolders":roots.iter().map(|root|json!({"uri":uri(root),"name":"fixture"})).collect::<Vec<_>>(),"capabilities":{"workspace":{"workspaceEdit":{"documentChanges":true}}}}),
    );
    server
}
fn open(server: &mut Server<RealAnalysis>, path: &Path, text: &str, version: i32) {
    notify(
        server,
        "textDocument/didOpen",
        json!({"textDocument":{"uri":uri(path),"languageId":"can","version":version,"text":text}}),
    );
}
fn change(server: &mut Server<RealAnalysis>, path: &Path, text: &str, version: i32) {
    notify(
        server,
        "textDocument/didChange",
        json!({"textDocument":{"uri":uri(path),"version":version},"contentChanges":[{"text":text}]}),
    );
}
fn position(text: &str, needle: &str) -> Value {
    let before = &text[..text.find(needle).unwrap()];
    json!({"line":before.matches('\n').count(),"character":before.rsplit('\n').next().unwrap().encode_utf16().count()})
}
fn at(path: &Path, text: &str, needle: &str) -> Value {
    json!({"textDocument":{"uri":uri(path)},"position":position(text,needle)})
}
fn diagnostics(server: &mut Server<RealAnalysis>) -> Vec<Value> {
    server
        .pump()
        .into_iter()
        .map(|text| serde_json::from_str::<Value>(&text).unwrap()["params"].clone())
        .collect()
}
fn watch(server: &mut Server<RealAnalysis>, path: &Path, kind: i32) {
    notify(
        server,
        "workspace/didChangeWatchedFiles",
        json!({"changes":[{"uri":uri(path),"type":kind}]}),
    );
}

#[test]
fn unopened_discovery_cross_file_queries_and_atomic_versioned_rename() {
    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("shared models #😀.can");
    let app = root.path().join("tasks.can");
    let second = root.path().join("other.can");
    std::fs::write(&shared, PROVIDER).unwrap();
    std::fs::write(&app, CONSUMER).unwrap();
    std::fs::write(&second, CONSUMER.replace("Tasks", "Other")).unwrap();
    // An unrelated duplicate app is neither a prerequisite nor a query owner.
    std::fs::write(
        root.path().join("unrelated.can"),
        "app Tasks\nGiven\n Broken {n:Missing}\nWhen\nThen\n",
    )
    .unwrap();
    let mut server = server(&[root.path()]);
    open(&mut server, &app, CONSUMER, 3);
    let initial = diagnostics(&mut server);
    assert!(
        initial.iter().all(|item| !item["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["severity"] == 1)),
        "{initial:?}"
    );
    let mut params = at(&app, CONSUMER, "title\n");
    let definition = request(&mut server, "textDocument/definition", params.clone());
    assert_eq!(definition[0]["uri"], uri(&shared));
    assert_eq!(
        definition[0]["range"]["start"],
        json!({"line":2,"character":16})
    );
    let hover = request(&mut server, "textDocument/hover", params.clone());
    assert!(
        hover["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("Shared title.")
    );
    let completion = request(&mut server, "textDocument/completion", params.clone());
    assert!(
        completion
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "title" && item["detail"] == "text")
    );
    params["context"] = json!({"includeDeclaration":true});
    let references = request(&mut server, "textDocument/references", params.clone());
    assert_eq!(references.as_array().unwrap().len(), 5);
    assert!(
        references
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["uri"] == uri(&second))
    );
    params["newName"] = json!("summary");
    assert!(
        request(&mut server, "textDocument/rename", params.clone()).is_null(),
        "closed files have no version guard"
    );
    open(&mut server, &shared, PROVIDER, 8);
    open(&mut server, &second, &CONSUMER.replace("Tasks", "Other"), 4);
    let rename = request(&mut server, "textDocument/rename", params);
    let edits = rename["documentChanges"].as_array().unwrap();
    assert_eq!(edits.len(), 3);
    assert_eq!(
        edits
            .iter()
            .map(|edit| edit["edits"].as_array().unwrap().len())
            .sum::<usize>(),
        5
    );
    for edit in edits {
        let document = &edit["textDocument"];
        let expected = if document["uri"] == uri(&shared) {
            8
        } else if document["uri"] == uri(&app) {
            3
        } else {
            4
        };
        assert_eq!(document["version"], expected);
    }
    // Starting on the owner reaches the same consumer closure.
    let mut owner = at(&shared, PROVIDER, "title:text");
    owner["context"] = json!({"includeDeclaration":true});
    assert_eq!(
        request(&mut server, "textDocument/references", owner)
            .as_array()
            .unwrap()
            .len(),
        5
    );
}

#[test]
fn unsaved_overlay_watch_delete_and_close_restore_current_disk() {
    let root = tempfile::tempdir().unwrap();
    let provider = root.path().join("p.can");
    let app = root.path().join("a.can");
    std::fs::write(&provider, PROVIDER).unwrap();
    std::fs::write(&app, CONSUMER).unwrap();
    let mut server = server(&[root.path()]);
    open(&mut server, &app, CONSUMER, 1);
    open(&mut server, &provider, PROVIDER, 1);
    diagnostics(&mut server);
    let overlay = PROVIDER.replace("title:text", "title:int");
    change(&mut server, &provider, &overlay, 2);
    let affected = diagnostics(&mut server);
    assert_eq!(affected.len(), 2, "dependent open docs revalidated");
    std::fs::write(&provider, PROVIDER.replace("Shared title.", "Disk title.")).unwrap();
    watch(&mut server, &provider, 2);
    let hovered = request(
        &mut server,
        "textDocument/hover",
        at(&app, CONSUMER, "title\n"),
    );
    assert!(
        hovered["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("declared: `int`")
    );
    notify(
        &mut server,
        "textDocument/didClose",
        json!({"textDocument":{"uri":uri(&provider)}}),
    );
    let hovered = request(
        &mut server,
        "textDocument/hover",
        at(&app, CONSUMER, "title\n"),
    );
    assert!(
        hovered["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("Disk title.")
    );
    std::fs::remove_file(&provider).unwrap();
    watch(&mut server, &provider, 3);
    assert!(
        request(
            &mut server,
            "textDocument/definition",
            at(&app, CONSUMER, "title\n")
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    assert!(diagnostics(&mut server).iter().any(
        |item| item["uri"] == uri(&app) && !item["diagnostics"].as_array().unwrap().is_empty()
    ));
    std::fs::write(&provider, PROVIDER).unwrap();
    watch(&mut server, &provider, 1);
    assert_eq!(
        request(
            &mut server,
            "textDocument/definition",
            at(&app, CONSUMER, "title\n")
        )[0]["uri"],
        uri(&provider)
    );
}

#[test]
fn folders_isolate_providers_and_excluded_directories_do_not_poison_owners() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let a_app = a.path().join("a.can");
    let b_app = b.path().join("b.can");
    for root in [a.path(), b.path()] {
        std::fs::write(root.join("p.can"), PROVIDER).unwrap();
        for excluded in [
            "node_modules",
            "vendor",
            "target",
            "dist",
            "build",
            ".worktrees",
        ] {
            std::fs::create_dir(root.join(excluded)).unwrap();
            std::fs::write(root.join(excluded).join("duplicate.can"), PROVIDER).unwrap();
        }
    }
    std::fs::write(&a_app, CONSUMER).unwrap();
    std::fs::write(&b_app, CONSUMER).unwrap();
    let mut server = server(&[a.path(), b.path()]);
    open(&mut server, &a_app, CONSUMER, 1);
    open(&mut server, &b_app, CONSUMER, 1);
    assert_eq!(
        request(
            &mut server,
            "textDocument/definition",
            at(&a_app, CONSUMER, "title\n")
        )[0]["uri"],
        uri(&a.path().join("p.can"))
    );
    assert_eq!(
        request(
            &mut server,
            "textDocument/definition",
            at(&b_app, CONSUMER, "title\n")
        )[0]["uri"],
        uri(&b.path().join("p.can"))
    );
    notify(
        &mut server,
        "workspace/didChangeWorkspaceFolders",
        json!({"event":{"removed":[{"uri":uri(b.path()),"name":"b"}],"added":[]}}),
    );
    assert!(
        request(
            &mut server,
            "textDocument/definition",
            at(&b_app, CONSUMER, "title\n")
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    assert!(
        !request(
            &mut server,
            "textDocument/definition",
            at(&a_app, CONSUMER, "title\n")
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    // draft is an ordinary authored directory, never categorically excluded.
    std::fs::create_dir(a.path().join("draft")).unwrap();
    std::fs::rename(a.path().join("p.can"), a.path().join("draft/p.can")).unwrap();
    watch(&mut server, &a.path().join("draft/p.can"), 1);
    assert_eq!(
        request(
            &mut server,
            "textDocument/definition",
            at(&a_app, CONSUMER, "title\n")
        )[0]["uri"],
        uri(&a.path().join("draft/p.can"))
    );
}

#[test]
fn ambiguous_imports_are_diagnosed_without_guessing_a_provider() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("a.can");
    std::fs::write(root.path().join("one.can"), PROVIDER).unwrap();
    std::fs::write(root.path().join("two.can"), PROVIDER).unwrap();
    std::fs::write(&app, CONSUMER).unwrap();
    let mut server = server(&[root.path()]);
    open(&mut server, &app, CONSUMER, 1);
    assert!(
        diagnostics(&mut server)[0]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "E2002"
                && item["message"]
                    .as_str()
                    .unwrap()
                    .contains("multiple declarations"))
    );
    assert!(
        request(
            &mut server,
            "textDocument/definition",
            at(&app, CONSUMER, "title\n")
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    let mut rename = at(&app, CONSUMER, "title\n");
    rename["newName"] = json!("summary");
    assert!(request(&mut server, "textDocument/rename", rename).is_null());
}

#[test]
fn failed_source_intake_is_visible_and_does_not_supply_partial_projects() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("a.can");
    std::fs::write(&app, CONSUMER).unwrap();
    std::fs::write(root.path().join("invalid.can"), [255]).unwrap();
    let mut server = server(&[root.path()]);
    open(&mut server, &app, CONSUMER, 1);
    assert!(
        diagnostics(&mut server)[0]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "E7002"
                && item["message"]
                    .as_str()
                    .unwrap()
                    .contains("cannot read workspace source"))
    );
}

#[test]
fn nested_folders_are_separate_import_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let child = root.path().join("nested");
    std::fs::create_dir(&child).unwrap();
    let app = root.path().join("a.can");
    let nested_app = child.join("a.can");
    std::fs::write(&app, CONSUMER).unwrap();
    std::fs::write(&nested_app, CONSUMER).unwrap();
    std::fs::write(child.join("p.can"), PROVIDER).unwrap();
    let mut server = server(&[root.path(), &child]);
    open(&mut server, &app, CONSUMER, 1);
    open(&mut server, &nested_app, CONSUMER, 1);
    assert!(
        request(
            &mut server,
            "textDocument/definition",
            at(&app, CONSUMER, "title\n")
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        request(
            &mut server,
            "textDocument/definition",
            at(&nested_app, CONSUMER, "title\n")
        )[0]["uri"],
        uri(&child.join("p.can"))
    );
    std::fs::write(root.path().join("p.can"), PROVIDER).unwrap();
    watch(&mut server, &root.path().join("p.can"), 1);
    assert_eq!(
        request(
            &mut server,
            "textDocument/definition",
            at(&app, CONSUMER, "title\n")
        )[0]["uri"],
        uri(&root.path().join("p.can"))
    );
}

#[test]
fn root_catalogs_do_not_leak_and_watched_updates_reload() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let catalog = |name: &str| {
        json!({"language_version":"1.0","catalog_version":"workspace-test","entries":[{"id":name,"js":name,"owner":"test","kind":"builtin","signature":format!("{name}(value:int)->int"),"effects":"pure","availability":"implemented"}]}).to_string()
    };
    std::fs::write(a.path().join("can-catalog.json"), catalog("left_only")).unwrap();
    std::fs::write(b.path().join("can-catalog.json"), catalog("right_only")).unwrap();
    let text = "app A\nGiven\nWhen\n scenario s() by=members\n  do\n   let n=left_only(1)\nThen\n";
    let a_app = a.path().join("a.can");
    let b_app = b.path().join("b.can");
    std::fs::write(&a_app, text).unwrap();
    std::fs::write(&b_app, text).unwrap();
    let mut server = Server::new(RealAnalysis::from_process());
    request(
        &mut server,
        "initialize",
        json!({"processId":null,"rootUri":uri(a.path()),"workspaceFolders":[{"uri":uri(a.path()),"name":"a"},{"uri":uri(b.path()),"name":"b"}],"capabilities":{}}),
    );
    open(&mut server, &a_app, text, 1);
    open(&mut server, &b_app, text, 1);
    let initial = diagnostics(&mut server);
    assert!(
        !initial
            .iter()
            .find(|item| item["uri"] == uri(&a_app))
            .unwrap()["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["severity"] == 1),
        "{initial:?}"
    );
    assert!(
        initial
            .iter()
            .find(|item| item["uri"] == uri(&b_app))
            .unwrap()["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "E2001"),
        "{initial:?}"
    );
    let left = request(
        &mut server,
        "textDocument/completion",
        at(&a_app, text, "left_only"),
    );
    let right = request(
        &mut server,
        "textDocument/completion",
        at(&b_app, text, "left_only"),
    );
    assert!(
        left.as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "left_only")
    );
    assert!(
        !left
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "right_only")
    );
    assert!(
        right
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "right_only")
    );
    assert!(
        !right
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "left_only")
    );
    std::fs::write(a.path().join("can-catalog.json"), catalog("replacement")).unwrap();
    watch(&mut server, &a.path().join("can-catalog.json"), 2);
    let reloaded = request(
        &mut server,
        "textDocument/completion",
        at(&a_app, text, "left_only"),
    );
    assert!(
        reloaded
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "replacement")
    );
    assert!(
        !reloaded
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "left_only")
    );
}

#[test]
fn oversized_sources_report_the_explicit_workspace_limit() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("a.can");
    std::fs::write(&app, CONSUMER).unwrap();
    // Metadata rejects this sparse file before its contents are allocated.
    std::fs::File::create(root.path().join("huge.can"))
        .unwrap()
        .set_len(65 * 1024 * 1024)
        .unwrap();
    let mut server = server(&[root.path()]);
    open(&mut server, &app, CONSUMER, 1);
    assert!(
        diagnostics(&mut server)[0]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "E7002"
                && item["message"].as_str().unwrap().contains("64 MiB"))
    );
}

#[test]
fn unopened_imported_errors_publish_at_owner_and_clear_after_repair_and_deletion() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("a.can");
    let provider = root.path().join("p.can");
    std::fs::write(&app, CONSUMER).unwrap();
    std::fs::write(&provider, PROVIDER.replace("title:text", "title:Missing")).unwrap();
    std::fs::write(
        root.path().join("unrelated.can"),
        "app Unrelated\nGiven\n Bad {n:Missing}\nWhen\nThen\n",
    )
    .unwrap();
    let mut server = server(&[root.path()]);
    open(&mut server, &app, CONSUMER, 6);
    let initial = diagnostics(&mut server);
    let closed = initial
        .iter()
        .find(|item| item["uri"] == uri(&provider))
        .expect("imported closed owner diagnostic");
    assert!(closed.get("version").is_none(), "{closed:?}");
    assert!(
        closed["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E2001")
    );
    assert!(
        !initial
            .iter()
            .any(|item| item["uri"] == uri(&root.path().join("unrelated.can")))
    );
    assert_eq!(
        initial
            .iter()
            .find(|item| item["uri"] == uri(&app))
            .unwrap()["version"],
        6
    );
    std::fs::write(&provider, PROVIDER).unwrap();
    watch(&mut server, &provider, 2);
    let repaired = diagnostics(&mut server);
    assert!(
        repaired
            .iter()
            .find(|item| item["uri"] == uri(&provider))
            .unwrap()["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    std::fs::remove_file(&provider).unwrap();
    watch(&mut server, &provider, 3);
    let removed = diagnostics(&mut server);
    let clear = removed
        .iter()
        .find(|item| item["uri"] == uri(&provider))
        .expect("deleted closed owner clear");
    assert!(clear.get("version").is_none());
    assert!(clear["diagnostics"].as_array().unwrap().is_empty());
    std::fs::write(&provider, PROVIDER.replace("title:text", "title:Missing")).unwrap();
    watch(&mut server, &provider, 1);
    diagnostics(&mut server);
    notify(
        &mut server,
        "textDocument/didClose",
        json!({"textDocument":{"uri":uri(&app)}}),
    );
    let abandoned = diagnostics(&mut server);
    assert!(
        abandoned
            .iter()
            .find(|item| item["uri"] == uri(&provider))
            .unwrap()["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "closing the last active consumer clears its closed project"
    );
}
