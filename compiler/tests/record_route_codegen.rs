//! Checked record-route production; native State/HTTP authority is qualified separately.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::ResolvedType;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax::SyntaxKind;
use std::process::Command;

const SOURCE: &str = r#"app RouteProducer uses=[pages]
package records
 Given
  export Item {name:text,active:bool}
  export Customer {name:text}
  policy Item read=public fields=name,active
  policy Customer read=members
 When
  export scenario capture(partner:Item,customer:Customer) by=members
   do require partner.active
 Then
package pages
 use records {Item as Partner,Customer,capture}
 Given
 When
 Then
  page /partners/share/{Partner.id} title="Partner introduction" nav=none
   require authenticated and row.active and row.active
   text row.name
   primary "Use attribution code" action=capture arguments={partner=row} fields=customer
"#;

fn checked(source: &str) -> (SourceDb, Catalog, CheckedProgram) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let file = db.add("record-route.can".into(), source.into());
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

fn emit_page(source: &str) -> (String, String) {
    let (db, catalog, program) = checked(source);
    let (lowered, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let page = lowered
        .modules
        .iter()
        .flat_map(|module| &module.pages)
        .next()
        .unwrap();
    let route = page.record_route.as_ref().unwrap();
    assert_eq!(route.model, "records.Item");
    assert_eq!(route.token, "Partner.id");
    let mut emitter = js::Emitter::new(&lowered);
    let mut writer = js::JsWriter::new();
    emitter.lower_page(page, &mut writer);
    let module = writer.finish("record-route.mjs".into());
    let (diagnostics, _, _, pages) = emitter.finish();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(module.js.contains("bindings.row"));
    assert!(!module.js.contains("unsupported route row"));
    (module.js, pages[0].export.clone())
}

#[test]
fn checked_alias_record_route_emits_lazy_viewer_lookup_and_retains_admitted_action_row() {
    let (js, descriptor) = emit_page(SOURCE);
    let scratch = tempfile::tempdir().unwrap();
    let module = scratch.path().join("record-route.mjs");
    // Substitute only the records/UI boundary. The emitted lookup, guard,
    // short circuit and binding expressions execute unchanged.
    let prefix = r#"
const $can$h$636865636b65645f6d657373616765=(source)=>source;
async function records(c,model,query){return c.canonical.readRecords(model,query)}
function hasRole(c,role){return c.canonical.builtinRoles.includes(role)}
"#;
    let names: std::collections::BTreeSet<_> = js
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '$' && c != '_')
        .filter(|word| word.starts_with("$can$u$"))
        .collect();
    let ui = names
        .iter()
        .map(|name| format!("const {name}=(...args)=>{{globalThis.ui.push(args);return '';}};\n"))
        .collect::<String>();
    std::fs::write(
        &module,
        format!("{prefix}{ui}{js}\nexport {{{descriptor} as descriptor}};\n"),
    )
    .unwrap();
    let runner = scratch.path().join("run.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {descriptor} from './record-route.mjs';
globalThis.ui=[];
let reads=0, activeReads=0, active=true;
const row=Object.freeze({id:'route-item',version:7n,name:'Partner',get active(){activeReads++;return active;}});
const failure=new Error('owning source failed');
let deny=false, multiple=false, prepared=0;
const c={actor:{id:'caller'},path:'/partners/share/route-item',prepareForm:async request=>{assert.equal(request.operation,'records.capture');assert.equal(request.arguments.partner,row);prepared++;return {status:'unavailable',message:'Independent action admission'};},canonical:{builtinRoles:['authenticated','members'],readRecords:async(model,query)=>{
 reads++; assert.equal(model,'records.Item');
 assert.deepEqual(query,{where:{op:'eq',field:'id',value:'route-item'},archived:'exclude',authority:'viewer'});
 if(deny)throw failure;return multiple?[row,row]:[row];
}}};
const route={'Partner.id':'route-item'};
const bindings=await descriptor.admit(c,route);assert.equal(bindings.row,row);assert.equal(reads,1);assert.equal(activeReads,2);
await descriptor.render(c,bindings);assert.equal(reads,1);
assert.equal(prepared,1,'action preparation receives the exact admitted row');
assert.ok(globalThis.ui.some(args=>Array.isArray(args[0]?.values)&&args[0].values.includes('Partner')),'render reads the admitted public name');
active=false;await assert.rejects(descriptor.admit(c,route),e=>e.code==='forbidden');assert.equal(reads,2);assert.equal(activeReads,3);
c.canonical.builtinRoles=[];await assert.rejects(descriptor.admit(c,route),e=>e.code==='forbidden');assert.equal(reads,2,'earlier context denial skips row lookup');
c.canonical.builtinRoles=['authenticated','members'];active=true;deny=true;
await assert.rejects(descriptor.admit(c,route),e=>e===failure);assert.equal(reads,3);
deny=false;multiple=true;await assert.rejects(descriptor.admit(c,route),e=>e.code==='forbidden');assert.equal(reads,4);
await assert.rejects(descriptor.admit(c,{}),e=>e.code==='validation');assert.equal(reads,4);
"#).unwrap();
    let output = Command::new("node").arg(&runner).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn record_route_refuses_missing_or_inconsistent_checked_model_association() {
    for mode in ["missing", "scalar", "foreign-model"] {
        let (db, catalog, mut program) = checked(SOURCE);
        let key = *program
            .types
            .node_types
            .keys()
            .find(|key| key.kind == SyntaxKind::RouteRecord as u8)
            .unwrap();
        match mode {
            "missing" => {
                program.types.node_types.remove(&key);
            }
            "scalar" => {
                program.types.node_types.insert(
                    key,
                    ResolvedType::Scalar(canlang_compiler::analysis::types::Scalar::Text),
                );
            }
            _ => {
                let customer = program
                    .symbols
                    .iter()
                    .find(|symbol| symbol.canonical == "records.Customer")
                    .unwrap()
                    .id;
                program.types.node_types.insert(
                    key,
                    ResolvedType::Record {
                        symbol: customer,
                        stored: true,
                    },
                );
            }
        }
        let (_, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "E6006" && d.message.contains("record route")),
            "{mode}: {diagnostics:?}"
        );
    }
}
