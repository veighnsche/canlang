//! Checked local row reuse through the unchanged installed presentation factories.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir::{self, IrExpr};
use canlang_compiler::source::{SourceDb, Span};
use std::{path::Path, process::Command};

#[test]
fn original_canbook_edits_and_disclosure_keep_the_owning_source_and_rows() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = include_str!("../../draft/apps/CanBook/CanBook.can");
    let mut db = SourceDb::new();
    let id = db.add("draft/apps/CanBook/CanBook.can".into(), original.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, _) = check_program(&db, &[id], catalog.as_ref());
    // Original imports and other unsupported source profiles still prevent
    // shipment. Inspect only the original ready edit/disclosure producers in raw IR.
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    let mut pending = program
        .modules
        .iter()
        .flat_map(|module| &module.pages)
        .flat_map(|page| &page.render)
        .collect::<Vec<_>>();
    let mut edits = std::collections::BTreeMap::new();
    let mut disclosures = 0;
    let mut date_controls = 0;
    let mut disclosure_lists = 0;
    let mut original_agendas = 0;
    let mut original_ordered_tables = 0;
    while let Some(node) = pending.pop() {
        pending.extend(&node.children);
        let authored = &original[node.span.start as usize..node.span.end as usize];
        if node.factory == "table" && authored.contains("order=from") {
            original_ordered_tables += 1;
            let IrExpr::Array(order) = &node
                .props
                .iter()
                .find(|(key, _)| key == "order")
                .unwrap()
                .1
                .expr
            else {
                panic!("original table order");
            };
            assert_eq!(order.len(), 1);
            assert!(matches!(&order[0].expr, IrExpr::Text(value) if value == "from"));
            assert!(
                node.props
                    .iter()
                    .any(|(key, value)| key == "page" && matches!(value.expr, IrExpr::Bool(true)))
            );
            assert!(
                !diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E6008"
                        && diagnostic.message.contains("table order")
                        && diagnostic.primary.start >= node.span.start
                        && diagnostic.primary.end <= node.span.end)
            );
            if authored.contains("filter=state defaults={state=preferences.appointment_state}") {
                let IrExpr::Array(filter) = &node
                    .props
                    .iter()
                    .find(|(key, _)| key == "filter")
                    .unwrap()
                    .1
                    .expr
                else {
                    panic!("original table filter");
                };
                assert_eq!(filter.len(), 1);
                let IrExpr::Object(column) = &filter[0].expr else {
                    panic!("original table enum metadata");
                };
                assert!(column.iter().any(|(key, value)| key == "field"
                    && matches!(&value.expr, IrExpr::Text(name) if name == "state")));
                let IrExpr::Object(defaults) = &node
                    .props
                    .iter()
                    .find(|(key, _)| key == "defaults")
                    .unwrap()
                    .1
                    .expr
                else {
                    panic!("original table default");
                };
                assert_eq!(defaults.len(), 1);
                assert_eq!(defaults[0].0, "state");
                assert!(
                    matches!(&defaults[0].1.expr, IrExpr::Member { base, field } if field == "appointment_state" && matches!(&base.expr, IrExpr::Name(name) if name == "preferences"))
                );
                assert!(
                    node.props.iter().any(|(key, value)| key == "where"
                        && matches!(value.expr, IrExpr::PageTimePredicate(_))),
                    "original Upcoming/Past retain the source-owned paginated time predicate; native cursor qualification remains separate"
                );
            }
        }
        if node.factory == "calendar" && authored.contains("calendar Appointment start=") {
            original_agendas += 1;
            for (name, expected) in [
                ("kind", "agenda"),
                ("model", "appointments.Appointment"),
                ("startField", "from"),
                ("endField", "until"),
            ] {
                assert!(
                    node.props.iter().any(|(key, value)| key == name
                        && matches!(&value.expr, IrExpr::Text(value) if value == expected)),
                    "{name}: {diagnostics:?}"
                );
            }
            assert!(
                node.props
                    .iter()
                    .any(|(key, value)| key == "page" && matches!(value.expr, IrExpr::Bool(true)))
            );
            assert!(
                !node.props.iter().any(|(key, _)| key == "parent"),
                "original agenda has no authored parent binding"
            );
            assert!(node.row_scope.is_some());
            let defaults = &node
                .props
                .iter()
                .find(|(key, _)| key == "defaults")
                .unwrap()
                .1;
            let IrExpr::Object(defaults) = &defaults.expr else {
                panic!("original typed defaults");
            };
            assert_eq!(defaults.len(), 1);
            assert_eq!(defaults[0].0, "state");
            let IrExpr::Member { base, field } = &defaults[0].1.expr else {
                panic!("original admitted preference default");
            };
            assert!(matches!(&base.expr, IrExpr::Name(name) if name == "preferences"));
            assert_eq!(field, "appointment_state");
            assert_eq!(
                node.children
                    .iter()
                    .map(|child| child.factory.as_str())
                    .collect::<Vec<_>>(),
                ["card"]
            );
            let outcome = &node.children[0];
            assert_eq!(
                outcome
                    .children
                    .iter()
                    .map(|child| child.factory.as_str())
                    .collect::<Vec<_>>(),
                [
                    "badge",
                    "status",
                    "status",
                    "badge",
                    "text",
                    "primaryActions",
                    "actionMenu",
                    "primaryActions",
                    "actionMenu",
                    "actionMenu",
                    "history"
                ]
            );
            assert_eq!(outcome.children[5].children.len(), 1);
            let attendance = &outcome.children[5].children[0];
            assert_eq!(attendance.factory, "form");
            assert!(attendance.props.iter().any(|(key,value)| key == "operation" && matches!(&value.expr, IrExpr::Text(value) if value == "appointments.attendance")));
            let IrExpr::Array(fields) = &attendance
                .props
                .iter()
                .find(|(key, _)| key == "fields")
                .unwrap()
                .1
                .expr
            else {
                panic!("original unbound inputs");
            };
            assert_eq!(
                fields
                    .iter()
                    .map(|field| match &field.expr {
                        IrExpr::Text(name) => name.as_str(),
                        _ => panic!("selected name"),
                    })
                    .collect::<Vec<_>>(),
                ["attend", "reason"]
            );
            assert_eq!(
                attendance
                    .children
                    .iter()
                    .map(|child| child.factory.as_str())
                    .collect::<Vec<_>>(),
                ["checkbox", "textarea"]
            );
            let IrExpr::Object(arguments) = &attendance
                .props
                .iter()
                .find(|(key, _)| key == "arguments")
                .unwrap()
                .1
                .expr
            else {
                panic!("protected original row");
            };
            assert_eq!(arguments[0].0, "appointment");
            let canlang_compiler::analysis::types::ResolvedType::Record {
                symbol,
                stored: true,
            } = arguments[0].1.ty
            else {
                panic!("checked own appointment row");
            };
            assert_eq!(
                checked.symbols[symbol.0 as usize].canonical,
                "appointments.Appointment"
            );
            let history = &outcome.children[10];
            assert_eq!(
                original[history.span.start as usize..history.span.end as usize].trim(),
                "history"
            );
            assert!(history.props.iter().any(|(key,value)| key == "model" && matches!(&value.expr, IrExpr::Text(value) if value == "appointments.Appointment")));
            assert!(history.props.iter().any(|(key, value)| key == "record"
                && matches!(&value.expr, IrExpr::Name(value) if value == "row")
                && value.ty
                    == canlang_compiler::analysis::types::ResolvedType::Record {
                        symbol,
                        stored: true
                    }));
        }
        if node.factory == "list"
            && (authored.contains("list row.Attempt columns=")
                || authored.contains("list row.Notice columns="))
        {
            disclosure_lists += 1;
            let IrExpr::Array(columns) = &node
                .props
                .iter()
                .find(|(key, _)| key == "columns")
                .unwrap()
                .1
                .expr
            else {
                panic!("original authored list column selection");
            };
            let columns = columns
                .iter()
                .map(|column| match &column.expr {
                    IrExpr::Text(value) => value.as_str(),
                    _ => panic!("checked list column path"),
                })
                .collect::<Vec<_>>();
            assert_eq!(
                columns,
                if authored.contains("list row.Attempt columns=") {
                    vec![
                        "kind",
                        "from",
                        "until",
                        "state",
                        "host_ok",
                        "room_ok",
                        "host_unknown",
                        "room_unknown",
                        "host_released",
                        "room_released",
                    ]
                } else {
                    vec!["kind", "state"]
                }
            );
            assert!(
                node.props
                    .iter()
                    .any(|(key, value)| key == "page" && matches!(value.expr, IrExpr::Bool(true)))
            );
            let IrExpr::Name(_) = node
                .props
                .iter()
                .find(|(key, _)| key == "parent")
                .unwrap()
                .1
                .expr
            else {
                panic!("original list retains its scoped parent row");
            };
            assert!(
                !diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E6008"
                        && diagnostic.message.contains("columns")
                        && diagnostic.primary.start >= node.span.start
                        && diagnostic.primary.end <= node.span.end)
            );
        }
        if node.factory == "form" && node.props.iter().any(|(key, value)| key == "operation"
            && matches!(&value.expr, IrExpr::Text(value) if value == "appointments.ClosedDay.create")) {
            let calendar = node.children.iter().find(|child| child.factory == "calendar")
                .expect("original ClosedDay calendar reaches the prepared form");
            date_controls += 1;
            assert!(calendar.props.iter().any(|(key,value)| key == "kind"
                && matches!(&value.expr, IrExpr::Text(value) if value == "field")));
            assert!(calendar.props.iter().any(|(key,value)| key == "field"
                && matches!(&value.expr, IrExpr::Text(value) if value == "day")));
            assert_eq!(original[calendar.span.start as usize..calendar.span.end as usize].trim(), "calendar day");
            assert!(calendar.children.is_empty());
            assert!(!diagnostics.iter().any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.primary.start >= calendar.span.start && diagnostic.primary.end <= calendar.span.end));
        }
        if node.factory == "collapse" && authored.contains("Appointment coordination") {
            disclosures += 1;
            let caption = &node
                .props
                .iter()
                .find(|(key, _)| key == "caption")
                .unwrap()
                .1;
            let IrExpr::Message(caption) = &caption.expr else {
                panic!("original localized caption");
            };
            assert_eq!(caption.source, "Appointment coordination");
            assert!(
                caption
                    .variants
                    .contains(&("nl".into(), Some("Afspraakafstemming".into())))
            );
            assert_eq!(node.children[0].factory, "text");
            let values = &node.children[0]
                .props
                .iter()
                .find(|(key, _)| key == "values")
                .unwrap()
                .1;
            let IrExpr::Array(values) = &values.expr else {
                panic!("original row values");
            };
            let mut fields = Vec::new();
            for value in values {
                let IrExpr::Member { base, field } = &value.expr else {
                    panic!("original row member");
                };
                let canlang_compiler::analysis::types::ResolvedType::Record {
                    symbol,
                    stored: true,
                } = base.ty
                else {
                    panic!("original stored appointment scope");
                };
                assert_eq!(
                    checked.symbols[symbol.0 as usize].canonical,
                    "appointments.Appointment"
                );
                fields.push(field.as_str());
            }
            assert_eq!(
                fields,
                ["host_ok", "room_ok", "host_delivery", "room_delivery"]
            );
            assert!(node.children.iter().all(|child| child.span.file == id
                && child.span.start >= node.span.start
                && child.span.end <= node.span.end));
        }
        if node.factory != "form"
            || !authored.lines().any(|line| {
                line.trim_start().starts_with("edit")
                    || line.trim_start().starts_with("primary") && line.contains(".update ")
            })
        {
            continue;
        }
        let operation = node
            .props
            .iter()
            .find(|(key, _)| key == "operation")
            .unwrap();
        let IrExpr::Text(operation) = &operation.1.expr else {
            panic!("canonical update operation");
        };
        let fields = node.props.iter().find(|(key, _)| key == "fields").unwrap();
        let IrExpr::Array(fields) = &fields.1.expr else {
            panic!("complete default field selection");
        };
        let fields = fields
            .iter()
            .map(|field| match &field.expr {
                IrExpr::Text(value) => value.as_str(),
                _ => panic!("writable field name"),
            })
            .collect::<Vec<_>>();
        let arguments = node
            .props
            .iter()
            .find(|(key, _)| key == "arguments")
            .unwrap();
        let IrExpr::Object(arguments) = &arguments.1.expr else {
            panic!("protected row arguments");
        };
        assert_eq!(arguments.len(), 1);
        assert_eq!(arguments[0].0, "record");
        assert!(matches!(arguments[0].1.expr, IrExpr::Name(_)));
        let canlang_compiler::analysis::types::ResolvedType::Record {
            symbol,
            stored: true,
        } = arguments[0].1.ty
        else {
            panic!("stored own row");
        };
        assert_eq!(
            format!("{}.update", checked.symbols[symbol.0 as usize].canonical),
            *operation
        );
        if operation == "appointments.Calendar.update" {
            assert_eq!(node.children.len(), 1);
            let checkbox = &node.children[0];
            assert_eq!(checkbox.factory, "checkbox");
            assert_eq!(
                original[checkbox.span.start as usize..checkbox.span.end as usize].trim(),
                "checkbox active"
            );
            assert!(checkbox.props.iter().any(|(key, value)| key == "field"
                && matches!(&value.expr, IrExpr::Text(value) if value == "active")));
            assert!(
                !diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E6008"
                        && diagnostic.primary.start >= node.span.start
                        && diagnostic.primary.end <= node.span.end)
            );
        } else {
            assert!(node.children.is_empty());
        }
        edits.insert(operation.as_str(), fields);
    }
    assert_eq!(
        disclosures, 2,
        "both original view uses retain their authored disclosure: {diagnostics:?}"
    );
    assert_eq!(date_controls, 1, "original date control occurs once");
    assert_eq!(
        original_ordered_tables, 3,
        "all original CanBook table orders remain in raw checked IR"
    );
    assert_eq!(
        original_agendas, 1,
        "complete original agenda raw IR is preserved without native acceptance: {diagnostics:?}"
    );
    assert_eq!(
        disclosure_lists, 4,
        "original Attempt/Notice lists survive both view uses"
    );
    assert!(
        !diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("cannot lower collapse:")),
        "original disclosure no longer refuses: {diagnostics:?}"
    );
    assert_eq!(
        edits,
        std::collections::BTreeMap::from([
            (
                "appointments.Calendar.update",
                vec!["duration", "hours", "instructions", "cutoff", "active"]
            ),
            (
                "appointments.WeeklyHours.update",
                vec!["weekday", "opens", "closes", "fold"]
            ),
            ("appointments.ClosedDay.update", vec!["day", "reason"]),
            (
                "appointments.Window.update",
                vec!["from", "until", "available"]
            ),
            ("appointments.Type.update", vec!["name", "duration", "room"]),
        ]),
        "{diagnostics:?}"
    );
}

