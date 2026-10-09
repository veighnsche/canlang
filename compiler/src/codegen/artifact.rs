//! Compile-artifact assembly per `packages/contracts/src/artifact.ts` (lane-01 codegen, PR6).
//!
//! [`assemble`] links lowered modules into a [`CompileArtifact`]:
//! `artifact_version` 1, sources with SHA-256, production modules with the
//! entrypoint first, callable registry references, operation and model
//! descriptors in source order, pages in source order, `requires`
//! capability entries (including the consumed builtin catalog pin) and
//! separate test artifacts. Production modules never import test
//! artifacts.
//!
//! Unavailable capabilities are precise `E6007` errors naming the producer
//! and availability — never silent emission. The `requires` capability ids
//! below (`canlang.builtins`, `values.<family>`, `state`) are provisional
//! pending lane-02/07 confirmation of the activation contract.

use crate::analysis::catalog::{Availability, Catalog};
use crate::codegen::bdd::BddModule;
use crate::codegen::ir::{IrItemKind, IrMigrationDirective, IrProgram, ReferencedBuiltin};
use crate::codegen::js::{Emitter, JsModel, JsOperation, JsOutput};
use crate::codegen::sourcemap::{self, SourceMap};
use crate::diagnostic::Diagnostic;
use crate::source::SourceDb;
use serde::Serialize;
use std::collections::BTreeSet;

/// Artifact envelope version (matches `ARTIFACT_VERSION` in `artifact.ts`).
pub const ARTIFACT_VERSION: u32 = 1;

/// Exact source revision an artifact was compiled from.
#[derive(Debug, Clone)]
pub struct ArtifactSource {
    /// Display path.
    pub path: String,
    /// Lowercase hex SHA-256 of the compiled bytes.
    pub sha256: String,
}

/// One library/runtime capability the emitted code links against.
#[derive(Debug, Clone)]
pub struct ArtifactRequirement {
    /// Producer capability id, e.g. `values.decimal`.
    pub capability: String,
    /// Minimum producer contract version.
    pub min_version: u64,
}

/// Emitted JavaScript module plus its source map.
#[derive(Debug, Clone)]
pub struct ArtifactModule {
    /// Output path relative to the artifact root.
    pub path: String,
    /// Compiled JavaScript (direct emission; no Can-to-TypeScript stage).
    pub js: String,
    /// Source map JSON mapping emitted lines to `.can` byte spans.
    pub map: SourceMap,
}

/// One declared page descriptor reference.
#[derive(Debug, Clone)]
pub struct ArtifactPage {
    /// Canonical declaring package.
    pub owner: String,
    /// Normalized route pattern.
    pub path: String,
    /// Module exporting the page descriptor.
    pub module: String,
    /// Exported descriptor binding name.
    pub export: String,
}

/// One callable registry entry reference.
#[derive(Debug, Clone)]
pub struct ArtifactCallable {
    /// Canonical qualified identity.
    pub id: String,
    /// Registry kind: operation, pure, rule, handler or migration.
    pub kind: String,
    /// Module exporting the callable.
    pub module: String,
    /// Registry member / export name.
    pub export: String,
    /// Path segments into the module's `canApp()` registry object.
    pub member: Vec<String>,
    /// Scenario argument convention; absent means the legacy runtime envelope.
    pub input_style: Option<String>,
}

/// One lowered migration directive in interim-intake vocabulary: `kind`
/// plus exactly the fields that kind carries (`None` fields never
/// render).
#[derive(Debug, Clone)]
pub struct ArtifactMigrationDirective {
    /// Intake kind: renameOwner, dropOwner, renameModel, renameField,
    /// dropModel, dropField, backfill or invalidate.
    pub kind: String,
    /// renameOwner old owner (empty until deployment binds it);
    /// renameModel old model; renameField old field.
    pub from: Option<String>,
    /// renameModel desired model; renameField desired field.
    pub to: Option<String>,
    /// renameField/dropField old model; dropModel/backfill model.
    pub model: Option<String>,
    /// dropField dropped field.
    pub field: Option<String>,
    /// invalidate handler contract.
    pub handler_contract: Option<String>,
}

