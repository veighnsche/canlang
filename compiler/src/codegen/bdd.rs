//! Separate test artifacts for inline behavior examples (lane-01 codegen, PR6).
//!
//! [`emit_suite`] lowers one [`BddSuite`] (fixtures, tables, sequences for
//! one attaching operation) to a test-only module with the
//! `exampleFixtures({self,other,imported})` factory: model/user/file
//! recipes, delivery recipes, tables with dependencies/inputs/rows and
//! sequences with call/binding/assertion steps. [`emit_fixture_shell`]
//! emits one failing recipe shell per fixture while PR5 example tables are
//! missing (`E6006` covers each).
//!
//! Production modules never import test artifacts: test modules live under
//! `tests/` and are listed in `CompileArtifact.tests`, erased from
//! production bundles.

use crate::codegen::ir::{
    IrFixture, IrFixtureKind, IrItem, IrItemKind, IrProgram, IrSequence, IrStep, IrTable,
    IrTableRow,
};
use crate::codegen::js::{Emitter, JsModule, JsWriter, js_string};
use crate::diagnostic::Diagnostic;
use crate::source::Span;

/// One canonical example import reference.
#[derive(Debug, Clone)]
pub struct IrExampleImport {
    /// Provider package.
    pub provider: String,
    /// Provider-side member.
    pub member: String,
    /// Consumer-side alias.
    pub alias: String,
}

/// One test suite: fixtures, tables and sequences for one scope.
#[derive(Debug, Clone)]
pub struct BddSuite {
    /// Attaching scenario/CRUD identity (scope of the test module).
    pub scope: String,
    /// Canonical fixture identities provisioned by this module.
    pub fixtures: Vec<IrFixture>,
    /// Canonical example imports used by `imported` recipes.
    pub imported: Vec<IrExampleImport>,
    /// Behavior tables in source order.
    pub tables: Vec<IrTable>,
    /// Causal sequences in source order.
    pub sequences: Vec<IrSequence>,
    /// Suite span (attaching operation declaration).
    pub span: Span,
}

/// One emitted test module.
#[derive(Debug, Clone)]
pub struct BddModule {
    /// Attaching scope (scenario/CRUD identity, or fixture identity for
    /// recipe shells).
    pub scope: String,
    /// Canonical fixture identities provisioned by this module.
    pub fixtures: Vec<String>,
    /// Emitted module (`tests/<scope>.mjs`).
    pub module: JsModule,
}