#[test]
fn original_ordered_list_columns_reach_the_authorized_installed_consumer() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/view-reuse.can")
        .replace(
            "Detail in Card {label:text label=\"Detail label\"}",
            "Detail in Card {label:text label=\"Detail label\",rank:int label=\"Detail rank\"}",
        )
        .replace("list row.Detail", "list row.Detail columns=rank,label");
    let input = scratch.path().join("list-columns.can");
    let compile = |source: &str| {
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path().join("staged"))
        .arg("list-columns")
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
            "unknown-field",
            source.replace("columns=rank,label", "columns=missing,label"),
        ),
        (
            "missing-selection",
            source.replace("columns=rank,label", "columns"),
        ),
    ] {
        let output = compile(&refused);
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
        assert!(
            artifact.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}

#[test]
fn original_nullable_enum_initial_default_reaches_native_page_admission() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/view-reuse.can")
        .replace("flag:bool label=\"Card flag\"}", "flag:bool label=\"Card flag\",state:enum(pending,confirmed)=pending}")
        .replace("Then\n", "Then\n preferences {appointment_state:Card.state?,explicit:Card.state=confirmed}\n")
        .replace("  table Card", "  details \"Initial state\" open=preferences.appointment_state!=null\n   text \"Default preserved\"\n  table Card");
    let input = scratch.path().join("agenda-preference.can");
    std::fs::write(&input, &source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path().join("staged"))
        .arg("agenda-preference")
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
}