/// One lowered per-owner migration transition for the registry.
#[derive(Debug, Clone)]
pub struct ArtifactMigration {
    /// Stable migration id (`{owner}@{from}`).
    pub id: String,
    /// Owner name as written.
    pub owner: String,
    /// `from=` predecessor snapshot id.
    pub from: String,
    /// Lowercase hex SHA-256 over the canonical directive encoding.
    pub body_digest: String,
    /// Lowered directives in source order.
    pub directives: Vec<ArtifactMigrationDirective>,
}

/// Map one lowered IR directive to its registry shape.
fn artifact_directive(directive: &IrMigrationDirective) -> ArtifactMigrationDirective {
    let (kind, from, to, model, field, handler_contract) = match directive {
        IrMigrationDirective::RenameOwner { from } => {
            ("renameOwner", Some(from.clone()), None, None, None, None)
        }
        IrMigrationDirective::DropOwner => ("dropOwner", None, None, None, None, None),
        IrMigrationDirective::RenameModel { from, to } => (
            "renameModel",
            Some(from.clone()),
            Some(to.clone()),
            None,
            None,
            None,
        ),
        IrMigrationDirective::RenameField { model, from, to } => (
            "renameField",
            Some(from.clone()),
            Some(to.clone()),
            Some(model.clone()),
            None,
            None,
        ),
        IrMigrationDirective::DropModel { model } => {
            ("dropModel", None, None, Some(model.clone()), None, None)
        }
        IrMigrationDirective::DropField { model, field } => (
            "dropField",
            None,
            None,
            Some(model.clone()),
            Some(field.clone()),
            None,
        ),
        IrMigrationDirective::Backfill { model } => {
            ("backfill", None, None, Some(model.clone()), None, None)
        }
        IrMigrationDirective::Invalidate { handler } => {
            ("invalidate", None, None, None, None, Some(handler.clone()))
        }
    };
    ArtifactMigrationDirective {
        kind: kind.to_string(),
        from,
        to,
        model,
        field,
        handler_contract,
    }
}

/// Separately emitted test artifact for inline behavior examples.
#[derive(Debug, Clone)]
pub struct ArtifactTestModule {
    /// Attaching scenario/CRUD identity (or fixture identity for shells).
    pub scope: String,
    /// Test-only module.
    pub module: ArtifactModule,
    /// Canonical fixture identities provisioned by this module.
    pub fixtures: Vec<String>,
}

/// Root artifact emitted for one program.
#[derive(Debug, Clone)]
pub struct CompileArtifact {
    /// Language version analyzed and emitted, e.g. `1.0`.
    pub language_version: String,
    /// Compiler version.
    pub tool_version: String,
    /// Every source revision consulted, in compilation order.
    pub sources: Vec<ArtifactSource>,
    /// Production modules; the first entry is the program entrypoint.
    pub modules: Vec<ArtifactModule>,
    /// Callable registry references (handlers/rules only, no metadata spread).
    pub callables: Vec<ArtifactCallable>,
    /// User-invocable operation descriptors in source order (MCP P1):
    /// `{name, kind, description, inputs}` per operation.
    pub operations: Vec<JsOperation>,
    /// Stored model descriptors in source order (T15a, T04a §3 intake
    /// plus additive ownership): `{name, fields, deleteMode, ...}` per
    /// model. Together with `operations` (and `artifact_version` 1, the
    /// pinned contract version) this is the L3 `ExecutionDescriptorSet`
    /// content the T16 join loads.
    pub models: Vec<JsModel>,
    /// Checked standard/custom value type contracts and enum declarations,
    /// when the source program owns any such values.
    pub value_types: Option<crate::codegen::js::JsValueTypes>,
    /// Checked complete owner-policy descriptors for the supported native profile.
    pub model_policies: Option<Vec<crate::codegen::model_policies::ModelPolicies>>,
    /// Page descriptors in source order.
    pub pages: Vec<ArtifactPage>,
    /// Lowered migration transitions in source order (B3-I1 registry).
    pub migrations: Vec<ArtifactMigration>,
    /// Linked library/runtime requirements checked at build/activation.
    pub requires: Vec<ArtifactRequirement>,
    /// Test-only example artifacts, erased from production bundles.
    pub tests: Vec<ArtifactTestModule>,
}

