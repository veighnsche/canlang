//! Private compile command implementation.
use super::*;

/// Refuse files outside the byte-offset range before allocating their contents.
pub(super) fn read_source_file(path: impl AsRef<Path>) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    admit_source_len(file.metadata()?.len())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    read_source_text(file)
}

/// A growing file or stream may reveal one byte beyond the representable range.
pub(super) fn read_source_text(reader: impl Read) -> std::io::Result<String> {
    let mut text = String::new();
    reader
        .take(u64::from(u32::MAX) + 1)
        .read_to_string(&mut text)?;
    admit_source_len(text.len() as u64)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(text)
}

pub(super) fn add_source(
    db: &mut SourceDb,
    path: String,
    text: String,
) -> Result<SourceId, DispatchResult> {
    let display = path.clone();
    db.try_add(path, text).map_err(|error| {
        DispatchResult::tool_error("E7002", format!("cannot admit '{display}': {error}"))
    })
}

pub(super) fn run_check_like(
    cmd: &str,
    operands: &[String],
    format: OutputFormat,
    analyzer: &dyn Analyzer,
    generation_root: Option<&str>,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {cmd} expects at least one FILE.can operand"),
        );
    }
    let saved_roots = generation_root
        .map(|root| vec![PathBuf::from(root)])
        .unwrap_or_else(|| compile_saved_roots(operands));
    let mut db = match frozen_source_db(operands, &saved_roots) {
        Ok(db) => db,
        Err(error) => return error,
    };
    let mut owned = analyzer.analyze_owned(&db, tool_version());
    if let Some(program) = &mut owned.program {
        prepare_saved_given(
            &mut db,
            program,
            owned.catalog.as_ref(),
            &saved_roots,
            &mut owned.result,
        );
    }
    let mut result = owned.result;
    result.finish();
    let code = if result.has_errors() {
        exit::DIAGNOSTICS
    } else {
        exit::OK
    };
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", result.to_json()),
        OutputFormat::Text => result.to_text(&db),
    };
    DispatchResult {
        code,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
}

