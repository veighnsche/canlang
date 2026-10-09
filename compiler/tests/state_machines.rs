//! Field lifecycle syntax, static write protection and the generated runtime join.
use canlang_compiler::analysis::check_program;
use canlang_compiler::format::format_source;
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::syntax::{SyntaxKind, parse_source};
use std::path::PathBuf;
use std::process::Command;

fn diagnostics(source: &str) -> Vec<canlang_compiler::diagnostic::Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("machine.can".into(), source.into());
    check_program(&db, &[id], None).1
}
fn app(field: &str, statement: &str) -> String {
    format!(
        "app Images\nGiven\n Job {{ {field} }}\nWhen\n scenario advance(job:Job) by=public\n  do\n   {statement}\nThen\n"
    )
}
#[test]
fn checked_machine_requires_stored_scalar_enum_and_constant_initial_case() {
    for field in [
        "status:text=\"idle\" machine",
        "status:enum(idle,ready)?=idle machine",
        "status:enum(idle,ready) machine",
        "status:enum(idle,ready)[]= [] machine",
    ] {
        let ds = diagnostics(&app(field, "return"));
        assert!(ds.iter().any(|d| d.code == "E3012"), "{field}: {ds:?}");
    }
    let source =
        "app Images\nGiven\nWhen\nThen\n preferences { status:enum(idle,ready)=idle machine }\n";
    assert!(diagnostics(source).iter().any(|d| d.code == "E3012"));
}
#[test]
fn transition_checks_field_and_endpoints_and_rejects_plain_writes() {
    let field = "status:enum(idle,queued,ready)=idle machine";
    let clean = app(
        field,
        "transition job.status idle -> queued\n   transition job.status queued -> ready",
    );
    assert!(diagnostics(&clean).is_empty(), "{:?}", diagnostics(&clean));
    for statement in [
        "transition job.status absent -> ready",
        "transition job.status idle -> absent",
        "transition job.other idle -> ready",
        "set job {status=ready}",
        "create Job {status=idle} as made",
    ] {
        assert!(
            diagnostics(&app(field, statement))
                .iter()
                .any(|d| d.code == "E3001"),
            "{statement}"
        );
    }
    assert!(
        diagnostics(&app(
            "status:enum(idle,ready)=idle",
            "transition job.status idle -> ready"
        ))
        .iter()
        .any(|d| d.code == "E3001")
    );
    let crud = format!(
        "app Images\nGiven\n Job {{ {field} }}\nWhen\n crud Job by=public fields=status\nThen\n"
    );
    assert!(diagnostics(&crud).iter().any(|d| d.code == "E3009"));
    let read = clean.replace(") by=public", ") read=true by=public");
    assert!(
        !diagnostics(&read).is_empty(),
        "read scenarios cannot transition"
    );
}
#[test]
fn formatter_preserves_transition_tokens_and_nested_target() {
    let source = app(
        "status:enum(idle,ready)=idle machine",
        "transition job . status idle->ready",
    );
    let (before, ds) = parse_source(SourceId(0), &source);
    assert!(ds.is_empty(), "{ds:?}");
    let formatted = format_source(SourceId(0), &source).unwrap();
    let (after, ds) = parse_source(SourceId(0), &formatted.text);
    assert!(ds.is_empty());
    let leaves = |tree: &canlang_compiler::syntax::SyntaxNode, text: &str| {
        tree.leaves()
            .filter(|n| n.kind != SyntaxKind::Trivia)
            .map(|n| (n.kind, n.text(text).to_owned()))
            .collect::<Vec<_>>()
    };
    assert_eq!(leaves(&before, &source), leaves(&after, &formatted.text));
    assert_eq!(
        format_source(SourceId(0), &formatted.text).unwrap().text,
        formatted.text
    );
}
#[test]
fn compiled_lifecycle_runs_through_canonical_runtime_and_state_driven_ui() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for dependency in [
        "packages/values/dist/catalog.json",
        "packages/cloudflare/dist/runtime/artifact.js",
        "packages/ui/dist/src/index.js",
    ] {
        assert!(
            root.join(dependency).exists(),
            "build producer prerequisite: {dependency}"
        );
    }
    let dir = std::env::temp_dir().join(format!("can-state-machine-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("Images.can");
    std::fs::write(
        &source,
        r#"app Images
Given
 Job { title:text="test", status:enum(idle,queued,generating,ready,failed)=idle machine, private_choice:bool=false, public_choice:bool? }
 policy Job read=public fields=title,status,public_choice
When
 crud Job by=public fields=title,private_choice,public_choice
 scenario advance(job:Job) by=public
  do
   let alias=job
   transition job.status idle -> queued
   require job.status==queued and alias.status==queued
   transition job.status queued -> generating
   require job.status==generating
 scenario finish(job:Job) by=public
  do transition job.status generating -> ready
 scenario rollback(job:Job) by=public
  do
   transition job.status idle -> queued
   transition job.status idle -> queued
 scenario branch(job:Job,pass:bool) by=public
  do
   if pass
    transition job.status generating -> ready
   else
    transition job.status generating -> failed
 scenario defaults(job:Job,selected:bool=true) by=public
  do
   if selected
    transition job.status idle -> ready
 scenario private_defaults(job:Job,selected:bool=job.private_choice) -> int by=public
  do
   if selected
    transition job.status idle -> ready
   return 7
 scenario public_defaults(job:Job,selected:bool=job.public_choice ?? false) -> int by=public
  do
   if selected
    transition job.status idle -> ready
   return 7
 scenario optional(job:Job) by=public
  do
   if job.private_choice
    transition job.status idle -> ready
 scenario optional_scalar(job:Job) -> int by=public
  do
   if job.private_choice
    transition job.status idle -> ready
   return 7
Then
 page / title="Images" poll=2s
  list Job empty="No jobs yet"
   alert
    require row.status==generating
    text "Generating"
   alert
    require row.status==ready
    text "Image ready"
"#,
    )
    .unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = dir.join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let checked = Command::new("node")
        .arg(root.join("compiler/tests/fixtures/state-machine-consumer.mjs"))
        .arg(&root)
        .arg(&artifact)
        .arg(&dir)
        .output()
        .unwrap();
    assert!(
        checked.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&checked.stdout),
        String::from_utf8_lossy(&checked.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&checked.stdout));
    std::fs::remove_dir_all(dir).unwrap();
}