/// Assemble the compile artifact from lowered production and test modules.
///
/// `test_builtins` are the catalog builtins referenced from test-module
/// callbacks. Returns the artifact plus `E6007` diagnostics for
/// unavailable capabilities and unpinned catalog requirements. Numeric
/// source-map capacity errors return an empty artifact plus `E6012`.
pub fn assemble(
    ir: &IrProgram,
    js: &JsOutput,
    test_modules: &[BddModule],
    test_builtins: &[ReferencedBuiltin],
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> (CompileArtifact, Vec<Diagnostic>) {
    if let Some(diagnostic) = js
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "E6012")
    {
        return (super::empty_artifact(db), vec![diagnostic.clone()]);
    }
    let mut diags = Vec::new();
    let sources = db
        .iter()
        .map(|(_id, source)| ArtifactSource {
            path: source.path.clone(),
            sha256: source.sha256.clone(),
        })
        .collect();
    let mut modules = Vec::with_capacity(1 + js.packages.len());
    let entry_map = match sourcemap::try_build(&js.entry.path, db, &js.entry.lines) {
        Ok(map) => map,
        Err(diagnostic) => return (super::empty_artifact(db), vec![diagnostic]),
    };
    modules.push(ArtifactModule {
        path: js.entry.path.clone(),
        js: js.entry.js.clone(),
        map: entry_map,
    });
    for package in &js.packages {
        let map = match sourcemap::try_build(&package.path, db, &package.lines) {
            Ok(map) => map,
            Err(diagnostic) => return (super::empty_artifact(db), vec![diagnostic]),
        };
        modules.push(ArtifactModule {
            path: package.path.clone(),
            js: package.js.clone(),
            map,
        });
    }
    let callables: Vec<ArtifactCallable> = js
        .callables
        .iter()
        .map(|c| ArtifactCallable {
            id: c.id.clone(),
            kind: c.kind.as_str().to_string(),
            module: js.entry.path.clone(),
            export: c.export.clone(),
            member: c.member.clone(),
            input_style: c.input_style.clone(),
        })
        .collect();
    let pages = js
        .pages
        .iter()
        .map(|p| ArtifactPage {
            owner: p.owner.clone(),
            path: p.path.clone(),
            module: js.entry.path.clone(),
            export: p.export.clone(),
        })
        .collect();
    let (mut requires, mut require_diags) =
        compute_requires(&ir.catalog_version, &js.stdlib_imports, db);
    if callables
        .iter()
        .any(|callable| callable.input_style.is_some())
    {
        requires.push(ArtifactRequirement {
            capability: "state.parameters".to_string(),
            min_version: 1,
        });
        requires.sort_by(|a, b| a.capability.cmp(&b.capability));
    }
    if ir.items.iter().any(|item| {
        matches!(
            item.kind,
            IrItemKind::Param {
                choices: Some(_),
                ..
            }
        )
    }) {
        requires.push(ArtifactRequirement {
            capability: "interfaces.input-choices".to_string(),
            min_version: 1,
        });
        requires.sort_by(|a, b| a.capability.cmp(&b.capability));
    }
    if ir
        .items
        .iter()
        .any(|item| matches!(&item.kind, IrItemKind::Field { modifiers, .. } if modifiers.machine))
    {
        requires.push(ArtifactRequirement {
            capability: "state.machines".to_string(),
            min_version: 1,
        });
        requires.sort_by(|a, b| a.capability.cmp(&b.capability));
    }
    if ir.items.iter().any(|item| {
        matches!(
            item.kind,
            IrItemKind::Scenario {
                cohort: Some(_),
                ..
            }
        )
    }) {
        requires.push(ArtifactRequirement {
            capability: "state.cohorts".to_string(),
            min_version: 1,
        });
        requires.sort_by(|a, b| a.capability.cmp(&b.capability));
    }
    diags.append(&mut require_diags);
    let mut referenced: Vec<ReferencedBuiltin> = ir.referenced_builtins.clone();
    referenced.extend(js.referenced_builtins.iter().cloned());
    referenced.extend(test_builtins.iter().cloned());
    diags.extend(check_builtin_availability(&referenced, catalog));
    let mut tests = Vec::with_capacity(test_modules.len());
    for test in test_modules {
        let map = match sourcemap::try_build(&test.module.path, db, &test.module.lines) {
            Ok(map) => map,
            Err(diagnostic) => {
                diags.push(diagnostic);
                return (super::empty_artifact(db), diags);
            }
        };
        tests.push(ArtifactTestModule {
            scope: test.scope.clone(),
            module: ArtifactModule {
                path: test.module.path.clone(),
                js: test.module.js.clone(),
                map,
            },
            fixtures: test.fixtures.clone(),
        });
    }
    let migrations = ir
        .migrations
        .iter()
        .map(|migration| ArtifactMigration {
            id: migration.migration_id.clone(),
            owner: migration.owner.clone(),
            from: migration.from_snapshot.clone(),
            body_digest: migration.body_digest.clone(),
            directives: migration
                .directives
                .iter()
                .map(artifact_directive)
                .collect(),
        })
        .collect();
    // T15a model descriptors derive here (JSON envelope only): the
    // runtime reads `appDefinition.models`, so models — unlike
    // operations — are not threaded through `JsOutput`/canApp().
    // Collection is total and diagnostic-free (see `collect_models`).
    let models = Emitter::with_value_types(ir, js.value_types.clone()).collect_models();
    let artifact = CompileArtifact {
        language_version: crate::LANGUAGE_VERSION.to_string(),
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        sources,
        modules,
        callables,
        operations: js.operations.clone(),
        models,
        value_types: js.value_types.clone(),
        model_policies: js.model_policies.clone(),
        pages,
        migrations,
        requires,
        tests,
    };
    (artifact, diags)
}

