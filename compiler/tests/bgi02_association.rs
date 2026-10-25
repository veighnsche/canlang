//! BGI-02: stable associations and saved-group intake.
use canlang_compiler::analysis::generation::{
    GenerationDescriptor, GenerationKind, discover_generation,
};
use canlang_compiler::analysis::generation_intake::{
    AssociationKey, AssociationSource, BindError, BindRequest, BindTarget, GENERATED_DIR,
    GenerationUnitId, IntakeAction, OriginalOutput, ProvenanceOrigin, UNIT_ABI_VERSION, UNIT_FILE,
    UnitAssociation, UnitKind, UnitProvenance, UnitRecord, apply_bind, associate,
    associate_with_source, associate_with_sources, association_for, contract_for,
    intake_associated, next_unit_id, read_saved_group, scan_unit_ids,
};
use canlang_compiler::cli::dispatch;
use canlang_compiler::format::format_source;
use canlang_compiler::source::{SourceId, sha256_hex};
use canlang_compiler::syntax::parse_source;
use std::collections::{BTreeMap, HashMap, HashSet};

const BASE: &str = r#"app Tasks
Given
 trait completable $"Add done:bool=false with Open/Done labels."
 keyword canonical_identity(target:model,field:field(target,text)) $"Use the field NFKC-normalized key."
 Todo {title:text trim min=1 max=200} completable
 Note {body:text} trait $"Add pinned:bool=false."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 style TaskSurface $"Readable task surfaces."
 view TaskTile(row:Todo) $"Arrange admitted title/status and declared controls." $TaskSurface
  edit fields=title
  delete
 page / title="Todos" $"A calm workspace."
  card "Add a task" $"A compact entry area."
   form Todo.create fields=title
    input title $TaskSurface
  list Todo as task $TaskSurface
   show TaskTile {row=row} $TaskSurface
"#;

fn discover(text: &str) -> Vec<GenerationDescriptor> {
    let (tree, diags) = parse_source(SourceId(0), text);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, text);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    found.descriptors
}

/// A saved record as `prepare` would have written it for `descriptor`.
fn saved_record(
    id: &str,
    descriptor: &GenerationDescriptor,
    path: &str,
    revision: &str,
) -> UnitRecord {
    let source = association_for(descriptor, path, revision).expect("identity descriptor");
    let mut contract = contract_for(descriptor).expect("identity descriptor");
    // The saved prompt fingerprint reflects the bound prompt.
    contract.prompt_sha256 =
        sha256_hex(descriptor.prompt.as_deref().unwrap_or_default().as_bytes());
    let mut files = BTreeMap::new();
    files.insert(
        "style.css".to_string(),
        "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e".to_string(),
    );
    UnitRecord {
        abi_version: UNIT_ABI_VERSION,
        id: GenerationUnitId::parse(id).unwrap(),
        source,
        contract: contract.clone(),
        original: OriginalOutput {
            prompt_sha256: contract.prompt_sha256.clone(),
            files,
        },
        provenance: UnitProvenance {
            origin: ProvenanceOrigin::Generated,
            runner: Some("codex".to_string()),
            model: Some("test-model".to_string()),
            note: None,
        },
    }
}

fn identity_keys(descriptors: &[GenerationDescriptor]) -> Vec<AssociationKey> {
    descriptors
        .iter()
        .filter(|d| UnitKind::of_descriptor(d.kind).is_some())
        .map(|d| AssociationKey {
            owner: d.owner.clone(),
            kind: UnitKind::of_descriptor(d.kind).unwrap(),
            label: d.label.clone(),
            anchor: d.anchor.clone(),
        })
        .collect()
}

#[test]
fn unit_json_round_trip_pins_abi_and_directory_id() {
    let descriptors = discover(BASE);
    let trait_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .unwrap();
    let record = saved_record("u1", trait_desc, "app.can", "rev0");
    let json = record.to_json();
    assert!(json.contains("\"abi_version\": 1"), "{json}");
    assert!(json.contains("\"id\": \"u1\""), "{json}");
    let back = UnitRecord::parse(&json, &GenerationUnitId::parse("u1").unwrap()).unwrap();
    assert_eq!(back, record);
    // Wrong ABI refuses with the exact want.
    let bad_abi = json.replace("\"abi_version\": 1", "\"abi_version\": 2");
    let err = UnitRecord::parse(&bad_abi, &GenerationUnitId::parse("u1").unwrap()).unwrap_err();
    assert!(err.contains("abi_version 2, want 1"), "{err}");
    // Directory/record ID mismatch refuses.
    let err = UnitRecord::parse(&json, &GenerationUnitId::parse("u2").unwrap()).unwrap_err();
    assert!(err.contains("does not match its directory"), "{err}");
    // Malformed JSON refuses.
    assert!(UnitRecord::parse("{nope", &GenerationUnitId::parse("u1").unwrap()).is_err());
}

#[test]
fn unit_ids_reject_paths_and_blank() {
    assert!(GenerationUnitId::parse("u1").is_ok());
    for bad in ["", "..", ".", "a/b", "a\\b", "u 1", "u\t1"] {
        assert!(GenerationUnitId::parse(bad).is_err(), "{bad:?} must refuse");
    }
    let used: HashSet<String> = ["u1".to_string(), "u3".to_string()].into_iter().collect();
    let first = next_unit_id(&used);
    let independently_allocated = next_unit_id(&used);
    for id in [&first, &independently_allocated] {
        assert_eq!(id.as_str().len(), 34);
        assert!(id.as_str().starts_with("g-"));
        assert!(
            id.as_str()[2..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
        assert!(!used.contains(id.as_str()));
    }
    assert_ne!(
        first, independently_allocated,
        "independent branch allocation must not share a counter"
    );
}

#[test]
fn format_and_unrelated_edits_retain_every_association() {
    let descriptors = discover(BASE);
    let revision = sha256_hex(BASE.as_bytes());
    let saved: Vec<UnitRecord> = identity_keys(&descriptors)
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let d = descriptors
                .iter()
                .filter(|d| UnitKind::of_descriptor(d.kind).is_some())
                .nth(i)
                .unwrap();
            saved_record(&format!("u{}", i + 1), d, "app.can", &revision)
        })
        .collect();
    let first: HashMap<_, _> = associate(&descriptors, &saved)
        .into_iter()
        .map(|(i, a)| (descriptors[i].anchor.clone(), a))
        .collect();
    assert!(first.values().all(|a| matches!(
        a,
        UnitAssociation::Retained {
            prompt_changed: false,
            ..
        }
    )));

    // Reformatting keeps every anchor (and ID): discovery ignores
    // formatting/comments, so association is untouched.
    let messy = BASE
        .replace("trait completable", "trait   completable")
        .replace("canonical_identity target=", "canonical_identity   target=")
        .replace("input title $TaskSurface", "input title    $TaskSurface");
    let once = format_source(SourceId(0), &messy).expect("format");
    let edited = discover(&once.text);
    let second: HashMap<_, _> = associate(&edited, &saved)
        .into_iter()
        .map(|(i, a)| (edited[i].anchor.clone(), a))
        .collect();
    assert_eq!(first.len(), second.len());
    for (anchor, before) in &first {
        assert_eq!(second.get(anchor), Some(before), "anchor {anchor}");
    }
    // An unrelated model elsewhere also changes nothing: every prior
    // anchor retains its exact prior association.
    let unrelated = BASE.replace("\nWhen\n", "\n Log {line:text}\nWhen\n");
    let edited = discover(&unrelated);
    let third: HashMap<_, _> = associate(&edited, &saved)
        .into_iter()
        .map(|(i, a)| (edited[i].anchor.clone(), a))
        .collect();
    assert_eq!(first.len(), third.len());
    for (anchor, before) in &first {
        assert_eq!(third.get(anchor), Some(before), "anchor {anchor}");
    }
}