/// `can compile`: full analysis, then codegen emission over the checked
/// program. Operand and input failures follow [`run_check_like`]
/// (`E7001`/`E7002`, exit 2). Analysis errors exit 10 with diagnostics
/// and no emission; emission diagnostics (`E6006`/`E6007`/`E6008`, all
/// error severity) also exit 10 with diagnostics and no artifact.
/// Success prints the artifact: one emitted module path per line as
/// text, the artifact envelope as json.
pub(super) fn run_compile(
    operands: &[String],
    format: OutputFormat,
    analyzer: &dyn Analyzer,
    native_scenario_receipts: bool,
    generation_root: Option<&str>,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can compile expects at least one FILE.can operand".to_string(),
        );
    }
    let saved_roots = generation_root
        .map(|root| vec![PathBuf::from(root)])
        .unwrap_or_else(|| compile_saved_roots(operands));
    let mut db = match frozen_source_db(operands, &saved_roots) {
        Ok(db) => db,
        Err(error) => return error,
    };
    let owned = analyzer.analyze_owned(&db, tool_version());
    let mut result = owned.result;
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let Some(mut program) = owned.program else {
        return DispatchResult::tool_error(
            "E7001",
            "can compile needs a pipeline analyzer; this backend keeps no checked program (production dispatch always passes one)".to_string(),
        );
    };
    // Saved production joins: consumed generation units resolve to
    // their current saved groups before emission, so missing or
    // incompatible inputs diagnose (exit 10, no artifact) instead of
    // compiling silently without them. Repeat saved builds stay
    // zero-AI: this path never invokes generation, it only reads
    // current saved bytes.
    let given_join = prepare_saved_given(
        &mut db,
        &mut program,
        owned.catalog.as_ref(),
        &saved_roots,
        &mut result,
    );
    // The Then join resolves here for coverage and packing; emission
    // re-resolves the same inputs deterministically for renderer
    // calls. Coverage failures block before emission.
    let then_join = crate::codegen::js::ThenBuildJoin::resolve(&db);
    for (span, detail) in then_join.missing() {
        result.push(crate::diagnostic::Diagnostic::error(
            "E6008",
            detail.clone(),
            *span,
        ));
    }
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let sources = crate::codegen::EmitSources {
        db: &db,
        result: &result,
        catalog: owned.catalog.as_ref(),
        options: crate::codegen::EmitOptions {
            native_scenario_receipts,
            ..crate::codegen::EmitOptions::new()
        },
    };
    let (artifact, emit_diags) = crate::codegen::emit(&program, &sources);
    for diagnostic in emit_diags {
        result.push(diagnostic);
    }
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let mut artifact = artifact;
    // Saved modules stage once, in staged-path order, after both
    // joins contribute their packed units.
    let mut staged: Vec<crate::codegen::artifact::SavedUnitModule> = Vec::new();
    if let Some(join) = given_join
        && let Err(diagnostic) = attach_saved_given(&mut artifact, &join, &db, &mut staged)
    {
        result.push(diagnostic);
        result.finish();
        return emit_diagnostics(&result, &db, format);
    }
    if let Err(diagnostic) = attach_saved_then(&mut artifact, &then_join, &db, &mut staged) {
        result.push(diagnostic);
        result.finish();
        return emit_diagnostics(&result, &db, format);
    }
    if let Err(detail) = crate::codegen::artifact::stage_saved_unit_modules(&mut artifact, &staged)
    {
        let primary = db
            .iter()
            .next()
            .map(|(id, _)| Span::new(id, 0, 0))
            .unwrap_or(Span::new(SourceId(0), 0, 0));
        result.push(crate::diagnostic::Diagnostic::error(
            "E6008",
            format!("cannot lower saved implementations: {detail}"),
            primary,
        ));
        result.finish();
        return emit_diagnostics(&result, &db, format);
    }
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", crate::codegen::artifact::to_json(&artifact)),
        OutputFormat::Text => {
            let mut out = String::new();
            for module in &artifact.modules {
                out.push_str(&module.path);
                out.push('\n');
            }
            for test in &artifact.tests {
                out.push_str(&test.module.path);
                out.push('\n');
            }
            out
        }
    };
    DispatchResult {
        code: exit::OK,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
}

/// Load source and saved implementation from one lease-protected snapshot.
fn frozen_source_db(operands: &[String], roots: &[PathBuf]) -> Result<SourceDb, DispatchResult> {
    // Validate every operand before the snapshot collector reads the owning
    // source closure. An oversized sparse file must never be materialized.
    for path in operands {
        let length = std::fs::File::open(path)
            .and_then(|file| file.metadata())
            .map(|metadata| metadata.len())
            .and_then(|bytes| {
                admit_source_len(bytes)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
            });
        if let Err(error) = length {
            return Err(DispatchResult::tool_error(
                "E7002",
                format!("cannot read '{path}': {error}"),
            ));
        }
    }
    let frozen = std::sync::Arc::new(
        crate::analysis::generation_store::FrozenGeneration::capture(roots).map_err(|error| {
            DispatchResult::tool_error("E7002", format!("cannot capture generated inputs: {error}"))
        })?,
    );
    let mut db = SourceDb::new();
    for path in operands {
        let text = frozen.source(Path::new(path)).ok_or_else(|| {
            DispatchResult::tool_error(
                "E7002",
                format!(
                    "source '{path}' is outside the selected generation root or was not captured"
                ),
            )
        })?;
        add_source(&mut db, path.clone(), text.to_string())?;
    }
    db.generation = Some(frozen);
    Ok(db)
}

/// Saved-unit roots for one compilation: the distinct parent
/// directories of the operand files, each contributing its
/// `can.generated/` records. Operands without a parent directory
/// resolve against the current directory.
fn compile_saved_roots(operands: &[String]) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for operand in operands {
        let root = Path::new(operand)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let root = if root.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            root
        };
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    let canonical = roots
        .iter()
        .map(|root| root.canonicalize().unwrap_or_else(|_| root.clone()))
        .collect::<Vec<_>>();
    roots
        .into_iter()
        .enumerate()
        .filter(|(index, _)| {
            !canonical.iter().enumerate().any(|(other, parent)| {
                other != *index
                    && canonical[*index] != *parent
                    && canonical[*index].starts_with(parent)
            })
        })
        .map(|(_, root)| root)
        .collect()
}

