//! Stable generation associations and saved-group intake (BGI-02).
//!
//! BGI-01 discovers structural [`GenerationDescriptor`](super::generation::GenerationDescriptor)
//! values with formatting-insensitive anchors. This module owns the next
//! handoff: tracked opaque unit IDs, `can.generated/<id>/unit.json`
//! records, conservative unique association, explicit bind/copy
//! reconciliation, and saved-group intake for ordinary builds.
//!
//! Association evidence is exactly owner/kind/label/normalized-structure.
//! A prompt-only change preserves the ID while the non-prompt anchor is
//! unchanged and unique. Identity is never inferred from a sole unmatched
//! old/new pair, nearest offset, or prompt similarity: ambiguous moves,
//! copies, or renames diagnose and require explicit `bind`.
//!
//! Intake reads only the owning unit's current files under
//! `can.generated/<id>/` plus `unit.json`. It consults no provider,
//! configuration, or login, and it never launches generation: the `$`
//! marker is inert during ordinary builds. Missing or incompatible
//! groups identify the exact unit and the generation or reconciliation
//! action instead of regenerating silently.

use crate::analysis::generation::{GenerationDescriptor, GenerationKind, LocalRegionCertificate};
use crate::source::sha256_hex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// ABI version written into every `unit.json` (frozen v1 record shape).
pub const UNIT_ABI_VERSION: u32 = 1;

/// Tracked saved-output root relative to the project root.
pub const GENERATED_DIR: &str = "can.generated";

/// Association record filename inside each unit directory.
pub const UNIT_FILE: &str = "unit.json";

/// Opaque generation-unit identity.
///
/// Opaque means callers never parse structure out of the text: retry and
/// inspection select units by source association, never by authoring IDs.
/// New IDs carry 128 random bits; existing opaque IDs remain readable.
/// The spelling carries no source ownership or ordering meaning.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GenerationUnitId(String);

impl GenerationUnitId {
    /// Validate a caller-supplied ID: non-empty, no path separators or
    /// whitespace, never `.`/`..`. Rejects traversal before any join.
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.is_empty() {
            return Err("unit id must not be empty".to_string());
        }
        if text == "." || text == ".." || text.contains(['/', '\\']) {
            return Err(format!("unit id `{text}` must not name a path"));
        }
        if text
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(format!("unit id `{text}` must not contain whitespace"));
        }
        Ok(Self(text.to_string()))
    }

    /// The ID text (for paths, reports, and `unit.json` round-trips).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for GenerationUnitId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Generation-unit kinds that own an ID and a saved output group.
///
/// Named trait/keyword applications reuse their definition without an
/// independent identity or copied group; named style uses carry instance
/// roots/hooks only. There is no inline keyword association.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnitKind {
    NamedTrait,
    InlineTrait,
    Keyword,
    Style,
    StyleInline,
    View,
    ViewStyleInline,
}

impl UnitKind {
    /// The identity-carrying kind for a descriptor, or `None` for
    /// applications and named uses, which reuse their definition.
    pub fn of_descriptor(kind: GenerationKind) -> Option<Self> {
        match kind {
            GenerationKind::NamedTrait => Some(Self::NamedTrait),
            GenerationKind::InlineTrait => Some(Self::InlineTrait),
            GenerationKind::KeywordDefinition => Some(Self::Keyword),
            GenerationKind::StyleDefinition => Some(Self::Style),
            GenerationKind::StyleInline => Some(Self::StyleInline),
            GenerationKind::ViewDefinition => Some(Self::View),
            GenerationKind::ViewRootStyleInline => Some(Self::ViewStyleInline),
            GenerationKind::TraitApplication
            | GenerationKind::KeywordApplication
            | GenerationKind::StyleNamedUse
            | GenerationKind::ViewRootStyleNamed => None,
        }
    }

    /// Stable kebab-case spelling shared with `unit.json` and tooling.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NamedTrait => "named-trait",
            Self::InlineTrait => "inline-trait",
            Self::Keyword => "keyword",
            Self::Style => "style",
            Self::StyleInline => "style-inline",
            Self::View => "view",
            Self::ViewStyleInline => "view-style-inline",
        }
    }

    /// Required primary outputs for this kind: unit-relative paths that
    /// must exist among current files before saved intake is usable.
    ///
    /// Style-family units produce CSS; trait units produce the
    /// compiler-visible contributions carrier; keyword and view units
    /// produce their saved JS module export. Owned assets and any other
    /// historical files are never required: only these declared primaries
    /// gate intake, and only by presence, never by hash equality.
    pub fn required_primary_outputs(&self) -> &'static [&'static str] {
        match self {
            Self::Style | Self::StyleInline | Self::ViewStyleInline => &["style.css"],
            Self::NamedTrait | Self::InlineTrait => &["contributions.can"],
            Self::Keyword | Self::View => &["implementation.js"],
        }
    }
}

/// Source side of a unit association: owner/kind/label/normalized-structure
/// plus the location/revision evidence an explicit `bind` inspects.
///
/// Matching uses only owner, kind, label, and anchor. Path, revision, and
/// span are bind-time evidence: they locate the source for reconciliation
/// but never identify the unit across edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceAssociation {
    pub owner: String,
    pub kind: UnitKind,
    pub label: Option<String>,
    /// Formatting-insensitive non-prompt anchor from BGI-01 discovery.
    pub anchor: String,
    /// Complete portable semantic selector; absent in legacy records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Exact local anonymous-region evidence; no whole-file revision dependency.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<LocalRegionCertificate>,
    /// Workspace-relative source path at bind time.
    pub path: String,
    /// Source revision (SHA-256 of the file text) at bind time.
    pub revision: String,
    /// Inspected byte span at bind time (evidence, not identity).
    pub start: u32,
    pub end: u32,
}

