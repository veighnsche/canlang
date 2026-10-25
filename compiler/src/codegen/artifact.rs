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
use crate::codegen::ir::{
    GivenContractIr, IrItemKind, IrMigrationDirective, IrProgram, ReferencedBuiltin,
};
use crate::codegen::js::{
    Emitter, JsFieldDefault, JsModel, JsModelField, JsModelFieldType, JsOperation, JsOutput,
};
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

/// One sealed derived-bool column of a page-gate receipt: the pinned
/// expansion plus the owning derive declaration source.
#[derive(Debug, Clone)]
pub struct ArtifactDerivedBoolColumn {
    /// Selector name as authored in `filter=`.
    pub field: String,
    /// Pinned expansion id (exactly the admitted `unassigned`/`overdue`).
    pub expansion: String,
    /// Declaring source path from the checked census.
    pub path: String,
    /// Declaring source SHA-256 from the checked census.
    pub sha256: String,
    /// Owning module name.
    pub module: String,
    /// Owning derive declaration span start (byte offset).
    pub node_start: u32,
    /// Owning derive declaration span end (exclusive).
    pub node_end: u32,
}

/// Compiler-emitted receipt binding one page collection occurrence
/// to its sealed derived-bool columns (see
/// `IrDerivedBoolReceipt`).
#[derive(Debug, Clone)]
pub struct ArtifactDerivedBoolReceipt {
    /// Collection node source file (occurrence prefix `f` part).
    pub file: u32,
    /// Collection node start byte (occurrence prefix `s` part).
    pub start: u32,
    /// Owning page normalized route.
    pub page_path: String,
    /// Canonical collection model.
    pub model: String,
    /// Sealed derived-bool columns of this collection, in order.
    pub columns: Vec<ArtifactDerivedBoolColumn>,
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
    /// Declaring source path. Present only for multi-source closures, where
    /// the module source map cannot resolve one exact declaring file.
    pub source: Option<String>,
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

/// Checked consumed renderer and optional inert browser enhancement.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGeneratedView {
    pub view: String,
    pub module: String,
    pub render_export: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount_export: Option<String>,
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
    /// Checked Given contracts (trait instantiations plus keyword
    /// rules) in global source order, folded in by the production
    /// compile join once saved intake feeds this layer. `None` when
    /// the program has no Given generation units; the JSON envelope
    /// omits the key then (loaders treat absence as "no descriptors").
    pub given_contracts: Option<GivenContractsArtifact>,
    /// Packed scoped stylesheets for the style units this build
    /// consumes, in staged-path order. Empty omits the JSON key.
    pub stylesheets: Vec<ArtifactStylesheet>,
    pub generated_views: Vec<ArtifactGeneratedView>,
    /// Checked standard/custom value type contracts and enum declarations,
    /// when the source program owns any such values.
    pub value_types: Option<crate::codegen::js::JsValueTypes>,
    /// Checked complete owner-policy descriptors for the supported native profile.
    pub model_policies: Option<Vec<crate::codegen::model_policies::ModelPolicies>>,
    /// Complete checked committed-model trigger inventory.
    pub committed_changes: Option<Vec<crate::codegen::js::JsCommittedChange>>,
    pub runtime_bindings: Vec<super::runtime_bindings::RuntimeBinding>,
    /// Page descriptors in source order.
    pub pages: Vec<ArtifactPage>,
    /// Sealed derived-bool collection receipts in page-decode order.
    /// Empty (and omitted from JSON) when no collection lowers a
    /// derived-bool selector.
    pub derived_bool_receipts: Vec<ArtifactDerivedBoolReceipt>,
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
            source: c.source.clone(),
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
    if ir
        .modules
        .iter()
        .any(|module| !module.runtime_bindings.is_empty())
    {
        requires.push(ArtifactRequirement {
            capability: "cloudflare.runtime-bindings".to_string(),
            min_version: 1,
        });
        requires.sort_by(|a, b| a.capability.cmp(&b.capability));
    }
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
    // Observations the lowering bound to the State membership producer carry
    // their exact checked source and selected call closure, so they resolve
    // to that defining owner. Only genuinely unbound references refuse here
    // with the producer's exact availability code.
    referenced
        .retain(|used| used.id != "active_member" || !js.membership_bound.contains(&used.span));
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
        // Saved joins attach after assembly: `assemble` itself stays
        // saved-free so direct emission keeps its exact prior posture.
        given_contracts: None,
        stylesheets: Vec::new(),
        generated_views: Vec::new(),
        value_types: js.value_types.clone(),
        model_policies: js.model_policies.clone(),
        committed_changes: js.committed_changes.clone(),
        runtime_bindings: super::runtime_bindings::inventory(ir),
        pages,
        derived_bool_receipts: ir
            .derived_bool_receipts
            .iter()
            .map(|receipt| ArtifactDerivedBoolReceipt {
                file: receipt.file,
                start: receipt.start,
                page_path: receipt.page_path.clone(),
                model: receipt.model.clone(),
                columns: receipt
                    .columns
                    .iter()
                    .map(|column| ArtifactDerivedBoolColumn {
                        field: column.field.clone(),
                        expansion: column.expansion.clone(),
                        path: column.path.clone(),
                        sha256: column.sha256.clone(),
                        module: column.module.clone(),
                        node_start: column.node_start,
                        node_end: column.node_end,
                    })
                    .collect(),
            })
            .collect(),
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
        (
            "values.decimal",
            &[
                "parseDecimal",
                "addDecimal",
                "subtractDecimal",
                "multiplyDecimal",
                "divideDecimal",
                "negateDecimal",
                "compareDecimal",
            ],
        ),
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
        "active_member",
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
                source: callable.source.as_deref(),
            })
            .collect(),
        operations: &artifact.operations,
        models: &artifact.models,
        given_contracts: artifact.given_contracts.as_ref().map(|contracts| {
            GivenContractsMemberWire {
                traits: &contracts.traits,
                keywords: &contracts.keywords,
            }
        }),
        stylesheets: artifact
            .stylesheets
            .iter()
            .map(StylesheetWire::new)
            .collect(),
        generated_views: &artifact.generated_views,
        value_types: artifact.value_types.as_ref(),
        model_policies: artifact.model_policies.as_deref(),
        committed_changes: artifact.committed_changes.as_deref(),
        runtime_bindings: &artifact.runtime_bindings,
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
        derived_bool_receipts: artifact
            .derived_bool_receipts
            .iter()
            .map(|receipt| DerivedBoolReceiptWire {
                file: receipt.file,
                start: receipt.start,
                page_path: &receipt.page_path,
                model: &receipt.model,
                columns: receipt
                    .columns
                    .iter()
                    .map(|column| DerivedBoolColumnWire {
                        field: &column.field,
                        expansion: &column.expansion,
                        path: &column.path,
                        sha256: &column.sha256,
                        module: &column.module,
                        node_start: column.node_start,
                        node_end: column.node_end,
                    })
                    .collect(),
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
    #[serde(rename = "givenContracts", skip_serializing_if = "Option::is_none")]
    given_contracts: Option<GivenContractsMemberWire<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stylesheets: Vec<StylesheetWire<'a>>,
    #[serde(
        rename = "generatedViews",
        skip_serializing_if = "<[ArtifactGeneratedView]>::is_empty"
    )]
    generated_views: &'a [ArtifactGeneratedView],
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "valueTypes")]
    value_types: Option<&'a crate::codegen::js::JsValueTypes>,
    #[serde(rename = "modelPolicies", skip_serializing_if = "Option::is_none")]
    model_policies: Option<&'a [crate::codegen::model_policies::ModelPolicies]>,
    #[serde(rename = "committedChanges", skip_serializing_if = "Option::is_none")]
    committed_changes: Option<&'a [crate::codegen::js::JsCommittedChange]>,
    #[serde(rename = "runtimeBindings")]
    runtime_bindings: &'a [super::runtime_bindings::RuntimeBinding],
    pages: Vec<PageWire<'a>>,
    #[serde(rename = "derivedBoolReceipts", skip_serializing_if = "Vec::is_empty")]
    derived_bool_receipts: Vec<DerivedBoolReceiptWire<'a>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
}

