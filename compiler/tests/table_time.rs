//! Source-owned table time predicates; native paged cursor execution is a separate join.
use std::{path::Path, process::Command};

#[test]
fn checked_table_time_reaches_native_identity_queries_and_rows() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/table-time.can");
    let input = scratch.path().join("table-time.can");
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
    let compiled = compile(source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    for (name, refused) in [
        (
            "cursor-time",
            source.replace("display=split\n", "cursor=\"unreleased\" display=split\n"),
        ),
        (
            "nullable-time",
            source.replace("from:datetime,until", "from:datetime?,until"),
        ),
        (
            "nondatetime-time",
            source
                .replace("from:datetime,until", "from:int,until")
                .replace("from:datetime,state", "from:int,state")
                .replace("until=from", "until=now"),
        ),
        (
            "invalid-time-operand",
            source.replace("visit.from>=now", "visit.from>=true"),
        ),
        (
            "invalid-reversed-operand",
            source.replace("visit.from>=now", "now<=visit.available"),
        ),
    ] {
        let output = compile(&refused);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        if matches!(name, "cursor-time") {
            let expected = if name == "cursor-time" {
                "E1203"
            } else {
                "E6008"
            };
            assert!(
                refused["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == expected),
                "{name}: {refused}"
            );
        }
        assert!(
            refused.get("modules").is_none(),
            "{name}: no partial body artifact"
        );
    }
    std::fs::write(&input, source).unwrap();
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(
            root.join("docs/implementation/compiler-completion/view-reuse/table-time-consumer.mjs"),
        )
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
    let gated = source.replacen("display=split\n", "display=split\n   require false\n", 1);
    let compiled_gate = compile(&gated);
    assert!(
        compiled_gate.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled_gate.stdout)
    );
    let gated_artifact = scratch.path().join("gated-artifact.json");
    std::fs::write(&gated_artifact, compiled_gate.stdout).unwrap();
    let gated_consumer = Command::new("node")
        .arg(
            root.join("docs/implementation/compiler-completion/view-reuse/table-time-consumer.mjs"),
        )
        .arg(root)
        .arg(&gated_artifact)
        .arg(scratch.path().join("gated-staged"))
        .arg("gated")
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        gated_consumer.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&gated_consumer.stdout),
        String::from_utf8_lossy(&gated_consumer.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumer.stdout));
}