#[test]
fn prompt_only_change_preserves_id_on_unchanged_unique_anchor() {
    let descriptors = discover(BASE);
    let revision = sha256_hex(BASE.as_bytes());
    let saved: Vec<UnitRecord> = descriptors
        .iter()
        .filter(|d| UnitKind::of_descriptor(d.kind).is_some())
        .enumerate()
        .map(|(i, d)| saved_record(&format!("u{}", i + 1), d, "app.can", &revision))
        .collect();
    // Rewrite every prompt; anchors stay unique and unchanged.
    let changed = BASE
        .replace(
            "Add done:bool=false with Open/Done labels.",
            "Completely different words.",
        )
        .replace("Use the field NFKC-normalized key.", "Other key words.")
        .replace("Add pinned:bool=false.", "Other pin words.")
        .replace("Readable task surfaces.", "Other surface words.")
        .replace(
            "Arrange admitted title/status and declared controls.",
            "Other arrange words.",
        )
        .replace("A calm workspace.", "Other calm words.")
        .replace("A compact entry area.", "Other compact words.");
    assert_ne!(changed, BASE);
    let edited = discover(&changed);
    assert_eq!(
        identity_keys(&edited),
        identity_keys(&descriptors),
        "prompt-only edits keep every association key"
    );
    for (index, association) in associate(&edited, &saved) {
        match association {
            UnitAssociation::Retained { prompt_changed, .. } => assert!(
                prompt_changed,
                "prompt freshness is reported, not silently kept"
            ),
            other => panic!("prompt-only change must retain, got {other:?}"),
        }
        let _ = index;
    }
}

#[test]
fn copies_and_ambiguous_relocation_cannot_reuse_ownership() {
    let descriptors = discover(BASE);
    let revision = sha256_hex(BASE.as_bytes());
    let saved: Vec<UnitRecord> = descriptors
        .iter()
        .filter(|d| UnitKind::of_descriptor(d.kind).is_some())
        .enumerate()
        .map(|(i, d)| saved_record(&format!("u{}", i + 1), d, "app.can", &revision))
        .collect();

    // A copied definition shares its whole key: both copies refuse reuse.
    // (The duplicate also diagnoses in discovery; association still refuses.)
    let copied = BASE.replacen(
        " trait completable $\"Add done:bool=false with Open/Done labels.\"\n",
        " trait completable $\"Add done:bool=false with Open/Done labels.\"\n trait completable $\"Add done:bool=false with Open/Done labels.\"\n",
        1,
    );
    let (tree, diags) = parse_source(SourceId(0), &copied);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &copied);
    for (index, association) in associate(&found.descriptors, &saved) {
        let d = &found.descriptors[index];
        if d.kind == GenerationKind::NamedTrait {
            assert!(
                matches!(association, UnitAssociation::Ambiguous { .. }),
                "copied trait must not reuse ownership, got {association:?}"
            );
        }
    }

    // A relocated inline trait (new anchor) requires reconciliation: the old ID is never
    // silently reused via a sole unmatched pair or nearest offset.
    let moved = BASE.replace(
        " Note {body:text} trait $\"Add pinned:bool=false.\"",
        " Note {body:text}\n Note2 {body:text} trait $\"Add pinned:bool=false.\"",
    );
    let edited = discover(&moved);
    let by_anchor: HashMap<_, _> = associate(&edited, &saved)
        .into_iter()
        .map(|(i, a)| (edited[i].anchor.clone(), a))
        .collect();
    let inline_new = by_anchor
        .iter()
        .find(|(anchor, _)| anchor.contains("Note2"))
        .map(|(_, a)| a);
    assert!(
        matches!(inline_new, Some(UnitAssociation::Ambiguous { .. })),
        "possibly displaced saved owner must require reconciliation"
    );
    // No association may point at the old Note inline unit's ID.
    let old_inline_id = saved
        .iter()
        .find(|r| r.source.anchor.contains("inline-trait") && r.source.anchor.contains("Note"))
        .map(|r| r.id.clone());
    for association in by_anchor.values() {
        if let UnitAssociation::Retained { id, .. } = association {
            assert_ne!(Some(id), old_inline_id.as_ref());
        }
    }

    // Duplicate saved records for one key refuse to pick one.
    let mut duped = saved.clone();
    let mut twin = duped[0].clone();
    twin.id = GenerationUnitId::parse("u99").unwrap();
    duped.push(twin);
    let again = associate(&descriptors, &duped);
    let dup_key = AssociationKey::of(&saved[0].source);
    for (index, association) in &again {
        let d = &descriptors[*index];
        let key = AssociationKey {
            owner: d.owner.clone(),
            kind: UnitKind::of_descriptor(d.kind).unwrap(),
            label: d.label.clone(),
            anchor: d.anchor.clone(),
        };
        if key == dup_key {
            match association {
                UnitAssociation::Ambiguous { candidates } => {
                    assert_eq!(candidates.len(), 2);
                }
                other => panic!("duplicate saved records must diagnose, got {other:?}"),
            }
        }
    }
}

#[test]
fn stale_bind_rejects_and_leaves_saved_group_intact() {
    let descriptors = discover(BASE);
    let trait_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .unwrap();
    let saved = vec![saved_record("u1", trait_desc, "app.can", "rev-inspected")];
    let request_for = |revision: &str, target| BindRequest {
        path: "app.can".to_string(),
        revision: revision.to_string(),
        start: trait_desc.span.start,
        end: trait_desc.span.end,
        source: association_for(trait_desc, "app.can", revision).unwrap(),
        contract: contract_for(trait_desc).unwrap(),
        target,
    };
    // Stale selector: inspected rev-inspected, current rev-now.
    let err = apply_bind(
        &saved,
        &request_for(
            "rev-inspected",
            BindTarget::Existing(GenerationUnitId::parse("u1").unwrap()),
        ),
        "rev-now",
    )
    .unwrap_err();
    assert!(matches!(err, BindError::StaleSelector { .. }), "{err:?}");
    assert!(err.to_string().contains("stale bind selector"), "{err}");
    assert_eq!(
        saved[0].source.revision, "rev-inspected",
        "failed bind keeps the saved group intact"
    );
    // Unknown unit.
    let err = apply_bind(
        &saved,
        &request_for(
            "rev-now",
            BindTarget::Existing(GenerationUnitId::parse("u7").unwrap()),
        ),
        "rev-now",
    )
    .unwrap_err();
    assert!(matches!(err, BindError::UnknownUnit { .. }), "{err:?}");
    // Kind mismatch: the trait ID cannot back a style unit.
    let style_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let cross = BindRequest {
        path: "app.can".to_string(),
        revision: "rev-now".to_string(),
        start: style_desc.span.start,
        end: style_desc.span.end,
        source: association_for(style_desc, "app.can", "rev-now").unwrap(),
        contract: contract_for(style_desc).unwrap(),
        target: BindTarget::Existing(GenerationUnitId::parse("u1").unwrap()),
    };
    let err = apply_bind(&saved, &cross, "rev-now").unwrap_err();
    assert!(matches!(err, BindError::KindMismatch { .. }), "{err:?}");
}