#[derive(Serialize)]
struct PageWire<'a> {
    owner: &'a str,
    path: &'a str,
    module: &'a str,
    export: &'a str,
}

#[derive(Serialize)]
struct DerivedBoolColumnWire<'a> {
    field: &'a str,
    expansion: &'a str,
    path: &'a str,
    #[serde(rename = "sha256")]
    sha256: &'a str,
    module: &'a str,
    #[serde(rename = "nodeStart")]
    node_start: u32,
    #[serde(rename = "nodeEnd")]
    node_end: u32,
}

#[derive(Serialize)]
struct DerivedBoolReceiptWire<'a> {
    file: u32,
    start: u32,
    #[serde(rename = "pagePath")]
    page_path: &'a str,
    model: &'a str,
    columns: Vec<DerivedBoolColumnWire<'a>>,
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

/// Embedded `givenContracts` member per `artifact.ts`
/// (`ArtifactGivenContracts`): trait instantiations plus keyword rules.
/// Unlike the standalone [`given_contracts_to_json`] envelope this
/// carries no versions; the artifact envelope owns those.
#[derive(Serialize)]
struct GivenContractsMemberWire<'a> {
    traits: &'a [ArtifactGivenTrait],
    keywords: &'a [ArtifactGivenKeyword],
}

/// Shared Can owner-link wire shape: the owner-link manifest and the
/// packed `stylesheets` member render identically.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerLinkWire<'a> {
    unit_id: &'a str,
    kind: &'a str,
    can_path: &'a str,
    can_revision: &'a str,
    start: u32,
    end: u32,
}

impl<'a> OwnerLinkWire<'a> {
    fn new(owner: &'a CanOwnerLink) -> Self {
        Self {
            unit_id: &owner.unit_id,
            kind: &owner.kind,
            can_path: &owner.can_path,
            can_revision: &owner.can_revision,
            start: owner.start,
            end: owner.end,
        }
    }
}

#[derive(Serialize)]
struct StylesheetWire<'a> {
    path: &'a str,
    css: &'a str,
    sha256: &'a str,
    owner: OwnerLinkWire<'a>,
    #[serde(skip_serializing_if = "<[ArtifactStyleAsset]>::is_empty")]
    assets: &'a [ArtifactStyleAsset],
}

impl<'a> StylesheetWire<'a> {
    fn new(sheet: &'a ArtifactStylesheet) -> Self {
        Self {
            path: &sheet.path,
            css: &sheet.css,
            sha256: &sheet.sha256,
            owner: OwnerLinkWire::new(&sheet.owner),
            assets: &sheet.assets,
        }
    }
}

// --- BGI-07 Given contract emission ----------------------------------------
// Checked Given contract emission: lowered trait instantiations and
// keyword rules become typed artifact descriptors (schemas, producer
// bindings, wrapper joins, derived references, fingerprints) rendered
// as compact JSON per `packages/contracts/src/artifact.ts`
// (`ArtifactGivenTrait`/`ArtifactGivenKeyword`). The production
// compile join folds them into `CompileArtifact.givenContracts`
// (embedded member wire above) and merges trait instantiations into
// the stored model descriptors below.

/// One emitted contributed field: the typed leaf a trait adds.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenField {
    /// Field name.
    pub name: String,
    /// Checked type text.
    #[serde(rename = "type")]
    pub type_name: String,
    /// Checked default constant (source text), when the template
    /// carries one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Contributed `trim` normalization.
    pub trim: bool,
    /// Contributed `min=` bound (source text), when given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    /// Contributed `max=` bound (source text), when given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
}