/// Minimal checked contract refs carried beside the association.
///
/// BGI-07 extends keyword/trait units with typed owner-versioned producer
/// descriptors; BGI-02 records only what association and freshness need.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitContract {
    /// Declared target (`workerd`, `browser`, CSS, or a row model).
    pub target: Option<String>,
    /// Owning declaration's optional generation profile (`agent=...`).
    pub profile: Option<String>,
    /// SHA-256 of the bound prompt text; prompt freshness evidence.
    pub prompt_sha256: String,
    /// Normalized keyword signature (`name(kind),...`) for keyword units.
    pub signature: Option<String>,
}

/// Truthful original-generation facts, preserved separately from current
/// edited bytes. Intake compares against these; it never overwrites them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginalOutput {
    /// SHA-256 of the prompt the original output was generated from.
    pub prompt_sha256: String,
    /// Original generated bytes per unit-relative path (rel path -> sha256).
    pub files: BTreeMap<String, String>,
}

/// Where the saved group came from. Recorded once, never rewritten by
/// intake; direct edits change current bytes, not provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProvenanceOrigin {
    Generated,
    Adopted,
    Bound,
}

/// Truthful original provenance for the saved group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitProvenance {
    pub origin: ProvenanceOrigin,
    pub runner: Option<String>,
    pub model: Option<String>,
    pub note: Option<String>,
}

/// The `can.generated/<id>/unit.json` record: opaque ID, source
/// association, kind/target, minimal contract refs, and original
/// provenance. `abi_version` is always [`UNIT_ABI_VERSION`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitRecord {
    pub abi_version: u32,
    pub id: GenerationUnitId,
    pub source: SourceAssociation,
    pub contract: UnitContract,
    pub original: OriginalOutput,
    pub provenance: UnitProvenance,
}

impl UnitRecord {
    /// Parse and validate a `unit.json` document: the ABI version must be
    /// exactly [`UNIT_ABI_VERSION`] and the record ID must match the
    /// directory-selected `expected` ID.
    pub fn parse(text: &str, expected: &GenerationUnitId) -> Result<Self, String> {
        let record: Self = serde_json::from_str(text)
            .map_err(|err| format!("unit.json is not a valid unit record: {err}"))?;
        if record.abi_version != UNIT_ABI_VERSION {
            return Err(format!(
                "unit `{}` has abi_version {}, want {UNIT_ABI_VERSION}",
                record.id, record.abi_version
            ));
        }
        if record.id != *expected {
            return Err(format!(
                "unit.json id `{}` does not match its directory `{expected}`",
                record.id
            ));
        }
        if let Some(region) = &record.source.region {
            if record.source.selector.is_none()
                || region.container.is_empty()
                || region.count == 0
                || region.occurrence >= region.count
                || region.sha256.len() != 64
                || !region
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Err("unit source has an invalid local region certificate".to_string());
            }
        }
        Ok(record)
    }

    /// Render for `unit.json` (stable key order via struct field order).
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Build the source-association evidence for one discovered unit.
pub fn association_for(
    descriptor: &GenerationDescriptor,
    path: &str,
    revision: &str,
) -> Option<SourceAssociation> {
    let kind = UnitKind::of_descriptor(descriptor.kind)?;
    Some(SourceAssociation {
        owner: descriptor.owner.clone(),
        kind,
        label: descriptor.label.clone(),
        anchor: descriptor.anchor.clone(),
        selector: descriptor.selector.clone(),
        region: descriptor.region.clone(),
        path: path.to_string(),
        revision: revision.to_string(),
        start: descriptor.span.start,
        end: descriptor.span.end,
    })
}

/// Build the minimal contract refs for one discovered unit.
pub fn contract_for(descriptor: &GenerationDescriptor) -> Option<UnitContract> {
    UnitKind::of_descriptor(descriptor.kind)?;
    let prompt_sha256 = sha256_hex(descriptor.prompt.as_deref().unwrap_or_default().as_bytes());
    let signature = (descriptor.kind == GenerationKind::KeywordDefinition).then(|| {
        descriptor
            .params
            .iter()
            .map(|p| {
                if p.kind == "field" {
                    format!(
                        "{}:field({},{})",
                        p.name,
                        p.target_param.as_deref().unwrap_or(""),
                        p.type_name.as_deref().unwrap_or("")
                    )
                } else {
                    format!("{}:{}", p.name, p.kind)
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    });
    Some(UnitContract {
        target: descriptor.target.clone(),
        profile: descriptor.profile.clone(),
        prompt_sha256,
        signature,
    })
}

/// Conservative association key: owner, kind, optional label, and the
/// normalized non-prompt anchor. Prompt text, offsets, and ordinals are
/// never evidence.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AssociationKey {
    pub owner: String,
    pub kind: UnitKind,
    pub label: Option<String>,
    pub anchor: String,
}

impl AssociationKey {
    pub fn of(source: &SourceAssociation) -> Self {
        Self {
            owner: source.owner.clone(),
            kind: source.kind,
            label: source.label.clone(),
            anchor: source.anchor.clone(),
        }
    }

    /// Human-readable key for diagnostics (`owner/kind/label` + anchor).
    pub fn describe(&self) -> String {
        format!(
            "{}/{}/{}{}",
            self.owner,
            self.kind.as_str(),
            self.label.as_deref().unwrap_or("-"),
            format_args!(" anchor `{}`", self.anchor)
        )
    }
}

/// Association outcome for one discovered identity-carrying descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitAssociation {
    /// Exactly one saved record carries this owner/kind/label/anchor.
    /// A prompt-only change preserves the ID: the prompt is compared for
    /// freshness reporting but never breaks the match.
    Retained {
        id: GenerationUnitId,
        prompt_changed: bool,
    },
    /// No saved record matches. Preparation would allocate a fresh ID;
    /// intake reports the missing group with its generation action.
    New,
    /// More than one saved record shares the key, or more than one current
    /// descriptor does (a copy). Reuse is refused; reconcile with `bind`.
    Ambiguous { candidates: Vec<GenerationUnitId> },
}

/// Current source evidence for one association pass: the workspace-relative
/// path and revision (SHA-256 of the file text) every `descriptor` span was
/// discovered from. Spans come from the descriptors themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssociationSource {
    pub path: String,
    pub revision: String,
}

