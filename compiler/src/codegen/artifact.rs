//! Compile-artifact assembly per `packages/contracts/src/artifact.ts` (lane-01 codegen, PR6).
//!
//! [`assemble`] links lowered modules into a [`CompileArtifact`]:
//! `artifact_version` 1, sources with SHA-256, production modules with the
//! entrypoint first, callable registry references, pages in source order,
//! `requires` capability entries (including the consumed builtin catalog
//! pin) and separate test artifacts. Production modules never import test
//! artifacts.
//!
//! Unavailable capabilities are precise `E6007` errors naming the producer
//! and availability — never silent emission. The `requires` capability ids
//! below (`canlang.builtins`, `values.<family>`, `state`) are provisional
//! pending lane-02/07 confirmation of the activation contract.

use crate::analysis::catalog::{Availability, Catalog};
use crate::codegen::bdd::BddModule;
use crate::codegen::ir::{IrMigrationDirective, IrProgram, ReferencedBuiltin};
use crate::codegen::js::{JsOperation, JsOutput, operations_json};
use crate::codegen::sourcemap::{self, SourceMap};
use crate::diagnostic::{Diagnostic, push_json_str};
use crate::source::SourceDb;
use std::collections::BTreeSet;
use std::fmt::Write as _;

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
/// unavailable capabilities and unpinned catalog requirements.
pub fn assemble(
    ir: &IrProgram,
    js: &JsOutput,
    test_modules: &[BddModule],
    test_builtins: &[ReferencedBuiltin],
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> (CompileArtifact, Vec<Diagnostic>) {
    let mut diags = Vec::new();
    let sources = db
        .iter()
        .map(|(_id, source)| ArtifactSource {
            path: source.path.clone(),
            sha256: source.sha256.clone(),
        })
        .collect();
    let mut modules = Vec::with_capacity(1 + js.packages.len());
    modules.push(ArtifactModule {
        path: js.entry.path.clone(),
        js: js.entry.js.clone(),
        map: sourcemap::build(&js.entry.path, db, &js.entry.lines),
    });
    for package in &js.packages {
        modules.push(ArtifactModule {
            path: package.path.clone(),
            js: package.js.clone(),
            map: sourcemap::build(&package.path, db, &package.lines),
        });
    }
    let callables = js
        .callables
        .iter()
        .map(|c| ArtifactCallable {
            id: c.id.clone(),
            kind: c.kind.as_str().to_string(),
            module: js.entry.path.clone(),
            export: c.export.clone(),
            member: c.member.clone(),
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
    let (requires, mut require_diags) =
        compute_requires(&ir.catalog_version, &js.stdlib_imports, db);
    diags.append(&mut require_diags);
    let mut referenced: Vec<ReferencedBuiltin> = ir.referenced_builtins.clone();
    referenced.extend(js.referenced_builtins.iter().cloned());
    referenced.extend(test_builtins.iter().cloned());
    diags.extend(check_builtin_availability(&referenced, catalog));
    let tests = test_modules
        .iter()
        .map(|t| ArtifactTestModule {
            scope: t.scope.clone(),
            module: ArtifactModule {
                path: t.module.path.clone(),
                js: t.module.js.clone(),
                map: sourcemap::build(&t.module.path, db, &t.module.lines),
            },
            fixtures: t.fixtures.clone(),
        })
        .collect();
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
    let artifact = CompileArtifact {
        language_version: crate::LANGUAGE_VERSION.to_string(),
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        sources,
        modules,
        callables,
        operations: js.operations.clone(),
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
    let mut out = String::new();
    let _ = write!(
        out,
        "{{\"artifact_version\":{ARTIFACT_VERSION},\"language_version\":"
    );
    push_json_str(&mut out, &artifact.language_version);
    out.push_str(",\"tool_version\":");
    push_json_str(&mut out, &artifact.tool_version);
    out.push_str(",\"sources\":[");
    for (i, source) in artifact.sources.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        push_json_str(&mut out, &source.path);
        out.push_str(",\"sha256\":");
        push_json_str(&mut out, &source.sha256);
        out.push('}');
    }
    out.push_str("],\"modules\":[");
    for (i, module) in artifact.modules.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_module(&mut out, module);
    }
    out.push_str("],\"callables\":[");
    for (i, callable) in artifact.callables.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        push_json_str(&mut out, &callable.id);
        out.push_str(",\"kind\":");
        push_json_str(&mut out, &callable.kind);
        out.push_str(",\"module\":");
        push_json_str(&mut out, &callable.module);
        out.push_str(",\"export\":");
        push_json_str(&mut out, &callable.export);
        out.push_str(",\"member\":[");
        for (j, segment) in callable.member.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            push_json_str(&mut out, segment);
        }
        out.push_str("]}");
    }
    out.push_str("],\"operations\":");
    out.push_str(&operations_json(&artifact.operations));
    out.push_str(",\"pages\":[");
    for (i, page) in artifact.pages.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"owner\":");
        push_json_str(&mut out, &page.owner);
        out.push_str(",\"path\":");
        push_json_str(&mut out, &page.path);
        out.push_str(",\"module\":");
        push_json_str(&mut out, &page.module);
        out.push_str(",\"export\":");
        push_json_str(&mut out, &page.export);
        out.push('}');
    }
    out.push_str("],\"migrations\":[");
    for (i, migration) in artifact.migrations.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        push_json_str(&mut out, &migration.id);
        out.push_str(",\"owner\":");
        push_json_str(&mut out, &migration.owner);
        out.push_str(",\"from\":");
        push_json_str(&mut out, &migration.from);
        out.push_str(",\"body_digest\":");
        push_json_str(&mut out, &migration.body_digest);
        out.push_str(",\"directives\":[");
        for (j, directive) in migration.directives.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("{\"kind\":");
            push_json_str(&mut out, &directive.kind);
            for (key, value) in [
                ("from", &directive.from),
                ("to", &directive.to),
                ("model", &directive.model),
                ("field", &directive.field),
                ("handlerContract", &directive.handler_contract),
            ] {
                if let Some(value) = value {
                    out.push_str(",\"");
                    out.push_str(key);
                    out.push_str("\":");
                    push_json_str(&mut out, value);
                }
            }
            out.push('}');
        }
        out.push_str("]}");
    }
    out.push_str("],\"requires\":[");
    for (i, require) in artifact.requires.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{{\"capability\":");
        push_json_str(&mut out, &require.capability);
        let _ = write!(out, ",\"min_version\":{}}}", require.min_version);
    }
    out.push_str("],\"tests\":[");
    for (i, test) in artifact.tests.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"scope\":");
        push_json_str(&mut out, &test.scope);
        out.push_str(",\"module\":");
        push_module(&mut out, &test.module);
        out.push_str(",\"fixtures\":[");
        for (j, fixture) in test.fixtures.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            push_json_str(&mut out, fixture);
        }
        out.push_str("]}");
    }
    out.push_str("]}");
    out
}

/// Render one artifact module object.
fn push_module(out: &mut String, module: &ArtifactModule) {
    out.push_str("{\"path\":");
    push_json_str(out, &module.path);
    out.push_str(",\"js\":");
    push_json_str(out, &module.js);
    out.push_str(",\"map\":");
    out.push_str(&sourcemap::to_json(&module.map));
    out.push('}');
}