/// One emitted trait instantiation: a saved template applied at one
/// target, sharing its definition's saved unit with every sibling.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenTrait {
    /// Compiler-owned instantiation identity.
    pub id: String,
    /// Owning module.
    pub owner: String,
    /// Trait name (absent for inline attachments).
    #[serde(rename = "trait", skip_serializing_if = "Option::is_none")]
    pub trait_name: Option<String>,
    /// Whether this instance owns a one-off inline attachment.
    pub inline: bool,
    /// Definition anchor (the stable association key).
    pub anchor: String,
    /// Saved unit this instance reuses.
    #[serde(rename = "unitId")]
    pub unit_id: String,
    /// Canonical target identity (`Owner.Model[.field]`).
    pub target: String,
    /// Instantiated template fields.
    pub fields: Vec<ArtifactGivenField>,
    /// SHA-256 over the contributions carrier bytes.
    pub fingerprint: String,
    /// Source order among the definition's applications.
    pub order: usize,
    /// Optional source-derived pure text-field check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<ArtifactGivenValidation>,
}

/// Fixed field-trait validation contract; generated metadata never chooses authority.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenValidation {
    pub producer: String,
    pub export: String,
    pub lifecycle: String,
    pub input: ArtifactGivenInputSchema,
    pub result: ArtifactGivenResultSchema,
    pub reads: Vec<String>,
    pub effects: Vec<String>,
    pub authority: Vec<String>,
    pub fingerprint: String,
}

/// Typed input schema of an emitted keyword rule.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenInputSchema {
    /// Input binding name.
    pub name: String,
    /// Checked input type.
    #[serde(rename = "type")]
    pub type_name: String,
}

/// Typed result schema of an emitted keyword rule.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenResultSchema {
    /// Checked result type (producer-fixed).
    #[serde(rename = "type")]
    pub type_name: String,
}

/// One emitted keyword-rule argument: references carry canonical
/// identities, constants carry their checked source text.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenKeywordArg {
    /// Argument name.
    pub name: String,
    /// Resolved value.
    pub value: String,
}

/// One emitted keyword rule: a standalone application bound to its
/// saved implementation through the checked owner-producer descriptor.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactGivenKeyword {
    /// Compiler-owned rule identity
    /// (`Owner.Model.field#keyword`).
    #[serde(rename = "ruleId")]
    pub rule_id: String,
    /// Owning module.
    pub owner: String,
    /// Keyword name (the standalone declaration form).
    pub keyword: String,
    /// Definition anchor (the stable association key).
    pub anchor: String,
    /// Saved unit this rule reuses.
    #[serde(rename = "unitId")]
    pub unit_id: String,
    /// Bound owner-versioned producer (compiler-known).
    pub producer: String,
    /// Fixed producer semantics id (compiler-owned).
    pub semantics: String,
    /// Producer lifecycle binding (compiler-owned).
    pub lifecycle: String,
    /// Saved export implementing the behavior.
    pub export: String,
    /// Typed input schema derived from the bound arguments.
    pub input: ArtifactGivenInputSchema,
    /// Typed result schema (producer-fixed).
    pub result: ArtifactGivenResultSchema,
    /// Admitted reads (empty for pure producers).
    pub reads: Vec<String>,
    /// Admitted effects (empty for pure producers).
    pub effects: Vec<String>,
    /// Admitted authority (empty: canonical owners admit bindings).
    pub authority: Vec<String>,
    /// Canonical value dependencies (the bound fields).
    pub dependencies: Vec<String>,
    /// SHA-256 over the saved implementation closure bytes.
    pub fingerprint: String,
    /// Canonical target model identity.
    #[serde(rename = "targetModel")]
    pub target_model: String,
    /// Canonical target field identity.
    #[serde(rename = "targetField")]
    pub target_field: String,
    /// Resolved arguments.
    pub args: Vec<ArtifactGivenKeywordArg>,
    /// Source order among the definition's applications.
    pub order: usize,
}

/// Emitted Given contracts for one program: trait instantiations and
/// keyword rules in global source order.
#[derive(Debug, Clone)]
pub struct GivenContractsArtifact {
    /// Compiler version.
    pub tool_version: String,
    /// Trait instantiations in global source order.
    pub traits: Vec<ArtifactGivenTrait>,
    /// Keyword rules in global source order.
    pub keywords: Vec<ArtifactGivenKeyword>,
}