/// Conservatively associate discovered units with saved records.
///
/// Both sides group by [`AssociationKey`]. A descriptor retains its ID only
/// when its key is unique on both sides and exactly one saved record
/// matches. Copies (duplicate keys on the descriptor side) and duplicate
/// saved records both yield [`UnitAssociation::Ambiguous`]; relocated
/// units whose anchor changed yield [`UnitAssociation::New`] rather than
/// silently reusing ownership. Descriptors without generation identity
/// (applications, named uses) are skipped: they reuse their definition.
///
/// This form carries no current-location evidence, so every duplicate key
/// refuses. Use [`associate_with_source`] when the caller can name the
/// inspected path/revision: an explicit bind is then honored for its exact
/// captured source revision/location, and only there.
pub fn associate(
    descriptors: &[GenerationDescriptor],
    saved: &[UnitRecord],
) -> Vec<(usize, UnitAssociation)> {
    associate_inner(descriptors, saved, &HashMap::new())
}

/// Compatibility single-source entry point. Complete-scope consumers should
/// use `associate_with_sources` so copies in another source cannot be hidden.
pub fn associate_with_source(
    descriptors: &[GenerationDescriptor],
    saved: &[UnitRecord],
    source: &AssociationSource,
) -> Vec<(usize, UnitAssociation)> {
    let sources = descriptors
        .iter()
        .map(|descriptor| (descriptor.span.file, source.clone()))
        .collect();
    associate_inner(descriptors, saved, &sources)
}

/// Resolve all live defining claims once, retaining source provenance per file.
/// The caller supplies the complete relevant source/record closure in one owner
/// root. Missing correspondence is never permission to consume another root.
pub fn associate_with_sources(
    descriptors: &[GenerationDescriptor],
    saved: &[UnitRecord],
    sources: &HashMap<crate::source::SourceId, AssociationSource>,
) -> Vec<(usize, UnitAssociation)> {
    associate_inner(descriptors, saved, sources)
}