#[test]
fn checked_scenario_checkbox_reaches_the_complete_protected_native_form() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/view-reuse.can")
        .replace(
            "scenario bind_card(visit:Card,note:text=\"Kept\") by=public label=\"Bind card\"\n  do let supplied=note",
            "scenario bind_card(visit:Card,attend:bool label=\"Attendance\",note:text=\"Kept\") by=public label=\"Bind card\"\n  do set visit {flag=attend,title=note}",
        )
        .replace("actions bind_card", "form bind_card arguments={visit=row}\n   checkbox attend");
    let input = scratch.path().join("scenario-checkbox.can");
    let compile = |source: &str| {
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path().join("staged"))
        .arg("scenario-checkbox")
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
            "duplicate",
            source.replace("checkbox attend", "checkbox attend\n   checkbox attend"),
        ),
        (
            "not-selected",
            source.replace(
                "form bind_card arguments={visit=row}",
                "form bind_card fields=visit,note arguments={visit=row}",
            ),
        ),
        (
            "bound-input",
            source.replace("arguments={visit=row}", "arguments={visit=row,attend=true}"),
        ),
        (
            "foreign-input",
            source.replace("checkbox attend", "checkbox flag"),
        ),
        (
            "nullable",
            source
                .replace("attend:bool label=", "attend:bool? label=")
                .replace("flag=attend", "flag=attend ?? false"),
        ),
        (
            "wrong-type",
            source
                .replace("attend:bool label=", "attend:text label=")
                .replace("flag=attend", "flag=attend==\"yes\""),
        ),
        (
            "no-owner",
            source.replace(
                "form bind_card arguments={visit=row}\n   checkbox attend",
                "checkbox attend",
            ),
        ),
        (
            "scope-boundary",
            source.replace("checkbox attend", "list row.Detail\n    checkbox attend"),
        ),
        (
            "body",
            source.replace("checkbox attend", "checkbox attend\n    text \"invalid\""),
        ),
        (
            "option",
            source.replace("checkbox attend", "checkbox attend bogus=true"),
        ),
    ] {
        let output = compile(&refused);
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
        assert!(
            artifact.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}

#[test]
fn authored_row_checkbox_keeps_the_complete_protected_native_edit() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/view-reuse.can")
        .replace("edit fields=title,flag", "edit\n   checkbox flag")
        .replace(
            "flag:bool label=\"Card flag\"}",
            "flag:bool label=\"Card flag\",internal:text=\"Private\",at:datetime server=now}",
        );
    let input = scratch.path().join("authored-edit.can");
    let compile = |source: &str| {
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path().join("staged"))
        .arg("edit-body")
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
            "duplicate",
            source.replace("checkbox flag", "checkbox flag\n   checkbox flag"),
        ),
        (
            "not-selected",
            source.replace(
                "edit\n   checkbox flag",
                "edit fields=title\n   checkbox flag",
            ),
        ),
        (
            "not-writable",
            source.replace("checkbox flag", "checkbox internal"),
        ),
        ("server", source.replace("checkbox flag", "checkbox at")),
        (
            "wrong-type",
            source.replace("checkbox flag", "checkbox title"),
        ),
        (
            "no-owner",
            source.replace("edit\n   checkbox flag", "checkbox flag"),
        ),
        (
            "scope-boundary",
            source.replace("checkbox flag", "list row.Detail\n    checkbox flag"),
        ),
        (
            "body",
            source.replace("checkbox flag", "checkbox flag\n    text \"invalid\""),
        ),
        (
            "unknown-option",
            source.replace("checkbox flag", "checkbox flag bogus=true"),
        ),
    ] {
        let output = compile(&refused);
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
        assert!(
            artifact.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}

#[test]
fn owned_date_calendar_reaches_the_complete_installed_form_control() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/view-reuse.can")
        .replace(" Detail in Card", " Holiday {note:text label=\"Authored note\",day:date=date(\"2030-01-02\") label=\"Holiday day\"}\n Detail in Card")
        .replace(" crud Detail", " crud Holiday by=public fields=note,day\n crud Detail")
        .replace("form save fields=note display=inline\n   input note", "form Holiday.create fields=note,day display=inline\n   input note\n   calendar day");
    let input = scratch.path().join("date-control.can");
    let compile = |source: &str| {
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path().join("staged"))
        .arg("calendar")
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
        ("wrong-type", source.replace("day:date=date(\"2030-01-02\")", "day:text=\"2030-01-02\"")),
        ("not-selected", source.replace("form Holiday.create fields=note,day", "form Holiday.create fields=note")),
        ("not-writable", source.replace("crud Holiday by=public fields=note,day", "crud Holiday by=public fields=note")),
        ("no-form", source.replace("form Holiday.create fields=note,day display=inline\n   input note\n   calendar day", "calendar day")),
        ("endpoint", source.replace("calendar day", "calendar day start=day")),
        ("body", source.replace("calendar day", "calendar day\n    text \"invalid\"")),
    ] {
        let output = compile(&refused);
        assert_eq!(output.status.code(), Some(10), "{name}: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!artifact["diagnostics"].as_array().unwrap().is_empty(), "{name}");
        assert!(artifact.get("modules").is_none(), "{name}: refused source cannot publish");
    }
}