/// Assemble emitted Given contracts from lowered records.
pub fn assemble_given_contracts(
    ir: &GivenContractIr,
    tool_version: &str,
) -> GivenContractsArtifact {
    GivenContractsArtifact {
        tool_version: tool_version.to_string(),
        traits: ir
            .traits
            .iter()
            .map(|instance| ArtifactGivenTrait {
                id: instance.id.clone(),
                owner: instance.owner.clone(),
                trait_name: instance.trait_name.clone(),
                inline: instance.inline,
                anchor: instance.anchor.clone(),
                unit_id: instance.unit_id.clone(),
                target: instance.target.clone(),
                fields: instance
                    .fields
                    .iter()
                    .map(|field| ArtifactGivenField {
                        name: field.name.clone(),
                        type_name: field.type_name.clone(),
                        default: field.default.clone(),
                        trim: field.trim,
                        min: field.min.clone(),
                        max: field.max.clone(),
                    })
                    .collect(),
                fingerprint: instance.fingerprint.clone(),
                validation: instance.validation_fingerprint.as_ref().map(|fingerprint| {
                    ArtifactGivenValidation {
                        producer: crate::analysis::types::GIVEN_PRODUCER_FIELD_VALIDATION
                            .to_string(),
                        export: crate::analysis::types::GIVEN_FIELD_VALIDATION_EXPORT.to_string(),
                        lifecycle: crate::analysis::types::GIVEN_FIELD_VALIDATION_LIFECYCLE
                            .to_string(),
                        input: ArtifactGivenInputSchema {
                            name: "value".to_string(),
                            type_name: "text".to_string(),
                        },
                        result: ArtifactGivenResultSchema {
                            type_name: "bool".to_string(),
                        },
                        reads: Vec::new(),
                        effects: Vec::new(),
                        authority: Vec::new(),
                        fingerprint: fingerprint.clone(),
                    }
                }),
                order: instance.order,
            })
            .collect(),
        keywords: ir
            .keywords
            .iter()
            .map(|rule| ArtifactGivenKeyword {
                rule_id: rule.rule_id.clone(),
                owner: rule.owner.clone(),
                keyword: rule.keyword.clone(),
                anchor: rule.anchor.clone(),
                unit_id: rule.unit_id.clone(),
                producer: rule.producer.clone(),
                semantics: rule.semantics.clone(),
                lifecycle: rule.lifecycle.clone(),
                export: rule.export.clone(),
                input: ArtifactGivenInputSchema {
                    name: rule.input_name.clone(),
                    type_name: rule.input_type.clone(),
                },
                result: ArtifactGivenResultSchema {
                    type_name: rule.result_type.clone(),
                },
                reads: rule.reads.clone(),
                effects: rule.effects.clone(),
                authority: rule.authority.clone(),
                dependencies: rule.dependencies.clone(),
                fingerprint: rule.fingerprint.clone(),
                target_model: rule.target_model.clone(),
                target_field: rule.target_field.clone(),
                args: rule
                    .args
                    .iter()
                    .map(|(name, value)| ArtifactGivenKeywordArg {
                        name: name.clone(),
                        value: value.clone(),
                    })
                    .collect(),
                order: rule.order,
            })
            .collect(),
    }
}

/// Render emitted Given contracts as compact JSON per `artifact.ts`.
pub fn given_contracts_to_json(artifact: &GivenContractsArtifact) -> String {
    let wire = GivenContractsWire {
        artifact_version: ARTIFACT_VERSION,
        tool_version: &artifact.tool_version,
        traits: &artifact.traits,
        keywords: &artifact.keywords,
    };
    crate::json::to_compact_string(&wire).expect("given contract serialization is infallible")
}

#[derive(Serialize)]
struct GivenContractsWire<'a> {
    artifact_version: u32,
    tool_version: &'a str,
    traits: &'a [ArtifactGivenTrait],
    keywords: &'a [ArtifactGivenKeyword],
}

/// Merge checked trait instantiations into stored model descriptors.
///
/// Model targets (`Owner.Model`) push their instantiated template
/// fields after the authored fields; field targets
/// (`Owner.Model.field`) fill absent constraint slots (default, trim,
/// bounds) on the existing field, never overriding authored values.
/// The mapping mirrors the authored-field lowering exactly (tags,
/// nullability, bounds, defaults), so a contributed field behaves
/// like the same field written by hand. Targets come from checked
/// contracts and always resolve; an unresolvable target is an
/// internal inconsistency and refuses with its detail (the caller
/// attaches the diagnostic span).
pub fn merge_given_trait_fields(
    models: &mut [JsModel],
    traits: &[ArtifactGivenTrait],
) -> Result<(), String> {
    for instance in traits {
        let mut parts = instance.target.split('.');
        let (model_name, field_name) = match (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) {
            (Some(owner), Some(model), None, None) => (format!("{owner}.{model}"), None),
            (Some(owner), Some(model), Some(field), None) => {
                (format!("{owner}.{model}"), Some(field))
            }
            _ => {
                return Err(format!(
                    "trait instance `{}` targets `{}`: expected `Owner.Model` or `Owner.Model.field`",
                    instance.id, instance.target,
                ));
            }
        };
        let Some(model) = models.iter_mut().find(|m| m.name == model_name) else {
            return Err(format!(
                "trait instance `{}` targets unknown model `{model_name}`",
                instance.id,
            ));
        };
        if let Some(field_name) = field_name {
            let Some(field) = model.fields.iter_mut().find(|f| f.name == field_name) else {
                return Err(format!(
                    "trait instance `{}` targets unknown field `{}`",
                    instance.id, instance.target,
                ));
            };
            for contributed in &instance.fields {
                merge_given_field_constraint(&instance.id, field, contributed)?;
            }
            continue;
        }
        for contributed in &instance.fields {
            // The Given check refused duplicate/authored collisions, so
            // any collision here is an internal inconsistency.
            if model.fields.iter().any(|f| f.name == contributed.name) {
                return Err(format!(
                    "trait instance `{}` contributes field `{}` to `{model_name}` which already declares it",
                    instance.id, contributed.name,
                ));
            }
            model.fields.push(given_model_field(contributed)?);
        }
    }
    Ok(())
}

/// Fill absent constraint slots of an authored field from a
/// field-target contribution. The Given check already refused
/// contradictions, so filling only absent slots cannot conflict.
fn merge_given_field_constraint(
    instance: &str,
    field: &mut JsModelField,
    contributed: &ArtifactGivenField,
) -> Result<(), String> {
    if field.name != contributed.name {
        return Err(format!(
            "trait instance `{instance}` contributes `{}` to field `{}`",
            contributed.name, field.name,
        ));
    }
    if field.default.is_none() {
        field.default = given_field_default(contributed)?;
    }
    if field.trim.is_none() && contributed.trim {
        field.trim = Some(true);
    }
    if field.min.is_none() {
        field.min = given_bound(&contributed.type_name, contributed.min.as_deref());
    }
    if field.max.is_none() {
        field.max = given_bound(&contributed.type_name, contributed.max.as_deref());
    }
    Ok(())
}

