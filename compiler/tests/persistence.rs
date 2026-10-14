//! Repository-level persistence: real Git operations and the public compiler.
use canlang_compiler::{
    analysis::generation::discover_generation,
    cli::{self, Analyzer, CatalogAnalyzer, OwnedAnalysis},
    source::{SourceDb, SourceId, sha256_hex},
    syntax::parse_source,
};
use serde_json::{Value, json};
use std::{path::Path, process::Command};

const APP: &str = "app Demo\nGiven\n Item {title:text}\nWhen\nThen\n style Surface $\"Calm surface\"\n page / title=\"Demo\" $Surface\n  text \"hello\"\n";
const CATALOG: &str = r#"{"language_version":"1.0","catalog_version":"1.0.0","entries":[]}"#;
fn write(root: &Path, path: &str, bytes: impl AsRef<[u8]>) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}
fn request(root: &Path, body: Value) -> cli::DispatchResult {
    write(root, ".request.json", serde_json::to_vec(&body).unwrap());
    cli::dispatch(&[
        "can".into(),
        "gen".into(),
        "--request".into(),
        root.join(".request.json").display().to_string(),
    ])
}
fn bind(root: &Path, file: &str, label: &str, unit: &str, copy: Option<&str>) -> String {
    let text = std::fs::read_to_string(root.join(file)).unwrap();
    let (tree, _) = parse_source(SourceId(0), &text);
    let found = discover_generation(&tree, &text);
    let d = found
        .descriptors
        .iter()
        .find(|d| d.has_generation_identity && d.label.as_deref() == Some(label))
        .unwrap();
    let mut body = json!({"version":1,"request_id":"binding","operation":"bind","root":root,"file":file,"start":d.span.start,"end":d.span.end,"revision":sha256_hex(text.as_bytes()),"unit":unit});
    if let Some(copy) = copy {
        body["copy_from"] = json!(copy);
    }
    let result = request(root, body);
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    serde_json::from_str::<Value>(&result.stdout).unwrap()["unit"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}
fn fixture(root: &Path) -> String {
    write(root, "App.can", APP);
    write(root, "catalog.json", CATALOG);
    write(root, ".gitignore", ".can/\n.request.json\n");
    let id = bind(root, "App.can", "Surface", "new", None);
    write(
        root,
        &format!("can.generated/{id}/style.css"),
        ".tile { color: red; } /* manual edit */\n",
    );
    write(
        root,
        &format!("can.generated/{id}/assets/icon.bin"),
        [0, 255, 128, 10, 0],
    );
    id
}
fn args(root: &Path, file: &str) -> Vec<String> {
    vec![
        "can".into(),
        "compile".into(),
        "--format=json".into(),
        format!("--catalog={}", root.join("catalog.json").display()),
        format!("--generation-root={}", root.display()),
        root.join(file).display().to_string(),
    ]
}
fn compile(root: &Path, file: &str) -> cli::DispatchResult {
    cli::dispatch(&args(root, file))
}
fn git(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "user.name=Persistence Test",
            "-c",
            "user.email=persistence@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap()
}
fn git_ok(root: &Path, args: &[&str]) {
    let result = git(root, args);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn tracked_clone_and_history_free_copy_build_without_generation() {
    let repo = tempfile::tempdir().unwrap();
    let id = fixture(repo.path());
    git_ok(repo.path(), &["init", "-q", "-b", "main"]);
    git_ok(repo.path(), &["add", "."]);
    git_ok(repo.path(), &["commit", "-qm", "saved output"]);
    let clone_parent = tempfile::tempdir().unwrap();
    let clone = clone_parent.path().join("clone");
    git_ok(
        repo.path(),
        &[
            "clone",
            "--quiet",
            "--no-hardlinks",
            repo.path().to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    for history in [true, false] {
        if !history {
            std::fs::remove_dir_all(clone.join(".git")).unwrap();
        }
        let built = compile(&clone, "App.can");
        assert_eq!(built.code, 0, "{} {}", built.stdout, built.stderr);
        assert!(built.stdout.contains("red"));
        assert_eq!(
            std::fs::read(clone.join(format!("can.generated/{id}/assets/icon.bin"))).unwrap(),
            [0, 255, 128, 10, 0]
        );
        assert_eq!(std::fs::read_to_string(clone.join("App.can")).unwrap(), APP);
    }
}

#[test]
fn deliberate_move_and_copy_preserve_current_bytes_and_clean_source() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    let original = std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap();
    std::fs::create_dir(root.join("pages")).unwrap();
    std::fs::rename(root.join("App.can"), root.join("pages/Main.can")).unwrap();
    assert_eq!(bind(root, "pages/Main.can", "Surface", &id, None), id);
    let moved = compile(root, "pages/Main.can");
    assert_eq!(moved.code, 0, "{} {}", moved.stdout, moved.stderr);
    let copy = APP
        .replace("style Surface", "style Duplicate")
        .replace("$Surface", "$Duplicate")
        .replace("app Demo", "app Copy");
    write(root, "Copy.can", &copy);
    let fork = bind(root, "Copy.can", "Duplicate", "new", Some(&id));
    assert_ne!(fork, id);
    assert!(fork.starts_with("g-") && fork.len() == 34);
    for unit in [&id, &fork] {
        assert_eq!(
            std::fs::read(root.join(format!("can.generated/{unit}/style.css"))).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read(root.join(format!("can.generated/{unit}/assets/icon.bin"))).unwrap(),
            [0, 255, 128, 10, 0]
        );
    }
    let built = compile(root, "Copy.can");
    assert_eq!(built.code, 0, "{} {}", built.stdout, built.stderr);
    assert_eq!(
        std::fs::read_to_string(root.join("Copy.can")).unwrap(),
        copy
    );
    assert_eq!(
        std::fs::read_to_string(root.join("pages/Main.can")).unwrap(),
        APP
    );
}

#[test]
fn plain_copy_and_conflicting_saved_claims_refuse_without_touching_code() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    let record = std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap();
    let css = std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap();
    write(root, "Copy.can", APP);
    let result = compile(root, "Copy.can");
    assert_ne!(result.code, 0);
    assert!(
        result.stdout.contains("ambiguous"),
        "{} {}",
        result.stdout,
        result.stderr
    );
    assert_eq!(
        std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap(),
        record
    );
    assert_eq!(
        std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap(),
        css
    );
}

#[test]
fn independent_git_additions_merge_and_conflicting_records_fail_closed() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    git_ok(root, &["init", "-q", "-b", "main"]);
    git_ok(root, &["add", "."]);
    git_ok(root, &["commit", "-qm", "base"]);
    git_ok(root, &["checkout", "-qb", "left"]);
    write(root, "Left.can", APP.replace("app Demo", "app Left"));
    let left = bind(root, "Left.can", "Surface", "new", Some(&id));
    git_ok(root, &["add", "."]);
    git_ok(root, &["commit", "-qm", "left addition"]);
    git_ok(root, &["checkout", "-qb", "right", "main"]);
    write(root, "Right.can", APP.replace("app Demo", "app Right"));
    let right = bind(root, "Right.can", "Surface", "new", Some(&id));
    assert_ne!(left, right);
    git_ok(root, &["add", "."]);
    git_ok(root, &["commit", "-qm", "right addition"]);
    git_ok(root, &["merge", "--no-edit", "left"]);
    for source in ["App.can", "Left.can", "Right.can"] {
        let result = compile(root, source);
        assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    }
    // A textually clean merge can still introduce two claims for one owner.
    let mut duplicated: Value = serde_json::from_slice(
        &std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap(),
    )
    .unwrap();
    duplicated["id"] = json!("legacy_copy");
    write(
        root,
        "can.generated/legacy_copy/unit.json",
        serde_json::to_vec(&duplicated).unwrap(),
    );
    write(
        root,
        "can.generated/legacy_copy/style.css",
        ".tile { color: blue; }",
    );
    let before = std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap();
    let result = compile(root, "App.can");
    assert_ne!(result.code, 0);
    assert!(
        result.stdout.contains("ambiguous"),
        "{} {}",
        result.stdout,
        result.stderr
    );
    assert_eq!(
        std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap(),
        before
    );
}

#[test]
fn compilation_uses_frozen_saved_bytes_and_unresolved_journals_refuse() {
    struct EditingAnalyzer {
        inner: CatalogAnalyzer,
        css: std::path::PathBuf,
    }
    impl Analyzer for EditingAnalyzer {
        fn analyze(
            &self,
            db: &SourceDb,
            version: &str,
        ) -> canlang_compiler::diagnostic::DiagnosticResult {
            self.analyze_owned(db, version).result
        }
        fn analyze_owned(&self, db: &SourceDb, version: &str) -> OwnedAnalysis {
            std::fs::write(&self.css, ".tile { color: blue; }").unwrap();
            self.inner.analyze_owned(db, version)
        }
    }
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    let analyzer = EditingAnalyzer {
        inner: CatalogAnalyzer::new(Some(root.join("catalog.json")), None, root.to_path_buf()),
        css: root.join(format!("can.generated/{id}/style.css")),
    };
    let result = cli::dispatch_with(&args(root, "App.can"), &analyzer);
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    assert!(result.stdout.contains("red"));
    assert!(!result.stdout.contains("color: blue"));
    write(root, ".can/gen/runs/interrupted/journal.json", "{}");
    let result = compile(root, "App.can");
    assert_ne!(result.code, 0);
    assert!(
        result.stderr.contains("unresolved"),
        "{} {}",
        result.stdout,
        result.stderr
    );
}

#[test]
fn actual_conflicting_git_merge_preserves_code_and_refuses_build() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    git_ok(root, &["init", "-q", "-b", "main"]);
    git_ok(root, &["add", "."]);
    git_ok(root, &["commit", "-qm", "base"]);
    let record_path = format!("can.generated/{id}/unit.json");
    let css = std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap();
    for (branch, path) in [("left", "Left.can"), ("right", "Right.can")] {
        git_ok(root, &["checkout", "-qb", branch, "main"]);
        let mut record: Value =
            serde_json::from_slice(&std::fs::read(root.join(&record_path)).unwrap()).unwrap();
        record["source"]["path"] = json!(path);
        write(
            root,
            &record_path,
            serde_json::to_vec_pretty(&record).unwrap(),
        );
        git_ok(root, &["add", "."]);
        git_ok(root, &["commit", "-qm", "relocate binding"]);
    }
    assert!(!git(root, &["merge", "--no-edit", "left"]).status.success());
    let conflict = std::fs::read(root.join(&record_path)).unwrap();
    assert!(String::from_utf8_lossy(&conflict).contains("<<<<<<<"));
    let result = compile(root, "App.can");
    assert_ne!(result.code, 0);
    assert!(
        result.stderr.contains("unit.json"),
        "{} {}",
        result.stdout,
        result.stderr
    );
    assert_eq!(std::fs::read(root.join(&record_path)).unwrap(), conflict);
    assert_eq!(
        std::fs::read(root.join(format!("can.generated/{id}/style.css"))).unwrap(),
        css
    );
}

