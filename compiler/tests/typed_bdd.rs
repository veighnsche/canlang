//! BDD strings retain generated JavaScript recipes and executable functions.
use canlang_compiler::analysis::resolve::{FixtureTarget, ModuleId, SymbolId};
use canlang_compiler::codegen::bdd::{BddSuite, IrExampleImport, emit_fixture_shell, emit_suite};
use canlang_compiler::codegen::ir::{IrFixture, IrFixtureKind, IrItem, IrItemKind, IrProgram};
use canlang_compiler::source::{SourceId, Span};

fn ir() -> IrProgram {
    IrProgram {
        modules: vec![],
        items: vec![],
        catalog_version: String::new(),
        value_constraints: Default::default(),
        scenario_disclosures: Default::default(),
        referenced_builtins: vec![],
        read_rules: vec![],
        invariants: vec![],
        locks: vec![],
        retention: vec![],
        crud_when: vec![],
        preferences_valid: vec![],
        suites: vec![],
        migrations: vec![],
    }
}

fn span() -> Span {
    Span::new(SourceId(0), 0, 1)
}

#[test]
fn generated_suite_keeps_strings_inside_executable_recipe() {
    let suite = BddSuite {
        scope: "Demo.run".into(),
        fixtures: vec![IrFixture {
            name: "worker".into(),
            canonical: "Demo.worker".into(),
            span: span(),
            dependencies: vec![],
            kind: IrFixtureKind::User {
                roles: vec!["a\"\\/\n\u{8}\u{c}é😀\u{2028}\u{2029}".into(), "".into()],
            },
        }],
        imported: vec![IrExampleImport {
            provider: "p\"\\/\n".into(),
            member: "é😀".into(),
            alias: "".into(),
        }],
        tables: vec![],
        sequences: vec![],
        span: span(),
    };
    let (emitted, diagnostics, builtins) = emit_suite(&ir(), &suite);
    assert!(diagnostics.is_empty());
    assert!(builtins.is_empty());
    assert_eq!(emitted.scope, "Demo.run");
    assert_eq!(emitted.fixtures, ["Demo.worker"]);
    assert_eq!(emitted.module.path, "tests/$can$t$44656d6f2e72756e.mjs");
    let expected = concat!(
        "// Test-only example artifact: erased from production bundles.\n",
        r#"export const exampleImports=[{provider:"p\"\\/\n",member:"é😀",alias:""}];"#,
        "\n",
        "export function exampleFixtures({self,other,imported}){\n",
        "const $can$f$776f726b6572={dependencies:[],user:async(c,s)=>({roles:[\"a\\\"\\\\/\\n\\u0008\\u000cé😀\u{2028}\u{2029}\",\"\"]})};\n",
        "return {fixtures:{[\"worker\"]:$can$f$776f726b6572},examples:[]};\n",
        "}\n",
    );
    assert_eq!(emitted.module.js, expected);
}

#[test]
fn generated_fixture_shell_keeps_quoted_error_and_throwing_function() {
    let item = IrItem {
        id: SymbolId(0),
        canonical: "Demo.a\"\\/\n\u{8}\u{c}é😀".into(),
        name: "worker".into(),
        module: ModuleId(0),
        span: span(),
        exported: false,
        kind: IrItemKind::Fixture {
            target: FixtureTarget::User,
            recipe: None,
        },
    };
    let emitted = emit_fixture_shell(&ir(), &item);
    let expected = concat!(
        "// Test-only example artifact: erased from production bundles.\n",
        "export function exampleFixtures({self,other,imported}){\n",
        r#"const $can$f$776f726b6572={dependencies:[],user:async(c,s)=>{throw new Error("unchecked fixture recipe: Demo.a\"\\/\n\u0008\u000cé😀");}};"#,
        "\n",
        "return {fixtures:{[\"worker\"]:$can$f$776f726b6572},examples:[]};\n",
        "}\n",
    );
    assert_eq!(emitted.module.js, expected);
}