/// Map one contributed template field to a stored model field,
/// mirroring the authored lowering (`model_field`): scalar tags,
/// wrappers, bounds and defaults behave exactly like hand-written
/// fields. Contributed model fields always carry checked defaults, so
/// they never require the caller.
fn given_model_field(contributed: &ArtifactGivenField) -> Result<JsModelField, String> {
    let (tag, value_type, nullable, is_array) = given_field_tag(&contributed.type_name);
    Ok(JsModelField {
        name: contributed.name.clone(),
        field: tag,
        value_type,
        required: false,
        nullable,
        trim: contributed.trim.then_some(true),
        min: given_bound(&contributed.type_name, contributed.min.as_deref()),
        max: given_bound(&contributed.type_name, contributed.max.as_deref()),
        server_only: false,
        array_required: is_array.then_some(false),
        default: given_field_default(contributed)?,
        machine: None,
        description: None,
    })
}

/// Carrier constants are source spellings; artifact defaults are Values wire
/// data. In particular numeric leaves never pass through a JSON number.
fn given_field_default(field: &ArtifactGivenField) -> Result<Option<JsFieldDefault>, String> {
    field
        .default
        .as_deref()
        .map(|source| {
            given_wire_constant(&field.type_name, source)
                .map(|value| JsFieldDefault::Literal(value.to_string()))
        })
        .transpose()
}

fn given_wire_constant(type_name: &str, source: &str) -> Result<serde_json::Value, String> {
    let source = source.trim();
    let ty = type_name.strip_suffix('?').unwrap_or(type_name);
    if source == "null" && ty != type_name {
        return Ok(serde_json::Value::Null);
    }
    if let Some(element) = ty.strip_suffix("[]") {
        let body = source
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .ok_or_else(|| format!("invalid contributed array default `{source}`"))?;
        return crate::analysis::types::split_given_consts(body)
            .iter()
            .map(|part| given_wire_constant(element, part))
            .collect::<Result<Vec<_>, _>>()
            .map(serde_json::Value::Array);
    }
    if matches!(ty, "int" | "integer") {
        return source
            .parse::<i64>()
            .map(|value| serde_json::Value::String(value.to_string()))
            .map_err(|_| format!("invalid contributed integer default `{source}`"));
    }
    if ty == "duration" {
        return super::ir::duration_millis(source)
            .map(|value| serde_json::Value::String(value.to_string()))
            .ok_or_else(|| format!("invalid contributed duration default `{source}`"));
    }
    if ty == "datetime" {
        let value = serde_json::from_str::<String>(source)
            .map_err(|_| format!("invalid contributed datetime default `{source}`"))?;
        return crate::analysis::types::canonical_datetime_literal(&value)
            .map(serde_json::Value::String);
    }
    if ty == "decimal" || ty.starts_with("enum(") {
        let value = serde_json::from_str::<String>(source).unwrap_or_else(|_| source.to_string());
        return Ok(serde_json::Value::String(value));
    }
    serde_json::from_str(source)
        .map_err(|_| format!("invalid contributed {type_name} default `{source}`"))
}

/// Split a checked contributed type into its tag, value type,
/// nullability and array marker. Mirrors `model_field_parts`/
/// `model_field_tag`/`model_value_type` over the carrier spellings the
/// Given check admits (one outer `?`, one `[]`, native scalar/enum leaves).
fn scalar_field_tag(rest: &str) -> Option<JsModelFieldType> {
    match rest {
        "text" | "email" | "url" | "locale" | "timezone" | "currency" => {
            Some(JsModelFieldType::String)
        }
        "int" | "integer" => Some(JsModelFieldType::Integer),
        "decimal" => Some(JsModelFieldType::Decimal),
        "money" => Some(JsModelFieldType::Money),
        "datetime" => Some(JsModelFieldType::Datetime),
        "bool" | "boolean" => Some(JsModelFieldType::Boolean),
        "file" => Some(JsModelFieldType::File),
        "date" => Some(JsModelFieldType::Date),
        "duration" => Some(JsModelFieldType::Duration),
        "secret" => Some(JsModelFieldType::Secret),
        "user" => Some(JsModelFieldType::User),
        "member" => Some(JsModelFieldType::Member),
        "json" => Some(JsModelFieldType::Json),
        "bytes" => Some(JsModelFieldType::Bytes),
        _ => None,
    }
}

fn scalar_value_type(
    rest: &str,
    type_name: &str,
    is_array: bool,
    nullable: bool,
) -> Option<String> {
    // Value-type selectivity mirrors `model_value_type`: only the
    // ambiguous leaves carry their written identity (`boolean`
    // normalizes to the canonical `bool` spelling authored fields use).
    match rest {
        "bool" | "boolean" => Some(format!(
            "bool{arr}{null}",
            arr = if is_array { "[]" } else { "" },
            null = if nullable { "?" } else { "" }
        )),
        "text" | "date" | "file" | "email" | "url" | "timezone" => Some(type_name.to_string()),
        _ => None,
    }
}

fn given_field_tag(type_name: &str) -> (JsModelFieldType, Option<String>, bool, bool) {
    let mut rest = type_name;
    let mut nullable = false;
    if let Some(inner) = rest.strip_suffix('?') {
        rest = inner;
        nullable = true;
    }
    let mut array_levels = 0usize;
    while let Some(elem) = rest.strip_suffix("[]") {
        rest = elem;
        array_levels += 1;
    }
    let is_array = array_levels > 0;
    // Nested arrays have no element tag (mirrors the authored lowering).
    if array_levels > 1 {
        return (
            JsModelFieldType::Other {
                type_id: "array".to_string(),
            },
            None,
            nullable,
            true,
        );
    }
    if let Some(cases) = rest
        .strip_prefix("enum(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let values: Vec<String> = cases
            .split(',')
            .map(|case| case.trim().to_string())
            .collect();
        return (JsModelFieldType::Enum { values }, None, nullable, is_array);
    }
    let Some(tag) = scalar_field_tag(rest) else {
        return (
            JsModelFieldType::Other {
                type_id: type_name.to_string(),
            },
            None,
            nullable,
            is_array,
        );
    };
    let value_type = scalar_value_type(rest, type_name, is_array, nullable);
    (tag, value_type, nullable, is_array)
}