fn associate_inner(
    descriptors: &[GenerationDescriptor],
    saved: &[UnitRecord],
    sources: &HashMap<crate::source::SourceId, AssociationSource>,
) -> Vec<(usize, UnitAssociation)> {
    fn key(descriptor: &GenerationDescriptor) -> AssociationKey {
        AssociationKey {
            owner: descriptor.owner.clone(),
            kind: UnitKind::of_descriptor(descriptor.kind).expect("identity kind"),
            label: descriptor.label.clone(),
            anchor: descriptor.anchor.clone(),
        }
    }
    fn same_claim(descriptor: &GenerationDescriptor, record: &UnitRecord) -> bool {
        if record.source.owner != descriptor.owner
            || Some(record.source.kind) != UnitKind::of_descriptor(descriptor.kind)
        {
            return false;
        }
        match (&record.source.selector, &descriptor.selector) {
            (Some(saved), Some(current)) => saved == current,
            (Some(_), None) => false,
            _ => AssociationKey::of(&record.source) == key(descriptor),
        }
    }
    fn same_descriptor(left: &GenerationDescriptor, right: &GenerationDescriptor) -> bool {
        if left.owner != right.owner || left.kind != right.kind {
            return false;
        }
        match (&left.selector, &right.selector) {
            (Some(left), Some(right)) => left == right,
            _ => key(left) == key(right),
        }
    }
    fn retained(descriptor: &GenerationDescriptor, record: &UnitRecord) -> UnitAssociation {
        UnitAssociation::Retained {
            id: record.id.clone(),
            prompt_changed: sha256_hex(descriptor.prompt.as_deref().unwrap_or_default().as_bytes())
                != record.contract.prompt_sha256,
        }
    }
    let identity = descriptors
        .iter()
        .enumerate()
        .filter(|(_, descriptor)| {
            descriptor.has_generation_identity && UnitKind::of_descriptor(descriptor.kind).is_some()
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let live_paths = sources
        .values()
        .map(|source| source.path.as_str())
        .collect::<HashSet<_>>();
    let mut id_counts = HashMap::new();
    for record in saved {
        *id_counts.entry(record.id.as_str()).or_insert(0usize) += 1;
    }
    let mut outcomes = Vec::new();
    for &index in &identity {
        let descriptor = &descriptors[index];
        let source = sources.get(&descriptor.span.file);
        let current_count = identity
            .iter()
            .filter(|&&other| same_descriptor(descriptor, &descriptors[other]))
            .count();
        let claims = saved
            .iter()
            .filter(|record| same_claim(descriptor, record))
            .collect::<Vec<_>>();
        let candidates = claims
            .iter()
            .map(|record| record.id.clone())
            .collect::<Vec<_>>();
        let eligible = claims
            .iter()
            .copied()
            .filter(|record| {
                if id_counts.get(record.id.as_str()) != Some(&1) {
                    return false;
                }
                if let Some(source) = source {
                    if source.path != record.source.path
                        && live_paths.contains(record.source.path.as_str())
                    {
                        return false;
                    }
                }
                if let Some(region) = &record.source.region {
                    let conflicting_region =
                        claims.iter().any(|claim| match &claim.source.region {
                            Some(other) => {
                                other.container != region.container
                                    || other.sha256 != region.sha256
                                    || other.count != region.count
                            }
                            None => true,
                        });
                    return !conflicting_region
                        && descriptor.region.as_ref() == Some(region)
                        && source.is_none_or(|source| {
                            source.path == record.source.path
                                || !live_paths.contains(record.source.path.as_str())
                        })
                        && identity
                            .iter()
                            .filter(|&&other| {
                                same_descriptor(descriptor, &descriptors[other])
                                    && descriptors[other].region.as_ref() == Some(region)
                            })
                            .count()
                            == 1;
                }
                if current_count == 1 && claims.len() == 1 {
                    // A current anonymous interval needs a captured certificate, never
                    // conversion of an old unique binding into an ordinal guess.
                    return descriptor.region.is_none();
                }
                // Legacy explicit-location evidence remains readable. New records use
                // local certificates, so unrelated source edits do not lose binding.
                record.source.selector.is_none()
                    && source.is_some_and(|source| {
                        record.source.path == source.path
                            && record.source.revision == source.revision
                            && record.source.start == descriptor.span.start
                            && record.source.end == descriptor.span.end
                    })
            })
            .collect::<Vec<_>>();
        let association = if eligible.len() == 1 {
            retained(descriptor, eligible[0])
        } else if claims.is_empty() {
            UnitAssociation::New
        } else {
            UnitAssociation::Ambiguous { candidates }
        };
        outcomes.push((index, association));
    }
    // One group cannot satisfy two source slots even if certificates were copied.
    let mut retained_counts = HashMap::new();
    for (_, association) in &outcomes {
        if let UnitAssociation::Retained { id, .. } = association {
            *retained_counts.entry(id.clone()).or_insert(0usize) += 1;
        }
    }
    for (_, association) in &mut outcomes {
        if let UnitAssociation::Retained { id, .. } = association {
            if retained_counts.get(id).is_some_and(|count| *count > 1) {
                *association = UnitAssociation::Ambiguous {
                    candidates: vec![id.clone()],
                };
            }
        }
    }
    let retained_ids = outcomes
        .iter()
        .filter_map(|(_, association)| match association {
            UnitAssociation::Retained { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    for (index, association) in &mut outcomes {
        if matches!(association, UnitAssociation::New) {
            let descriptor = &descriptors[*index];
            let mut displaced = saved
                .iter()
                .filter(|record| {
                    // Owner names can change during a move or app/package rename.
                    // The caller already qualifies this collection by output root;
                    // unmatched same-kind output there still needs reconciliation.
                    Some(record.source.kind) == UnitKind::of_descriptor(descriptor.kind)
                        && !retained_ids.contains(&record.id)
                })
                .map(|record| record.id.clone())
                .collect::<Vec<_>>();
            displaced.sort_by(|left, right| left.as_str().cmp(right.as_str()));
            displaced.dedup();
            if !displaced.is_empty() {
                *association = UnitAssociation::Ambiguous {
                    candidates: displaced,
                };
            }
        }
        if let UnitAssociation::Ambiguous { candidates } = association {
            candidates.sort_by(|left, right| left.as_str().cmp(right.as_str()));
            candidates.dedup();
        }
    }
    outcomes
}

/// Allocate 128 OS-random bits, independent of branch-local tracked counters.
/// Entropy failure returns before any binding/output mutation.
pub fn try_next_unit_id(used: &HashSet<String>) -> Result<GenerationUnitId, String> {
    loop {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("cannot allocate generation identity: {error}"))?;
        let candidate = format!(
            "g-{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        if !used.contains(&candidate) {
            return Ok(GenerationUnitId(candidate));
        }
    }
}

/// Existing callers fail closed at their tool-error panic boundary on unavailable entropy.
pub fn next_unit_id(used: &HashSet<String>) -> GenerationUnitId {
    try_next_unit_id(used).expect("OS entropy is required to allocate a generation identity")
}

/// List the unit IDs already tracked under `<root>/can.generated/`.
/// Missing root means no saved units. Unreadable or malformed membership must
/// not make existing output disappear and authorize fresh generation.
pub fn scan_unit_ids(root: &Path) -> Result<Vec<String>, String> {
    let dir = root.join(GENERATED_DIR);
    match std::fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot inspect {}: {error}", dir.display())),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(format!("{} must be a regular directory", dir.display()));
        }
        Ok(_) => {}
    }
    let mut ids = Vec::new();
    for entry in
        std::fs::read_dir(&dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("cannot inspect {}: {e}", entry.path().display()))?;
        if kind.is_file() {
            continue; // Ordinary documentation may accompany the unit directories.
        }
        if !kind.is_dir() || kind.is_symlink() {
            return Err(format!(
                "saved group {} must be a regular directory",
                entry.path().display()
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "saved group name is not UTF-8".to_string())?;
        GenerationUnitId::parse(&name)?;
        ids.push(name);
    }
    ids.sort();
    Ok(ids)
}

/// Explicit bind target: an existing saved ID, or a fresh one.
///
/// `New` is the copy answer: a copied definition or inline unit binds with
/// `new=true` and receives its own ID and output group; it never shares
/// mutable implementation ownership with its source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindTarget {
    Existing(GenerationUnitId),
    New,
}

/// Explicit reconciliation of one inspected source location.
///
/// The caller supplies the inspected location (`path`, byte span) and the
/// source `revision` it inspected. The revision is checked against the
/// current revision before anything is re-associated: a stale selector is
/// rejected, never applied to moved bytes.
#[derive(Debug, Clone)]
pub struct BindRequest {
    pub path: String,
    pub revision: String,
    pub start: u32,
    pub end: u32,
    /// Fresh association evidence for the inspected location.
    pub source: SourceAssociation,
    /// Fresh contract refs for the inspected location.
    pub contract: UnitContract,
    pub target: BindTarget,
}

/// Bind failure: stale selectors, unknown IDs, and kind mismatches all
/// refuse; the saved group is left intact for every failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// The inspected revision no longer matches the current source bytes.
    /// Re-inspect the location and retry with the current revision.
    StaleSelector { expected: String, actual: String },
    /// No saved record carries the requested existing ID.
    UnknownUnit { id: GenerationUnitId },
    /// OS entropy was unavailable; no binding has been written.
    AllocationFailed { detail: String },
    /// The saved unit's kind differs (a trait group cannot become style).
    /// Rebind to an ID of the same kind, or bind `new=true`.
    KindMismatch {
        id: GenerationUnitId,
        expected: UnitKind,
        actual: UnitKind,
    },
}

impl std::fmt::Display for BindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StaleSelector { expected, actual } => write!(
                f,
                "stale bind selector: inspected revision `{expected}` does not match current `{actual}`; re-inspect the source location"
            ),
            Self::AllocationFailed { detail } => f.write_str(detail),
            Self::UnknownUnit { id } => {
                write!(f, "no saved unit `{id}`; bind `new=true` for a fresh ID")
            }
            Self::KindMismatch {
                id,
                expected,
                actual,
            } => write!(
                f,
                "saved unit `{id}` is a {} group, not {}; bind a same-kind ID or `new=true`",
                actual.as_str(),
                expected.as_str()
            ),
        }
    }
}