#[test]
fn bind_existing_refreshes_evidence_and_bind_new_allocates_for_copies() {
    let descriptors = discover(BASE);
    let trait_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .unwrap();
    let saved = vec![saved_record("u1", trait_desc, "app.can", "rev-old")];
    // Existing bind after a move: new anchor/location, same ID, same
    // original fingerprints and provenance.
    let mut moved_source = association_for(trait_desc, "moved.can", "rev-new").unwrap();
    moved_source.anchor = "Tasks:trait:completable:".to_string();
    let request = BindRequest {
        path: "moved.can".to_string(),
        revision: "rev-new".to_string(),
        start: 10,
        end: 20,
        source: moved_source,
        contract: contract_for(trait_desc).unwrap(),
        target: BindTarget::Existing(GenerationUnitId::parse("u1").unwrap()),
    };
    let bound = apply_bind(&saved, &request, "rev-new").unwrap();
    assert_eq!(bound.id.as_str(), "u1");
    assert_eq!(bound.source.path, "moved.can");
    assert_eq!(bound.source.revision, "rev-new");
    assert_eq!(bound.original, saved[0].original);
    assert_eq!(bound.provenance, saved[0].provenance);
    // Copy bind: new=true allocates a fresh ID with no shared outputs.
    let copy = BindRequest {
        target: BindTarget::New,
        ..request.clone()
    };
    let fresh = apply_bind(&saved, &copy, "rev-new").unwrap();
    assert!(fresh.id.as_str().starts_with("g-"));
    assert_ne!(fresh.id, saved[0].id);
    assert!(fresh.original.files.is_empty());
    assert_eq!(fresh.provenance.origin, ProvenanceOrigin::Bound);
}

#[test]
fn named_style_uses_share_one_saved_group_with_zero_new_ids() {
    // The definition used twice plus one added compatible use: still one unit.
    let two = BASE.to_string();
    let three = two.replace(
        "   show TaskTile {row=row} $TaskSurface\n",
        "   show TaskTile {row=row} $TaskSurface\n   text \"more\" $TaskSurface\n",
    );
    // `text` with a style suffix must parse as an inline-attachment host.
    let before = discover(&two);
    let after = discover(&three);
    let defs_before: Vec<_> = before
        .iter()
        .filter(|d| d.kind == GenerationKind::StyleDefinition)
        .collect();
    let defs_after: Vec<_> = after
        .iter()
        .filter(|d| d.kind == GenerationKind::StyleDefinition)
        .collect();
    assert_eq!(defs_before.len(), 1);
    assert_eq!(defs_after.len(), 1);
    assert_eq!(defs_before[0].anchor, defs_after[0].anchor);
    // Uses carry no generation identity: association skips them entirely.
    for d in after.iter().filter(|d| {
        matches!(
            d.kind,
            GenerationKind::StyleNamedUse | GenerationKind::ViewRootStyleNamed
        )
    }) {
        assert!(!d.has_generation_identity);
    }
    let revision = sha256_hex(three.as_bytes());
    let saved = vec![saved_record("u1", defs_before[0], "app.can", &revision)];
    let associations = associate(&after, &saved);
    let style_units: Vec<_> = associations
        .iter()
        .filter(|(i, _)| after[*i].kind == GenerationKind::StyleDefinition)
        .collect();
    assert_eq!(style_units.len(), 1);
    assert!(
        matches!(
            style_units[0].1,
            UnitAssociation::Retained {
                prompt_changed: false,
                ..
            }
        ),
        "compatible new use consumes the same saved CSS, got {:?}",
        style_units[0].1
    );
    // No other style-kind association exists: one definition, one group.
    let styleish = associations
        .iter()
        .filter(|(i, _)| {
            matches!(
                after[*i].kind,
                GenerationKind::StyleDefinition
                    | GenerationKind::StyleNamedUse
                    | GenerationKind::ViewRootStyleNamed
            )
        })
        .count();
    assert_eq!(styleish, 1);
}

#[test]
fn intake_reads_current_files_and_keeps_original_fingerprints() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let descriptors = discover(BASE);
    let style_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let revision = sha256_hex(BASE.as_bytes());
    let mut record = saved_record("u1", style_desc, "app.can", &revision);
    // Original fingerprints name the generated bytes, not today's edits.
    record.original.files.insert(
        "style.css".to_string(),
        sha256_hex(b".TaskSurface{color:old}"),
    );
    let unit_dir = root.join(GENERATED_DIR).join("u1");
    std::fs::create_dir_all(unit_dir.join("assets")).unwrap();
    std::fs::write(unit_dir.join(UNIT_FILE), record.to_json()).unwrap();
    // A direct edit is the current build input.
    std::fs::write(unit_dir.join("style.css"), b".TaskSurface{color:new}").unwrap();
    std::fs::write(unit_dir.join("assets/logo.bin"), [0u8, 1, 2, 3]).unwrap();

    let group = read_saved_group(root, &GenerationUnitId::parse("u1").unwrap()).unwrap();
    assert_eq!(group.record, record);
    let css = group
        .files
        .iter()
        .find(|f| f.rel_path == "style.css")
        .unwrap();
    assert_eq!(css.bytes, b".TaskSurface{color:new}");
    assert_eq!(css.sha256, sha256_hex(b".TaskSurface{color:new}"));
    assert_ne!(
        css.sha256, group.record.original.files["style.css"],
        "current bytes and original fingerprints are distinct facts"
    );
    let asset = group
        .files
        .iter()
        .find(|f| f.rel_path == "assets/logo.bin")
        .unwrap();
    assert_eq!(asset.bytes, vec![0u8, 1, 2, 3]);
    assert!(!group.files.iter().any(|f| f.rel_path == UNIT_FILE));
    assert_eq!(scan_unit_ids(root).unwrap(), vec!["u1".to_string()]);
    // Missing root is no saved units, not an error.
    assert!(scan_unit_ids(&root.join("elsewhere")).unwrap().is_empty());
}