/// Checked saved Given inputs for one compilation: the BGI-07
/// contract tables plus the consumed groups/units that feed artifact
/// packing. Built before emission; missing or incompatible inputs
/// diagnose instead of compiling silently without them.
struct GivenJoin {
    tables: crate::analysis::types::GivenContractTables,
    groups: std::collections::HashMap<String, crate::analysis::generation_intake::SavedGroup>,
    units: std::collections::HashMap<
        crate::analysis::generation_intake::AssociationKey,
        crate::analysis::types::GivenSavedUnit,
    >,
}

/// Reuse checked saved declarations for semantic checking and emission.
/// This reads owning saved inputs only; it neither generates nor emits JS.
fn prepare_saved_given(
    db: &mut SourceDb,
    program: &mut crate::analysis::CheckedProgram,
    catalog: Option<&crate::analysis::catalog::Catalog>,
    roots: &[PathBuf],
    result: &mut DiagnosticResult,
) -> Option<GivenJoin> {
    let mut given_result = DiagnosticResult::new(
        tool_version(),
        crate::LANGUAGE_VERSION,
        crate::SCHEMA_VERSION,
    );
    let join = join_saved_given(db, program, roots, &mut given_result);
    if let Some(join) = &join
        && catalog.is_some()
        && !given_result.has_errors()
    {
        let files = program.checked_files().to_vec();
        let (joined, diagnostics) =
            crate::analysis::check_program_with_given(db, &files, catalog, Some(&join.tables));
        *program = joined;
        result.diagnostics = diagnostics;
        result.sources.clear();
        result.add_sources(db);
    }
    result.diagnostics.extend(given_result.diagnostics);
    join
}