/// Map one contributed bound to its wire value, mirroring the
/// authored bound lowering: length bounds (arrays and string-like
/// leaves) take integer values; numeric value bounds retain exact wire strings.
fn given_bound(type_name: &str, bound: Option<&str>) -> Option<serde_json::Value> {
    let bound = bound?;
    let mut rest = type_name;
    if let Some(inner) = rest.strip_suffix('?') {
        rest = inner;
    }
    let mut is_array = false;
    while let Some(elem) = rest.strip_suffix("[]") {
        rest = elem;
        is_array = true;
    }
    let string_like = matches!(
        rest,
        "text" | "email" | "url" | "locale" | "timezone" | "currency"
    );
    if is_array || string_like {
        let value: i64 = bound.trim().parse().ok()?;
        if !(0..=9_007_199_254_740_991).contains(&value) {
            return None;
        }
        return Some(serde_json::Value::from(u64::try_from(value).ok()?));
    }
    given_wire_constant(rest, bound).ok()
}

/// BGI-11 Can owner link: the separate unit/span link identifying the
/// owning `.can` intent beside a saved-JS map. Maps locate executable
/// current saved JavaScript; this link attributes it to its source
/// definition without inventing executable statements inside the
/// natural-language prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanOwnerLink {
    /// Opaque saved unit id.
    pub unit_id: String,
    /// Unit kind wire string (`keyword`, `view`, ...).
    pub kind: String,
    /// Owning `.can` path as recorded at bind time.
    pub can_path: String,
    /// SHA-256 of the owning source bytes the link was bound to.
    pub can_revision: String,
    /// Bind-time definition span start (evidence, not identity).
    pub start: u32,
    /// Bind-time definition span end (evidence, not identity).
    pub end: u32,
}

/// One packed saved unit module: fingerprint-verified bytes, an
/// identity map over those bytes, and the Can owner link.
#[derive(Debug, Clone)]
pub struct SavedUnitModule {
    /// Staged artifact path (`can.generated/<id>/server.js` for Given
    /// keywords and field checks, `can.generated/<id>/view.js` for
    /// views).
    pub path: String,
    /// Verified saved JavaScript bytes.
    pub js: String,
    /// Identity map locating the saved bytes.
    pub map: crate::codegen::sourcemap::SavedJsMap,
    /// Owning `.can` intent link.
    pub owner: CanOwnerLink,
}

/// Staged artifact path for one saved JS unit. Checked keywords, optional
/// field-trait checks and views pack modules; styles use the CSS pipeline.
pub fn saved_unit_module_path(
    kind: crate::analysis::generation_intake::UnitKind,
    unit_id: &str,
) -> Result<String, String> {
    use crate::analysis::generation_intake::UnitKind;
    match kind {
        UnitKind::Keyword | UnitKind::NamedTrait | UnitKind::InlineTrait => {
            Ok(format!("can.generated/{unit_id}/server.js"))
        }
        UnitKind::View => Ok(format!("can.generated/{unit_id}/view.js")),
        _ => Err(format!(
            "unit `{unit_id}` ({}): only keyword, field-trait check and view units pack saved JavaScript modules",
            kind.as_str(),
        )),
    }
}

/// Pack one validated saved unit into a staged module: the bytes must
/// be non-empty UTF-8 and match `expected_sha256` exactly, or packing
/// refuses (unknown unit / changed code stays loud, never silent).
/// The owner link must name this unit and kind.
pub fn pack_saved_unit(
    kind: crate::analysis::generation_intake::UnitKind,
    owner: CanOwnerLink,
    js_bytes: &[u8],
    expected_sha256: &str,
) -> Result<SavedUnitModule, String> {
    if owner.unit_id.is_empty() || owner.kind != kind.as_str() {
        return Err(format!(
            "owner link names unit `{}` kind `{}` but packs a {} unit",
            owner.unit_id,
            owner.kind,
            kind.as_str(),
        ));
    }
    if js_bytes.is_empty() {
        return Err(format!(
            "unit `{}` packs empty implementation bytes; refusing an empty module",
            owner.unit_id,
        ));
    }
    let actual = crate::source::sha256_hex(js_bytes);
    if actual != expected_sha256 {
        return Err(format!(
            "unit `{}` saved implementation changed (fingerprint mismatch): re-validate before packing; refusing to pack changed code silently",
            owner.unit_id,
        ));
    }
    let js = String::from_utf8(js_bytes.to_vec())
        .map_err(|_| format!("unit `{}` implementation is not valid UTF-8", owner.unit_id))?;
    let path = saved_unit_module_path(kind, &owner.unit_id)?;
    let map = crate::codegen::sourcemap::build_saved_js_map(&path, &js);
    Ok(SavedUnitModule {
        path,
        js,
        map,
        owner,
    })
}