#[test]
fn paginated_table_time_cli_emits_checked_page_query_now_operand() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let ordinary = include_str!("fixtures/table-time.can");
    let paged = ordinary.replace("display=split\n", "display=split\n   pagination\n");
    let compile = |name: &str, source: &str| {
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    for (name, source, paginated) in [
        ("ordinary", ordinary, false),
        ("paged", paged.as_str(), true),
    ] {
        let output = compile(name, source);
        assert!(
            output.status.success(),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let js = artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|module| module["js"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            js.matches("value:{kind:\"page-query-now\"}").count(),
            if paginated { 2 } else { 0 },
            "{name}: only the two source-owned paged predicates use the closed operand"
        );
        assert_eq!(
            js.matches("value:encodeValue(\"datetime\",c.now)").count(),
            if paginated { 0 } else { 2 },
            "{name}: ordinary predicates keep the original admitted-time codec"
        );
        for operation in ["gte", "lt"] {
            assert!(
                js.contains(&format!("where:{{op:\"{operation}\",field:\"from\",value:")),
                "{name}: existing owning field/operator retained"
            );
        }
        std::fs::write(scratch.path().join(format!("{name}.json")), output.stdout).unwrap();
    }
    for (name, source, expected) in [
        (
            "cursor-time",
            paged.replace("display=split\n", "cursor=\"unreleased\" display=split\n"),
            Some("E1203"),
        ),
        (
            "invalid-time-operand",
            paged.replace("visit.from>=now", "visit.from>=true"),
            None,
        ),
        (
            "invalid-reversed-operand",
            paged.replace("visit.from>=now", "now<=visit.available"),
            None,
        ),
        (
            "duplicate-pagination",
            paged.replacen("   pagination\n", "   pagination\n   pagination\n", 1),
            Some("E6008"),
        ),
        (
            "malformed-pagination",
            paged.replacen("   pagination\n", "   pagination limit=1\n", 1),
            Some("E6008"),
        ),
        (
            "nullable-paged-time",
            paged.replace("from:datetime,until", "from:datetime?,until"),
            None,
        ),
        (
            "nondatetime-paged-time",
            paged.replace("from:datetime,until", "from:int,until"),
            None,
        ),
    ] {
        let output = compile(name, &source);
        assert_eq!(output.status.code(), Some(10), "{name}");
        let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        if let Some(expected) = expected {
            assert!(
                refused["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == expected),
                "{name}: {refused}"
            );
        }
        assert!(
            refused.get("modules").is_none(),
            "{name}: no partial artifact"
        );
    }
    // Only the checked public module/descriptor correspondence is exercised.
    // Dev owns authenticated cursor issuance and continuation execution.
    let runner = scratch.path().join("page-time-producer.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [root,scratch]=process.argv.slice(2),require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile}=await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
for(const name of ['ordinary','paged']){
 const input=loadArtifactFile(resolve(scratch,name+'.json')),artifact=input.artifact;
 const asm=await assembleModules(input,{workDir:resolve(scratch,name+'-modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
 const generated=await importVerifiedAssemblyModule(asm,artifact.modules[0].path,artifact);
 assert.deepEqual(generated.canApp().operations,artifact.operations,'verified '+name+' source publication');
 assert.equal(generated.appDefinition.pages[0].path,'/table-time');
}
"#,
    ).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn checked_table_time_ir(source: &str) -> canlang_compiler::codegen::ir::IrProgram {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::ir;
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add("table-time.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    program
}

#[test]
fn paginated_time_operand_requires_original_page_occurrence_model_and_field() {
    use canlang_compiler::analysis::{ResolvedType, Scalar};
    use canlang_compiler::codegen::{ir, js};
    let source = include_str!("fixtures/table-time.can");
    let paged = source.replace("display=split\n", "display=split\n   pagination\n");
    let program = checked_table_time_ir(&paged);
    let tables = &program.modules[0].pages[0].render;
    assert_eq!(tables.len(), 2);
    let genuine = js::emit_program(&program);
    assert!(genuine.diagnostics.is_empty(), "{:?}", genuine.diagnostics);
    let page = tables[0]
        .props
        .iter()
        .find(|(key, _)| key == "page")
        .unwrap()
        .1
        .clone();
    let other_page = tables[1]
        .props
        .iter()
        .find(|(key, _)| key == "page")
        .unwrap()
        .1
        .clone();
    let first_where = tables[0]
        .props
        .iter()
        .find(|(key, _)| key == "where")
        .unwrap()
        .1
        .clone();
    let field = program
        .items
        .iter()
        .find(|item| item.canonical == "TableTime.Window.from")
        .unwrap()
        .id;
    for corruption in 0..9 {
        let mut changed = program.clone();
        match corruption {
            0 => changed.modules[0].pages[0].render[0]
                .props
                .retain(|(key, _)| key != "page"),
            1 => {
                changed.modules[0].pages[0].render[0]
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "page")
                    .unwrap()
                    .1
                    .expr = ir::IrExpr::Bool(false)
            }
            2 => {
                changed.modules[0].pages[0].render[0]
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "page")
                    .unwrap()
                    .1 = other_page.clone()
            }
            3 => {
                changed.modules[0].pages[0].render[1]
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "where")
                    .unwrap()
                    .1 = first_where.clone()
            }
            4 => {
                changed.modules[0].pages[0].render[0]
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "model")
                    .unwrap()
                    .1
                    .expr = ir::IrExpr::Text("TableTime.Calendar".into())
            }
            5 => {
                let ir::IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind
                else {
                    panic!("owning from field");
                };
                *ty = ir::IrType::Known(ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
                    Scalar::Datetime,
                ))));
            }
            6 => {
                changed.modules[0].pages[0].render[0]
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "where")
                    .unwrap()
                    .0 = "empty".into()
            }
            7 => {
                let table = &mut changed.modules[0].pages[0].render[0];
                let mut model = table
                    .props
                    .iter()
                    .find(|(key, _)| key == "model")
                    .unwrap()
                    .1
                    .clone();
                model.expr = ir::IrExpr::Text("TableTime.Calendar".into());
                table.props.push(("model".into(), model));
            }
            8 => changed.modules[0].pages[0].render[0]
                .props
                .push(("where".into(), first_where.clone())),
            _ => unreachable!(),
        }
        let emitted = js::emit_program(&changed);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "owning paged predicate skew {corruption}: {:?}",
            emitted.diagnostics
        );
    }
    let mut ordinary = checked_table_time_ir(source);
    ordinary.modules[0].pages[0].render[0]
        .props
        .push(("page".into(), page));
    let changed = js::emit_program(&ordinary);
    assert!(
        changed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "an edited page prop cannot manufacture the private source pagination fact: {:?}",
        changed.diagnostics
    );
}