impl std::error::Error for BindError {}

/// Apply an explicit bind against the tracked records.
///
/// On success the returned record is the new association to persist to
/// `can.generated/<id>/unit.json` (persistence itself is the caller's,
/// lease-coordinated step under BGI-04). Existing binds refresh the
/// location/revision evidence and contract refs while preserving the
/// original output fingerprints and provenance. New binds allocate a
/// fresh ID with `Bound` provenance and empty original outputs: the unit
/// has no generated bytes yet.
pub fn apply_bind(
    saved: &[UnitRecord],
    request: &BindRequest,
    current_revision: &str,
) -> Result<UnitRecord, BindError> {
    if request.revision != current_revision {
        return Err(BindError::StaleSelector {
            expected: request.revision.clone(),
            actual: current_revision.to_string(),
        });
    }
    match &request.target {
        BindTarget::Existing(id) => {
            let prior = saved
                .iter()
                .find(|r| r.id == *id)
                .ok_or_else(|| BindError::UnknownUnit { id: id.clone() })?;
            if prior.source.kind != request.source.kind {
                return Err(BindError::KindMismatch {
                    id: id.clone(),
                    expected: request.source.kind,
                    actual: prior.source.kind,
                });
            }
            Ok(UnitRecord {
                abi_version: UNIT_ABI_VERSION,
                id: id.clone(),
                source: SourceAssociation {
                    revision: current_revision.to_string(),
                    ..request.source.clone()
                },
                contract: request.contract.clone(),
                original: prior.original.clone(),
                provenance: prior.provenance.clone(),
            })
        }
        BindTarget::New => {
            let used: HashSet<String> = saved.iter().map(|r| r.id.as_str().to_string()).collect();
            let id =
                try_next_unit_id(&used).map_err(|detail| BindError::AllocationFailed { detail })?;
            Ok(UnitRecord {
                abi_version: UNIT_ABI_VERSION,
                id,
                source: SourceAssociation {
                    revision: current_revision.to_string(),
                    ..request.source.clone()
                },
                contract: request.contract.clone(),
                original: OriginalOutput {
                    prompt_sha256: request.contract.prompt_sha256.clone(),
                    files: BTreeMap::new(),
                },
                provenance: UnitProvenance {
                    origin: ProvenanceOrigin::Bound,
                    runner: None,
                    model: None,
                    note: Some("explicit bind; no generated output yet".to_string()),
                },
            })
        }
    }
}

/// Handwritten legacy `unit.json` shape (pre-v1 `handwritten-script`
/// records kept under `can.generated/<id>/` by draft tooling).
///
/// Only the identity-bearing fields are read: `unit_id` (must equal the
/// directory ID), `kind` (legacy `style`/`then_view` spellings), the
/// optional `label`, and the contract refs (`prompt`/`target`/`profile`).
/// The legacy `owner` is a stale package hint, never identity: adoption
/// always stamps the live sought key instead.
#[derive(Debug, Clone, serde::Deserialize)]
struct LegacyUnitDoc {
    unit_id: Option<String>,
    kind: String,
    label: Option<String>,
    prompt: Option<String>,
    target: Option<String>,
    profile: Option<String>,
    origin: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

/// Recognize the untouched draft record family without treating malformed
/// modern records as legacy. Only an explicit bind may migrate these records.
pub fn is_legacy_bind_record(text: &str, id: &GenerationUnitId) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    value.is_object()
        && ["id", "contract", "original", "provenance"]
            .iter()
            .all(|field| value.get(field).is_none())
        && value["unit_id"].as_str() == Some(id.as_str())
        && value["abi_version"].as_u64() == Some(UNIT_ABI_VERSION as u64)
        && value["draft"].as_bool() == Some(true)
        && matches!(
            value["origin"].as_str(),
            Some("handwritten-draft" | "handwritten-script")
        )
        && (value.get("source").is_none() || value["source"].is_string())
        && matches!(
            value["kind"].as_str(),
            Some("given_trait" | "given_keyword" | "style" | "then_view")
        )
        && serde_json::from_str::<LegacyUnitDoc>(text).is_ok()
}