/// Join consumed Given definitions to their current saved groups and
/// check the BGI-07 contracts. Consumed means applied: a named trait
/// or keyword with no application, and any definition without a
/// matching saved record, stays pending generation — only applied
/// definitions without a bound unit diagnose. Diagnostics (missing
/// units, unreadable groups, contract failures) merge into `result`
/// as errors; the caller blocks emission on them. Carriers join the
/// database after the program check, exactly as validation does, so
/// checked-program ids stay stable.
fn join_saved_given(
    db: &mut SourceDb,
    program: &crate::analysis::CheckedProgram,
    _roots: &[std::path::PathBuf],
    result: &mut DiagnosticResult,
) -> Option<GivenJoin> {
    use crate::analysis::generation::{GenerationKind, discover_program};
    use crate::analysis::generation_intake as intake;
    let found = discover_program(db, program.checked_files());
    let mut defs: Vec<&crate::analysis::generation::GenerationDescriptor> = found
        .descriptors
        .iter()
        .filter(|d| {
            matches!(
                d.kind,
                GenerationKind::NamedTrait
                    | GenerationKind::InlineTrait
                    | GenerationKind::KeywordDefinition
            )
        })
        .collect();
    if defs.is_empty() {
        return None;
    }
    defs.sort_by_key(|d| (d.span.file.0, d.span.start));
    // Applied definitions consume their saved unit; unapplied ones are
    // pending generation and stay silent. Inline attachments apply at
    // their own target, always.
    let applied = |def: &crate::analysis::generation::GenerationDescriptor| -> bool {
        match def.kind {
            GenerationKind::InlineTrait => true,
            GenerationKind::NamedTrait => found.descriptors.iter().any(|d| {
                d.kind == GenerationKind::TraitApplication
                    && d.owner == def.owner
                    && d.label == def.label
            }),
            GenerationKind::KeywordDefinition => found.descriptors.iter().any(|d| {
                d.kind == GenerationKind::KeywordApplication
                    && d.owner == def.owner
                    && d.label == def.label
            }),
            _ => false,
        }
    };
    let mut saved: std::collections::HashMap<
        intake::AssociationKey,
        crate::analysis::types::GivenSavedUnit,
    > = std::collections::HashMap::new();
    let mut groups: std::collections::HashMap<String, intake::SavedGroup> =
        std::collections::HashMap::new();
    let mut failed = false;
    for def in defs {
        if !applied(def) {
            continue;
        }
        let Some(kind) = intake::UnitKind::of_descriptor(def.kind) else {
            continue;
        };
        let key = intake::AssociationKey {
            owner: def.owner.clone(),
            kind,
            label: def.label.clone(),
            anchor: def.anchor.clone(),
        };
        let what = match def.kind {
            GenerationKind::NamedTrait => {
                format!("trait `{}`", def.label.as_deref().unwrap_or_default())
            }
            GenerationKind::InlineTrait => "inline trait".to_string(),
            _ => format!("keyword `{}`", def.label.as_deref().unwrap_or_default()),
        };
        let resolved = db
            .generation
            .as_ref()
            .ok_or_else(|| "saved input snapshot unavailable".to_string())
            .and_then(|snapshot| snapshot.resolve(db, &key, def.span));
        let (staged_id, group) = match resolved {
            Ok(Some(group)) => group,
            Ok(None) => {
                result.push(crate::diagnostic::Diagnostic::error("E6008", format!("cannot lower {what}: no saved unit is bound to {}; prepare the unit (action: generate)", key.describe()), def.span));
                failed = true;
                continue;
            }
            Err(detail) => {
                result.push(crate::diagnostic::Diagnostic::error(
                    "E6008",
                    format!("cannot lower {what}: {detail} (action: bind)"),
                    def.span,
                ));
                failed = true;
                continue;
            }
        };
        let id = intake::GenerationUnitId::parse(&staged_id).expect("validated staged identity");
        match given_saved_unit(db, def, &id, &group) {
            Ok(unit) => {
                groups.insert(id.as_str().to_string(), group);
                saved.insert(key, unit);
            }
            Err(detail) => {
                result.push(crate::diagnostic::Diagnostic::error(
                    "E6008",
                    format!("cannot lower {what}: {detail}"),
                    def.span,
                ));
                failed = true;
            }
        }
    }
    if failed {
        return None;
    }
    if saved.is_empty() {
        return None;
    }
    let (tables, mut diags) = crate::analysis::check::check_given_contracts(
        &crate::analysis::check::GivenContractInputs {
            db,
            program,
            saved: &saved,
        },
    );
    for diagnostic in diags.drain(..) {
        result.push(diagnostic);
    }
    Some(GivenJoin {
        tables,
        groups,
        units: saved,
    })
}

/// Build one consumed unit's Given inputs from its saved group:
/// the contributions carrier (when present), the implementation
/// bytes plus their resolved import closure (keywords and field checks), and the
/// owner-visible declaration (keyword units).
fn given_saved_unit(
    db: &mut SourceDb,
    def: &crate::analysis::generation::GenerationDescriptor,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
) -> Result<crate::analysis::types::GivenSavedUnit, String> {
    use crate::analysis::generation::GenerationKind;
    let mut contributions = None;
    if let Some(carrier) = group
        .files
        .iter()
        .find(|f| f.rel_path == "contributions.can")
    {
        // A keyword carrier passes through so the Given check refuses
        // it as hidden authority instead of validating hidden bytes.
        let text = String::from_utf8_lossy(&carrier.bytes).into_owned();
        contributions = Some(db.add(
            format!(
                "{}/{}/contributions.can",
                crate::analysis::generation_intake::GENERATED_DIR,
                id.as_str()
            ),
            text,
        ));
    }
    let mut implementation_js = None;
    let mut implementation_imports = Vec::new();
    if let Some(file) = group
        .files
        .iter()
        .find(|f| f.rel_path == "implementation.js")
    {
        let js = String::from_utf8(file.bytes.clone()).map_err(|_| {
            format!(
                "unit `{}` `implementation.js` is not valid UTF-8; repair the file or reconcile with adopt",
                id.as_str(),
            )
        })?;
        if matches!(
            def.kind,
            GenerationKind::NamedTrait | GenerationKind::InlineTrait
        ) && !scan_js_module(&js)
            .exports
            .iter()
            .any(|export| export == crate::analysis::types::GIVEN_FIELD_VALIDATION_EXPORT)
        {
            return Err(format!(
                "unit `{id}` field validation implementation declares no `check` export in `implementation.js`"
            ));
        }
        implementation_imports =
            resolve_saved_js_closure(id, group, "implementation.js", &js, "workerd").map_err(
                |detail| format!("{detail}; fix the saved imports or reconcile with adopt"),
            )?;
        implementation_js = Some(js);
    }
    let mut declaration = None;
    if def.kind == GenerationKind::KeywordDefinition {
        declaration = Some(
            read_saved_declaration(id, group, def).map_err(|failure| failure.message.clone())?,
        );
    }
    Ok(crate::analysis::types::GivenSavedUnit {
        unit_id: id.as_str().to_string(),
        contributions,
        implementation_js,
        implementation_imports,
        declaration,
    })
}