#[test]
fn anonymous_saved_styles_survive_outside_edits_and_refuse_insertions() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let source = "app Demo\nGiven\n Item {title:text}\nWhen\nThen\n page / title=\"Demo\"\n  card \"Same\" $\"Quiet\"\n   text \"one\"\n  card \"Same\" $\"Quiet\"\n   text \"two\"\n";
    write(root, "App.can", source);
    write(root, "catalog.json", CATALOG);
    let (tree, _) = parse_source(SourceId(0), source);
    let found = discover_generation(&tree, source);
    let mut ids = Vec::new();
    for descriptor in found
        .descriptors
        .iter()
        .filter(|d| d.has_generation_identity)
    {
        let result = request(
            root,
            json!({"version":1,"request_id":"bind","operation":"bind","root":root,"file":"App.can","start":descriptor.span.start,"end":descriptor.span.end,"revision":sha256_hex(source.as_bytes()),"unit":"new"}),
        );
        assert_eq!(result.code, 0, "{}", result.stdout);
        let id = serde_json::from_str::<Value>(&result.stdout).unwrap()["unit"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        write(
            root,
            &format!("can.generated/{id}/style.css"),
            format!(
                ".tile {{ color: {}; }}",
                if ids.is_empty() { "red" } else { "blue" }
            ),
        );
        ids.push(id);
    }
    assert_eq!(ids.len(), 2);
    let outside = source.replace(
        "Given\n",
        "## ordinary documentation\nGiven\n Extra {value:text}\n",
    );
    write(root, "App.can", &outside);
    let result = compile(root, "App.can");
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    let artifact: Value = serde_json::from_str(&result.stdout).unwrap();
    assert_eq!(artifact["stylesheets"].as_array().unwrap().len(), 2);
    let records = ids
        .iter()
        .map(|id| std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap())
        .collect::<Vec<_>>();
    write(
        root,
        "App.can",
        outside.replace(
            "  card \"Same\"",
            "  card \"Same\" $\"Quiet\"\n   text \"inserted\"\n  card \"Same\"",
        ),
    );
    let result = compile(root, "App.can");
    assert_ne!(result.code, 0);
    assert!(
        result.stdout.contains("ambiguous"),
        "{} {}",
        result.stdout,
        result.stderr
    );
    for (id, before) in ids.iter().zip(records) {
        assert_eq!(
            std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap(),
            before
        );
    }
}