/// Explicitly bind existing draft bytes to a selected live declaration. Source
/// owns the current contract; legacy prompts and files remain adoption evidence.
/// Returned canonical primary copies join the caller's existing bind journal.
pub fn bind_legacy_unit(
    dir: &Path,
    id: &GenerationUnitId,
    source: &SourceAssociation,
    contract: &UnitContract,
) -> Result<(UnitRecord, Vec<SavedFile>), String> {
    ensure_bind_group_has_no_symlink(dir)?;
    let text = std::fs::read_to_string(dir.join(UNIT_FILE)).map_err(|error| error.to_string())?;
    if !is_legacy_bind_record(&text, id) {
        return Err("saved record is not a recognized handwritten legacy unit".into());
    }
    let doc: LegacyUnitDoc = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    if !legacy_kind_matches_source(&doc, source) {
        return Err(format!(
            "legacy {} unit `{id}` does not match selected {} {:?}",
            doc.kind,
            source.kind.as_str(),
            source.label
        ));
    }
    let mut files = Vec::new();
    collect_current_files(dir, dir, &mut files)?;
    let copied_primary = maybe_copy_server_primary(source, &mut files);
    ensure_required_primary_outputs(source, &files, id)?;
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    let original_prompt = sha256_hex(doc.prompt.as_deref().unwrap_or_default().as_bytes());
    let record = UnitRecord {
        abi_version: UNIT_ABI_VERSION,
        id: id.clone(),
        source: source.clone(),
        contract: contract.clone(),
        original: OriginalOutput {
            prompt_sha256: original_prompt,
            files: files
                .iter()
                .map(|file| (file.rel_path.clone(), file.sha256.clone()))
                .collect(),
        },
        provenance: UnitProvenance {
            origin: ProvenanceOrigin::Adopted,
            runner: doc.provider,
            model: doc.model,
            note: Some(format!(
                "explicit bind adopted legacy {}; existing files preserved{}",
                doc.origin.as_deref().unwrap_or("handwritten draft"),
                if copied_primary {
                    "; implementation.js copied byte-for-byte from server.js"
                } else {
                    ""
                }
            )),
        },
    };
    Ok((record, files))
}

fn ensure_bind_group_has_no_symlink(dir: &Path) -> Result<(), String> {
    for path in [dir.to_path_buf(), dir.join(UNIT_FILE)] {
        if std::fs::symlink_metadata(&path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("legacy binding requires its own regular saved group and record".into());
        }
    }
    Ok(())
}

fn legacy_kind_matches_source(doc: &LegacyUnitDoc, source: &SourceAssociation) -> bool {
    match doc.kind.as_str() {
        "given_trait" => match doc.label {
            Some(_) => source.kind == UnitKind::NamedTrait && doc.label == source.label,
            None => source.kind == UnitKind::InlineTrait,
        },
        "given_keyword" => {
            source.kind == UnitKind::Keyword && doc.label.is_some() && doc.label == source.label
        }
        "then_view" => {
            source.kind == UnitKind::View && doc.label.is_some() && doc.label == source.label
        }
        "style" => match doc.label {
            Some(_) => source.kind == UnitKind::Style && doc.label == source.label,
            None => matches!(
                source.kind,
                UnitKind::StyleInline | UnitKind::ViewStyleInline
            ),
        },
        _ => false,
    }
}

fn maybe_copy_server_primary(source: &SourceAssociation, files: &mut Vec<SavedFile>) -> bool {
    if matches!(
        source.kind,
        UnitKind::Keyword | UnitKind::View | UnitKind::NamedTrait | UnitKind::InlineTrait
    ) && !files
        .iter()
        .any(|file| file.rel_path == "implementation.js")
        && let Some(server) = files.iter().find(|file| file.rel_path == "server.js")
    {
        files.push(SavedFile {
            rel_path: "implementation.js".into(),
            bytes: server.bytes.clone(),
            sha256: server.sha256.clone(),
        });
        return true;
    }
    false
}

fn ensure_required_primary_outputs(
    source: &SourceAssociation,
    files: &[SavedFile],
    id: &GenerationUnitId,
) -> Result<(), String> {
    for required in source.kind.required_primary_outputs() {
        if !files.iter().any(|file| file.rel_path == *required) {
            return Err(format!(
                "legacy unit `{id}` is missing required output `{required}`"
            ));
        }
    }
    Ok(())
}

/// Bind-time evidence for a legacy adoption: the inspected source
/// location. Identity comes from the live sought key, never from these.
#[derive(Debug, Clone)]
pub struct AdoptEvidence {
    pub path: String,
    pub revision: String,
    pub start: u32,
    pub end: u32,
}

