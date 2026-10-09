//! Checked local row reuse through the unchanged installed presentation factories.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir::{self, IrExpr};
use canlang_compiler::source::{SourceDb, Span};
use std::{path::Path, process::Command};

#[test]
fn local_views_bind_rows_once_and_keep_native_occurrences_distinct() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/view-reuse.can");
    let mut db = SourceDb::new();
    let id = db.add("view-reuse.can".into(), source.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.view_models.len(), 1);
    assert_eq!(checked.types.view_uses.len(), 2);
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let uses = &ir.modules[0].pages[0].render[0].children;
    assert_eq!(ir.modules[0].pages[0].render[0].factory, "table");
    assert_eq!(uses.len(), 2);
    assert_ne!(
        uses[0].view.as_ref().unwrap().identity,
        uses[1].view.as_ref().unwrap().identity
    );
    for view in uses {
        // Each checked call has one argument in a lexical expansion binding;
        // descendants refer to that row rather than copying its initializer.
        assert!(matches!(
            view.view.as_ref().unwrap().argument.expr,
            IrExpr::Call { .. } | IrExpr::BoundCall { .. }
        ));
        assert_eq!(view.children[0].span, uses[0].children[0].span);
        assert_eq!(view.children[0].factory, "actions");
        assert!(view.children.iter().any(|child| child.factory == "status"));
        assert_ne!(view.children[0].span, view.span);
        assert!(view.children.iter().any(|child| child.factory == "form"));
        let mut pending = vec![view];
        let mut protected_forms = Vec::new();
        while let Some(child) = pending.pop() {
            pending.extend(&child.children);
            if child.factory == "form" && child.props.iter().any(|(key, _)| key == "arguments") {
                protected_forms.push(child);
            }
        }
        assert_eq!(protected_forms.len(), 2);
        for form in protected_forms {
            assert_eq!(form.span.file, id);
            let authored = &source[form.span.start as usize..form.span.end as usize];
            assert!(authored.contains("bind_card") || authored.contains("recover_detail"));
            assert_ne!(form.span, view.span);
            assert!(form.children.is_empty());
            assert!(
                !form
                    .props
                    .iter()
                    .any(|(key, _)| key == "fields" || key == "display")
            );
        }
    }
    let input = scratch.path().join("view-reuse.can");
    std::fs::write(&input, source).unwrap();
    let compile = |path: &Path| {
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(&catalog_path)
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&input);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, &compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("implementation/compiler-completion/view-reuse/consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path().join("staged"))
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        consumer.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumer.stdout),
        String::from_utf8_lossy(&consumer.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumer.stdout));

    for (name, refused) in [
        ("missing-row", source.replace("{row=chosen(row)}", "{}")),
        (
            "extra-row",
            source.replace("{row=chosen(row)}", "{row=chosen(row),extra=row}"),
        ),
        (
            "table-children-without-split",
            source.replace(" display=split", ""),
        ),
        (
            "unknown-table-display",
            source.replace("display=split", "display=drawer"),
        ),
        (
            "authored-table-occurrence",
            source.replace("display=split", "display=split occurrence=\"forged\""),
        ),
        ("wrong-model", source.replace("row:Card", "row:Detail")),
        (
            "unknown-view",
            source.replace("show card_body", "show absent"),
        ),
        ("nullable-row", source.replace("row:Card", "row:Card?")),
        (
            "captured-preference",
            source.replace(
                "  text row.title\n  tabs",
                "  text preferences.view\n  tabs",
            ),
        ),
        (
            "recursive-use",
            source.replace(
                "  text row.title\n  tabs",
                "  show card_body {row=row}\n  tabs",
            ),
        ),
        (
            "status-record",
            source.replace("status row.flag", "status row"),
        ),
        (
            "status-variant",
            source.replace("tone=success size=sm", "tone=success size=sm variant=soft"),
        ),
        (
            "exported-view",
            source.replace(" view card_body", " export view card_body"),
        ),
        (
            "implicit-action-no-host",
            source.replace("actions bind_card", "actions save"),
        ),
        (
            "duplicate-action",
            source.replace("actions bind_card", "actions bind_card,bind_card"),
        ),
        (
            "action-content",
            source.replace(
                "  actions bind_card",
                "  actions bind_card\n   text row.title",
            ),
        ),
        (
            "explicit-action-scalar",
            source.replace("arguments={attempt=row}", "arguments={attempt=\"scalar\"}"),
        ),
        (
            "executable-view",
            source.replace(
                "When\n",
                "When\n scenario run(card:Card) by=public\n  do\n   card_body(card)\n",
            ),
        ),
    ] {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, refused).unwrap();
        let output = compile(&path);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            !artifact["diagnostics"].as_array().unwrap().is_empty(),
            "{name}"
        );
        if matches!(name, "implicit-action-no-host" | "duplicate-action") {
            assert!(
                artifact["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == "E6008"),
                "{name}"
            );
        }
        assert!(
            artifact.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}