#[test]
fn formatted_occupied_slot_and_pending_output_never_create_or_synthesize_code() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    let record = std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap();
    let source = format!("## formatting edit\n{APP}");
    write(root, "App.can", &source);
    let (tree, _) = parse_source(SourceId(0), &source);
    let found = discover_generation(&tree, &source);
    let d = found
        .descriptors
        .iter()
        .find(|d| d.has_generation_identity)
        .unwrap();
    let result = request(
        root,
        json!({"version":1,"request_id":"bind-again","operation":"bind","root":root,"file":"App.can","start":d.span.start,"end":d.span.end,"revision":sha256_hex(source.as_bytes()),"unit":"new"}),
    );
    assert_ne!(result.code, 0);
    assert!(
        result.stdout.contains("occupied-binding"),
        "{}",
        result.stdout
    );
    assert_eq!(
        canlang_compiler::analysis::generation_intake::scan_unit_ids(root).unwrap(),
        vec![id.clone()]
    );
    assert_eq!(
        std::fs::read(root.join(format!("can.generated/{id}/unit.json"))).unwrap(),
        record
    );
    std::fs::remove_file(root.join(format!("can.generated/{id}/style.css"))).unwrap();
    let result = compile(root, "App.can");
    assert_ne!(result.code, 0);
    assert!(
        result.stdout.contains("no saved `style.css`"),
        "{} {}",
        result.stdout,
        result.stderr
    );
}