/// Pack one validated saved unit plus its consumed unit-local import
/// closure into staged modules: the root stages at the unit's staged
/// path (`server.js`/`view.js`), each closure member beside it as
/// `can.generated/<id>/<rel>`, so saved relative imports resolve to
/// staged siblings. `expected_sha256` is the closure fingerprint from
/// the checked contract: pack verifies the exact consumed bytes before
/// staging, and refuses changed code, non-UTF-8 members, traversal or
/// colliding rel paths, and owner-link mismatches. Units without
/// imports pack through [`pack_saved_unit`], which verifies the same
/// fingerprint over the root alone.
pub fn pack_saved_unit_closure(
    kind: crate::analysis::generation_intake::UnitKind,
    owner: CanOwnerLink,
    root_js: &[u8],
    imports: &[crate::analysis::types::GivenSavedImport],
    expected_sha256: &str,
) -> Result<Vec<SavedUnitModule>, String> {
    if owner.unit_id.is_empty() || owner.kind != kind.as_str() {
        return Err(format!(
            "owner link names unit `{}` kind `{}` but packs a {} unit",
            owner.unit_id,
            owner.kind,
            kind.as_str(),
        ));
    }
    if root_js.is_empty() {
        return Err(format!(
            "unit `{}` packs empty implementation bytes; refusing an empty module",
            owner.unit_id,
        ));
    }
    let root = String::from_utf8(root_js.to_vec())
        .map_err(|_| format!("unit `{}` implementation is not valid UTF-8", owner.unit_id))?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut staged: Vec<(String, &[u8])> = Vec::with_capacity(imports.len());
    for import in imports {
        let rel = import.rel_path.replace('\\', "/");
        let clean = rel
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if import.rel_path.is_empty()
            || clean.is_empty()
            || clean.iter().any(|part| *part == "." || *part == "..")
        {
            return Err(format!(
                "unit `{}` closure member `{}` is not a unit-local relative path; refusing to stage it",
                owner.unit_id, import.rel_path,
            ));
        }
        let rel = clean.join("/");
        if !seen.insert(rel.clone()) {
            return Err(format!(
                "unit `{}` closure stages `{rel}` twice; refusing the ambiguous closure",
                owner.unit_id,
            ));
        }
        staged.push((rel, import.bytes.as_slice()));
    }
    let root_name = saved_unit_module_path(kind, &owner.unit_id)
        .map(|path| path.rsplit('/').next().unwrap_or_default().to_string())?;
    for (rel, _) in &staged {
        if rel == &root_name {
            return Err(format!(
                "unit `{}` closure member `{rel}` collides with the staged root module; refusing to pack it",
                owner.unit_id,
            ));
        }
    }
    // The fingerprint covers exactly the staged rel paths and bytes.
    let closure_refs: Vec<(&str, &[u8])> = staged
        .iter()
        .map(|(rel, bytes)| (rel.as_str(), *bytes))
        .collect();
    let actual = crate::analysis::types::given_closure_fingerprint(root_js, &closure_refs);
    if actual != expected_sha256 {
        return Err(format!(
            "unit `{}` saved implementation changed (fingerprint mismatch): re-validate before packing; refusing to pack changed code silently",
            owner.unit_id,
        ));
    }
    let mut packed = Vec::with_capacity(1 + imports.len());
    let root_path = saved_unit_module_path(kind, &owner.unit_id)?;
    packed.push(SavedUnitModule {
        map: crate::codegen::sourcemap::build_saved_js_map(&root_path, &root),
        path: root_path,
        js: root,
        owner: owner.clone(),
    });
    for (rel, bytes) in &staged {
        let js = String::from_utf8(bytes.to_vec()).map_err(|_| {
            format!(
                "unit `{}` closure member `{rel}` is not valid UTF-8; refusing to pack it",
                owner.unit_id,
            )
        })?;
        let path = format!("can.generated/{}/{rel}", owner.unit_id);
        packed.push(SavedUnitModule {
            map: crate::codegen::sourcemap::build_saved_js_map(&path, &js),
            path,
            js,
            owner: owner.clone(),
        });
    }
    Ok(packed)
}

/// Stage packed saved units into an artifact: appended after existing
/// modules (the entrypoint stays first) in staged-path order, so the
/// same packed set always stages identically. Duplicate or aliased
/// staged paths refuse; staging never overwrites an existing module.
pub fn stage_saved_unit_modules(
    artifact: &mut CompileArtifact,
    packed: &[SavedUnitModule],
) -> Result<(), String> {
    let mut ordered: Vec<&SavedUnitModule> = packed.iter().collect();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    let mut known: BTreeSet<String> = artifact.modules.iter().map(|m| m.path.clone()).collect();
    for unit in ordered {
        if !known.insert(unit.path.clone()) {
            return Err(format!(
                "staged path `{}` is already an artifact module; refusing to overwrite it",
                unit.path
            ));
        }
        artifact.modules.push(ArtifactModule {
            path: unit.path.clone(),
            js: unit.js.clone(),
            map: unit.map.map.clone(),
        });
    }
    Ok(())
}

/// Render packed saved units as the owner-link manifest the deploy
/// host carries beside the artifact: staged path, verified bytes hash,
/// and the Can owner link per unit, in staged-path order. Compact
/// JSON per the shared string-escape policy, no trailing newline.
pub fn saved_unit_manifest_to_json(packed: &[SavedUnitModule]) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct EntryWire<'a> {
        path: &'a str,
        sha256: &'a str,
        owner: OwnerLinkWire<'a>,
    }
    let mut ordered: Vec<&SavedUnitModule> = packed.iter().collect();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    let entries: Vec<EntryWire<'_>> = ordered
        .iter()
        .map(|unit| EntryWire {
            path: &unit.path,
            sha256: &unit.map.js_sha256,
            owner: OwnerLinkWire::new(&unit.owner),
        })
        .collect();
    crate::json::to_compact_string(&entries).expect("owner manifest serialization is infallible")
}