/// Lower one suite to a test module.
pub fn emit_suite(
    ir: &IrProgram,
    suite: &BddSuite,
) -> (
    BddModule,
    Vec<Diagnostic>,
    Vec<crate::codegen::ir::ReferencedBuiltin>,
) {
    let mut emitter = Emitter::new(ir);
    let mut body = JsWriter::new();
    if !suite.imported.is_empty() {
        let imports = suite
            .imported
            .iter()
            .map(|i| {
                format!(
                    "{{provider:{},member:{},alias:{}}}",
                    js_string(&i.provider),
                    js_string(&i.member),
                    js_string(&i.alias)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        body.push(
            suite.span,
            Some("exampleImports".to_string()),
            &format!("export const exampleImports=[{imports}];"),
        );
    }
    body.push(
        suite.span,
        Some("exampleFixtures".to_string()),
        "export function exampleFixtures({self,other,imported}){",
    );
    for fixture in &suite.fixtures {
        let recipe = lower_recipe(&mut emitter, fixture);
        body.push(
            fixture.span,
            Some(fixture.canonical.clone()),
            &format!("const {}={};", sanitize(&fixture.name), recipe),
        );
    }
    let names: Vec<String> = suite.fixtures.iter().map(|f| sanitize(&f.name)).collect();
    let mut examples = Vec::new();
    for table in &suite.tables {
        examples.push(lower_table(&mut emitter, table));
    }
    for sequence in &suite.sequences {
        examples.push(lower_sequence(&mut emitter, sequence));
    }
    body.push(
        suite.span,
        Some("exampleFixtures".to_string()),
        &format!(
            "return {{fixtures:{{{}}},examples:[{}]}};",
            names.join(","),
            examples.join(",")
        ),
    );
    body.push(suite.span, Some("exampleFixtures".to_string()), "}");
    let mut out = JsWriter::new();
    out.push(
        suite.span,
        None,
        "// Test-only example artifact: erased from production bundles.",
    );
    for line in emitter.import_lines() {
        out.push(suite.span, None, &line);
    }
    out.append(&body);
    let (diags, builtins, _, _) = emitter.finish();
    let fixtures = suite.fixtures.iter().map(|f| f.canonical.clone()).collect();
    let module = out.finish(format!("tests/{}.mjs", sanitize(&suite.scope)));
    (
        BddModule {
            scope: suite.scope.clone(),
            fixtures,
            module,
        },
        diags,
        builtins,
    )
}

/// Emit one failing recipe shell for a fixture while PR5 example tables
/// are missing. The shell keeps the recipe kind shape but throws loudly.
pub fn emit_fixture_shell(ir: &IrProgram, item: &IrItem) -> BddModule {
    let target = match &item.kind {
        IrItemKind::Fixture { target, .. } => *target,
        _ => panic!("fixture shell needs a fixture item"),
    };
    let message = format!("unchecked fixture recipe: {}", item.canonical);
    let recipe = match target {
        crate::analysis::resolve::FixtureTarget::Model(model) => {
            // Never direct-index: like the Operation arm, a missing row
            // keeps the recipe shape against the fixture name. The shell
            // still throws; only the model label loses precision.
            let name = ir
                .items
                .get(model.0 as usize)
                .map(|row| row.canonical.clone())
                .unwrap_or_else(|| item.canonical.clone());
            format!(
                "{{model:{},dependencies:[],value:async(c,s)=>{{throw new Error({});}}}}",
                js_string(&name),
                js_string(&message)
            )
        }
        crate::analysis::resolve::FixtureTarget::User => format!(
            "{{dependencies:[],user:async(c,s)=>{{throw new Error({});}}}}",
            js_string(&message)
        ),
        crate::analysis::resolve::FixtureTarget::File => format!(
            "{{dependencies:[],file:async(c,s)=>{{throw new Error({});}}}}",
            js_string(&message)
        ),
        // The operation identity rides the target (G11) when the fixture
        // resolves locally; `None` (bound-external/opaque) falls back to
        // the fixture name. Shells still throw: only the message gains
        // precision.
        crate::analysis::resolve::FixtureTarget::Operation(op) => {
            let name = op
                .and_then(|id| ir.items.get(id.0 as usize))
                .map(|item| item.canonical.clone())
                .unwrap_or_else(|| item.canonical.clone());
            format!(
                "{{dependencies:[],values:async(c,s)=>{{throw new Error({});}}}}",
                js_string(&format!("unchecked fixture recipe: {name}"))
            )
        }
        crate::analysis::resolve::FixtureTarget::Unknown => format!(
            "{{dependencies:[],value:async(c,s)=>{{throw new Error({});}}}}",
            js_string(&format!("unresolved fixture target: {}", item.canonical))
        ),
    };
    let mut out = JsWriter::new();
    out.push(
        item.span,
        None,
        "// Test-only example artifact: erased from production bundles.",
    );
    out.push(
        item.span,
        Some(item.canonical.clone()),
        "export function exampleFixtures({self,other,imported}){",
    );
    out.push(
        item.span,
        Some(item.canonical.clone()),
        &format!("const {}={};", sanitize(&item.name), recipe),
    );
    out.push(
        item.span,
        Some(item.canonical.clone()),
        &format!(
            "return {{fixtures:{{{}}},examples:[]}};",
            sanitize(&item.name)
        ),
    );
    out.push(item.span, Some(item.canonical.clone()), "}");
    BddModule {
        scope: item.canonical.clone(),
        fixtures: vec![item.canonical.clone()],
        module: out.finish(format!("tests/{}.mjs", sanitize(&item.canonical))),
    }
}

/// Lower one fixture recipe. Kinds are mutually exclusive; a recipe is
/// never dereferenced as though it were a stored row.
fn lower_recipe(emitter: &mut Emitter<'_>, fixture: &IrFixture) -> String {
    let deps = fixture
        .dependencies
        .iter()
        .map(|d| sanitize(d))
        .collect::<Vec<_>>()
        .join(",");
    match &fixture.kind {
        IrFixtureKind::Model { model, fields } => format!(
            "{{model:{},dependencies:[{deps}],value:async(c,s)=>({})}}",
            js_string(model),
            emitter.lower_expr(fields)
        ),
        IrFixtureKind::User { roles } => format!(
            "{{dependencies:[],user:async(c,s)=>({{roles:[{}]}})}}",
            roles
                .iter()
                .map(|r| js_string(r))
                .collect::<Vec<_>>()
                .join(",")
        ),
        IrFixtureKind::File { fields } => format!(
            "{{dependencies:[{deps}],file:async(c,s)=>({})}}",
            emitter.lower_expr(fields)
        ),
        IrFixtureKind::Delivery {
            operation,
            request,
            status,
            result,
            error,
        } => {
            let mut values = vec![format!("request:{}", emitter.lower_expr(request))];
            if let Some(status) = status {
                values.push(format!("status:{}", emitter.lower_expr(status)));
            }
            if let Some(result) = result {
                values.push(format!("result:{}", emitter.lower_expr(result)));
            }
            if let Some(error) = error {
                values.push(format!("error:{}", emitter.lower_expr(error)));
            }
            format!(
                "{{dependencies:[{deps}],delivery:{},values:async(c,s)=>({{{}}})}}",
                js_string(operation),
                values.join(",")
            )
        }
    }
}

/// Lower one behavior table: common dependencies and inputs, selectors,
/// observations, and rows with either expected values or an exact error.
fn lower_table(emitter: &mut Emitter<'_>, table: &IrTable) -> String {
    let deps = names_list(&table.dependencies);
    let inputs = emitter.lower_expr(&table.inputs);
    let selectors = table
        .selectors
        .iter()
        .map(|s| js_string(s))
        .collect::<Vec<_>>()
        .join(",");
    let observations = table
        .observations
        .iter()
        .map(|o| format!("async(c,s)=>{}", emitter.lower_expr(o)))
        .collect::<Vec<_>>()
        .join(",");
    let rows = table
        .rows
        .iter()
        .map(|row| lower_row(emitter, row))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{operation:{},dependencies:[{deps}],inputs:async(c,s)=>({inputs}),selectors:[{selectors}],observations:[{observations}],rows:[{rows}]}}",
        js_string(&table.operation)
    )
}

/// Lower one table row.
fn lower_row(emitter: &mut Emitter<'_>, row: &IrTableRow) -> String {
    let deps = names_list(&row.dependencies);
    let values = emitter.lower_expr(&row.values);
    let mut parts = vec![
        format!("dependencies:[{deps}]"),
        format!("values:async(c,s)=>({values})"),
    ];
    match (&row.expected, &row.error) {
        (Some(expected), None) => {
            parts.push(format!(
                "expected:async(c,s)=>({})",
                emitter.lower_expr(expected)
            ));
        }
        (None, Some(error)) => {
            parts.push(format!("error:{}", js_string(error)));
        }
        // Both or neither is a malformed row; analysis owns that error
        // (`E5xxx`), so lowering keeps the values and reports nothing.
        (Some(_), Some(_)) | (None, None) => {}
    }
    format!("{{{}}}", parts.join(","))
}

/// Lower one causal sequence: dependency closure plus call/binding/
/// assertion steps. The outer operation causes no implicit call.
fn lower_sequence(emitter: &mut Emitter<'_>, sequence: &IrSequence) -> String {
    let deps = names_list(&sequence.dependencies);
    let steps = sequence
        .steps
        .iter()
        .map(|step| lower_step(emitter, step))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{operation:{},dependencies:[{deps}],sequence:[{steps}]}}",
        js_string(&sequence.operation)
    )
}

