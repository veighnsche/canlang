//! Actual checked source emission; native observation authority has its owning join.
use canlang_compiler::analysis::catalog::{Availability, Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::io::Write;
use std::process::{Command, Stdio};

const SOURCE: &str = "app Membership\nGiven\n Person {account:user}\n event Received {person:user}\n derive can_use(person:user?):bool = person!=null and active_member(person,team)\n policy Person read=can_use(actor)\nWhen\n scenario run(person:user) -> bool by=members\n  require can_use(person)\n  do return true\n scenario observed on=Received\n  do\n   if not active_member(event.person,team)\n    require false\nThen\n page /people title=\"People\"\n  list Person as person where can_use(person.account)\n   text row.account\n";

fn checked() -> (SourceDb, Catalog, CheckedProgram) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let file = db.add("membership.can".into(), SOURCE.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, catalog, program)
}

#[test]
fn checked_membership_emits_exact_source_arguments_and_true_site_stages() {
    let (db, catalog, program) = checked();
    let mut result = DiagnosticResult::new("membership", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.complete = true;
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    if catalog.lookup("active_member").unwrap().availability == Availability::External {
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert_eq!(diagnostics[0].code, "E6007", "{diagnostics:?}");
    } else {
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
    let emitted = &artifact.modules[0].js;
    assert!(
        emitted.contains("export function canMembershipSources()"),
        "{emitted}"
    );
    assert!(emitted.contains("read-policy"), "{emitted}");
    assert!(emitted.contains("read-predicate"), "{emitted}");
    assert!(emitted.contains("body-condition"), "{emitted}");
    assert!(emitted.contains("leading-require"), "{emitted}");
    assert!(emitted.contains("Membership.Person.read.1"), "{emitted}");
    assert!(emitted.contains("await active_member(c,"), "{emitted}");
    let file = db.iter().next().unwrap().1;
    for original in [
        "active_member(person,team)",
        "active_member(event.person,team)",
    ] {
        let node = program
            .types
            .selected_calls
            .keys()
            .find(|node| SOURCE[node.start as usize..node.end as usize].trim() == original)
            .unwrap();
        let metadata = serde_json::json!({
            "source":{"path":file.path,"sha256":file.sha256,"module":"Membership"},
            "node":{"start":node.start,"end":node.end},
        });
        assert!(
            emitted.contains(&metadata.to_string()),
            "{metadata}: {emitted}"
        );
    }
    let mut node = Command::new("node")
        .args(["--check", "--input-type=module"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(emitted.as_bytes())
        .unwrap();
    let node = node.wait_with_output().unwrap();
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
}

#[test]
fn raw_ir_keeps_the_missing_checked_membership_source_refusal() {
    let (db, catalog, program) = checked();
    let (lowered, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let raw = js::emit_program_with_native_source_receipts(&lowered, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("membership observation")),
        "{:?}",
        raw.diagnostics
    );
}
