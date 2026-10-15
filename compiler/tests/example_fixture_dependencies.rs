//! Common and row-specific fixture dependencies retain checked declaration identity.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

#[test]
fn nested_common_inputs_seed_imported_fixtures_without_seeding_later_rows() {
    let source = r#"app FixtureDependencyRoots uses=[owners,consumer]
package owners
 Given
  export Customer {name:text}
  export Contact in Customer {name:text}
  export fixture company=Customer {name="company"}
  export fixture contact=Contact {parent=company,name="contact"}
  export fixture later=Customer {name="later"}
 When
 Then
package consumer
 use owners {Customer,Contact,company as selected,contact as person,later as alternative}
 Given
  contract Bundle {customer:Customer,contacts:Contact[]}
 When
  scenario echo(input:Bundle) by=members -> Customer
   do return input.customer
   examples input={customer=selected,contacts=[person]}
    input.customer -> result.name
    selected -> "company"
    alternative -> "later"
 Then
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add("fixture-dependencies.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new("fixture-dependencies", "1.0", 1);
    result.add_sources(&db);
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: EmitOptions::new(),
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let modules = artifact
        .tests
        .iter()
        .map(|suite| (&suite.scope, &suite.module.js))
        .collect::<Vec<_>>();
    let script = r#"import assert from 'node:assert/strict';
const modules=new Map();
for(const [key,js]of __MODULES__)modules.set(key,await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64')));
const cache=new Map();
function provide(key){if(cache.has(key))return cache.get(key);const module=modules.get(key),imported={};for(const dep of module.exampleImports??[])Object.assign(imported,provide(dep.alias));const value=module.exampleFixtures({self:'self',other:'other',imported});cache.set(key,value.fixtures);return value.fixtures;}
const module=modules.get('consumer.echo'),imported={};for(const dep of module.exampleImports??[])Object.assign(imported,provide(dep.alias));
const {fixtures,examples:[table]}=module.exampleFixtures({self:'self',other:'other',imported});
assert.deepEqual(new Set(table.dependencies),new Set([fixtures['owners.company'],fixtures['owners.contact']]));
assert.deepEqual(table.rows[0].dependencies,[]);
assert.deepEqual(table.rows[1].dependencies,[fixtures['owners.later']]);
assert.ok(!table.dependencies.includes(fixtures['owners.later']));
const scope={'owners.company':{name:'company'},'owners.contact':{name:'contact'},'owners.later':{name:'later'}};
const input=await table.inputs({},scope);
assert.equal(input.input.customer,scope['owners.company']);assert.equal(input.input.contacts[0],scope['owners.contact']);
assert.deepEqual(await table.rows[0].values({},scope),[scope['owners.company']]);
assert.deepEqual(await table.rows[1].values({},scope),[scope['owners.later']]);
"#.replace("__MODULES__", &serde_json::to_string(&modules).unwrap());
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "--eval", &script])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