/// Adopt one handwritten legacy record for the live sought key.
///
/// The legacy directory keeps its files; the returned record carries the
/// sought key as its source association with [`ProvenanceOrigin::Adopted`]
/// provenance, and the returned files are the directory's current bytes
/// (fingerprinted as the adopted originals). Kind and label must match
/// the sought key exactly; anything else stays invisible so unbound units
/// keep reporting `no saved unit is bound`. Legacy `then_view` units
/// carry the handwritten renderer as `server.js`, which the view lowering
/// accepts as the adopted module. Nothing is written to disk: persist
/// with `can gen bind`.
pub fn adopt_legacy_unit(
    dir: &Path,
    id: &GenerationUnitId,
    key: &AssociationKey,
    evidence: &AdoptEvidence,
) -> Result<(UnitRecord, Vec<SavedFile>), String> {
    let text = std::fs::read_to_string(dir.join(UNIT_FILE))
        .map_err(|err| format!("cannot read legacy record: {err}"))?;
    let doc: LegacyUnitDoc =
        serde_json::from_str(&text).map_err(|err| format!("not a legacy unit record: {err}"))?;
    if doc.unit_id.as_deref() != Some(id.as_str()) {
        return Err(format!(
            "legacy record identity `{}` does not match its directory `{id}`",
            doc.unit_id.as_deref().unwrap_or("-"),
        ));
    }
    let kind = match doc.kind.as_str() {
        "style" => UnitKind::Style,
        "then_view" => UnitKind::View,
        _ => {
            return Err(format!(
                "legacy kind `{}` has no v1 unit kind; prepare generation for the unit",
                doc.kind,
            ));
        }
    };
    if kind != key.kind || doc.label != key.label {
        return Err(format!(
            "legacy {} unit `{id}` is not bound to {}",
            kind.as_str(),
            key.describe(),
        ));
    }
    let mut files = Vec::new();
    collect_current_files(dir, dir, &mut files)?;
    files.sort_by(|a: &SavedFile, b: &SavedFile| a.rel_path.cmp(&b.rel_path));
    // Required primaries gate adoption, by presence never by hash: style
    // units produce CSS; legacy views carry the handwritten renderer as
    // `server.js` instead of the v1 `implementation.js` module name.
    let wanted: &[&str] = match kind {
        UnitKind::View => &["server.js"],
        _ => kind.required_primary_outputs(),
    };
    let missing: Vec<&&str> = wanted
        .iter()
        .filter(|name| !files.iter().any(|f| &f.rel_path == *name))
        .collect();
    if !missing.is_empty() {
        let names: Vec<String> = missing.into_iter().map(|n| format!("`{n}`")).collect();
        return Err(format!(
            "legacy {} unit `{id}` is missing required output {}; prepare generation for the unit",
            kind.as_str(),
            names.join(", "),
        ));
    }
    let prompt_sha256 = sha256_hex(doc.prompt.as_deref().unwrap_or_default().as_bytes());
    let record = UnitRecord {
        abi_version: UNIT_ABI_VERSION,
        id: id.clone(),
        source: SourceAssociation {
            owner: key.owner.clone(),
            kind,
            label: key.label.clone(),
            anchor: key.anchor.clone(),
            selector: None,
            region: None,
            path: evidence.path.clone(),
            revision: evidence.revision.clone(),
            start: evidence.start,
            end: evidence.end,
        },
        contract: UnitContract {
            target: doc.target,
            profile: doc.profile,
            prompt_sha256: prompt_sha256.clone(),
            signature: None,
        },
        original: OriginalOutput {
            prompt_sha256,
            files: files
                .iter()
                .map(|f| (f.rel_path.clone(), f.sha256.clone()))
                .collect(),
        },
        provenance: UnitProvenance {
            origin: ProvenanceOrigin::Adopted,
            runner: None,
            model: None,
            note: Some(
                "adopted in-memory from a handwritten-script legacy record at compile; persist with `can gen bind`"
                    .to_string(),
            ),
        },
    };
    Ok((record, files))
}

/// One current file of a saved group: live bytes plus their fresh
/// fingerprint, kept distinct from the original fingerprints in `unit.json`.
#[derive(Debug, Clone)]
pub struct SavedFile {
    /// Unit-relative path with `/` separators (e.g. `style.css`).
    pub rel_path: String,
    /// Current bytes, exactly as read (direct edits are build inputs).
    pub bytes: Vec<u8>,
    /// SHA-256 over the current bytes.
    pub sha256: String,
}

/// An intaken saved group: its association record plus current files.
#[derive(Debug, Clone)]
pub struct SavedGroup {
    pub record: UnitRecord,
    /// Unit directory (`<root>/can.generated/<id>/`).
    pub dir: PathBuf,
    /// Current files sorted by unit-relative path.
    pub files: Vec<SavedFile>,
}

/// The generation or reconciliation action a missing/incompatible group needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntakeAction {
    /// Prepare generation for the unit (no saved group to build).
    Generate,
    /// Reconcile the association explicitly (`bind` the inspected source).
    Bind,
    /// Adopt drifted source/interface output deterministically (`adopt`).
    Adopt,
}

impl IntakeAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::Bind => "bind",
            Self::Adopt => "adopt",
        }
    }
}

/// A saved-group intake failure: the exact unit plus its action.
/// Intake never regenerates, repairs, or consults providers on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntakeIssue {
    /// Opaque unit ID, or the `owner/kind/label` key when unbound.
    pub unit: String,
    pub action: IntakeAction,
    pub detail: String,
}

impl std::fmt::Display for IntakeIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "unit `{}`: {} (action: {})",
            self.unit,
            self.detail,
            self.action.as_str()
        )
    }
}

impl std::error::Error for IntakeIssue {}