/// Attach checked saved Given inputs to a freshly emitted artifact:
/// the `givenContracts` member, contributed trait fields merged into
/// the stored model descriptors, and packed keyword/field-check server modules
/// (with their import-closure siblings) appended to `staged`. Any
/// failure refuses the artifact with its diagnostic; the caller
/// reports it with exit 10 and no output.
fn attach_saved_given(
    artifact: &mut crate::codegen::artifact::CompileArtifact,
    join: &GivenJoin,
    db: &SourceDb,
    staged: &mut Vec<crate::codegen::artifact::SavedUnitModule>,
) -> Result<(), crate::diagnostic::Diagnostic> {
    use crate::codegen::artifact as art;
    let primary = db
        .iter()
        .next()
        .map(|(id, _)| Span::new(id, 0, 0))
        .unwrap_or(Span::new(SourceId(0), 0, 0));
    let fail = |detail: String| crate::diagnostic::Diagnostic::error("E6008", detail, primary);
    let given_ir = crate::codegen::ir::lower_given_contracts(&join.tables);
    if !given_ir.traits.is_empty() || !given_ir.keywords.is_empty() {
        artifact.given_contracts = Some(art::assemble_given_contracts(&given_ir, tool_version()));
    }
    if let Some(contracts) = artifact.given_contracts.as_ref() {
        if contracts
            .traits
            .iter()
            .any(|instance| instance.validation.is_some())
            && !artifact
                .requires
                .iter()
                .any(|requirement| requirement.capability == "state.field-validation")
        {
            artifact.requires.push(art::ArtifactRequirement {
                capability: "state.field-validation".into(),
                min_version: 1,
            });
        }
        for instance in &contracts.traits {
            if instance.target.split('.').count() == 2
                && let Some(model) = artifact
                    .models
                    .iter_mut()
                    .find(|model| model.name == instance.target)
            {
                model.fields.retain(|field| {
                    !instance
                        .fields
                        .iter()
                        .any(|contributed| contributed.name == field.name)
                });
            }
        }
        art::merge_given_trait_fields(&mut artifact.models, &contracts.traits)
            .map_err(|detail| fail(format!("cannot lower saved trait contributions: {detail}")))?;
    }
    // Given server modules pack per checked contract: the expected
    // fingerprint is the contract's own closure hash, so pack refuses
    // any pairing skew between check and staging.
    if let Some(contracts) = artifact.given_contracts.as_ref() {
        let mut packed_units = std::collections::HashMap::<&str, &str>::new();
        let implementations = contracts
            .keywords
            .iter()
            .map(|rule| (rule.unit_id.as_str(), rule.fingerprint.as_str(), "keyword"))
            .chain(contracts.traits.iter().filter_map(|instance| {
                instance.validation.as_ref().map(|validation| {
                    (
                        instance.unit_id.as_str(),
                        validation.fingerprint.as_str(),
                        "trait",
                    )
                })
            }));
        for (unit_id, fingerprint, kind) in implementations {
            // Applications retain independent checked rules, while the
            // declaration owns one implementation and import closure.
            if let Some(previous) = packed_units.insert(unit_id, fingerprint) {
                if previous != fingerprint {
                    return Err(fail(format!(
                        "{kind} unit `{unit_id}` has inconsistent checked implementation fingerprints"
                    )));
                }
                continue;
            }
            let Some(group) = join.groups.get(unit_id) else {
                return Err(fail(format!(
                    "cannot lower {kind} unit `{unit_id}`: saved unit was not consumed by this build"
                )));
            };
            let owner = art::CanOwnerLink {
                unit_id: unit_id.to_string(),
                kind: group.record.source.kind.as_str().to_string(),
                can_path: group.record.source.path.clone(),
                can_revision: group.record.source.revision.clone(),
                start: group.record.source.start,
                end: group.record.source.end,
            };
            let root = group
                .files
                .iter()
                .find(|f| f.rel_path == "implementation.js")
                .map(|f| f.bytes.clone())
                .unwrap_or_default();
            let imports: Vec<crate::analysis::types::GivenSavedImport> = join
                .units
                .values()
                .find(|unit| unit.unit_id == unit_id)
                .map(|unit| unit.implementation_imports.clone())
                .unwrap_or_default();
            let mut packed = if imports.is_empty() {
                vec![
                    art::pack_saved_unit(group.record.source.kind, owner, &root, fingerprint)
                        .map_err(|detail| {
                            fail(format!(
                                "cannot lower saved {kind} implementation: {detail}"
                            ))
                        })?,
                ]
            } else {
                art::pack_saved_unit_closure(
                    group.record.source.kind,
                    owner,
                    &root,
                    &imports,
                    fingerprint,
                )
                .map_err(|detail| {
                    fail(format!(
                        "cannot lower saved {kind} implementation: {detail}"
                    ))
                })?
            };
            staged.append(&mut packed);
        }
    }
    Ok(())
}

