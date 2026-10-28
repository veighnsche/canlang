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

use crate::analysis::types::ResolvedType;
use crate::codegen::ir::{
    IrExpr, IrFixture, IrFixtureKind, IrItem, IrItemKind, IrMessage, IrMessageCallParam, IrProgram,
    IrQuery, IrQueryDomain, IrSequence, IrStep, IrTable, IrTableRow, TypedExpr,
};
use crate::codegen::js::{Emitter, JsModule, JsWriter, binding_ident, js_string};
use crate::diagnostic::Diagnostic;
use crate::source::Span;
use std::collections::{HashMap, HashSet};

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
    let (fixtures, tables) = complete_table_fixture_bindings(ir, suite);
    let fixtures = match order_fixture_recipes(fixtures) {
        Ok(fixtures) => fixtures,
        Err(diagnostic) => return (
            BddModule {
                scope: suite.scope.clone(),
                fixtures: suite.fixtures.iter().map(|fixture| fixture.name.clone()).collect(),
                module: JsModule {
                    path: format!("tests/{}.mjs", binding_ident("t", &suite.scope)),
                    js: "export function exampleFixtures(){throw new Error(\"cannot lower cyclic fixture recipes\");}\n".to_string(),
                    lines: Vec::new(),
                },
            },
            vec![diagnostic],
            Vec::new(),
        ),
    };
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
    for import in &suite.imported {
        body.push(
            suite.span,
            Some(import.alias.clone()),
            &format!(
                "const {}=imported[{}];",
                binding_ident("f", &import.alias),
                js_string(&import.alias)
            ),
        );
    }
    for fixture in &fixtures {
        let recipe = lower_recipe(&mut emitter, fixture);
        body.push(
            fixture.span,
            Some(fixture.canonical.clone()),
            &format!("const {}={};", binding_ident("f", &fixture.name), recipe),
        );
    }
    let names: Vec<String> = fixtures
        .iter()
        .map(|f| format!("[{}]:{}", js_string(&f.name), binding_ident("f", &f.name)))
        .collect();
    let mut examples = Vec::new();
    let mut table_diags = Vec::new();
    for table in &tables {
        if !table_channels_are_aligned(table) {
            table_diags.push(Diagnostic::error(
                "E6008",
                "cannot lower example table: selector channels are not aligned with checked selectors".to_string(),
                table.span,
            ));
            continue;
        }
        examples.push(lower_table(&mut emitter, table));
    }
    for sequence in &suite.sequences {
        examples.push(lower_sequence(&mut emitter, sequence));
    }
    body.push(
        suite.span,
        Some("exampleFixtures".to_string()),
        &format!(
            "return {{fixtures:{{...imported,{}}},examples:[{}]}};",
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
    for line in emitter.example_helper_lines() {
        out.push(suite.span, None, &line);
    }
    for line in emitter.support_lines() {
        out.push(suite.span, None, &line);
    }
    out.append(&body);
    let (mut diags, builtins, _, _) = emitter.finish();
    diags.extend(table_diags);
    let fixtures = fixtures.iter().map(|f| f.canonical.clone()).collect();
    let path = format!("tests/{}.mjs", binding_ident("t", &suite.scope));
    let module = match out.try_finish(path.clone()) {
        Ok(module) => module,
        Err(diagnostic) => {
            diags.push(diagnostic);
            JsModule {
                path,
                js: String::new(),
                lines: Vec::new(),
            }
        }
    };
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

/// Recipe objects eagerly reference their dependencies. Complete the graph
/// first, then emit dependencies before consumers with source order as the
/// stable tie-breaker. A malformed late graph refuses instead of emitting TDZ.
fn order_fixture_recipes(mut fixtures: Vec<IrFixture>) -> Result<Vec<IrFixture>, Diagnostic> {
    fixtures.sort_by_key(|fixture| (fixture.span.file.0, fixture.span.start));
    let local: HashSet<_> = fixtures
        .iter()
        .map(|fixture| fixture.name.clone())
        .collect();
    let mut ordered = Vec::new();
    let mut emitted = HashSet::new();
    while !fixtures.is_empty() {
        let Some(next) = fixtures.iter().position(|fixture| {
            fixture
                .dependencies
                .iter()
                .all(|dependency| !local.contains(dependency) || emitted.contains(dependency))
        }) else {
            return Err(Diagnostic::error(
                "E6008",
                "cannot lower fixture dependency cycle".to_string(),
                fixtures[0].span,
            ));
        };
        let fixture = fixtures.remove(next);
        emitted.insert(fixture.name.clone());
        ordered.push(fixture);
    }
    Ok(ordered)
}

/// A table's common `name=fixture` binding can share its spelling with the
/// attaching scenario parameter. The general IR then retains a bare name
/// (the scenario parameter wins member lookup), although examples must read
/// the test fixture. Recover only a declared same-module recipe named by that
/// common binding, and rewrite that table's checked expressions to `s.name`.
/// The recipe and its dependencies join the suite before lowering; rows never
/// close over a production parameter that the test factory does not receive.
fn complete_table_fixture_bindings(
    ir: &IrProgram,
    suite: &BddSuite,
) -> (Vec<IrFixture>, Vec<IrTable>) {
    let Some(module) = ir
        .items
        .iter()
        .find(|item| item.canonical == suite.scope)
        .map(|item| item.module)
    else {
        return (suite.fixtures.clone(), suite.tables.clone());
    };
    let recipes: Vec<&IrFixture> = ir
        .items
        .iter()
        .filter_map(|item| {
            if item.module != module {
                return None;
            }
            match &item.kind {
                IrItemKind::Fixture {
                    recipe: Some(recipe),
                    ..
                } => Some(recipe),
                _ => None,
            }
        })
        .collect();
    let by_name: HashMap<&str, &IrFixture> = recipes
        .iter()
        .flat_map(|recipe| {
            [
                (recipe.name.as_str(), *recipe),
                (
                    recipe.canonical.rsplit('.').next().unwrap_or(&recipe.name),
                    *recipe,
                ),
            ]
        })
        .collect();
    let mut needed: HashSet<String> = suite
        .fixtures
        .iter()
        .map(|fixture| fixture.name.clone())
        .collect();
    let mut tables = suite.tables.clone();
    for table in &mut tables {
        let mut aliases = HashMap::new();
        if let IrExpr::Object(entries) = &table.inputs.expr {
            for (_, value) in entries {
                if let IrExpr::Name(name) = &value.expr
                    && by_name.contains_key(name.as_str())
                {
                    aliases.insert(name.clone(), by_name[name.as_str()].name.clone());
                    needed.insert(by_name[name.as_str()].name.clone());
                    if !table.dependencies.contains(&by_name[name.as_str()].name) {
                        table.dependencies.push(by_name[name.as_str()].name.clone());
                    }
                }
            }
        }
        if aliases.is_empty() {
            continue;
        }
        rewrite_fixture_names(&mut table.inputs, &aliases);
        for observation in &mut table.observations {
            rewrite_fixture_names(observation, &aliases);
        }
        for row in &mut table.rows {
            rewrite_fixture_names(&mut row.values, &aliases);
            if let Some(expected) = &mut row.expected {
                rewrite_fixture_names(expected, &aliases);
            }
        }
    }
    loop {
        let before = needed.len();
        for name in needed.clone() {
            // A linked provider owns its complete transitive closure. Never
            // clone one of its local dependencies over the imported object.
            if suite.imported.iter().any(|import| import.alias == name) {
                continue;
            }

            if let Some(recipe) = recipes.iter().find(|recipe| recipe.name == name) {
                needed.extend(recipe.dependencies.iter().cloned());
            }
        }
        if needed.len() == before {
            break;
        }
    }
    let mut fixtures = suite.fixtures.clone();
    for recipe in recipes {
        if needed.contains(&recipe.name)
            && !suite
                .imported
                .iter()
                .any(|import| import.alias == recipe.name)
            && !fixtures.iter().any(|fixture| fixture.name == recipe.name)
        {
            fixtures.push(recipe.clone());
        }
    }
    (fixtures, tables)
}

fn visible_aliases(
    aliases: &HashMap<String, String>,
    domain: &IrQueryDomain,
) -> HashMap<String, String> {
    let mut visible = aliases.clone();
    visible.remove(match domain {
        IrQueryDomain::Value { alias, .. } => alias.as_str(),
        IrQueryDomain::Model(_) => "row",
    });
    visible
}

fn rewrite_query_fixtures(query: &mut IrQuery, aliases: &HashMap<String, String>) {
    if let IrQueryDomain::Value { base, .. } = &mut query.domain {
        rewrite_fixture_names(base, aliases);
    }
    for value in [&mut query.parent, &mut query.limit, &mut query.archived]
        .into_iter()
        .flatten()
    {
        rewrite_fixture_names(value, aliases);
    }
    if let Some(predicate) = &mut query.where_pred {
        rewrite_fixture_names(predicate, &visible_aliases(aliases, &query.domain));
    }
    if let Some(order) = &mut query.value_order {
        rewrite_fixture_names(&mut order.key, &visible_aliases(aliases, &query.domain));
    }
    if let Some(projection) = &mut query.select {
        let mut visible = aliases.clone();
        if let Some(param) = &query.select_param {
            visible.remove(param);
        }
        rewrite_fixture_names(projection, &visible);
    }
}

fn rewrite_message_call_fixtures(
    descriptor: &mut IrMessage,
    args: &mut Vec<TypedExpr>,
    params: &mut Vec<IrMessageCallParam>,
    aliases: &HashMap<String, String>,
) {
    for param in &mut descriptor.params {
        rewrite_fixture_names(&mut param.value, aliases);
    }
    for arg in args {
        rewrite_fixture_names(arg, aliases);
    }
    for param in params {
        if let Some(default) = &mut param.default {
            rewrite_fixture_names(default, aliases);
        }
    }
}

fn rewrite_fixture_names(expr: &mut TypedExpr, aliases: &HashMap<String, String>) {
    match &mut expr.expr {
        IrExpr::Name(name) if aliases.contains_key(name) => {
            let fixture = aliases.get(name).expect("checked alias").clone();
            expr.expr = IrExpr::Member {
                base: Box::new(TypedExpr::new(
                    IrExpr::Name("s".to_string()),
                    ResolvedType::Unknown,
                    expr.span,
                )),
                field: fixture,
            };
        }
        IrExpr::Member { base, .. }
        | IrExpr::Unary { operand: base, .. }
        | IrExpr::DeliveryRead { record: base, .. } => rewrite_fixture_names(base, aliases),
        IrExpr::Call { args, .. }
        | IrExpr::BoundCall { args, .. }
        | IrExpr::Array(args)
        | IrExpr::Format { args, .. } => {
            for arg in args {
                rewrite_fixture_names(arg, aliases);
            }
        }
        IrExpr::Binary { left, right, .. } => {
            rewrite_fixture_names(left, aliases);
            rewrite_fixture_names(right, aliases);
        }
        IrExpr::Object(entries) => {
            for (_, value) in entries {
                rewrite_fixture_names(value, aliases);
            }
        }
        IrExpr::Query(query) => {
            rewrite_query_fixtures(query, aliases);
        }
        IrExpr::Message(message) => {
            for param in &mut message.params {
                rewrite_fixture_names(&mut param.value, aliases);
            }
        }
        IrExpr::MessageCall {
            descriptor,
            args,
            params,
        } => {
            rewrite_message_call_fixtures(descriptor, args, params, aliases);
        }
        IrExpr::JudgmentSpecification {
            options: Some(options),
            ..
        } => {
            rewrite_fixture_names(options, aliases);
        }
        IrExpr::HasRole {
            person: Some(person),
            ..
        } => {
            rewrite_fixture_names(person, aliases);
        }
        IrExpr::Lambda { param, body } => {
            let mut visible = aliases.clone();
            visible.remove(param);
            rewrite_fixture_names(body, &visible);
        }
        _ => {}
    }
}

/// Emit one failing recipe shell for a fixture while PR5 example tables
/// are missing. The shell keeps the recipe kind shape but throws loudly.
///
/// # Panics
/// Requires a fixture item and representable output. Use
/// [`try_emit_fixture_shell`] to handle numeric output exhaustion.
pub fn emit_fixture_shell(ir: &IrProgram, item: &IrItem) -> BddModule {
    try_emit_fixture_shell(ir, item)
        .unwrap_or_else(|error| panic!("cannot emit fixture shell: {}", error.message))
}

/// Emit a fixture shell, refusing unrepresentable generated line numbers.
pub fn try_emit_fixture_shell(ir: &IrProgram, item: &IrItem) -> Result<BddModule, Diagnostic> {
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
        &format!("const {}={};", binding_ident("f", &item.name), recipe),
    );
    out.push(
        item.span,
        Some(item.canonical.clone()),
        &format!(
            "return {{fixtures:{{[{}]:{}}},examples:[]}};",
            js_string(&item.name),
            binding_ident("f", &item.name)
        ),
    );
    out.push(item.span, Some(item.canonical.clone()), "}");
    Ok(BddModule {
        scope: item.canonical.clone(),
        fixtures: vec![item.canonical.clone()],
        module: out.try_finish(format!("tests/{}.mjs", binding_ident("t", &item.canonical)))?,
    })
}

/// Lower one fixture recipe. Kinds are mutually exclusive; a recipe is
/// never dereferenced as though it were a stored row.
fn lower_recipe(emitter: &mut Emitter<'_>, fixture: &IrFixture) -> String {
    let deps = fixture
        .dependencies
        .iter()
        .map(|d| binding_ident("f", d))
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
fn table_channels_are_aligned(table: &IrTable) -> bool {
    use crate::analysis::examples::SelectorChannel;
    let Some(channels) = &table.selector_channels else {
        return true;
    };
    channels.len() == table.selectors.len()
        && channels
            .iter()
            .zip(&table.selectors)
            .all(|(channel, selector)| match channel {
                SelectorChannel::Caller => selector == "as",
                SelectorChannel::Request => {
                    selector.starts_with("request.") && selector.len() > "request.".len()
                }
                SelectorChannel::Input => selector != "as",
            })
}

fn lower_table(emitter: &mut Emitter<'_>, table: &IrTable) -> String {
    let channels = if let Some(channels) = &table.selector_channels {
        format!(
            ",selectorChannels:[{}]",
            channels
                .iter()
                .map(|channel| js_string(channel.as_str()))
                .collect::<Vec<_>>()
                .join(",")
        )
    } else {
        String::new()
    };
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
        .map(|observation| {
            let mut observation = observation.clone();
            // The table callback receives live observation values through s;
            // source `result` is not an ambient JavaScript identifier.
            rewrite_fixture_names(
                &mut observation,
                &HashMap::from([("result".to_string(), "result".to_string())]),
            );
            format!("async(c,s)=>{}", emitter.lower_expr(&observation))
        })
        .collect::<Vec<_>>()
        .join(",");
    // The load-time caller probe evaluates only the `as` cell, so rows
    // carry a dedicated caller closure and never evaluate sibling cells
    // (which may reference unprovisioned business fixtures or validating
    // calls) just to select the caller.
    let caller_index = table.selector_channels.as_ref().and_then(|channels| {
        channels
            .iter()
            .position(|channel| channel.as_str() == "caller")
    });
    let rows = table
        .rows
        .iter()
        .map(|row| lower_row(emitter, row, caller_index))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{operation:{},dependencies:[{deps}],inputs:async(c,s)=>({inputs}),selectors:[{selectors}]{channels},observations:[{observations}],rows:[{rows}]}}",
        js_string(&table.operation)
    )
}

/// Lower one table row.
fn lower_row(emitter: &mut Emitter<'_>, row: &IrTableRow, caller_index: Option<usize>) -> String {
    let deps = names_list(&row.dependencies);
    let values = emitter.lower_expr(&row.values);
    let mut parts = vec![
        format!("dependencies:[{deps}]"),
        format!("values:async(c,s)=>({values})"),
    ];
    if let (Some(index), IrExpr::Array(cells)) = (caller_index, &row.values.expr)
        && let Some(cell) = cells.get(index)
    {
        let caller = emitter.lower_expr(cell);
        parts.push(format!("caller:async(c,s)=>({caller})"));
    }
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
        .map(|n| binding_ident("f", n))
        .collect::<Vec<_>>()
        .join(",")
}
