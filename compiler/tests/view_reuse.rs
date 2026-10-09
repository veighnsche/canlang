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
    assert!(
        ir.modules[0].pages[0].render[0]
            .props
            .iter()
            .any(|(key, value)| { key == "page" && matches!(value.expr, IrExpr::Bool(true)) })
    );
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
            assert_ne!(child.factory, "pagination", "marker is not a row child");
            if child.factory == "list" {
                assert!(child.props.iter().any(|(key, value)| {
                    key == "page" && matches!(value.expr, IrExpr::Bool(true))
                }));
            }
            if child.factory == "form" && child.props.iter().any(|(key, _)| key == "arguments") {
                protected_forms.push(child);
            }
        }
        assert_eq!(protected_forms.len(), 4);
        for form in protected_forms {
            assert_eq!(form.span.file, id);
            let authored = &source[form.span.start as usize..form.span.end as usize];
            let is_edit = authored.trim_start().starts_with("edit fields=");
            assert!(
                is_edit || authored.contains("bind_card") || authored.contains("recover_detail")
            );
            assert_ne!(form.span, view.span);
            assert!(form.children.is_empty());
            assert!(!form.props.iter().any(|(key, _)| key == "display"));
            if is_edit {
                let operation = form
                    .props
                    .iter()
                    .find(|(key, _)| key == "operation")
                    .unwrap();
                let (canonical, model, fields) = if authored.contains("fields=title,flag") {
                    (
                        "ViewReuse.Card.update",
                        "ViewReuse.Card",
                        vec!["title", "flag"],
                    )
                } else {
                    ("ViewReuse.Detail.update", "ViewReuse.Detail", vec!["label"])
                };
                assert!(matches!(&operation.1.expr, IrExpr::Text(value) if value == canonical));
                let arguments = &form
                    .props
                    .iter()
                    .find(|(key, _)| key == "arguments")
                    .unwrap()
                    .1;
                let IrExpr::Object(arguments) = &arguments.expr else {
                    panic!("protected edit arguments");
                };
                assert_eq!(arguments.len(), 1);
                assert_eq!(arguments[0].0, "record");
                assert!(matches!(arguments[0].1.expr, IrExpr::Name(_)));
                let canlang_compiler::analysis::types::ResolvedType::Record {
                    symbol,
                    stored: true,
                } = &arguments[0].1.ty
                else {
                    panic!("checked stored lexical edit row");
                };
                assert_eq!(checked.symbols[symbol.0 as usize].canonical, model);
                let selection = &form
                    .props
                    .iter()
                    .find(|(key, _)| key == "fields")
                    .unwrap()
                    .1;
                let IrExpr::Array(selection) = &selection.expr else {
                    panic!("checked edit fields");
                };
                assert_eq!(
                    selection
                        .iter()
                        .map(|field| match &field.expr {
                            IrExpr::Text(value) => value.as_str(),
                            _ => panic!("simple writable edit field"),
                        })
                        .collect::<Vec<_>>(),
                    fields
                );
            } else {
                assert!(!form.props.iter().any(|(key, _)| key == "fields"));
            }
        }
    }
    let split_only = source.replacen("   pagination\n", "", 1);
    let mut split_db = SourceDb::new();
    let split_id = split_db.add("split-only.can".into(), split_only);
    let (split_checked, diagnostics) = check_program(&split_db, &[split_id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (split_ir, diagnostics) = ir::build(&split_checked, &split_db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        !split_ir.modules[0].pages[0].render[0]
            .props
            .iter()
            .any(|(key, _)| key == "page"),
        "split alone does not request pagination"
    );
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
    let emitted: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
    let javascript = emitted["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for operation in ["ViewReuse.Card.update", "ViewReuse.Detail.update"] {
        assert_eq!(
            javascript
                .matches(&format!(".prepareForm({{operation:\"{operation}\""))
                .count(),
            2,
            "one owning preparation per checked edit expansion"
        );
    }
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
        (
            "edit-outside-row",
            source.replace(
                " page /views title=\"Views\"",
                " page /views title=\"Views\"\n  edit fields=title,flag",
            ),
        ),
        (
            "edit-update-disabled",
            source.replace(
                "crud Card by=public fields=title,flag",
                "crud Card by=public fields=title,flag update=none",
            ),
        ),
        (
            "edit-duplicate-field",
            source.replace("edit fields=title,flag", "edit fields=title,title"),
        ),
        (
            "edit-dotted-field",
            source.replace("edit fields=title,flag", "edit fields=title.id"),
        ),
        (
            "edit-denied-field",
            source.replace(
                "crud Card by=public fields=title,flag",
                "crud Card by=public fields=title",
            ),
        ),
        (
            "edit-header",
            source.replace("edit fields=title,flag", "edit row fields=title,flag"),
        ),
        (
            "edit-extra-attribute",
            source.replace(
                "edit fields=title,flag",
                "edit fields=title,flag display=inline",
            ),
        ),
        (
            "edit-body",
            source.replace(
                "  edit fields=title,flag",
                "  edit fields=title,flag\n   text row.title",
            ),
        ),
        (
            "pagination-placement",
            source.replace(
                " page /views title=\"Views\"",
                " page /views title=\"Views\"\n  pagination",
            ),
        ),
        (
            "pagination-attributes",
            source.replacen("   pagination", "   pagination limit=1", 1),
        ),
        (
            "pagination-header",
            source.replacen("   pagination", "   pagination 1", 1),
        ),
        (
            "pagination-content",
            source.replacen("   pagination", "   pagination\n    text \"invalid\"", 1),
        ),
        (
            "pagination-repeated",
            source.replacen("   pagination", "   pagination\n   pagination", 1),
        ),
        (
            "authored-page",
            source.replace("display=split", "display=split page=true"),
        ),
        (
            "authored-list-occurrence",
            source.replace("list row.Detail", "list row.Detail occurrence=\"forged\""),
        ),
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
        std::fs::write(&path, &refused).unwrap();
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
        if matches!(
            name,
            "implicit-action-no-host"
                | "duplicate-action"
                | "pagination-placement"
                | "pagination-attributes"
                | "pagination-header"
                | "pagination-content"
                | "pagination-repeated"
        ) {
            assert!(
                artifact["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == "E6008"),
                "{name}"
            );
        }
        if matches!(name, "authored-page" | "authored-list-occurrence") {
            let attribute = if name == "authored-page" {
                "page"
            } else {
                "occurrence"
            };
            let diagnostics = artifact["diagnostics"].as_array().unwrap();
            assert_eq!(
                diagnostics.len(),
                if name == "authored-page" { 1 } else { 3 },
                "{name}: {diagnostics:?}"
            );
            let attribute_errors: Vec<_> = diagnostics
                .iter()
                .filter(|diagnostic| diagnostic["code"] == "E1203")
                .collect();
            assert_eq!(attribute_errors.len(), 1, "{name}: {diagnostics:?}");
            assert_eq!(
                attribute_errors[0]["message"],
                format!("unsupported attribute `{attribute}`")
            );
            let primary = &attribute_errors[0]["primary"];
            let start = primary["start"].as_u64().unwrap() as usize;
            let end = primary["end"].as_u64().unwrap() as usize;
            assert_eq!(&refused[start..end], attribute);
            for cascade in diagnostics
                .iter()
                .filter(|diagnostic| diagnostic["code"] != "E1203")
            {
                assert_eq!(cascade["code"], "E2001");
                assert_eq!(
                    cascade["message"],
                    "show must name a view declared in the same module"
                );
                let primary = &cascade["primary"];
                let start = primary["start"].as_u64().unwrap() as usize;
                let end = primary["end"].as_u64().unwrap() as usize;
                assert!(refused[start..end].trim().starts_with("show card_body"));
            }
        }
        assert!(
            artifact.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}