/// Attach consumed Then inputs to a freshly emitted artifact: packed
/// stylesheets for consumed style units (plus view-colocated root
/// CSS), and staged view modules with their import-closure siblings
/// appended to `staged`. The view fingerprint is self-consistent by
/// construction (views carry no checked contract hash): pack still
/// enforces shape, UTF-8, and traversal rules, and refuses any
/// pairing skew it can see. Any failure refuses the artifact.
fn attach_saved_then(
    artifact: &mut crate::codegen::artifact::CompileArtifact,
    join: &crate::codegen::js::ThenBuildJoin,
    db: &SourceDb,
    staged: &mut Vec<crate::codegen::artifact::SavedUnitModule>,
) -> Result<(), crate::diagnostic::Diagnostic> {
    use crate::codegen::artifact as art;
    let primary = db
        .iter()
        .next()
        .map(|(id, _)| Span::new(id, 0, 0))
        .unwrap_or(Span::new(SourceId(0), 0, 0));
    let fail = |detail: String| crate::diagnostic::Diagnostic::error("E6008", detail, primary);
    let owner_of = |group: &crate::analysis::generation_intake::SavedGroup| art::CanOwnerLink {
        unit_id: group.record.id.as_str().to_string(),
        kind: group.record.source.kind.as_str().to_string(),
        can_path: group.record.source.path.clone(),
        can_revision: group.record.source.revision.clone(),
        start: group.record.source.start,
        end: group.record.source.end,
    };
    // Consumed style units pack their scoped CSS.
    let mut sheets: Vec<art::ArtifactStylesheet> = Vec::new();
    let mut style_ids: Vec<&String> = join.styles().keys().collect();
    style_ids.sort();
    for unit_id in style_ids {
        let group = &join.styles()[unit_id];
        let Some(css_file) = group.files.iter().find(|f| f.rel_path == "style.css") else {
            return Err(fail(format!(
                "unit `{unit_id}` has no saved `style.css`; repair the group or reconcile with adopt"
            )));
        };
        let css = String::from_utf8(css_file.bytes.clone()).map_err(|_| {
            fail(format!(
                "unit `{unit_id}` `style.css` is not valid UTF-8; repair the file or reconcile with adopt"
            ))
        })?;
        sheets.push(
            art::pack_saved_stylesheet_with_assets(
                group.record.source.kind,
                owner_of(group),
                &css,
                &group.files,
            )
            .map_err(|detail| fail(format!("cannot lower saved styles: {detail}")))?,
        );
    }
    // Consumed view units pack their renderer module (plus closure
    // siblings) and their colocated root CSS, when present.
    let mut view_ids: Vec<&String> = join.views().keys().collect();
    view_ids.sort();
    for unit_id in view_ids {
        let group = &join.views()[unit_id];
        let id = crate::analysis::generation_intake::GenerationUnitId::parse(unit_id)
            .map_err(|reason| fail(format!("saved unit id is malformed: {reason}")))?;
        // Adopted legacy views carry the handwritten renderer as
        // `server.js` instead of the v1 `implementation.js` module.
        let adopted = group.record.provenance.origin
            == crate::analysis::generation_intake::ProvenanceOrigin::Adopted;
        let module_rel = if group
            .files
            .iter()
            .any(|f| f.rel_path == "implementation.js")
        {
            "implementation.js"
        } else if adopted {
            "server.js"
        } else {
            "implementation.js"
        };
        let root = group
            .files
            .iter()
            .find(|f| f.rel_path == module_rel)
            .map(|f| f.bytes.clone())
            .unwrap_or_default();
        let root_text = String::from_utf8(root.clone()).map_err(|_| {
            fail(format!(
                "unit `{unit_id}` `{module_rel}` is not valid UTF-8; repair the file or reconcile with adopt"
            ))
        })?;
        let scan = scan_js_module(&root_text);
        if !scan.exports.iter().any(|name| name == "render") {
            return Err(fail(format!("view `{unit_id}` must export render")));
        }
        let module =
            art::saved_unit_module_path(group.record.source.kind, unit_id).map_err(fail)?;
        let mut names: Vec<String> = join
            .resolved_shows()
            .filter(|show| show.unit_id == *unit_id)
            .map(|show| show.view_name.clone())
            .collect();
        names.sort();
        names.dedup();
        for view in names {
            artifact.generated_views.push(art::ArtifactGeneratedView {
                view,
                module: module.clone(),
                render_export: "render".to_string(),
                mount_export: scan
                    .exports
                    .iter()
                    .any(|name| name == "mount")
                    .then(|| "mount".to_string()),
            });
        }
        let closure =
            resolve_saved_js_closure(&id, group, module_rel, &root_text, "workerd/browser")
                .map_err(|detail| {
                    fail(format!(
                        "cannot lower view `{unit_id}`: {detail}; fix the saved imports or reconcile with adopt"
                    ))
                })?;
        let closure_refs: Vec<(&str, &[u8])> = closure
            .iter()
            .map(|import| (import.rel_path.as_str(), import.bytes.as_slice()))
            .collect();
        let expected =
            crate::analysis::types::given_closure_fingerprint(root.as_slice(), &closure_refs);
        let mut packed = if closure.is_empty() {
            vec![
                art::pack_saved_unit(group.record.source.kind, owner_of(group), &root, &expected)
                    .map_err(|detail| {
                    fail(format!("cannot lower saved view implementation: {detail}"))
                })?,
            ]
        } else {
            art::pack_saved_unit_closure(
                group.record.source.kind,
                owner_of(group),
                &root,
                &closure,
                &expected,
            )
            .map_err(|detail| fail(format!("cannot lower saved view implementation: {detail}")))?
        };
        staged.append(&mut packed);
        if let Some(file) = group.files.iter().find(|f| f.rel_path == "style.css") {
            let css = String::from_utf8(file.bytes.clone()).map_err(|_| {
                fail(format!(
                    "unit `{unit_id}` `style.css` is not valid UTF-8; repair the file or reconcile with adopt"
                ))
            })?;
            sheets.push(
                art::pack_saved_stylesheet_with_assets(
                    group.record.source.kind,
                    owner_of(group),
                    &css,
                    &group.files,
                )
                .map_err(|detail| fail(format!("cannot lower saved styles: {detail}")))?,
            );
        }
    }
    sheets.sort_by(|a, b| a.path.cmp(&b.path));
    artifact.stylesheets.extend(sheets);
    Ok(())
}