/// Read one saved group: `unit.json` plus the owning unit's current files.
///
/// Only the unit's own directory is read (recursively, so owned assets
/// travel with their unit). No provider, configuration, login, or ambient
/// state is consulted; the `$` marker never launches a CLI here. Current
/// bytes are returned as-is with fresh fingerprints; the original
/// fingerprints in `unit.json` are preserved untouched for comparison.
///
/// Intake is exactly the owning unit: symlinks (which could escape to
/// outside bytes) refuse with the affected unit, and the kind's required
/// primary outputs must be present before the group is usable. Fresh
/// preparation groups (a `bound` record with no recorded original outputs)
/// may still be allocated without outputs; direct edits remain current
/// inputs and historical optional assets are never required.
pub fn read_saved_group(root: &Path, id: &GenerationUnitId) -> Result<SavedGroup, IntakeIssue> {
    let dir = root.join(GENERATED_DIR).join(id.as_str());
    if std::fs::symlink_metadata(&dir)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(IntakeIssue {
            unit: id.as_str().to_string(),
            action: IntakeAction::Bind,
            detail: format!(
                "saved group at {} is a symlink; intake reads only the owning unit's own directory — reconcile with an explicit bind",
                dir.display()
            ),
        });
    }
    let record_path = dir.join(UNIT_FILE);
    if std::fs::symlink_metadata(&record_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(IntakeIssue {
            unit: id.as_str().to_string(),
            action: IntakeAction::Bind,
            detail: format!(
                "saved group `{id}` record at {} is a symlink; intake reads only the owning unit's own files — reconcile with an explicit bind",
                record_path.display()
            ),
        });
    }
    let text = std::fs::read_to_string(&record_path).map_err(|_| IntakeIssue {
        unit: id.as_str().to_string(),
        action: IntakeAction::Generate,
        detail: format!(
            "no saved group at {}; prepare generation for the unit",
            record_path.display()
        ),
    })?;
    let record = UnitRecord::parse(&text, id).map_err(|reason| IntakeIssue {
        unit: id.as_str().to_string(),
        action: IntakeAction::Bind,
        detail: format!("saved group is incompatible: {reason}; reconcile with an explicit bind"),
    })?;
    let mut files = Vec::new();
    collect_current_files(&dir, &dir, &mut files).map_err(|reason| IntakeIssue {
        unit: id.as_str().to_string(),
        action: IntakeAction::Bind,
        detail: format!("saved group at {} is unreadable: {reason}", dir.display()),
    })?;
    files.sort_by(|a: &SavedFile, b: &SavedFile| a.rel_path.cmp(&b.rel_path));
    let fresh_preparation =
        record.provenance.origin == ProvenanceOrigin::Bound && record.original.files.is_empty();
    if !fresh_preparation {
        let missing: Vec<&&str> = record
            .source
            .kind
            .required_primary_outputs()
            .iter()
            .filter(|wanted| !files.iter().any(|f| &f.rel_path == *wanted))
            .collect();
        if !missing.is_empty() {
            let names: Vec<&str> = missing.into_iter().copied().collect();
            return Err(IntakeIssue {
                unit: id.as_str().to_string(),
                action: IntakeAction::Generate,
                detail: format!(
                    "saved group `{id}` ({}) is missing required primary output {}; prepare generation for the unit",
                    record.source.kind.as_str(),
                    names
                        .iter()
                        .map(|n| format!("`{n}`"))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            });
        }
    }
    Ok(SavedGroup { record, dir, files })
}

fn collect_current_files(
    dir: &Path,
    unit_dir: &Path,
    out: &mut Vec<SavedFile>,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|err| format!("cannot list {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("cannot read entry: {err}"))?;
        let path = entry.path();
        // DirEntry file types never follow symlinks: a link reads as a
        // link, never as its target.
        let file_type = entry
            .file_type()
            .map_err(|err| format!("cannot stat entry: {err}"))?;
        if file_type.is_symlink() {
            let rel = rel_path(&path, unit_dir)?;
            return Err(format!(
                "entry `{rel}` is a symlink; saved groups hold only regular files owned by the unit — reconcile with an explicit bind"
            ));
        }
        if file_type.is_dir() {
            collect_current_files(&path, unit_dir, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if path.file_name().is_some_and(|n| n == UNIT_FILE) && path.parent() == Some(unit_dir) {
            continue; // unit.json is parsed, not a current input file.
        }
        let rel = rel_path(&path, unit_dir)?;
        let bytes =
            std::fs::read(&path).map_err(|err| format!("cannot read {}: {err}", path.display()))?;
        let sha256 = sha256_hex(&bytes);
        out.push(SavedFile {
            rel_path: rel,
            bytes,
            sha256,
        });
    }
    Ok(())
}

/// Unit-relative `/`-joined path for a collected entry.
fn rel_path(path: &Path, unit_dir: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(unit_dir)
        .map_err(|_| "unit path escapes its directory".to_string())?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

/// Intake every associated unit: retained associations load their saved
/// group; new and ambiguous associations become exact-unit issues with
/// their generation or reconciliation action.
pub fn intake_associated(
    root: &Path,
    descriptors: &[GenerationDescriptor],
    associations: &[(usize, UnitAssociation)],
) -> (Vec<SavedGroup>, Vec<IntakeIssue>) {
    let mut groups = Vec::new();
    let mut issues = Vec::new();
    for (index, association) in associations {
        let descriptor = &descriptors[*index];
        let key = format!(
            "{}/{}/{}",
            descriptor.owner,
            UnitKind::of_descriptor(descriptor.kind)
                .map(|k| k.as_str())
                .unwrap_or("?"),
            descriptor.label.as_deref().unwrap_or("-")
        );
        match association {
            UnitAssociation::Retained { id, .. } => match read_saved_group(root, id) {
                Ok(group) => groups.push(group),
                Err(issue) => issues.push(issue),
            },
            UnitAssociation::New => issues.push(IntakeIssue {
                unit: key,
                action: IntakeAction::Generate,
                detail: "no saved group is associated; prepare generation for the unit".to_string(),
            }),
            UnitAssociation::Ambiguous { candidates } => {
                let detail = if candidates.is_empty() {
                    "copied or relocated unit shares its association key; bind each copy explicitly (copies take new IDs)".to_string()
                } else {
                    format!(
                        "association key matches saved units {}; bind the inspected source explicitly",
                        candidates
                            .iter()
                            .map(GenerationUnitId::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                issues.push(IntakeIssue {
                    unit: key,
                    action: IntakeAction::Bind,
                    detail,
                });
            }
        }
    }
    (groups, issues)
}