/// Compute `requires` from the consumed catalog version and the stdlib
/// imports the entrypoint actually uses. Returns the requirements plus
/// `E6007` when the catalog pin is missing.
fn compute_requires(
    catalog_version: &str,
    stdlib_imports: &BTreeSet<String>,
    db: &SourceDb,
) -> (Vec<ArtifactRequirement>, Vec<Diagnostic>) {
    let mut diags = Vec::new();
    let mut requires: Vec<ArtifactRequirement> = Vec::new();
    let primary = db
        .iter()
        .next()
        .map(|(id, _)| crate::source::Span::new(id, 0, 0))
        .unwrap_or(crate::source::Span::new(crate::source::SourceId(0), 0, 0));
    match parse_major(catalog_version) {
        Some(major) => requires.push(ArtifactRequirement {
            capability: "canlang.builtins".to_string(),
            min_version: major,
        }),
        None => {
            let reason = if catalog_version.is_empty() {
                "no producer catalog was consulted (catalog_version is empty); requires cannot pin builtin semantics"
            } else {
                "producer catalog_version is not a semver major the artifact can pin"
            };
            diags.push(Diagnostic::error(
                "E6007",
                format!("cannot pin producer capabilities: {reason} (catalog_version {catalog_version:?})"),
                primary,
            ));
        }
    }
    // Scalar-family pins follow the stdlib imports the lowering actually
    // used: one capability per family with §13 import names.
    let families: &[(&str, &[&str])] = &[
        (
            "values.money",
            &[
                "addMoney",
                "subtractMoney",
                "multiplyMoney",
                "compareMoney",
                "equalMoney",
                "negateMoney",
                "money",
            ],
        ),
        ("values.decimal", &["divideDecimal", "compareDecimal"]),
        (
            "values.temporal",
            &[
                "durationBetween",
                "compareInstant",
                "compareDate",
                "addDuration",
                "subtractDuration",
                "date",
                "datetime",
            ],
        ),
        ("values.int64", &["int64"]),
    ];
    for (capability, imports) in families {
        if imports.iter().any(|name| stdlib_imports.contains(*name)) {
            requires.push(ArtifactRequirement {
                capability: (*capability).to_string(),
                min_version: 1,
            });
        }
    }
    if [
        "create",
        "set",
        "transition",
        "deleteRecord",
        "send",
        "schedule",
        "cancel",
        "delivery",
        "emit",
    ]
    .iter()
    .any(|name| stdlib_imports.contains(*name))
    {
        requires.push(ArtifactRequirement {
            capability: "state".to_string(),
            min_version: 1,
        });
    }
    requires.sort_by(|a, b| a.capability.cmp(&b.capability));
    (requires, diags)
}

