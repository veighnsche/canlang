//! Ephemeral, immutable saved-code intake shared by compiler consumers.
//! The repository's unit records remain the only persistent binding owner.
use super::generation::{GenerationDescriptor, discover_generation};
use super::generation_intake as intake;
use crate::source::{SourceDb, SourceId, Span};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) struct HeldLease {
    root: PathBuf,
    set: crate::leases::LeaseSet,
}
impl HeldLease {
    pub(crate) fn acquire(
        root: &Path,
        paths: &[&str],
        mode: crate::leases::LeaseMode,
        holder: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            root: root.to_path_buf(),
            set: crate::leases::acquire(root, paths, mode, holder).map_err(|e| e.to_string())?,
        })
    }
}
impl Drop for HeldLease {
    fn drop(&mut self) {
        let _ = crate::leases::release(&self.root, &self.set);
    }
}

/// Source membership within the explicitly selected owning root. Build and
/// status inspect all claims, even when the caller selects just one file.
pub(crate) fn source_files(root: &Path) -> Result<Vec<String>, String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if name.starts_with('.')
                    || matches!(
                        name.as_ref(),
                        "can.generated" | "node_modules" | "target" | "dist"
                    )
                {
                    continue;
                }
                walk(root, &entry.path(), out)?;
            } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "can") {
                let bytes = entry.metadata().map_err(|e| e.to_string())?.len();
                crate::source::admit_source_len(bytes)
                    .map_err(|error| format!("{}: {error}", entry.path().display()))?;
                out.push(
                    entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

#[derive(Debug)]
struct FrozenRoot {
    original: PathBuf,
    mirror: tempfile::TempDir,
    sources: HashMap<String, String>,
    descriptors: Vec<GenerationDescriptor>,
    evidence: HashMap<SourceId, intake::AssociationSource>,
    records: Vec<intake::UnitRecord>,
}

#[derive(Debug)]
pub(crate) struct FrozenGeneration {
    roots: Vec<FrozenRoot>,
    /// Checked source spellings resolve once, before analysis. Emission must
    /// not follow later renames, deletions or symlink changes on live disk.
    source_paths: std::sync::Mutex<HashMap<PathBuf, (usize, String)>>,
}

impl FrozenGeneration {
    pub(crate) fn capture(roots: &[PathBuf]) -> Result<Self, String> {
        let mut roots = roots
            .iter()
            .map(|root| {
                root.canonicalize()
                    .map_err(|e| format!("{}: {e}", root.display()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let all = roots.clone();
        roots.retain(|root| {
            !all.iter()
                .any(|other| root != other && root.starts_with(other))
        });
        let mut seen = std::collections::HashSet::new();
        roots.retain(|root| seen.insert(root.clone()));
        let mut captured = Vec::new();
        for root in &roots {
            let original = root
                .canonicalize()
                .map_err(|e| format!("{}: {e}", root.display()))?;
            // Membership and exact file leases cover allocation, promotion and
            // participating edits while the closure is enumerated and copied.
            let _membership = HeldLease::acquire(
                &original,
                &[intake::GENERATED_DIR, "can.generated/bindings"],
                crate::leases::LeaseMode::Read,
                "compile-capture",
            )?;
            let sources = source_files(&original)?;
            let mut paths = sources.clone();
            let unit_ids = intake::scan_unit_ids(&original)?;
            let group_paths = unit_ids
                .iter()
                .map(|id| format!("{}/{id}", intake::GENERATED_DIR))
                .collect::<Vec<_>>();
            let _groups = HeldLease::acquire(
                &original,
                &group_paths.iter().map(String::as_str).collect::<Vec<_>>(),
                crate::leases::LeaseMode::Read,
                "compile-capture",
            )?;
            freeze_unit_groups(&original, unit_ids, &mut paths)?;
            let frozen = crate::leases::snapshot_inputs(
                &original,
                "compile-capture",
                &paths.iter().map(String::as_str).collect::<Vec<_>>(),
            )
            .map_err(|e| e.to_string())?;
            // Detect a nonparticipating membership edit during enumeration.
            if source_files(&original)? != sources {
                return Err("source scope changed during capture; retry".into());
            }
            let (mirror, source_texts) = mirror_frozen_inputs(frozen, &sources)?;
            let (descriptors, evidence) = describe_root_sources(&sources, &source_texts);
            let records = load_mirror_records(&mirror)?;
            captured.push(FrozenRoot {
                original,
                mirror,
                sources: source_texts,
                descriptors,
                evidence,
                records,
            });
        }
        Ok(Self {
            roots: captured,
            source_paths: std::sync::Mutex::new(HashMap::new()),
        })
    }
}

fn regular_tree(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "saved group contains a symlink: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            regular_tree(&entry.map_err(|e| e.to_string())?.path())?;
        }
    } else if !metadata.is_file() {
        return Err(format!(
            "saved group contains a non-file: {}",
            path.display()
        ));
    }
    Ok(())
}

fn freeze_unit_groups(
    original: &Path,
    unit_ids: Vec<String>,
    paths: &mut Vec<String>,
) -> Result<(), String> {
    for id in unit_ids {
        regular_tree(&original.join(intake::GENERATED_DIR).join(&id))?;
        for file in crate::leases::group_files(original, &id).map_err(|e| e.to_string())? {
            paths.push(format!("{}/{id}/{file}", intake::GENERATED_DIR));
        }
    }
    Ok(())
}

fn mirror_frozen_inputs(
    frozen: Vec<crate::leases::ConsumedInput>,
    sources: &[String],
) -> Result<(tempfile::TempDir, HashMap<String, String>), String> {
    let mirror = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut source_texts = HashMap::new();
    for file in frozen {
        if sources.contains(&file.path) {
            source_texts.insert(
                file.path.clone(),
                String::from_utf8(file.bytes.clone())
                    .map_err(|_| format!("{} is not UTF-8", file.path))?,
            );
        }
        let target = mirror.path().join(file.path);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(target, file.bytes).map_err(|e| e.to_string())?;
    }
    Ok((mirror, source_texts))
}

fn describe_root_sources(
    sources: &[String],
    source_texts: &HashMap<String, String>,
) -> (
    Vec<GenerationDescriptor>,
    HashMap<SourceId, intake::AssociationSource>,
) {
    let mut descriptors = Vec::new();
    let mut evidence = HashMap::new();
    for (index, path) in sources.iter().enumerate() {
        let text = &source_texts[path];
        let id = SourceId(index as u32);
        let (tree, _) = crate::syntax::parse_source(id, text);
        descriptors.extend(discover_generation(&tree, text).descriptors);
        evidence.insert(
            id,
            intake::AssociationSource {
                path: path.clone(),
                revision: crate::source::sha256_hex(text.as_bytes()),
            },
        );
    }
    (descriptors, evidence)
}

fn load_mirror_records(mirror: &tempfile::TempDir) -> Result<Vec<intake::UnitRecord>, String> {
    let mut records = Vec::new();
    for name in intake::scan_unit_ids(mirror.path())? {
        let id = intake::GenerationUnitId::parse(&name).map_err(|e| e.to_string())?;
        let path = mirror
            .path()
            .join(intake::GENERATED_DIR)
            .join(&name)
            .join(intake::UNIT_FILE);
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // Legacy hand-authored records are handled by the existing
        // explicit adoption path. Modern malformed records fail closed.
        match intake::UnitRecord::parse(&text, &id) {
            Ok(record) => records.push(record),
            Err(error) => {
                if !serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .is_some_and(|v| {
                        v.get("id").is_none() && v["unit_id"].as_str() == Some(name.as_str())
                    })
                {
                    return Err(error.to_string());
                }
            }
        }
    }
    Ok(records)
}

impl FrozenGeneration {
    pub(crate) fn source(&self, path: &Path) -> Option<&str> {
        let spelling = path.to_path_buf();
        let mut source_paths = self.source_paths.lock().ok()?;
        if let Some((index, relative)) = source_paths.get(&spelling) {
            return self.roots[*index].sources.get(relative).map(String::as_str);
        }
        let path = path.canonicalize().ok()?;
        let resolved = self.roots.iter().enumerate().find_map(|(index, root)| {
            let relative = path
                .strip_prefix(&root.original)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            root.sources
                .contains_key(&relative)
                .then_some((index, relative))
        })?;
        source_paths.insert(spelling, resolved.clone());
        self.roots[resolved.0]
            .sources
            .get(&resolved.1)
            .map(String::as_str)
    }

    pub(crate) fn resolve(
        &self,
        db: &SourceDb,
        key: &intake::AssociationKey,
        span: Span,
    ) -> Result<Option<(String, intake::SavedGroup)>, String> {
        let path = db
            .get(span.file)
            .ok_or("missing source owner")?
            .path
            .clone();
        let (root_index, relative) = self
            .source_paths
            .lock()
            .map_err(|_| "captured source mapping unavailable")?
            .get(Path::new(&path))
            .cloned()
            .ok_or("source has no captured generated output root")?;
        let root = &self.roots[root_index];
        let selected = select_claimed_descriptor(root, key, &relative, span)?;
        let associations =
            intake::associate_with_sources(&root.descriptors, &root.records, &root.evidence);
        match associations
            .into_iter()
            .find(|(index, _)| *index == selected)
            .map(|(_, a)| a)
        {
            Some(intake::UnitAssociation::Retained { id, .. }) => {
                let staged = self.stage_retained_group(root_index, id)?;
                Ok(Some(staged))
            }
            Some(intake::UnitAssociation::New) => {
                self.adopt_candidate_group(root_index, key, selected)
            }
            _ => Err(format!(
                "ambiguous or displaced saved binding for {}; reconcile with bind",
                key.describe()
            )),
        }
    }

    fn stage_retained_group(
        &self,
        root_index: usize,
        id: intake::GenerationUnitId,
    ) -> Result<(String, intake::SavedGroup), String> {
        let root = &self.roots[root_index];
        let mut group =
            intake::read_saved_group(root.mirror.path(), &id).map_err(|e| e.to_string())?;
        let staged_id = if self.roots.len() > 1 {
            format!("r{root_index}-{}", id.as_str())
        } else {
            id.as_str().to_string()
        };
        // Qualification is ephemeral artifact naming; persisted identity
        // and its editable directory retain the original unit ID.
        group.record.id = intake::GenerationUnitId::parse(&staged_id).map_err(|e| e.to_string())?;
        Ok((staged_id, group))
    }

    fn adopt_candidate_group(
        &self,
        root_index: usize,
        key: &intake::AssociationKey,
        selected: usize,
    ) -> Result<Option<(String, intake::SavedGroup)>, String> {
        let root = &self.roots[root_index];
        let descriptor = &root.descriptors[selected];
        let source = &root.evidence[&descriptor.span.file];
        let evidence = intake::AdoptEvidence {
            path: source.path.clone(),
            revision: source.revision.clone(),
            start: descriptor.span.start,
            end: descriptor.span.end,
        };
        let mut adopted = Vec::new();
        for name in intake::scan_unit_ids(root.mirror.path())? {
            let id = intake::GenerationUnitId::parse(&name)?;
            if root.records.iter().any(|record| record.id == id) {
                continue;
            }
            let dir = root.mirror.path().join(intake::GENERATED_DIR).join(&name);
            if let Ok((mut record, files)) = intake::adopt_legacy_unit(&dir, &id, key, &evidence) {
                let staged_id = if self.roots.len() > 1 {
                    format!("r{root_index}-{name}")
                } else {
                    name
                };
                record.id = intake::GenerationUnitId::parse(&staged_id)?;
                adopted.push((staged_id, intake::SavedGroup { record, files, dir }));
            }
        }
        if adopted.len() > 1 {
            return Err("ambiguous legacy bindings; reconcile with adopt".into());
        }
        if !adopted.is_empty()
            && root
                .descriptors
                .iter()
                .filter(|descriptor| {
                    descriptor.has_generation_identity
                        && intake::UnitKind::of_descriptor(descriptor.kind) == Some(key.kind)
                        && descriptor.label == key.label
                })
                .count()
                != 1
        {
            return Err("ambiguous legacy source claims; reconcile with adopt".into());
        }
        Ok(adopted.pop())
    }
}

fn select_claimed_descriptor(
    root: &FrozenRoot,
    key: &intake::AssociationKey,
    relative: &str,
    span: Span,
) -> Result<usize, String> {
    let keyed = root
        .descriptors
        .iter()
        .enumerate()
        .filter(|(_, d)| {
            intake::association_for(d, "", "")
                .is_some_and(|s| intake::AssociationKey::of(&s) == *key)
        })
        .collect::<Vec<_>>();
    let exact = keyed
        .iter()
        .filter(|(_, d)| {
            root.evidence[&d.span.file].path == relative
                && d.span.start == span.start
                && d.span.end == span.end
        })
        .collect::<Vec<_>>();
    let contained = keyed
        .iter()
        .filter(|(_, d)| {
            root.evidence[&d.span.file].path == relative
                && span.start <= d.span.start
                && d.span.end <= span.end
        })
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        Ok(exact[0].0)
    } else if contained.len() == 1 {
        Ok(contained[0].0)
    } else if keyed.len() == 1 {
        Ok(keyed[0].0)
    } else {
        Err(format!(
            "ambiguous source claims for {}; reconcile with bind",
            key.describe()
        ))
    }
}