/// Lower one sequence step.
fn lower_step(emitter: &mut Emitter<'_>, step: &IrStep) -> String {
    match step {
        IrStep::Call {
            operation,
            by,
            inputs,
            request,
            bind,
            error,
        } => {
            let mut parts = vec![
                format!("operation:{}", js_string(operation)),
                format!("by:async(c,s,b)=>({})", emitter.lower_expr(by)),
                format!("inputs:async(c,s,b)=>({})", emitter.lower_expr(inputs)),
            ];
            if let Some(request) = request {
                parts.push(format!(
                    "request:async(c,s,b)=>({})",
                    emitter.lower_expr(request)
                ));
            }
            if let Some(bind) = bind {
                parts.push(format!("bind:{}", js_string(bind)));
            }
            if let Some(error) = error {
                parts.push(format!("error:{}", js_string(error)));
            }
            format!("{{{}}}", parts.join(","))
        }
        IrStep::Binding { name, value } => format!(
            "{{let:{},value:async(c,s,b)=>({})}}",
            js_string(name),
            emitter.lower_expr(value)
        ),
        IrStep::Assertion {
            observations,
            expected,
            types,
        } => format!(
            "{{observations:async(c,s,b)=>({}),expected:async(c,s,b)=>({}),types:[{}]}}",
            emitter.lower_expr(observations),
            emitter.lower_expr(expected),
            types
                .iter()
                .map(|t| js_string(t))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

/// Recipe-name list for dependency arrays.
fn names_list(names: &[String]) -> String {
    names
        .iter()
        .map(|n| sanitize(n))
        .collect::<Vec<_>>()
        .join(",")
}

/// Sanitize a scope/recipe name into a JS identifier or path segment.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .replace('.', "_")
}

#[cfg(test)]
mod string_tests {
    use super::js_string;

    #[test]
    fn fixed_string_bytes_cover_every_control_and_unicode() {
        let controls: String = (0u8..32).map(char::from).collect();
        assert_eq!(
            js_string(&controls),
            r#""\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\t\n\u000b\u000c\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f""#,
        );
        assert_eq!(js_string(""), r#""""#);
        assert_eq!(
            js_string("\"\\/é😀\u{2028}\u{2029}"),
            "\"\\\"\\\\/é😀\u{2028}\u{2029}\""
        );
    }
}