/// Parse the leading semver major from a catalog version.
fn parse_major(version: &str) -> Option<u64> {
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u64>().ok())
}

/// Check referenced builtins against the producer catalog: missing,
/// `planned` or `external` entries are precise `E6007` errors naming the
/// producer and availability. One diagnostic per referenced id (first
/// use-site span wins).
pub fn check_builtin_availability(
    referenced: &[ReferencedBuiltin],
    catalog: Option<&Catalog>,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for used in referenced {
        if !seen.insert(used.id.as_str()) {
            continue;
        }
        let Some(catalog) = catalog else {
            diags.push(Diagnostic::error(
                "E6007",
                format!(
                    "cannot verify capability '{}': no producer catalog was provided to codegen; refusing to link blind",
                    used.id
                ),
                used.span,
            ));
            continue;
        };
        let Some(entry) = catalog.lookup(&used.id) else {
            diags.push(Diagnostic::error(
                "E6007",
                format!(
                    "builtin '{}' is not in producer catalog {}; refusing to link an unknown capability",
                    used.id,
                    catalog.version()
                ),
                used.span,
            ));
            continue;
        };
        match entry.availability {
            Availability::Implemented => {}
            Availability::Planned => {
                diags.push(Diagnostic::error(
                    "E6007",
                    format!(
                        "builtin '{}' is planned (owner {}): no implementation to link",
                        used.id, entry.owner
                    ),
                    used.span,
                ));
            }
            Availability::External => {
                diags.push(Diagnostic::error(
                    "E6007",
                    format!(
                        "builtin '{}' is external (owner {}): implemented by another lane, unavailable here",
                        used.id, entry.owner
                    ),
                    used.span,
                ));
            }
        }
    }
    diags
}