#[test]
fn original_canbook_paged_time_keeps_predicates_and_row_body() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::ir::{self, IrExpr};
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = include_str!("../../draft/apps/CanBook/CanBook.can");
    let mut db = SourceDb::new();
    let id = db.add("draft/apps/CanBook/CanBook.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, _) = check_program(&db, &[id], catalog.as_ref());
    // Other original profiles still block the full app; this is raw owning IR.
    let (program, _) = ir::build(&checked, &db, catalog.as_ref());
    let mut pending = program
        .modules
        .iter()
        .flat_map(|module| &module.pages)
        .flat_map(|page| &page.render)
        .collect::<Vec<_>>();
    let mut predicates = std::collections::BTreeSet::new();
    while let Some(table) = pending.pop() {
        pending.extend(&table.children);
        let authored = &source[table.span.start as usize..table.span.end as usize];
        if table.factory != "table"
            || !authored
                .trim_start()
                .starts_with("table Appointment as visit where ")
        {
            continue;
        }
        let predicate = if authored.contains("visit.from>=now") {
            "gte"
        } else {
            assert!(authored.contains("visit.from<now"));
            "lt"
        };
        assert!(predicates.insert(predicate));
        let prop = |name: &str| &table.props.iter().find(|(key, _)| key == name).unwrap().1;
        assert!(
            matches!(&prop("model").expr, IrExpr::Text(name) if name == "appointments.Appointment")
        );
        assert!(matches!(prop("where").expr, IrExpr::PageTimePredicate(_)));
        assert!(matches!(prop("page").expr, IrExpr::Bool(true)));
        let marker = prop("page").span;
        assert_eq!(
            source[marker.start as usize..marker.end as usize].trim(),
            "pagination"
        );
        let IrExpr::Array(order) = &prop("order").expr else {
            panic!("original order");
        };
        assert_eq!(order.len(), 1);
        assert!(matches!(&order[0].expr, IrExpr::Text(field) if field == "from"));
        let IrExpr::Array(filter) = &prop("filter").expr else {
            panic!("original filter");
        };
        assert_eq!(filter.len(), 1);
        let IrExpr::Object(column) = &filter[0].expr else {
            panic!("owning enum metadata");
        };
        assert!(column.iter().any(|(key, value)| key == "field"
            && matches!(&value.expr, IrExpr::Text(field) if field == "state")));
        let IrExpr::Object(defaults) = &prop("defaults").expr else {
            panic!("original defaults");
        };
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].0, "state");
        assert!(
            matches!(&defaults[0].1.expr, IrExpr::Member { base, field } if field == "appointment_state" && matches!(&base.expr, IrExpr::Name(name) if name == "preferences"))
        );
        assert_eq!(table.children.len(), 1);
        let view = &table.children[0];
        assert_eq!(
            source[view.span.start as usize..view.span.end as usize].trim(),
            "show appointment_coordination {row=row}"
        );
        assert!(
            matches!(&view.view.as_ref().unwrap().argument.expr, IrExpr::Name(name) if name == &table.row_scope.as_ref().unwrap().0)
        );
        assert_eq!(
            view.children
                .iter()
                .map(|child| child.factory.as_str())
                .collect::<Vec<_>>(),
            ["card"]
        );
        assert_eq!(
            view.children[0]
                .children
                .iter()
                .map(|child| child.factory.as_str())
                .collect::<Vec<_>>(),
            [
                "badge",
                "status",
                "status",
                "actionMenu",
                "primaryActions",
                "actionMenu",
                "actionMenu",
                "collapse"
            ]
        );
    }
    assert_eq!(predicates.into_iter().collect::<Vec<_>>(), ["gte", "lt"]);
}

#[test]
fn source_owned_time_predicate_cannot_move_to_another_ui_property() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::{ir, js};
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add(
        "table-time.can".into(),
        include_str!("fixtures/table-time.can").into(),
    );
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (mut program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let table = program.modules[0].pages[0]
        .render
        .iter_mut()
        .find(|node| node.factory == "table")
        .unwrap();
    let (name, value) = table
        .props
        .iter_mut()
        .find(|(key, _)| key == "where")
        .unwrap();
    assert!(matches!(value.expr, ir::IrExpr::PageTimePredicate(_)));
    *name = "empty".into();
    let emitted = js::emit_program(&program);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        emitted.diagnostics
    );
}