/// One packed scoped stylesheet: the BGI-10 scoped output of a style
/// unit the build consumes, plus its Can owner link.
#[derive(Debug, Clone)]
pub struct ArtifactStylesheet {
    /// Staged artifact path (`can.generated/<id>/style.css`).
    pub path: String,
    /// Scoped CSS bytes (the `scope_stylesheet` output guards).
    pub css: String,
    /// SHA-256 over the scoped CSS bytes.
    pub sha256: String,
    /// Owning `.can` intent link.
    pub owner: CanOwnerLink,
    pub assets: Vec<ArtifactStyleAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactStyleAsset {
    pub path: String,
    pub content_base64: String,
    pub sha256: String,
    pub content_type: String,
}

/// Finite MIME admission shared by style validation and packing.
fn detect_asset_bytes(bytes: &[u8]) -> Option<&'static str> {
    let ascii = |start: usize, end: usize| bytes.get(start..end).unwrap_or(&[]);
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if ascii(0, 6) == b"GIF87a" || ascii(0, 6) == b"GIF89a" {
        Some("image/gif")
    } else if ascii(0, 4) == b"RIFF" && ascii(8, 12) == b"WEBP" {
        Some("image/webp")
    } else if ascii(4, 8) == b"ftyp" && (ascii(8, 12) == b"avif" || ascii(8, 12) == b"avis") {
        Some("image/avif")
    } else if ascii(0, 4) == b"wOFF" {
        Some("font/woff")
    } else if ascii(0, 4) == b"wOF2" {
        Some("font/woff2")
    } else if bytes.starts_with(&[0, 1, 0, 0]) {
        Some("font/ttf")
    } else if ascii(0, 4) == b"OTTO" {
        Some("font/otf")
    } else {
        detect_svg_bytes(bytes)
    }
}

fn detect_svg_bytes(bytes: &[u8]) -> Option<&'static str> {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let mut prefix = prefix.trim_start_matches('\u{feff}').trim_start();
    if prefix.starts_with("<?xml")
        && let Some(end) = prefix.find("?>")
    {
        prefix = prefix[end + 2..].trim_start();
    }
    let root = prefix
        .get(..4)
        .is_some_and(|head| head.eq_ignore_ascii_case("<svg"))
        && prefix[4..]
            .chars()
            .next()
            .is_some_and(|ch| ch.is_whitespace() || ch == '>');
    root.then_some("image/svg+xml")
}

fn expected_asset_mime(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "",
    }
}

pub fn style_asset_content_type(path: &str, bytes: &[u8]) -> Result<&'static str, String> {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if extension == "css" {
        return Ok("text/css");
    }
    if extension == "js" || extension == "mjs" {
        return Ok("application/javascript");
    }
    let detected = detect_asset_bytes(bytes);
    let expected = expected_asset_mime(extension.as_str());
    detected.filter(|mime| extension == "bin" || *mime == expected).ok_or_else(|| format!("unsupported or mismatched owned asset type for `{path}`; submit a supported image/font with matching bytes"))
}

/// Staged artifact path for one style unit's scoped CSS. Style-family
/// units and view units (which may colocate their root `style.css`)
/// pack stylesheets; trait and keyword units never do.
pub fn saved_unit_style_path(
    kind: crate::analysis::generation_intake::UnitKind,
    unit_id: &str,
) -> Result<String, String> {
    use crate::analysis::generation_intake::UnitKind;
    match kind {
        UnitKind::Style | UnitKind::StyleInline | UnitKind::ViewStyleInline | UnitKind::View => {
            Ok(format!("can.generated/{unit_id}/style.css"))
        }
        _ => Err(format!(
            "unit `{unit_id}` ({}): only style and view units pack stylesheets",
            kind.as_str(),
        )),
    }
}

/// Pack one consumed style unit's saved CSS: the bytes must scope
/// through the same BGI-10 ownership guards validation uses, or
/// packing refuses with the scope failure. The owner link must name
/// this unit and kind. Returns the staged stylesheet entry.
pub fn pack_saved_stylesheet(
    kind: crate::analysis::generation_intake::UnitKind,
    owner: CanOwnerLink,
    css: &str,
) -> Result<ArtifactStylesheet, String> {
    pack_saved_stylesheet_with_assets(kind, owner, css, &[])
}

pub fn pack_saved_stylesheet_with_assets(
    kind: crate::analysis::generation_intake::UnitKind,
    owner: CanOwnerLink,
    css: &str,
    files: &[crate::analysis::generation_intake::SavedFile],
) -> Result<ArtifactStylesheet, String> {
    if owner.unit_id.is_empty() || owner.kind != kind.as_str() {
        return Err(format!(
            "owner link names unit `{}` kind `{}` but packs a {} stylesheet",
            owner.unit_id,
            owner.kind,
            kind.as_str(),
        ));
    }
    let scoped =
        crate::css_scope::scope_deployed_stylesheet(&owner.unit_id, css).map_err(|errors| {
            let first = &errors[0];
            let mut message = format!(
                "unit `{}` `style.css` failed scope checks: {} {} (line {}, column {})",
                owner.unit_id, first.code, first.message, first.line, first.column,
            );
            if errors.len() > 1 {
                message.push_str(&format!(" (+{} more)", errors.len() - 1));
            }
            message
        })?;
    use base64::Engine;
    let mut assets = Vec::new();
    for path in &scoped.assets {
        let file = files
            .iter()
            .find(|file| &file.rel_path == path)
            .ok_or_else(|| {
                format!(
                    "unit `{}` references missing owned asset `{path}`",
                    owner.unit_id
                )
            })?;
        let content_type = style_asset_content_type(path, &file.bytes)?;
        assets.push(ArtifactStyleAsset {
            path: format!("can.generated/{}/{path}", owner.unit_id),
            content_base64: base64::engine::general_purpose::STANDARD.encode(&file.bytes),
            sha256: crate::source::sha256_hex(&file.bytes),
            content_type: content_type.to_string(),
        });
    }
    let path = saved_unit_style_path(kind, &owner.unit_id)?;
    let sha256 = crate::source::sha256_hex(scoped.css.as_bytes());
    Ok(ArtifactStylesheet {
        path,
        css: scoped.css,
        sha256,
        owner,
        assets,
    })
}