#[test]
fn missing_and_incompatible_groups_identify_exact_unit_and_action() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Missing group: exact ID plus the generation action.
    let issue = read_saved_group(root, &GenerationUnitId::parse("u3").unwrap()).unwrap_err();
    assert_eq!(issue.unit, "u3");
    assert_eq!(issue.action, IntakeAction::Generate);
    assert!(issue.detail.contains("no saved group"), "{issue}");
    // Incompatible group (wrong ABI): exact ID plus bind reconciliation.
    let unit_dir = root.join(GENERATED_DIR).join("u4");
    std::fs::create_dir_all(&unit_dir).unwrap();
    std::fs::write(
        unit_dir.join(UNIT_FILE),
        r#"{"abi_version":2,"id":"u4","source":{},"contract":{},"original":{},"provenance":{}}"#,
    )
    .unwrap();
    let issue = read_saved_group(root, &GenerationUnitId::parse("u4").unwrap()).unwrap_err();
    assert_eq!(issue.unit, "u4");
    assert_eq!(issue.action, IntakeAction::Bind);
    assert!(issue.detail.contains("incompatible"), "{issue}");
    // Unbound and ambiguous associations also name their unit and action.
    let descriptors = discover(BASE);
    let (groups, issues) = intake_associated(root, &descriptors, &associate(&descriptors, &[]));
    assert!(groups.is_empty());
    assert!(!issues.is_empty());
    assert!(issues.iter().all(|i| i.action == IntakeAction::Generate));
    assert!(issues.iter().all(|i| !i.unit.is_empty()));
}

#[test]
fn saved_intake_consults_no_provider_config_or_login() {
    // Even with hostile ambient config, intake reads only the unit dir.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Edition 2024 marks process-env mutation unsafe (threads); this
    // test mutates before intake and restores before returning.
    unsafe {
        std::env::set_var("CAN_CATALOG", "/nonexistent/catalog.json");
        std::env::set_var("CAN_GEN_RUNNER", "nonexistent-runner");
    }
    let descriptors = discover(BASE);
    let view_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::ViewDefinition)
        .unwrap();
    let record = saved_record("u1", view_desc, "app.can", &sha256_hex(BASE.as_bytes()));
    let unit_dir = root.join(GENERATED_DIR).join("u1");
    std::fs::create_dir_all(&unit_dir).unwrap();
    std::fs::write(unit_dir.join(UNIT_FILE), record.to_json()).unwrap();
    std::fs::write(unit_dir.join("implementation.js"), b"// current renderer").unwrap();
    // No can.gen.toml anywhere under the root, no network, no login.
    let group = read_saved_group(root, &GenerationUnitId::parse("u1").unwrap()).unwrap();
    assert_eq!(group.record.id.as_str(), "u1");
    unsafe {
        std::env::remove_var("CAN_CATALOG");
        std::env::remove_var("CAN_GEN_RUNNER");
    }
}

fn argv(words: &[&str]) -> Vec<String> {
    std::iter::once("can".to_string())
        .chain(words.iter().map(|w| w.to_string()))
        .collect()
}

fn write_fixture(dir: &std::path::Path, name: &str, text: &str) -> String {
    let path = dir.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().to_string()
}

