//! Selected checked bindings through actual public compilation and installed
//! facades. Direct getter inputs qualify expression order, not canonical input
//! admission. Localized formatting requires a qualified handler scope;
//! broader presentation sinks and serving remain separately scoped.
#![cfg(unix)]

use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn production_selected_calls_execute_actual_facades() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script = scratch.path().join("probe.mjs");
    std::fs::write(&script, include_str!("fixtures/selected-call-consumer.mjs")).unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(root())
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .output()
        .expect("Node required for actual facade qualification");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    eprintln!("{stdout}");
}

#[test]
fn imported_scalar_aliases_preserve_installed_temporal_overloads() {
    use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
    use canlang_compiler::codegen::ir::{IrCallTarget, IrExpr, IrItemKind};

    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/scalar-alias-overlaps.can");
    let mut db = SourceDb::new();
    let source_id = db.add("scalar-alias-overlaps.can".into(), source.into());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(source_id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    assert_eq!(catalog.overloads("overlaps").unwrap().len(), 2);
    let (checked, diagnostics) = check_program(&db, &[source_id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut arms = Vec::new();
    for (key, selected) in &checked.types.selected_calls {
        let SelectedCallTarget::Builtin { id, overload } = &selected.target else {
            continue;
        };
        if id != "overlaps" {
            continue;
        }
        let scalar = match overload {
            0 => Scalar::Date,
            1 => Scalar::Datetime,
            other => panic!("unexpected installed overlaps arm: {other}"),
        };
        arms.push(*overload);
        assert_eq!(
            checked.types.node_types[key],
            ResolvedType::Scalar(Scalar::Bool)
        );
        assert_eq!(selected.slots, [Some(3), Some(1), Some(2), Some(0)]);
        assert_eq!(selected.arguments.len(), 4);
        for argument in &selected.arguments {
            assert_eq!(
                checked.types.node_types[argument],
                ResolvedType::Scalar(scalar)
            );
            let alias = &checked.types.selected_calls[argument];
            let SelectedCallTarget::DeriveFn(symbol) = alias.target else {
                panic!("scalar originates in an imported owning derive")
            };
            let expected_owner = if *overload == 0 {
                "Calendar.day"
            } else {
                "Calendar.instant"
            };
            assert_eq!(checked.symbols[symbol.0 as usize].canonical, expected_owner);
        }
    }
    arms.sort_unstable();
    assert_eq!(arms, [0, 1]);

    let (program, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for (canonical, scalar, owner) in [
        ("ScalarAlias.date_overlap", Scalar::Date, "Calendar.day"),
        (
            "ScalarAlias.datetime_overlap",
            Scalar::Datetime,
            "Calendar.instant",
        ),
    ] {
        let item = program
            .items
            .iter()
            .find(|item| item.canonical == canonical)
            .unwrap();
        let IrItemKind::DeriveFn {
            expr: Some(value), ..
        } = &item.kind
        else {
            panic!("owning scalar workflow derive")
        };
        assert_eq!(value.ty, ResolvedType::Scalar(Scalar::Bool));
        let IrExpr::BoundCall {
            target,
            args,
            slots,
        } = &value.expr
        else {
            panic!("named temporal operands preserve checked slots")
        };
        assert!(matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "overlaps"));
        assert_eq!(slots, &[Some(3), Some(1), Some(2), Some(0)]);
        assert_eq!(args.len(), 4);
        for (argument, field) in args.iter().zip(["bEnd", "aEnd", "bStart", "aStart"]) {
            assert_eq!(argument.ty, ResolvedType::Scalar(scalar));
            let IrExpr::Call {
                target: IrCallTarget::DeriveFn(actual),
                args,
            } = &argument.expr
            else {
                panic!("imported identity derive remains source-callable")
            };
            assert_eq!(actual, owner);
            assert_eq!(args.len(), 1);
            assert_eq!(args[0].ty, ResolvedType::Scalar(scalar));
            assert!(
                matches!(&args[0].expr, IrExpr::Member { field: actual, .. } if actual == field)
            );
        }
    }
    // Reuse the existing production CLI/native facade host in its isolated
    // scalar mode; the earlier selected-call matrix is not executed.
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script = scratch.path().join("probe.mjs");
    std::fs::write(&script, include_str!("fixtures/selected-call-consumer.mjs")).unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(root())
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .arg("--scalar-alias-overlaps")
        .output()
        .expect("Node required for actual temporal scalar facade qualification");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
fn effectful_custom_same_arity_binding_executes_typed_native_getters() {
    use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
    use canlang_compiler::codegen::ir::{IrCallTarget, IrExpr, IrItemKind, IrStmt};

    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let installed_catalog = root().join("packages/values/dist/catalog.json");
    let mut custom: serde_json::Value =
        serde_json::from_slice(&std::fs::read(installed_catalog).unwrap()).unwrap();
    let builtin = custom["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "add_days")
        .unwrap();
    assert_eq!(builtin["signature"], "add_days(value:date,days:int)->date");
    assert_eq!(builtin["availability"], "implemented");
    // Same names and arity: actual field types reject the earlier candidate.
    // The winning signature restores the installed facade's Date/Int order.
    builtin["signature"] =
        "add_days(days:date,value:int)->date; add_days(value:date,days:int)->date".into();
    builtin["effects"] = "state-read".into();
    let catalog_path = scratch.path().join("catalog.json");
    std::fs::write(&catalog_path, serde_json::to_vec(&custom).unwrap()).unwrap();
    let source = "app T\nGiven\n contract Shift {start:date,offset:int}\nWhen\n scenario shift(v:Shift) read=true -> date by=members\n  do return add_days(days=v.offset,value=v.start)\nThen\n";
    let mut db = SourceDb::new();
    let id = db.add("shift.can".into(), source.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    assert_eq!(catalog.overloads("add_days").unwrap().len(), 2);
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.selected_calls.len(), 1);
    let (call_key, selected) = checked.types.selected_calls.iter().next().unwrap();
    assert!(
        matches!(&selected.target, SelectedCallTarget::Builtin { id, overload: 1 } if id == "add_days")
    );
    assert_eq!(selected.slots, [Some(1), Some(0)]);
    assert_eq!(
        checked.types.node_types[call_key],
        ResolvedType::Scalar(Scalar::Date)
    );
    assert_eq!(
        selected
            .arguments
            .iter()
            .map(|key| &checked.types.node_types[key])
            .collect::<Vec<_>>(),
        [
            &ResolvedType::Scalar(Scalar::Int),
            &ResolvedType::Scalar(Scalar::Date)
        ]
    );
    // Carry the actual owning SourceDb and loaded catalog through lowering.
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let scenario = ir
        .items
        .iter()
        .find(|item| item.canonical == "T.shift")
        .unwrap();
    let IrItemKind::Scenario { effects, .. } = &scenario.kind else {
        panic!("owning scenario declaration")
    };
    let [
        IrStmt::Return {
            value: Some(value), ..
        },
    ] = effects.as_slice()
    else {
        panic!("one authored return: {effects:?}")
    };
    let IrExpr::BoundCall {
        target,
        args,
        slots,
    } = &value.expr
    else {
        panic!("checked reordered builtin: {:?}", value.expr)
    };
    assert!(matches!(target, IrCallTarget::Builtin { id, awaited: true } if id == "add_days"));
    assert_eq!(slots, &selected.slots);
    for (arg, field) in args.iter().zip(["offset", "start"]) {
        assert!(matches!(&arg.expr, IrExpr::Member { field: actual, .. } if actual == field));
    }
    assert_eq!(args.len(), 2);
    let emitted = canlang_compiler::codegen::js::emit_program(&ir);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    assert!(emitted.stdlib_imports.contains("add_days"));
    for module in std::iter::once(&emitted.entry).chain(&emitted.packages) {
        let path = scratch.path().join(&module.path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &module.js).unwrap();
    }
    // A strict native getter host exercises expression evaluation only. It
    // does not qualify State admission, authority integration, or serving.
    let script = scratch.path().join("probe.mjs");
    std::fs::write(
        &script,
        r#"import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {date} from '@canlang/stdlib';
const registry = (await import(pathToFileURL(process.argv[2]))).canApp();
const context = {memberships:['members']};
const start = date('2026-10-07');
const expected = {kind:'date',year:2026,month:10,day:10};
function host(trace, fail) {
  const reads = new Set();
  const failures = {offset:new Error('offset failed'),start:new Error('start failed')};
  const record = {};
  for (const [field, value] of [['offset',3n],['start',start]]) {
    Object.defineProperty(record, field, {get() {
      assert.equal(this, record, field+' receiver');
      assert(!reads.has(field), field+' read twice');
      reads.add(field); trace.push(field);
      if (fail === field) throw failures[field];
      return value;
    }});
  }
  return {record, failures};
}
const trace = [];
const {record} = host(trace);
assert.deepEqual(await registry['T.shift'](context, {v:record}), expected);
assert.deepEqual(trace, ['offset','start']);
for (const [fail, expectedTrace] of [['offset',['offset']],['start',['offset','start']]]) {
  const trace = [];
  const {record, failures} = host(trace, fail);
  await assert.rejects(registry['T.shift'](context, {v:record}), error => error === failures[fail]);
  assert.deepEqual(trace, expectedTrace);
}
"#,
    )
    .unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(scratch.path().join(&emitted.entry.path))
        .output()
        .expect("Node required for actual installed facade execution");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn missing_checked_binding_has_no_catalog_reconstruction_fallback() {
    let mut db = SourceDb::new();
    let id = db.add(
        "selected.can".into(),
        "app T\nGiven\n derive g():text = lower(value=\"HI\")\nWhen\nThen\n".into(),
    );
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(SourceId(0), 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (mut checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.selected_calls.len(), 1);
    checked.types.selected_calls.clear();
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let emitted = canlang_compiler::codegen::js::emit_program(&ir);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diag| diag.code == "E6008"
                && diag.message.contains("checked selected-call binding")),
        "{:?}",
        emitted.diagnostics
    );
}

#[test]
fn rejected_currency_overload_preserves_winning_text_argument_facts() {
    use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
    use canlang_compiler::codegen::ir::{IrCallTarget, IrExpr, IrItemKind};

    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let installed_catalog = root().join("packages/values/dist/catalog.json");
    let mut custom: serde_json::Value =
        serde_json::from_slice(&std::fs::read(installed_catalog).unwrap()).unwrap();
    let builtin = custom["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "choose")
        .unwrap();
    assert_eq!(builtin["signature"], "choose(condition:bool,yes:T,no:T)->T");
    assert_eq!(builtin["availability"], "implemented");
    // Both signatures are sound subsets of the same installed generic
    // native choose. Only the signature changes; all owner facts survive.
    builtin["signature"] = "choose(condition:bool,yes:currency,no:currency)->currency; choose(condition:bool,yes:T,no:T)->T".into();
    let catalog_path = scratch.path().join("catalog.json");
    std::fs::write(&catalog_path, serde_json::to_vec(&custom).unwrap()).unwrap();
    let source = "app T\nGiven\n derive chosen():text = choose(true,\"USD\",\"not a currency\")\n derive accepted():currency = choose(true,\"USD\",\"GBP\")\nWhen\nThen\n";
    let mut db = SourceDb::new();
    let id = db.add("choice.can".into(), source.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    assert_eq!(catalog.overloads("choose").unwrap().len(), 2);
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.selected_calls.len(), 2);
    let (call_key, selected) = checked.types.selected_calls.iter().find(|(_, selected)| matches!(&selected.target, SelectedCallTarget::Builtin { id, overload: 1 } if id == "choose")).unwrap();
    assert!(
        matches!(&selected.target, SelectedCallTarget::Builtin { id, overload: 1 } if id == "choose")
    );
    assert_eq!(selected.slots, [Some(0), Some(1), Some(2)]);
    assert_eq!(
        checked.types.node_types[call_key],
        ResolvedType::Scalar(Scalar::Text)
    );
    let argument_types = selected
        .arguments
        .iter()
        .map(|key| checked.types.node_types[key].clone())
        .collect::<Vec<_>>();
    let (accepted_key, accepted) = checked.types.selected_calls.iter().find(|(_, selected)| matches!(&selected.target, SelectedCallTarget::Builtin { id, overload: 0 } if id == "choose")).unwrap();
    assert_eq!(
        checked.types.node_types[accepted_key],
        ResolvedType::Scalar(Scalar::Currency)
    );
    let accepted_argument_types = accepted
        .arguments
        .iter()
        .map(|key| checked.types.node_types[key].clone())
        .collect::<Vec<_>>();
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let item = ir
        .items
        .iter()
        .find(|item| item.canonical == "T.chosen")
        .unwrap();
    let IrItemKind::DeriveFn {
        expr: Some(value), ..
    } = &item.kind
    else {
        panic!("owning source derive expression")
    };
    let IrExpr::Call { target, args } = &value.expr else {
        panic!("checked winning builtin: {:?}", value.expr)
    };
    assert!(matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "choose"));
    let ir_argument_types = args.iter().map(|arg| arg.ty.clone()).collect::<Vec<_>>();
    let accepted_item = ir
        .items
        .iter()
        .find(|item| item.canonical == "T.accepted")
        .unwrap();
    let IrItemKind::DeriveFn {
        expr: Some(accepted_value),
        ..
    } = &accepted_item.kind
    else {
        panic!("owning narrowed derive expression")
    };
    assert_eq!(accepted_value.ty, ResolvedType::Scalar(Scalar::Currency));
    let IrExpr::Call {
        target: accepted_target,
        args: accepted_args,
    } = &accepted_value.expr
    else {
        panic!("checked winning narrowed builtin")
    };
    assert!(
        matches!(accepted_target, IrCallTarget::Builtin { id, awaited: false } if id == "choose")
    );
    let accepted_ir_argument_types = accepted_args
        .iter()
        .map(|arg| arg.ty.clone())
        .collect::<Vec<_>>();
    let emitted = canlang_compiler::codegen::js::emit_program(&ir);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    assert!(emitted.stdlib_imports.contains("choose"));
    assert!(
        std::iter::once(&emitted.entry)
            .chain(&emitted.packages)
            .any(|module| module.js.contains("@canlang/stdlib")),
        "actual public stdlib import required"
    );
    for module in std::iter::once(&emitted.entry).chain(&emitted.packages) {
        let path = scratch.path().join(&module.path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &module.js).unwrap();
    }
    let script = scratch.path().join("probe.mjs");
    std::fs::write(
        &script,
        r#"import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const registry = (await import(pathToFileURL(process.argv[2]))).canApp();
const value = await registry['T.chosen']({});
assert.equal(value, 'USD');
const accepted = await registry['T.accepted']({});
assert.equal(accepted, 'USD');
console.log(JSON.stringify({consumer:'generated canApp → installed stdlib choose', value, accepted}));
"#,
    )
    .unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(scratch.path().join(&emitted.entry.path))
        .output()
        .expect("Node required for actual installed choose execution");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    eprintln!(
        "selected written argument types: {argument_types:?}; typed IR argument types: {ir_argument_types:?}"
    );
    eprintln!(
        "accepted narrowed argument types: {accepted_argument_types:?}; typed IR argument types: {accepted_ir_argument_types:?}"
    );
    // Native execution precedes these fact checks: a rejected trial must
    // leave no contextual Currency fact in the successful generic program.
    let expected = [
        ResolvedType::Scalar(Scalar::Bool),
        ResolvedType::Scalar(Scalar::Text),
        ResolvedType::Scalar(Scalar::Text),
    ];
    assert_eq!(argument_types, expected);
    assert_eq!(ir_argument_types, expected);
    let narrowed_expected = [
        ResolvedType::Scalar(Scalar::Bool),
        ResolvedType::Scalar(Scalar::Currency),
        ResolvedType::Scalar(Scalar::Currency),
    ];
    assert_eq!(accepted_argument_types, narrowed_expected);
    assert_eq!(accepted_ir_argument_types, narrowed_expected);
}

#[test]
fn disjoint_same_arity_names_require_one_owning_overload() {
    let scratch = tempfile::tempdir().unwrap();
    let catalog_path = scratch.path().join("catalog.json");
    std::fs::write(&catalog_path, r#"{
        "language_version":"1.0","catalog_version":"disjoint-name-control",
        "entries":[{"id":"starts_with","kind":"builtin","js":"starts_with",
        "owner":"test","effects":"pure","availability":"implemented",
        "signature":"starts_with(value:text,prefix:text)->bool; starts_with(text:text,start:text)->bool"}]
    }"#).unwrap();
    let source =
        "app T\nGiven\n derive g():bool = starts_with(value=\"AB\",start=\"A\")\nWhen\nThen\n";
    let input = scratch.path().join("mixed.can");
    std::fs::write(&input, source).unwrap();
    let mut db = SourceDb::new();
    let id = db.add(input.display().to_string(), source.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.expect("both overloads must be admitted");
    assert_eq!(catalog.overloads("starts_with").unwrap().len(), 2);
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0].code, "E3005");
    assert!(diagnostics[0].message.contains("no overload"));
    let call_start = source.find("starts_with(").unwrap();
    assert_eq!(diagnostics[0].primary.start as usize, call_start);
    assert_eq!(
        &source[diagnostics[0].primary.start as usize..diagnostics[0].primary.end as usize],
        "starts_with(value=\"AB\",start=\"A\")"
    );
    assert!(checked.types.selected_calls.is_empty());
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(&catalog_path)
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(10),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(artifact["diagnostics"].as_array().unwrap().len(), 1);
    assert_eq!(artifact["diagnostics"][0]["code"], "E3005");
    assert!(artifact.get("modules").is_none());
}

#[test]
fn nominal_catalog_deferral_preserves_actual_checked_arguments() {
    use canlang_compiler::analysis::catalog::Availability;
    use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};

    let scratch = tempfile::tempdir().unwrap();
    for (name, nominal, source, unresolved) in [
        (
            "declared",
            "Box",
            "app T\nGiven\n contract Box { label:text }\n derive g(value:Box):bool = starts_with(value,\"A\")\nWhen\nThen\n",
            false,
        ),
        (
            "deferred",
            "MisspelledBox",
            "app T\nGiven\n derive g():bool = starts_with(7,\"A\")\nWhen\nThen\n",
            false,
        ),
        (
            "unresolved",
            "MisspelledBox",
            "app T\nGiven\n derive g():bool = starts_with(missing,\"A\")\nWhen\nThen\n",
            true,
        ),
    ] {
        let catalog_path = scratch.path().join(format!("{name}.catalog.json"));
        std::fs::write(&catalog_path, format!(r#"{{"language_version":"1.0","catalog_version":"nominal-deferral-control","entries":[{{"id":"starts_with","kind":"builtin","js":"starts_with","owner":"test","effects":"pure","availability":"implemented","signature":"starts_with(value:{nominal},prefix:text)->bool"}}]}}"#)).unwrap();
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, source).unwrap();
        let mut db = SourceDb::new();
        let id = db.add(input.display().to_string(), source.into());
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: scratch.path(),
            primary: Span::new(id, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{name}: {diagnostics:?}");
        let catalog = catalog.unwrap();
        // Availability comes only from the explicit catalog entry. Nominal
        // deferral neither establishes a deployment nor validates a value.
        assert_eq!(
            catalog.availability("starts_with"),
            Some(Availability::Implemented)
        );
        let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
        assert!(
            checked
                .modules
                .iter()
                .all(|module| module.imports.is_empty())
        );
        assert!(checked.types.target_bindings.is_empty());
        if unresolved {
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            assert_eq!(diagnostics[0].code, "E2001");
        } else {
            assert!(diagnostics.is_empty(), "{name}: {diagnostics:?}");
            assert_eq!(checked.types.selected_calls.len(), 1);
            let (call_key, selected) = checked.types.selected_calls.iter().next().unwrap();
            assert!(
                matches!(&selected.target, SelectedCallTarget::Builtin { id, overload:0 } if id=="starts_with")
            );
            assert_eq!(selected.slots, [Some(0), Some(1)]);
            assert_eq!(
                checked.types.node_types[call_key],
                ResolvedType::Scalar(Scalar::Bool)
            );
            let actual = &checked.types.node_types[&selected.arguments[0]];
            if name == "declared" {
                let ResolvedType::Record { symbol, .. } = actual else {
                    panic!("actual contract argument: {actual:?}")
                };
                assert_eq!(checked.symbols[symbol.0 as usize].canonical, "T.Box");
                assert!(matches!(
                    checked.symbols[symbol.0 as usize].kind,
                    canlang_compiler::analysis::resolve::SymbolKind::Contract { .. }
                ));
                let declaration = checked
                    .symbols
                    .iter()
                    .find(|item| item.canonical == "T.g")
                    .unwrap();
                let canlang_compiler::analysis::resolve::SymbolKind::DeriveFn { params, .. } =
                    &declaration.kind
                else {
                    panic!("owning derive declaration")
                };
                assert_eq!(
                    actual, &checked.types.symbol_types[&params[0]],
                    "nominal deferral retains the owning parameter type"
                );
            } else {
                assert_eq!(*actual, ResolvedType::Scalar(Scalar::Int));
                assert!(!checked.symbols.iter().any(|symbol| symbol.name == nominal));
            }
        }
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["check", "--format=json", "--catalog"])
            .arg(&catalog_path)
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .current_dir(scratch.path())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(if unresolved { 10 } else { 0 }),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let cli_diagnostics = result["diagnostics"].as_array().unwrap();
        if unresolved {
            assert_eq!(cli_diagnostics.len(), 1);
            assert_eq!(cli_diagnostics[0]["code"], "E2001");
        } else {
            assert!(cli_diagnostics.is_empty());
        }
    }
}
