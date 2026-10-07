//! Native subprocesses qualify flat expressions without relying on Rust test-thread stacks.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "can-flat-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// File-backed output avoids a pipe/capture deadlock; deadline failure kills and reaps.
fn run(scratch: &Path, program: &str, args: &[&str], label: &str) -> (bool, String, String) {
    let stdout = scratch.join(format!("{label}.stdout"));
    let stderr = scratch.join(format!("{label}.stderr"));
    let mut child = Command::new("sh")
        .args(["-c", "ulimit -c 0; exec \"$@\"", "can-flat-child", program])
        .args(args)
        .current_dir(root())
        .stdout(Stdio::from(std::fs::File::create(&stdout).unwrap()))
        .stderr(Stdio::from(std::fs::File::create(&stderr).unwrap()))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{label} exceeded 30s; child killed/reaped");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    (
        status.success(),
        std::fs::read_to_string(stdout).unwrap(),
        std::fs::read_to_string(stderr).unwrap(),
    )
}

fn compile(scratch: &Path, source: &str, name: &str) -> String {
    let input = scratch.join(format!("{name}.can"));
    std::fs::write(&input, source).unwrap();
    let catalog = root().join("packages/values/dist/catalog.json");
    let input = input.to_str().unwrap();
    let catalog = catalog.to_str().unwrap();
    for stage in ["check", "compile"] {
        let (ok, output, error) = run(
            scratch,
            env!("CARGO_BIN_EXE_can"),
            &[stage, "--format=json", "--catalog", catalog, input],
            &format!("{name}-{stage}"),
        );
        assert!(ok, "{name}/{stage}: {output}\n{error}");
        if stage == "compile" {
            return output;
        }
    }
    unreachable!()
}

