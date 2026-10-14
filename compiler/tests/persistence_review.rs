//! Focused regressions for whole-scope legacy ownership and frozen source paths.
use canlang_compiler::{
    analysis::generation::discover_generation,
    cli::{self, Analyzer, CatalogAnalyzer, OwnedAnalysis},
    source::{SourceDb, SourceId, sha256_hex},
    syntax::parse_source,
};
use serde_json::json;
use std::path::{Path, PathBuf};

const APP: &str = "app Demo\nGiven\n Item {title:text}\nWhen\nThen\n style Surface $\"Calm surface\"\n page / title=\"Demo\" $Surface\n  text \"hello\"\n";
const CATALOG: &str = r#"{"language_version":"1.0","catalog_version":"1.0.0","entries":[]}"#;

fn args(root: &Path, source: &str) -> Vec<String> {
    vec![
        "can".into(),
        "compile".into(),
        "--format=json".into(),
        format!("--catalog={}", root.join("catalog.json").display()),
        format!("--generation-root={}", root.display()),
        root.join(source).display().to_string(),
    ]
}

#[test]
fn legacy_fallback_refuses_multiple_current_source_claims() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::write(root.join("App.can"), APP).unwrap();
    std::fs::write(root.join("Copy.can"), APP).unwrap();
    std::fs::write(root.join("catalog.json"), CATALOG).unwrap();
    let group = root.join("can.generated/u1");
    std::fs::create_dir_all(&group).unwrap();
    let record = json!({"unit_id":"u1","kind":"style","label":"Surface","prompt":"Calm surface"})
        .to_string();
    std::fs::write(group.join("unit.json"), &record).unwrap();
    let css = ".tile { color: red; }";
    std::fs::write(group.join("style.css"), css).unwrap();
    let result = cli::dispatch(&args(root, "Copy.can"));
    assert_ne!(result.code, 0, "{} {}", result.stdout, result.stderr);
    assert!(
        result.stdout.contains("ambiguous legacy source claims"),
        "{} {}",
        result.stdout,
        result.stderr
    );
    assert_eq!(
        std::fs::read_to_string(group.join("unit.json")).unwrap(),
        record
    );
    assert_eq!(
        std::fs::read_to_string(group.join("style.css")).unwrap(),
        css
    );
}

#[test]
fn frozen_build_survives_source_rename_after_analysis_starts() {
    check_frozen_source_rename(false);
}

#[cfg(unix)]
#[test]
fn frozen_build_preserves_symlink_operand_mapping_after_source_rename() {
    check_frozen_source_rename(true);
}

fn check_frozen_source_rename(use_alias: bool) {
    struct RenamingAnalyzer {
        inner: CatalogAnalyzer,
        source: PathBuf,
        moved: PathBuf,
    }
    impl Analyzer for RenamingAnalyzer {
        fn analyze(
            &self,
            db: &SourceDb,
            version: &str,
        ) -> canlang_compiler::diagnostic::DiagnosticResult {
            self.analyze_owned(db, version).result
        }
        fn analyze_owned(&self, db: &SourceDb, version: &str) -> OwnedAnalysis {
            std::fs::rename(&self.source, &self.moved).unwrap();
            self.inner.analyze_owned(db, version)
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::write(root.join("App.can"), APP).unwrap();
    std::fs::write(root.join("catalog.json"), CATALOG).unwrap();
    let (tree, _) = parse_source(SourceId(0), APP);
    let found = discover_generation(&tree, APP);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.has_generation_identity)
        .unwrap();
    let request = json!({"version":1,"request_id":"bind","operation":"bind","root":root,"file":"App.can","start":descriptor.span.start,"end":descriptor.span.end,"revision":sha256_hex(APP.as_bytes()),"unit":"new"});
    let request_path = root.join("request.json");
    std::fs::write(&request_path, request.to_string()).unwrap();
    let result = cli::dispatch(&[
        "can".into(),
        "gen".into(),
        "--request".into(),
        request_path.display().to_string(),
    ]);
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    let result_json: serde_json::Value = serde_json::from_str(&result.stdout).unwrap();
    let id = result_json["unit"]["id"].as_str().unwrap();
    std::fs::write(
        root.join(format!("can.generated/{id}/style.css")),
        ".tile { color: red; }",
    )
    .unwrap();
    #[cfg(unix)]
    if use_alias {
        std::os::unix::fs::symlink("App.can", root.join("Alias.can")).unwrap();
    }
    let analyzer = RenamingAnalyzer {
        inner: CatalogAnalyzer::new(Some(root.join("catalog.json")), None, root.to_path_buf()),
        source: root.join("App.can"),
        moved: root.join("Moved.can"),
    };
    let result = cli::dispatch_with(
        &args(root, if use_alias { "Alias.can" } else { "App.can" }),
        &analyzer,
    );
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    assert!(result.stdout.contains("red"));
}