/// Render a compile artifact as compact JSON per `artifact.ts`.
pub fn to_json(artifact: &CompileArtifact) -> String {
    let wire = ArtifactWire {
        artifact_version: ARTIFACT_VERSION,
        language_version: &artifact.language_version,
        tool_version: &artifact.tool_version,
        sources: artifact
            .sources
            .iter()
            .map(|source| SourceWire {
                path: &source.path,
                sha256: &source.sha256,
            })
            .collect(),
        modules: artifact.modules.iter().map(ModuleWire::new).collect(),
        callables: artifact
            .callables
            .iter()
            .map(|callable| CallableWire {
                id: &callable.id,
                kind: &callable.kind,
                module: &callable.module,
                export: &callable.export,
                member: &callable.member,
                input_style: callable.input_style.as_deref(),
            })
            .collect(),
        operations: &artifact.operations,
        models: &artifact.models,
        value_types: artifact.value_types.as_ref(),
        model_policies: artifact.model_policies.as_deref(),
        pages: artifact
            .pages
            .iter()
            .map(|page| PageWire {
                owner: &page.owner,
                path: &page.path,
                module: &page.module,
                export: &page.export,
            })
            .collect(),
        migrations: artifact
            .migrations
            .iter()
            .map(|migration| MigrationWire {
                id: &migration.id,
                owner: &migration.owner,
                from: &migration.from,
                body_digest: &migration.body_digest,
                directives: migration
                    .directives
                    .iter()
                    .map(|directive| DirectiveWire {
                        kind: &directive.kind,
                        from: directive.from.as_deref(),
                        to: directive.to.as_deref(),
                        model: directive.model.as_deref(),
                        field: directive.field.as_deref(),
                        handler_contract: directive.handler_contract.as_deref(),
                    })
                    .collect(),
            })
            .collect(),
        requires: artifact
            .requires
            .iter()
            .map(|require| RequirementWire {
                capability: &require.capability,
                min_version: require.min_version,
            })
            .collect(),
        tests: artifact
            .tests
            .iter()
            .map(|test| TestWire {
                scope: &test.scope,
                module: ModuleWire::new(&test.module),
                fixtures: &test.fixtures,
            })
            .collect(),
    };
    crate::json::to_compact_string(&wire).expect("artifact DTO serialization is infallible")
}

#[derive(Serialize)]
struct ArtifactWire<'a> {
    artifact_version: u32,
    language_version: &'a str,
    tool_version: &'a str,
    sources: Vec<SourceWire<'a>>,
    modules: Vec<ModuleWire<'a>>,
    callables: Vec<CallableWire<'a>>,
    operations: &'a [JsOperation],
    models: &'a [JsModel],
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "valueTypes")]
    value_types: Option<&'a crate::codegen::js::JsValueTypes>,
    #[serde(rename = "modelPolicies", skip_serializing_if = "Option::is_none")]
    model_policies: Option<&'a [crate::codegen::model_policies::ModelPolicies]>,
    pages: Vec<PageWire<'a>>,
    migrations: Vec<MigrationWire<'a>>,
    requires: Vec<RequirementWire<'a>>,
    tests: Vec<TestWire<'a>>,
}

#[derive(Serialize)]
struct SourceWire<'a> {
    path: &'a str,
    sha256: &'a str,
}

#[derive(Serialize)]
struct ModuleWire<'a> {
    path: &'a str,
    js: &'a str,
    map: &'a SourceMap,
}

impl<'a> ModuleWire<'a> {
    fn new(module: &'a ArtifactModule) -> Self {
        Self {
            path: &module.path,
            js: &module.js,
            map: &module.map,
        }
    }
}

#[derive(Serialize)]
struct CallableWire<'a> {
    id: &'a str,
    kind: &'a str,
    module: &'a str,
    export: &'a str,
    member: &'a [String],
    #[serde(rename = "inputStyle", skip_serializing_if = "Option::is_none")]
    input_style: Option<&'a str>,
}

#[derive(Serialize)]
struct PageWire<'a> {
    owner: &'a str,
    path: &'a str,
    module: &'a str,
    export: &'a str,
}

#[derive(Serialize)]
struct MigrationWire<'a> {
    id: &'a str,
    owner: &'a str,
    from: &'a str,
    body_digest: &'a str,
    directives: Vec<DirectiveWire<'a>>,
}

#[derive(Serialize)]
struct DirectiveWire<'a> {
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'a str>,
    #[serde(rename = "handlerContract", skip_serializing_if = "Option::is_none")]
    handler_contract: Option<&'a str>,
}

#[derive(Serialize)]
struct RequirementWire<'a> {
    capability: &'a str,
    min_version: u64,
}

#[derive(Serialize)]
struct TestWire<'a> {
    scope: &'a str,
    module: ModuleWire<'a>,
    fixtures: &'a [String],
}