#[test]
fn cli_status_reports_units_and_actions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_fixture(dir.path(), "app.can", BASE);
    // No saved groups yet: every unit reports its generate action.
    let result = dispatch(&argv(&["gen", "status", &root, &file]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    assert!(
        result.stdout.contains("(action: generate)"),
        "{}",
        result.stdout
    );
    assert!(result.stdout.contains("named-trait"), "{}", result.stdout);
    // Unknown gen operations diagnose instead of guessing BGI-03 shapes.
    let result = dispatch(&argv(&["gen", "retry", &root, &file]));
    assert_eq!(result.code, 2);
    assert!(result.stderr.contains("BGI-03"), "{}", result.stderr);
}

#[test]
fn cli_bind_round_trip_then_status_retains() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_fixture(dir.path(), "app.can", BASE);
    let revision = sha256_hex(BASE.as_bytes());
    let descriptors = discover(BASE);
    let trait_desc = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .unwrap();
    let start = trait_desc.span.start.to_string();
    let end = trait_desc.span.end.to_string();
    // Bind new: copies and fresh units allocate their own ID.
    let result = dispatch(&argv(&[
        "gen", "bind", &root, &file, &start, &end, &revision, "new",
    ]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    let allocated = scan_unit_ids(dir.path()).unwrap();
    assert_eq!(allocated.len(), 1);
    let id = &allocated[0];
    assert!(id.starts_with("g-"));
    assert!(
        result.stdout.contains(&format!("bound {id}")),
        "{}",
        result.stdout
    );
    let unit_json = dir.path().join(GENERATED_DIR).join(id).join(UNIT_FILE);
    assert!(unit_json.is_file());
    // Status now retains the bound unit with its current path.
    let result = dispatch(&argv(&["gen", "status", &root, &file]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    assert!(
        result.stdout.contains(&format!("unit {id}")),
        "{}",
        result.stdout
    );
    // The saved closure includes metadata, contributions, imports and assets.
    write_fixture(
        dir.path(),
        &format!("can.generated/{id}/contributions.can"),
        "Given\n",
    );
    write_fixture(
        dir.path(),
        &format!("can.generated/{id}/helper.js"),
        "export const x = 1;\n",
    );
    write_fixture(
        dir.path(),
        &format!("can.generated/{id}/unused.can"),
        "Given\n",
    );
    // JSON status carries the same association.
    let result = dispatch(&argv(&["gen", "status", "--format=json", &root, &file]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    assert!(
        result.stdout.contains("\"association\":\"retained\""),
        "{}",
        result.stdout
    );
    assert!(
        result.stdout.contains(&format!("\"id\":\"{id}\"")),
        "{}",
        result.stdout
    );
    assert!(
        result.stdout.contains(&format!("can.generated/{id}")),
        "{}",
        result.stdout
    );
    assert!(
        result.stdout.contains(&format!(".can/gen/attempts/{id}")),
        "{}",
        result.stdout
    );
    let status: serde_json::Value = serde_json::from_str(&result.stdout).unwrap();
    let unit = status["units"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"].as_str() == Some(id.as_str()))
        .unwrap();
    let files = unit["current_files"].as_array().unwrap();
    for path in [
        "app.can",
        &format!("can.generated/{id}/unit.json"),
        &format!("can.generated/{id}/contributions.can"),
        &format!("can.generated/{id}/helper.js"),
        &format!("can.generated/{id}/unused.can"),
    ] {
        assert!(files.iter().any(|entry| entry["path"] == path && entry["sha256"].as_str().unwrap().len() == 64), "{path}: {files:?}");
    }
    assert_eq!(
        unit["compiler_sources"],
        serde_json::json!(["app.can", &format!("can.generated/{id}/contributions.can")])
    );
    // Stale revision refuses and writes nothing new.
    let result = dispatch(&argv(&[
        "gen", "bind", &root, &file, &start, &end, "deadbeef", "new",
    ]));
    assert_eq!(result.code, 2);
    assert!(result.stderr.contains("stale"), "{}", result.stderr);
    assert_eq!(scan_unit_ids(dir.path()).unwrap(), allocated);
    // Binding an application span refuses: uses reuse their definition.
    let app = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::TraitApplication)
        .unwrap();
    let result = dispatch(&argv(&[
        "gen",
        "bind",
        &root,
        &file,
        &app.span.start.to_string(),
        &app.span.end.to_string(),
        &revision,
        "new",
    ]));
    assert_eq!(result.code, 2);
    assert!(
        result.stderr.contains("no generation unit"),
        "{}",
        result.stderr
    );
}

fn legacy_group(
    root: &std::path::Path,
    id: &str,
    kind: &str,
    label: Option<&str>,
    primary: Option<&str>,
) -> String {
    let document = serde_json::json!({
        "abi_version": 1, "unit_id": id, "kind": kind, "label": label,
        "draft": true, "origin": "handwritten-draft", "provider": null,
        "model": null, "owner": "historical-owner", "source": "old/app.can",
        "prompt": "Historical prompt.", "target": "historical description",
        "profile": "historical recipe"
    })
    .to_string();
    write_fixture(root, &format!("can.generated/{id}/unit.json"), &document);
    if let Some(primary) = primary {
        write_fixture(
            root,
            &format!("can.generated/{id}/{primary}"),
            "original bytes\n",
        );
    }
    write_fixture(
        root,
        &format!("can.generated/{id}/notes.txt"),
        "historical notes\n",
    );
    document
}

fn bind_json(
    root: &std::path::Path,
    descriptor: &GenerationDescriptor,
    unit: &str,
    revision: &str,
) -> canlang_compiler::cli::DispatchResult {
    let request = serde_json::json!({
        "version": 1, "request_id": "bind-legacy", "operation": "bind",
        "root": root, "file": "app.can", "start": descriptor.span.start,
        "end": descriptor.span.end, "revision": revision, "unit": unit
    });
    let path = write_fixture(root, "bind-request.json", &request.to_string());
    dispatch(&argv(&["gen", "--request", &path]))
}

#[test]
fn cli_bind_adopts_legacy_kind_families_preserving_existing_bytes() {
    let source = BASE.replace("$TaskSurface\n  edit", "$\"Quiet view root.\"\n  edit");
    let descriptors = discover(&source);
    let cases = [
        (
            GenerationKind::NamedTrait,
            "given_trait",
            Some("completable"),
            "contributions.can",
        ),
        (
            GenerationKind::InlineTrait,
            "given_trait",
            None,
            "contributions.can",
        ),
        (
            GenerationKind::KeywordDefinition,
            "given_keyword",
            Some("canonical_identity"),
            "server.js",
        ),
        (
            GenerationKind::StyleDefinition,
            "style",
            Some("TaskSurface"),
            "style.css",
        ),
        (GenerationKind::StyleInline, "style", None, "style.css"),
        (
            GenerationKind::ViewDefinition,
            "then_view",
            Some("TaskTile"),
            "server.js",
        ),
        (
            GenerationKind::ViewRootStyleInline,
            "style",
            None,
            "style.css",
        ),
    ];
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let file = write_fixture(root, "app.can", &source);
    let revision = sha256_hex(source.as_bytes());
    // Untouched legacy siblings do not prevent explicit migration of one unit.
    for (index, (_, legacy_kind, label, primary)) in cases.iter().enumerate() {
        legacy_group(
            root,
            &format!("legacy-{index}"),
            legacy_kind,
            *label,
            Some(primary),
        );
        if *legacy_kind == "given_trait" {
            write_fixture(
                root,
                &format!("can.generated/legacy-{index}/server.js"),
                "legacy field check bytes\n",
            );
        }
    }
    // An existing canonical module remains current even when server.js differs.
    write_fixture(
        root,
        "can.generated/legacy-5/implementation.js",
        "existing canonical bytes\n",
    );
    for (index, (kind, _, _, primary)) in cases.iter().enumerate() {
        let descriptor = descriptors.iter().find(|d| d.kind == *kind).unwrap();
        let id = format!("legacy-{index}");
        let result = if index % 2 == 0 {
            bind_json(root, descriptor, &id, &revision)
        } else {
            dispatch(&argv(&[
                "gen",
                "bind",
                &root.to_string_lossy(),
                &file,
                &descriptor.span.start.to_string(),
                &descriptor.span.end.to_string(),
                &revision,
                &id,
            ]))
        };
        assert_eq!(
            result.code, 0,
            "{kind:?}: {} {}",
            result.stdout, result.stderr
        );
        let group = read_saved_group(root, &GenerationUnitId::parse(&id).unwrap()).unwrap();
        assert_eq!(
            group.record.source,
            association_for(descriptor, "app.can", &revision).unwrap()
        );
        assert_eq!(group.record.contract, contract_for(descriptor).unwrap());
        assert_eq!(
            group.record.original.prompt_sha256,
            sha256_hex(b"Historical prompt.")
        );
        assert_eq!(group.record.provenance.origin, ProvenanceOrigin::Adopted);
        assert_eq!(group.record.provenance.runner, None);
        assert_eq!(group.record.provenance.model, None);
        assert!(
            group
                .record
                .provenance
                .note
                .as_deref()
                .unwrap()
                .contains("handwritten-draft")
        );
        for (path, contents) in [
            (*primary, "original bytes\n"),
            ("notes.txt", "historical notes\n"),
        ] {
            assert_eq!(
                std::fs::read_to_string(group.dir.join(path)).unwrap(),
                contents
            );
            assert_eq!(
                group.record.original.files[path],
                sha256_hex(contents.as_bytes())
            );
        }
        if matches!(
            kind,
            GenerationKind::KeywordDefinition
                | GenerationKind::NamedTrait
                | GenerationKind::InlineTrait
        ) {
            assert_eq!(
                std::fs::read(group.dir.join("implementation.js")).unwrap(),
                std::fs::read(group.dir.join("server.js")).unwrap()
            );
            assert_eq!(
                group.record.original.files["implementation.js"],
                group.record.original.files["server.js"]
            );
        }
        if *kind == GenerationKind::ViewDefinition {
            assert_eq!(
                std::fs::read_to_string(group.dir.join("implementation.js")).unwrap(),
                "existing canonical bytes\n"
            );
        }
    }
}

#[test]
fn cli_legacy_bind_refuses_stale_incompatible_and_malformed_inputs_without_writes() {
    let descriptors = discover(BASE);
    let selected = descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .unwrap();
    for case in ["stale", "label", "family", "missing", "modern"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_fixture(root, "app.can", BASE);
        let document = legacy_group(
            root,
            "legacy",
            if case == "family" {
                "style"
            } else {
                "given_trait"
            },
            Some(if case == "label" {
                "OtherTrait"
            } else {
                "completable"
            }),
            (case != "missing").then_some("contributions.can"),
        );
        if case == "modern" {
            write_fixture(
                root,
                "can.generated/broken/unit.json",
                r#"{"id":"broken","unit_id":"broken","abi_version":1,"kind":"style","draft":true,"origin":"handwritten-draft"}"#,
            );
        }
        let revision = if case == "stale" {
            "stale".into()
        } else {
            sha256_hex(BASE.as_bytes())
        };
        let result = bind_json(root, selected, "legacy", &revision);
        assert_eq!(
            result.code, 2,
            "{case}: {} {}",
            result.stdout, result.stderr
        );
        let body: serde_json::Value = serde_json::from_str(&result.stdout).unwrap();
        assert_eq!(
            body["error"]["code"],
            match case {
                "stale" => "stale-selector",
                "modern" => "invalid-saved-record",
                _ => "legacy-binding-refused",
            }
        );
        assert_eq!(
            std::fs::read_to_string(root.join("can.generated/legacy/unit.json")).unwrap(),
            document
        );
        assert!(!root.join("can.generated/legacy/implementation.js").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("can.generated/legacy/notes.txt")).unwrap(),
            "historical notes\n"
        );
    }
}

#[test]
fn cli_legacy_bind_preserves_group_lease_and_source_claim_guards() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write_fixture(root, "app.can", BASE);
    let descriptor = discover(BASE)
        .into_iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let document = legacy_group(
        root,
        "legacy",
        "style",
        Some("TaskSurface"),
        Some("style.css"),
    );
    let revision = sha256_hex(BASE.as_bytes());
    let held = canlang_compiler::leases::acquire(
        root,
        &["can.generated/legacy"],
        canlang_compiler::leases::LeaseMode::Write,
        "another-writer",
    )
    .unwrap();
    let refused = bind_json(root, &descriptor, "legacy", &revision);
    assert_eq!(refused.code, 3, "{} {}", refused.stdout, refused.stderr);
    canlang_compiler::leases::release(root, &held).unwrap();
    let modern = saved_record("modern", &descriptor, "app.can", &revision);
    write_fixture(root, "can.generated/modern/unit.json", &modern.to_json());
    let occupied = bind_json(root, &descriptor, "legacy", &revision);
    assert_eq!(occupied.code, 2, "{} {}", occupied.stdout, occupied.stderr);
    assert!(
        occupied.stdout.contains("occupied-binding"),
        "{}",
        occupied.stdout
    );
    std::fs::remove_dir_all(root.join("can.generated/modern")).unwrap();
    write_fixture(root, "copy.can", BASE);
    let duplicate = bind_json(root, &descriptor, "legacy", &revision);
    assert_eq!(
        duplicate.code, 2,
        "{} {}",
        duplicate.stdout, duplicate.stderr
    );
    assert!(
        duplicate.stdout.contains("ambiguous-binding"),
        "{}",
        duplicate.stdout
    );
    assert_eq!(
        std::fs::read_to_string(root.join("can.generated/legacy/unit.json")).unwrap(),
        document
    );
    assert_eq!(
        std::fs::read_to_string(root.join("can.generated/legacy/style.css")).unwrap(),
        "original bytes\n"
    );
}

/// Two inline text styles sharing one structural key, as in the probe:
/// `text "one" $"Readable"` and `text "two" $"Readable"` in page/UiLeaf.
fn copied_inline_styles() -> Vec<GenerationDescriptor> {
    [("one", 1u32, 10u32), ("two", 20u32, 30u32)]
        .into_iter()
        .map(|(_text, start, end)| GenerationDescriptor {
            selector: None,
            region: None,
            owner: "Test".to_string(),
            kind: GenerationKind::StyleInline,
            label: Some("UiLeaf".to_string()),
            prompt: Some("Readable".to_string()),
            profile: None,
            span: canlang_compiler::source::Span {
                file: SourceId(0),
                start,
                end,
            },
            anchor: "Test:style-inline:UiLeaf:UiLeaf".to_string(),
            target: Some("UiLeaf".to_string()),
            has_generation_identity: true,
            params: Vec::new(),
            args: Vec::new(),
            use_sites: Vec::new(),
        })
        .collect()
}

#[test]
fn explicit_bind_honored_for_exact_captured_location_only() {
    let descriptors = copied_inline_styles();
    let revision = "rev";
    // Bind the original location to u1, then the copy with new=true to u2.
    let first = &descriptors[0];
    let seed = saved_record("u1", first, "app.can", revision);
    let bind_original = BindRequest {
        path: "app.can".to_string(),
        revision: revision.to_string(),
        start: first.span.start,
        end: first.span.end,
        source: association_for(first, "app.can", revision).unwrap(),
        contract: contract_for(first).unwrap(),
        target: BindTarget::Existing(GenerationUnitId::parse("u1").unwrap()),
    };
    let bound_original = apply_bind(&[seed], &bind_original, revision).unwrap();
    let second = &descriptors[1];
    let bind_copy = BindRequest {
        path: "app.can".to_string(),
        revision: revision.to_string(),
        start: second.span.start,
        end: second.span.end,
        source: association_for(second, "app.can", revision).unwrap(),
        contract: contract_for(second).unwrap(),
        target: BindTarget::New,
    };
    let bound_copy =
        apply_bind(std::slice::from_ref(&bound_original), &bind_copy, revision).unwrap();
    let copy_id = bound_copy.id.clone();
    assert!(copy_id.as_str().starts_with("g-"));
    let saved = vec![bound_original, bound_copy];

    // Without current-location evidence the shared key still refuses.
    for (_, association) in associate(&descriptors, &saved) {
        match association {
            UnitAssociation::Ambiguous { candidates } => {
                assert_eq!(candidates.len(), 2);
            }
            other => panic!("evidence-free copies must refuse, got {other:?}"),
        }
    }
    // With exact evidence each location retains its own bound ID.
    let source = AssociationSource {
        path: "app.can".to_string(),
        revision: revision.to_string(),
    };
    let honored: Vec<_> = associate_with_source(&descriptors, &saved, &source);
    assert_eq!(honored.len(), 2);
    assert!(matches!(
        honored[0].1,
        UnitAssociation::Retained { ref id, prompt_changed: false }
        if id.as_str() == "u1"
    ));
    assert!(matches!(
        honored[1].1,
        UnitAssociation::Retained { ref id, prompt_changed: false }
        if id == &copy_id
    ));
    // Changed or stale source never guesses: a new revision refuses both.
    let stale = AssociationSource {
        path: "app.can".to_string(),
        revision: "rev-edited".to_string(),
    };
    for (_, association) in associate_with_source(&descriptors, &saved, &stale) {
        assert!(
            matches!(association, UnitAssociation::Ambiguous { .. }),
            "stale revision must not guess, got {association:?}"
        );
    }
    // A moved span refuses while its untouched sibling still retains:
    // only the exact captured location honors.
    let mut moved = descriptors.clone();
    moved[0].span.start = 2;
    let rematched = associate_with_source(&moved, &saved, &source);
    assert_eq!(rematched.len(), 2);
    assert!(
        matches!(rematched[0].1, UnitAssociation::Ambiguous { .. }),
        "moved span must not guess, got {:?}",
        rematched[0].1
    );
    assert!(matches!(
        rematched[1].1,
        UnitAssociation::Retained { ref id, prompt_changed: false }
        if id == &copy_id
    ));
}

#[test]
fn missing_primary_output_refuses_while_edits_and_optional_assets_pass() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let descriptors = copied_inline_styles();
    let mut record = saved_record("u1", &descriptors[0], "app.can", "rev");
    record.original.files.insert(
        "assets/old-logo.bin".to_string(),
        sha256_hex(b"old logo bytes"),
    );
    let unit_dir = root.join(GENERATED_DIR).join("u1");
    std::fs::create_dir_all(&unit_dir).unwrap();
    std::fs::write(unit_dir.join(UNIT_FILE), record.to_json()).unwrap();
    // Current style.css missing: exact unit plus its generation action.
    let issue = read_saved_group(root, &GenerationUnitId::parse("u1").unwrap()).unwrap_err();
    assert_eq!(issue.unit, "u1");
    assert_eq!(issue.action, IntakeAction::Generate);
    assert!(issue.detail.contains("style.css"), "{issue}");
    // A direct edit (bytes differ from the historical hash) is usable,
    // and the missing historical optional asset is not required.
    std::fs::write(unit_dir.join("style.css"), b".UiLeaf{color:new}").unwrap();
    let group = read_saved_group(root, &GenerationUnitId::parse("u1").unwrap()).unwrap();
    assert_eq!(group.record.id.as_str(), "u1");
    assert_eq!(group.files.len(), 1);
    assert_ne!(
        group.files[0].sha256, group.record.original.files["style.css"],
        "edited bytes are current inputs, not hash failures"
    );
    // A fresh preparation group (bound, no recorded outputs) may still be
    // allocated without outputs.
    let fresh = apply_bind(
        &[record],
        &BindRequest {
            path: "app.can".to_string(),
            revision: "rev".to_string(),
            start: 20,
            end: 30,
            source: association_for(&descriptors[1], "app.can", "rev").unwrap(),
            contract: contract_for(&descriptors[1]).unwrap(),
            target: BindTarget::New,
        },
        "rev",
    )
    .unwrap();
    let fresh_dir = root.join(GENERATED_DIR).join(fresh.id.as_str());
    std::fs::create_dir_all(&fresh_dir).unwrap();
    std::fs::write(fresh_dir.join(UNIT_FILE), fresh.to_json()).unwrap();
    let group = read_saved_group(root, &fresh.id).unwrap();
    assert!(group.files.is_empty());
}

#[test]
#[cfg(unix)]
fn symlink_entries_refuse_with_exact_affected_unit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let descriptors = copied_inline_styles();
    let record = saved_record("u1", &descriptors[0], "app.can", "rev");
    let unit_dir = root.join(GENERATED_DIR).join("u1");
    std::fs::create_dir_all(&unit_dir).unwrap();
    std::fs::write(unit_dir.join(UNIT_FILE), record.to_json()).unwrap();
    let outside = dir.path().join("outside.css");
    std::fs::write(&outside, b"external bytes").unwrap();
    // A current file symlinking outside refuses; external bytes never
    // serve as the unit's own output.
    std::os::unix::fs::symlink(&outside, unit_dir.join("style.css")).unwrap();
    let issue = read_saved_group(root, &GenerationUnitId::parse("u1").unwrap()).unwrap_err();
    assert_eq!(issue.unit, "u1");
    assert_eq!(issue.action, IntakeAction::Bind);
    assert!(issue.detail.contains("style.css"), "{issue}");
    assert!(issue.detail.contains("symlink"), "{issue}");
    std::fs::remove_file(unit_dir.join("style.css")).unwrap();
    std::fs::write(unit_dir.join("style.css"), b".UiLeaf{}").unwrap();
    assert!(read_saved_group(root, &GenerationUnitId::parse("u1").unwrap()).is_ok());

    // A symlinked unit record refuses with the affected unit.
    let record2 = saved_record("u2", &descriptors[1], "app.can", "rev");
    let unit2 = root.join(GENERATED_DIR).join("u2");
    std::fs::create_dir_all(&unit2).unwrap();
    let external_record = dir.path().join("external-unit.json");
    std::fs::write(&external_record, record2.to_json()).unwrap();
    std::os::unix::fs::symlink(&external_record, unit2.join(UNIT_FILE)).unwrap();
    let issue = read_saved_group(root, &GenerationUnitId::parse("u2").unwrap()).unwrap_err();
    assert_eq!(issue.unit, "u2");
    assert_eq!(issue.action, IntakeAction::Bind);
    assert!(issue.detail.contains("symlink"), "{issue}");

    // A symlinked unit directory refuses with the affected unit.
    let real = dir.path().join("real-u3");
    std::fs::create_dir_all(&real).unwrap();
    let record3 = saved_record("u3", &descriptors[0], "app.can", "rev");
    std::fs::write(real.join(UNIT_FILE), record3.to_json()).unwrap();
    std::fs::write(real.join("style.css"), b".UiLeaf{}").unwrap();
    std::os::unix::fs::symlink(&real, root.join(GENERATED_DIR).join("u3")).unwrap();
    let issue = read_saved_group(root, &GenerationUnitId::parse("u3").unwrap()).unwrap_err();
    assert_eq!(issue.unit, "u3");
    assert_eq!(issue.action, IntakeAction::Bind);
    assert!(issue.detail.contains("symlink"), "{issue}");
}

#[test]
fn source_revision_hook_tracks_exact_bytes() {
    let mut db = canlang_compiler::source::SourceDb::new();
    let id = db.add("app.can".to_string(), BASE.to_string());
    assert_eq!(db.revision(id), Some(sha256_hex(BASE.as_bytes()).as_str()));
    let id2 = db.add("app.can".to_string(), format!("{BASE} Log {{line:text}}\n"));
    assert_ne!(db.revision(id), db.revision(id2));
    // The original ID still denotes its original bytes.
    assert_eq!(db.revision(id), Some(sha256_hex(BASE.as_bytes()).as_str()));
}

const ANONYMOUS: &str = r#"app Tasks
Given
 Log {line:text}
When
Then
 page / title="Tasks"
  text "Same" $"Readable"
  text "Same" $"Readable"
"#;

fn anonymous_records(text: &str) -> (Vec<GenerationDescriptor>, Vec<UnitRecord>) {
    let descriptors = discover(text);
    let saved = descriptors
        .iter()
        .filter(|descriptor| descriptor.has_generation_identity)
        .enumerate()
        .map(|(index, descriptor)| {
            saved_record(
                &format!("u{}", index + 1),
                descriptor,
                "app.can",
                &sha256_hex(text.as_bytes()),
            )
        })
        .collect();
    (descriptors, saved)
}

#[test]
fn anonymous_local_interval_survives_formatting_comments_and_outside_edits() {
    let (original, saved) = anonymous_records(ANONYMOUS);
    assert_eq!(saved.len(), 2);
    assert_eq!(original[0].selector, original[1].selector);
    assert_eq!(saved[0].source.region.as_ref().unwrap().occurrence, 0);
    assert_eq!(saved[1].source.region.as_ref().unwrap().occurrence, 1);
    let changed = ANONYMOUS
        .replace("When\n", " Audit {entry:text}\nWhen\n")
        .replace("  text ", "  text    ")
        .replacen("  text", "  ## unrelated explanatory comment\n  text", 1)
        + "  text \"Outside\" $\"Other styling\"\n";
    let edited = discover(&changed);
    let outcomes = associate_with_source(
        &edited,
        &saved,
        &AssociationSource {
            path: "app.can".to_string(),
            revision: sha256_hex(changed.as_bytes()),
        },
    );
    assert_eq!(outcomes.len(), 3);
    for index in 0..2 {
        assert!(
            matches!(&outcomes[index].1, UnitAssociation::Retained { id, prompt_changed:false } if id == &saved[index].id),
            "{:?}",
            outcomes[index]
        );
    }
    assert!(matches!(outcomes[2].1, UnitAssociation::New));
}

#[test]
fn changed_anonymous_interval_refuses_insertion_and_competing_certificates() {
    let (_, saved) = anonymous_records(ANONYMOUS);
    let original_records = saved.clone();
    let inserted = ANONYMOUS.to_string() + "  text \"Same\" $\"Readable\"\n";
    for (_, outcome) in associate(&discover(&inserted), &saved) {
        assert!(
            matches!(outcome, UnitAssociation::Ambiguous { .. }),
            "{outcome:?}"
        );
    }
    assert_eq!(
        saved, original_records,
        "association preserves every output receipt"
    );
    let mut competing = saved.clone();
    let mut extra = saved[0].clone();
    extra.id = GenerationUnitId::parse("competing").unwrap();
    extra.source.region.as_mut().unwrap().sha256 = "0".repeat(64);
    competing.push(extra);
    for (_, outcome) in associate(&discover(ANONYMOUS), &competing) {
        assert!(
            matches!(outcome, UnitAssociation::Ambiguous { .. }),
            "{outcome:?}"
        );
    }
    let changed_prompt = ANONYMOUS.replacen("Readable", "Different prompt", 1);
    for (_, outcome) in associate(&discover(&changed_prompt), &saved) {
        assert!(
            matches!(outcome, UnitAssociation::Ambiguous { .. }),
            "{outcome:?}"
        );
    }
}

#[test]
fn complete_containment_distinguishes_pages_and_view_prompt_roles() {
    let source = r#"app Tasks
Given
 Item {title:text}
When
Then
 view Tile(row:Item) $"Render" $"Style"
  text row.title
 page / title="Tasks"
  text "Same" $"Readable"
 page /other title="Other"
  text "Same" $"Readable"
"#;
    let descriptors = discover(source)
        .into_iter()
        .filter(|descriptor| descriptor.has_generation_identity)
        .collect::<Vec<_>>();
    assert_eq!(descriptors.len(), 4);
    assert_ne!(
        descriptors[0].selector, descriptors[1].selector,
        "renderer/root style roles differ"
    );
    assert_eq!(
        descriptors[2].anchor, descriptors[3].anchor,
        "legacy nearest-host keys coincide"
    );
    assert_ne!(
        descriptors[2].selector, descriptors[3].selector,
        "complete page containment differs"
    );
    let saved = descriptors
        .iter()
        .enumerate()
        .map(|(index, descriptor)| saved_record(&format!("u{index}"), descriptor, "app.can", "old"))
        .collect::<Vec<_>>();
    for (_, outcome) in associate(&descriptors, &saved) {
        assert!(
            matches!(outcome, UnitAssociation::Retained { .. }),
            "{outcome:?}"
        );
    }
}

#[test]
fn complete_scope_blocks_cross_file_copy_and_duplicate_ids() {
    let source = "app Tasks\nGiven\nWhen\nThen\n style Surface $\"Readable\"\n";
    let mut descriptors = discover(source);
    let saved = vec![saved_record("u1", &descriptors[0], "original.can", "old")];
    let mut copied = descriptors[0].clone();
    copied.span.file = SourceId(1);
    descriptors.push(copied);
    let sources = [
        (
            SourceId(0),
            AssociationSource {
                path: "original.can".to_string(),
                revision: "new".to_string(),
            },
        ),
        (
            SourceId(1),
            AssociationSource {
                path: "copy.can".to_string(),
                revision: "new".to_string(),
            },
        ),
    ]
    .into_iter()
    .collect();
    for (_, outcome) in associate_with_sources(&descriptors, &saved, &sources) {
        assert!(
            matches!(outcome, UnitAssociation::Ambiguous { .. }),
            "{outcome:?}"
        );
    }
    let mut twin = saved[0].clone();
    twin.source.selector = Some("another semantic claim".to_string());
    for (_, outcome) in associate(&descriptors[..1], &[saved[0].clone(), twin]) {
        assert!(
            matches!(outcome, UnitAssociation::Ambiguous { .. }),
            "{outcome:?}"
        );
    }
}

#[test]
fn owner_rename_requires_reconciliation_for_each_saved_kind() {
    let original = discover(BASE);
    let saved = original
        .iter()
        .filter(|descriptor| descriptor.has_generation_identity)
        .enumerate()
        .map(|(index, descriptor)| saved_record(&format!("u{index}"), descriptor, "app.can", "old"))
        .collect::<Vec<_>>();
    let renamed = BASE.replace("app Tasks", "app Renamed");
    let current = discover(&renamed);
    let outcomes = associate_with_source(
        &current,
        &saved,
        &AssociationSource {
            path: "moved.can".to_string(),
            revision: sha256_hex(renamed.as_bytes()),
        },
    );
    assert_eq!(outcomes.len(), saved.len());
    for (index, outcome) in outcomes {
        let kind = UnitKind::of_descriptor(current[index].kind).unwrap();
        let expected = saved
            .iter()
            .filter(|record| record.source.kind == kind)
            .map(|record| record.id.clone())
            .collect::<Vec<_>>();
        match outcome {
            UnitAssociation::Ambiguous { candidates } => assert_eq!(candidates, expected),
            other => panic!("owner rename must reconcile saved {kind:?}: {other:?}"),
        }
    }
    // A genuinely new kind has no displaced same-kind output to reconcile.
    let view_only = saved
        .into_iter()
        .filter(|record| record.source.kind == UnitKind::View)
        .collect::<Vec<_>>();
    let current_style = discover("app New\nGiven\nWhen\nThen\n style Fresh $\"Readable\"\n");
    assert!(matches!(
        associate(&current_style, &view_only)[0].1,
        UnitAssociation::New
    ));
}

#[test]
fn legacy_records_parse_without_optional_evidence_and_invalid_region_refuses() {
    let (_, saved) = anonymous_records(ANONYMOUS);
    let mut document: serde_json::Value = serde_json::from_str(&saved[0].to_json()).unwrap();
    document["source"]
        .as_object_mut()
        .unwrap()
        .remove("selector");
    document["source"].as_object_mut().unwrap().remove("region");
    let legacy = UnitRecord::parse(&document.to_string(), &saved[0].id).unwrap();
    assert!(legacy.source.selector.is_none() && legacy.source.region.is_none());
    document = serde_json::from_str(&saved[0].to_json()).unwrap();
    document["source"]["region"]["occurrence"] = serde_json::json!(2);
    assert!(
        UnitRecord::parse(&document.to_string(), &saved[0].id)
            .unwrap_err()
            .contains("region certificate")
    );
}