fn execute(scratch: &Path, artifacts: &[(&str, String)], assertions: &str) {
    // This is the actual built stdlib, not an arithmetic/permission mock.
    let packages = scratch.join("node_modules/@canlang");
    std::fs::create_dir_all(&packages).unwrap();
    std::os::unix::fs::symlink(root().join("packages/stdlib"), packages.join("stdlib")).unwrap();
    for (name, json) in artifacts {
        std::fs::write(scratch.join(format!("{name}.json")), json).unwrap();
    }
    let runner = scratch.join("execute.mjs");
    std::fs::write(&runner, format!(r#"
import assert from 'node:assert/strict';
import {{readFileSync,writeFileSync,mkdirSync}} from 'node:fs';
import {{dirname,resolve}} from 'node:path';
import {{pathToFileURL}} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
async function load(name){{
 const artifact=JSON.parse(readFileSync(resolve(base,name+'.json'),'utf8'));
 for(const module of artifact.modules){{const path=resolve(base,name,module.path);mkdirSync(dirname(path),{{recursive:true}});writeFileSync(path,module.js);}}
 const entry=await import(pathToFileURL(resolve(base,name,artifact.modules[0].path)));
 const registry=entry.canApp();
 return name=>{{const item=artifact.callables.find(item=>item.id.endsWith('.'+name));assert(item,name);let fn=registry;for(const part of item.member)fn=fn[part];assert.equal(typeof fn,'function');return fn;}};
}}
const context={{memberships:['members'],actor:{{id:'actor'}}}};
{assertions}
console.log('flat runtime controls passed');
"#)).unwrap();
    let (ok, output, error) = run(scratch, "node", &[runner.to_str().unwrap()], "node");
    assert!(ok, "Node: {output}\n{error}");
}

#[test]
fn flat_ladder_checks_compiles_and_executes_actual_artifacts() {
    let scratch = Scratch::new();
    let mut artifacts = Vec::new();
    for terms in [64, 512, 1024, 2048, 3000] {
        let source = format!(
            "app T\nGiven\nWhen\n scenario s() read=true -> int by=members\n  do return {}\nThen\n",
            vec!["1"; terms].join("+")
        );
        // Retain the actual failing scenario-source consumer through compile.
        compile(&scratch.0, &source, &format!("scenario{terms}"));
        // Scenario gates have separate unimplemented stdlib exports. A compiled
        // pure owner executes the same arithmetic through the real facade.
        let pure = format!(
            "app T\nGiven\n derive s():int = {}\nWhen\nThen\n",
            vec!["1"; terms].join("+")
        );
        artifacts.push((
            format!("sum{terms}"),
            compile(&scratch.0, &pure, &format!("sum{terms}")),
        ));
    }
    let refs: Vec<_> = artifacts
        .iter()
        .map(|(name, json)| (name.as_str(), json.clone()))
        .collect();
    execute(
        &scratch.0,
        &refs,
        "for(const terms of [64,512,1024,2048,3000]){const call=await load('sum'+terms);assert.equal(await call('s')(context),BigInt(terms));}",
    );
}

#[test]
fn long_binary_emission_preserves_order_overflow_grouping_and_lazy_rhs() {
    let scratch = Scratch::new();
    let zeroes = vec!["0"; 80].join("+");
    let true_terms = vec!["true"; 80].join(" and ");
    let false_terms = vec!["false"; 80].join(" or ");
    let mut source = "app Semantics\nGiven\n contract Row { a:int,b:int,c:int,flag:bool,maybe:int? }\n derive identity(value:int):int = value\n derive boolIdentity(value:bool):bool = value\n".to_string();
    for (name, result, expression) in [
        ("associate", "int", format!("{zeroes}+100-10-5")),
        ("precedence", "int", format!("{zeroes}+2+3*4")),
        ("grouped", "int", format!("{zeroes}+100-(10-5)")),
        ("ordered", "int", format!("row.a+row.b+{zeroes}+row.c")),
        (
            "asyncOrdered",
            "int",
            format!("identity(row.a)+identity(row.b)+{zeroes}+identity(row.c)"),
        ),
        (
            "overflow",
            "int",
            format!("9223372036854775807+1+row.a+{zeroes}"),
        ),
        (
            "andLazy",
            "bool",
            format!("{true_terms} and false and row.flag"),
        ),
        (
            "andAsyncLazy",
            "bool",
            format!("{true_terms} and false and boolIdentity(row.flag)"),
        ),
        (
            "orLazy",
            "bool",
            format!("{false_terms} or true or row.flag"),
        ),
        (
            "coalesceLazy",
            "int",
            format!("row.maybe??({zeroes}+row.a)"),
        ),
    ] {
        source.push_str(&format!(
            " derive {name}(row:Row):{result} = {expression}\n"
        ));
    }
    source.push_str("When\nThen\n");
    let artifact = compile(&scratch.0, &source, "semantics");
    execute(
        &scratch.0,
        &[("semantics", artifact)],
        r#"
const call=await load('semantics');
for(const [name,expected]of [['associate',85n],['precedence',14n],['grouped',95n]])assert.equal(await call(name)(context,{}),expected);
for(const name of ['ordered','asyncOrdered']){
 const trace=[];const row={};for(const [key,value]of [['a',1n],['b',2n],['c',3n]])Object.defineProperty(row,key,{get(){trace.push(key);return value;}});
 assert.equal(await call(name)(context,row),6n);assert.deepEqual(trace,['a','b','c']);
}
let reads=0;const row={maybe:7n};for(const key of ['a','flag'])Object.defineProperty(row,key,{get(){reads++;throw Error('skipped RHS read');}});
assert.equal(await call('andLazy')(context,row),false);
assert.equal(await call('orLazy')(context,row),true);
assert.equal(await call('andAsyncLazy')(context,row),false);
assert.equal(await call('coalesceLazy')(context,row),7n);
await assert.rejects(call('overflow')(context,row));assert.equal(reads,0,'overflow occurs before later RHS');
"#,
    );
}

#[test]
fn long_logical_check_and_recovery_keep_valid_siblings() {
    let scratch = Scratch::new();
    let source = format!(
        "app T\nGiven\n derive s():bool = {}\nWhen\nThen\n",
        vec!["true"; 1024].join(" and ")
    );
    let artifact = compile(&scratch.0, &source, "logical");
    execute(
        &scratch.0,
        &[("logical", artifact)],
        "const call=await load('logical');assert.equal(await call('s')(context),true);",
    );
    let malformed = scratch.0.join("recovery.can");
    std::fs::write(&malformed, "app T\nGiven\nWhen\n scenario bad() read=true -> int by=members\n  do return 1+\n scenario good() read=true -> int by=members\n  do return 2+3\nThen\n").unwrap();
    let catalog = root().join("packages/values/dist/catalog.json");
    let (ok, output, error) = run(
        &scratch.0,
        env!("CARGO_BIN_EXE_can"),
        &[
            "check",
            "--format=json",
            "--catalog",
            catalog.to_str().unwrap(),
            malformed.to_str().unwrap(),
        ],
        "recovery",
    );
    assert!(!ok, "malformed source must fail: {output}");
    assert!(error.is_empty(), "recovery aborted: {error}");
    let result = canlang_compiler::json::parse(&output).unwrap();
    let diagnostics = result.get("diagnostics").unwrap().as_arr().unwrap();
    assert!(!diagnostics.is_empty());
    let text = std::fs::read_to_string(&malformed).unwrap();
    let good_start = text.find("scenario good").unwrap();
    assert!(diagnostics.iter().all(|d| {
        d.get("primary")
            .unwrap()
            .get("start")
            .unwrap()
            .as_i64()
            .unwrap()
            < good_start as i64
    }));
    let mut db = canlang_compiler::source::SourceDb::new();
    let id = db.add("recovery.can".into(), text);
    let (program, _) = canlang_compiler::analysis::check_program(&db, &[id], None);
    assert!(
        program
            .types
            .node_types
            .iter()
            .any(|(key, ty)| key.start as usize > good_start
                && key.kind == canlang_compiler::syntax::SyntaxKind::Binary as u8
                && *ty
                    == canlang_compiler::analysis::ResolvedType::Scalar(
                        canlang_compiler::analysis::Scalar::Int
                    ))
    );
}

/// Constructed-carrier control, separate from admitted source/runtime tests:
/// unsupported binary families must not visit skipped child placeholders.
#[test]
fn unsupported_binary_retains_skipped_operand_diagnostics() {
    use canlang_compiler::analysis::{ResolvedType, Scalar};
    use canlang_compiler::codegen::ir::{IrBinOp, IrExpr, TypedExpr};
    let mut db = canlang_compiler::source::SourceDb::new();
    let id = db.add("host.can".into(), "app T\nGiven\nWhen\nThen\n".into());
    let (program, _) = canlang_compiler::analysis::check_program(&db, &[id], None);
    let (ir, _) = canlang_compiler::codegen::ir::build(&program, &db, None);
    let span = canlang_compiler::source::Span::new(id, 0, 1);
    for height in [1, 80] {
        let mut left = TypedExpr::new(
            IrExpr::Unsupported {
                what: "skipped child".into(),
                why: "must not be visited".into(),
            },
            ResolvedType::Scalar(Scalar::Int),
            span,
        );
        for _ in 0..height {
            left = TypedExpr::new(
                IrExpr::Binary {
                    op: IrBinOp::Add,
                    left: Box::new(left),
                    right: Box::new(TypedExpr::new(
                        IrExpr::Int(1),
                        ResolvedType::Scalar(Scalar::Int),
                        span,
                    )),
                },
                ResolvedType::Scalar(Scalar::Int),
                span,
            );
        }
        let expression = TypedExpr::new(
            IrExpr::Binary {
                op: IrBinOp::In,
                left: Box::new(left),
                right: Box::new(TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    span,
                )),
            },
            ResolvedType::Scalar(Scalar::Bool),
            span,
        );
        let mut emitter = canlang_compiler::codegen::js::Emitter::new(&ir);
        let output = emitter.lower_expr(&expression);
        let (diagnostics, _, _, _) = emitter.finish();
        assert!(output.contains("in over non-collection"));
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert!(!diagnostics[0].message.contains("skipped child"));
        assert!(!output.contains("int64"));
    }
}