#[test]
fn separate_output_roots_qualify_the_same_legacy_id() {
    let repo = tempfile::tempdir().unwrap();
    let first = repo.path().join("first");
    let second = repo.path().join("second");
    let mut files = Vec::new();
    for (root, name) in [(&first, "One"), (&second, "Two")] {
        let id = fixture(root);
        write(
            root,
            "App.can",
            APP.replace("app Demo", &format!("app {name}")),
        );
        bind(root, "App.can", "Surface", &id, None);
        let from = root.join(format!("can.generated/{id}"));
        let to = root.join("can.generated/u1");
        std::fs::rename(from, &to).unwrap();
        let mut record: Value =
            serde_json::from_slice(&std::fs::read(to.join("unit.json")).unwrap()).unwrap();
        record["id"] = json!("u1");
        write(
            root,
            "can.generated/u1/unit.json",
            serde_json::to_vec(&record).unwrap(),
        );
        files.push(root.join("App.can").display().to_string());
    }
    let mut argv = vec![
        "can".into(),
        "compile".into(),
        "--format=json".into(),
        format!("--catalog={}", first.join("catalog.json").display()),
    ];
    argv.extend(files);
    let result = cli::dispatch(&argv);
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    let artifact: Value = serde_json::from_str(&result.stdout).unwrap();
    let ids = artifact["stylesheets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["owner"]["unitId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["r0-u1", "r1-u1"]);
}

#[cfg(unix)]
#[test]
fn unresolved_saved_membership_blocks_allocation_and_preserves_bytes() {
    use std::os::unix::fs::symlink;
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    let id = fixture(root);
    let group = root.join(format!("can.generated/{id}"));
    let saved = root.join("saved-before-review");
    std::fs::rename(&group, &saved).unwrap();
    symlink(&saved, &group).unwrap();
    let original = std::fs::read(saved.join("style.css")).unwrap();
    let record = std::fs::read(saved.join("unit.json")).unwrap();
    let (tree, _) = parse_source(SourceId(0), APP);
    let discovered = discover_generation(&tree, APP);
    let descriptor = discovered
        .descriptors
        .iter()
        .find(|d| d.has_generation_identity)
        .unwrap();
    for symlink_record in [false, true] {
        if symlink_record {
            std::fs::remove_file(&group).unwrap();
            std::fs::rename(&saved, &group).unwrap();
            let saved_record = root.join("record-before-review.json");
            std::fs::rename(group.join("unit.json"), &saved_record).unwrap();
            symlink(saved_record, group.join("unit.json")).unwrap();
        }
        let status = request(
            root,
            json!({"version":1,"request_id":"unresolved-status","operation":"status","root":root,"files":[root.join("App.can")]}),
        );
        assert_eq!(status.code, 0, "{}", status.stdout);
        let report: Value = serde_json::from_str(&status.stdout).unwrap();
        assert!(
            !report["issues"].as_array().unwrap().is_empty(),
            "{}",
            status.stdout
        );
        let attempted = request(
            root,
            json!({"version":1,"request_id":"unresolved-bind","operation":"bind","root":root,"file":"App.can","start":descriptor.span.start,"end":descriptor.span.end,"revision":sha256_hex(APP.as_bytes()),"unit":"new"}),
        );
        assert_ne!(attempted.code, 0, "{}", attempted.stdout);
        assert_ne!(compile(root, "App.can").code, 0);
        assert_eq!(std::fs::read(group.join("style.css")).unwrap(), original);
        assert_eq!(std::fs::read(group.join("unit.json")).unwrap(), record);
        assert_eq!(
            std::fs::read_dir(root.join("can.generated"))
                .unwrap()
                .count(),
            1
        );
    }
}