#[test]
fn bare_row_edits_use_complete_allowed_defaults_in_the_native_form() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    // The original CanBook lists use this bare edit profile. The existing
    // complete consumer exercises it with an allowed boolean/text pair and
    // a nested row, without needing the separately blocked edit body profile.
    let source = include_str!("fixtures/view-reuse.can")
        .replace("edit fields=title,flag", "edit")
        .replace("edit fields=label", "edit")
        .replace(
            "flag:bool label=\"Card flag\"}",
            "flag:bool label=\"Card flag\",internal:text=\"Private\",at:datetime server=now}",
        )
        .replace(
            "crud Card by=public fields=title,flag",
            "crud Card by=public fields=flag,title",
        );
    let input = scratch.path().join("bare-edit.can");
    let compile = |source: &str| {
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, &compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
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
            "no-row",
            source.replace(
                " page /views title=\"Views\"",
                " page /views title=\"Views\"\n  edit",
            ),
        ),
        (
            "update-disabled",
            source.replace(
                "crud Card by=public fields=flag,title",
                "crud Card by=public fields=flag,title update=none",
            ),
        ),
        (
            "field-context-ended-by-collection",
            source.replace(
                "  edit\n  form",
                "  edit\n   list row.Detail\n    input title\n  form",
            ),
        ),
        (
            "header",
            source.replace("  edit\n  form", "  edit row\n  form"),
        ),
        (
            "bare-fields-attribute",
            source.replace("  edit\n  form", "  edit fields\n  form"),
        ),
    ] {
        let output = compile(&refused);
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
        assert!(
            artifact.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}

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
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/consumer.mjs"))
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
            "duplicate-authored-edit-control",
            source.replace(
                "  edit fields=title,flag",
                "  edit fields=title,flag\n   input title\n   input title",
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
            "unknown-table-child",
            source.replace("   pagination", "   unknown_child"),
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

#[test]
fn agenda_endpoints_retain_checked_owners_and_refuse_unsupported_profiles() {
    const SOURCE: &str = r#"app AgendaEndpoints
Given
 Visit {from:datetime,until:datetime,state:enum(open,closed)}
 Other {from:datetime}
 policy Visit read=public
When
Then
 preferences {initial:Visit.state?}
 page /agenda title="Agenda"
  calendar Visit start=from end=until filter=state defaults={state=preferences.initial}
   pagination
   badge row.state
   text "First row body"
   text "Second row body"
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("agenda-endpoints.can");
    for (name, source, supported, source_error) in [
        ("datetime", SOURCE.to_string(), true, false),
        (
            "date",
            SOURCE.replace("from:datetime,until:datetime", "from:date,until:date"),
            true,
            false,
        ),
        (
            "foreign",
            SOURCE.replace("end=until", "end=Other.from"),
            false,
            true,
        ),
        (
            "unknown",
            SOURCE.replace("end=until", "end=absent"),
            false,
            true,
        ),
        (
            "multiple",
            SOURCE.replace("start=from", "start=from,until"),
            false,
            true,
        ),
        (
            "nontemporal",
            SOURCE.replace("from:datetime,until", "from:text,until"),
            false,
            false,
        ),
        (
            "nullable",
            SOURCE.replace("from:datetime,until", "from:datetime?,until"),
            false,
            false,
        ),
    ] {
        let mut db = SourceDb::new();
        let id = db.add(format!("{name}.can"), source.clone());
        let catalog_path = root.join("packages/values/dist/catalog.json");
        let (catalog, catalog_diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: root,
            primary: Span::new(id, 0, 0),
        });
        assert!(
            catalog_diagnostics.is_empty(),
            "{name}: {catalog_diagnostics:?}"
        );
        let (checked, source_diagnostics) = check_program(&db, &[id], catalog.as_ref());
        if source_error {
            assert!(
                !source_diagnostics.is_empty(),
                "{name}: invalid source selector must refuse"
            );
        } else {
            assert!(
                source_diagnostics.is_empty(),
                "{name}: source acceptance stays unchanged: {source_diagnostics:?}"
            );
        }
        let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
        let mut pending = program
            .modules
            .iter()
            .flat_map(|module| &module.pages)
            .flat_map(|page| &page.render)
            .collect::<Vec<_>>();
        let mut agendas = Vec::new();
        while let Some(node) = pending.pop() {
            pending.extend(&node.children);
            if node.factory == "calendar" {
                agendas.push(node);
            }
        }
        if supported {
            assert!(diagnostics.is_empty(), "{name}: {diagnostics:?}");
            assert_eq!(agendas.len(), 1, "{name}");
            let agenda = agendas[0];
            for (key, expected) in [
                ("kind", "agenda"),
                ("model", "AgendaEndpoints.Visit"),
                ("startField", "from"),
                ("endField", "until"),
            ] {
                assert!(
                    agenda.props.iter().any(|(name, value)| name == key
                        && matches!(&value.expr, IrExpr::Text(value) if value == expected)),
                    "{name}: {key}"
                );
            }
            assert!(
                agenda
                    .props
                    .iter()
                    .any(|(key, value)| key == "page" && matches!(value.expr, IrExpr::Bool(true))),
                "{name}"
            );
            assert_eq!(
                agenda
                    .row_scope
                    .as_ref()
                    .map(|(row, view)| (row.as_str(), view.as_str())),
                Some(("row", "rowView"))
            );
            assert_eq!(
                agenda
                    .children
                    .iter()
                    .map(|node| node.factory.as_str())
                    .collect::<Vec<_>>(),
                ["badge", "text", "text"]
            );
            assert!(
                agenda
                    .children
                    .windows(2)
                    .all(|pair| pair[0].span.start < pair[1].span.start),
                "{name}: authored order"
            );
            let defaults = &agenda
                .props
                .iter()
                .find(|(key, _)| key == "defaults")
                .unwrap()
                .1;
            let IrExpr::Object(defaults) = &defaults.expr else {
                panic!("{name}: original defaults object");
            };
            assert_eq!(defaults.len(), 1);
            assert_eq!(defaults[0].0, "state");
            assert!(matches!(&defaults[0].1.expr, IrExpr::Member { base, field }
                if field == "initial" && matches!(&base.expr, IrExpr::Name(name) if name == "preferences")));
            let filter = &agenda
                .props
                .iter()
                .find(|(key, _)| key == "filter")
                .unwrap()
                .1;
            let IrExpr::Array(fields) = &filter.expr else {
                panic!("{name}: checked filter metadata");
            };
            assert_eq!(fields.len(), 1);
            let IrExpr::Object(meta) = &fields[0].expr else {
                panic!("{name}: own enum column");
            };
            assert!(meta.iter().any(|(key, value)| key == "field"
                && matches!(&value.expr,IrExpr::Text(value) if value == "state")));
            assert!(meta.iter().any(|(key,value)| key == "type" && matches!(&value.expr,IrExpr::Text(value) if value == "enum:AgendaEndpoints.Visit.state")));
            let IrExpr::Object(labels) = &meta
                .iter()
                .find(|(key, _)| key == "valueLabels")
                .unwrap()
                .1
                .expr
            else {
                panic!("{name}: exact enum cases");
            };
            assert_eq!(
                labels
                    .iter()
                    .map(|(key, _)| key.as_str())
                    .collect::<Vec<_>>(),
                ["open", "closed"]
            );
        } else {
            assert!(
                agendas.is_empty(),
                "{name}: unsupported endpoint cannot acquire a row profile"
            );
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E6008"
                        && diagnostic.message.contains("calendar")),
                "{name}: {diagnostics:?}"
            );
        }
        // The exact source crosses the shipping gate. Supported endpoints
        // publish their complete source-owned agenda carrier; refusals cannot
        // publish a partial body.
        std::fs::write(&input, &source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(&catalog_path)
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(if supported { 0 } else { 10 }),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            refused.get("modules").is_some() == supported,
            "{name}: only complete supported carriers publish"
        );
    }
}
