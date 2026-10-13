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

use crate::analysis::generation::{GenerationDescriptor, GenerationKind};
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
/// Allocation is sequential `u<N>` over the tracked `can.generated/<id>/`
/// directories (see [`next_unit_id`]); the spelling carries no meaning.
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
    associate_inner(descriptors, saved, None)
}

/// Associate with current source evidence, honoring explicit binds.
///
/// Behaves exactly like [`associate`] except under duplicate keys: when a
/// descriptor's current location (this pass's path/revision plus the
/// descriptor's own span) exactly equals one saved record's captured bind
/// evidence (`source.path/revision/start/end` for the same key), that
/// descriptor retains that record's ID. Changed or stale source never
/// guesses: a revision or span that no longer matches refuses with
/// [`UnitAssociation::Ambiguous`] as before, as do two records claiming
/// the same location.
pub fn associate_with_source(
    descriptors: &[GenerationDescriptor],
    saved: &[UnitRecord],
    source: &AssociationSource,
) -> Vec<(usize, UnitAssociation)> {
    associate_inner(descriptors, saved, Some(source))
}

fn associate_inner(
    descriptors: &[GenerationDescriptor],
    saved: &[UnitRecord],
    source: Option<&AssociationSource>,
) -> Vec<(usize, UnitAssociation)> {
    let mut saved_by_key: HashMap<AssociationKey, Vec<&UnitRecord>> = HashMap::new();
    for record in saved {
        saved_by_key
            .entry(AssociationKey::of(&record.source))
            .or_default()
            .push(record);
    }
    let mut key_counts: HashMap<AssociationKey, usize> = HashMap::new();
    let mut keyed: Vec<(usize, AssociationKey)> = Vec::new();
    for (index, descriptor) in descriptors.iter().enumerate() {
        if UnitKind::of_descriptor(descriptor.kind).is_none() {
            continue;
        }
        let key = AssociationKey {
            owner: descriptor.owner.clone(),
            kind: UnitKind::of_descriptor(descriptor.kind).expect("identity kind checked above"),
            label: descriptor.label.clone(),
            anchor: descriptor.anchor.clone(),
        };
        *key_counts.entry(key.clone()).or_default() += 1;
        keyed.push((index, key));
    }
    /// An explicit bind honored for one descriptor: exactly one same-key
    /// record captured this exact source revision/location.
    fn bound_match<'s>(
        descriptors: &[GenerationDescriptor],
        group: &[&'s UnitRecord],
        index: usize,
        source: &AssociationSource,
    ) -> Option<&'s UnitRecord> {
        let span = &descriptors[index].span;
        let mut hit: Option<&UnitRecord> = None;
        for record in group {
            if record.source.path == source.path
                && record.source.revision == source.revision
                && record.source.start == span.start
                && record.source.end == span.end
            {
                if hit.is_some() {
                    return None;
                }
                hit = Some(record);
            }
        }
        hit
    }
    fn retained(
        descriptors: &[GenerationDescriptor],
        index: usize,
        record: &UnitRecord,
    ) -> UnitAssociation {
        let current = sha256_hex(
            descriptors[index]
                .prompt
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        UnitAssociation::Retained {
            id: record.id.clone(),
            prompt_changed: current != record.contract.prompt_sha256,
        }
    }
    keyed
        .into_iter()
        .map(|(index, key)| {
            let association = if key_counts.get(&key).copied().unwrap_or(0) > 1 {
                // A copied definition shares its whole key: refuse reuse,
                // unless an explicit bind captured this exact location.
                let group: &[&UnitRecord] =
                    saved_by_key.get(&key).map(Vec::as_slice).unwrap_or(&[]);
                match source.and_then(|s| bound_match(descriptors, group, index, s)) {
                    Some(record) => retained(descriptors, index, record),
                    None => {
                        let mut candidates: Vec<GenerationUnitId> =
                            group.iter().map(|r| r.id.clone()).collect();
                        candidates.sort_by(|a, b| a.as_str().cmp(b.as_str()));
                        UnitAssociation::Ambiguous { candidates }
                    }
                }
            } else {
                match saved_by_key.get(&key).map(Vec::as_slice) {
                    Some([record]) => retained(descriptors, index, record),
                    Some(many) => {
                        // Duplicate saved records: refuse to pick one,
                        // unless an explicit bind captured this exact location.
                        match source.and_then(|s| bound_match(descriptors, many, index, s)) {
                            Some(record) => retained(descriptors, index, record),
                            None => {
                                let mut candidates: Vec<GenerationUnitId> =
                                    many.iter().map(|r| r.id.clone()).collect();
                                candidates.sort_by(|a, b| a.as_str().cmp(b.as_str()));
                                UnitAssociation::Ambiguous { candidates }
                            }
                        }
                    }
                    None => UnitAssociation::New,
                }
            };
            (index, association)
        })
        .collect()
}

/// Allocate the smallest fresh `u<N>` ID outside `used`.
///
/// Sequential allocation keeps IDs opaque (no meaning) and deterministic
/// under tests. Lease-coordinated allocation across writers is BGI-04's
/// protocol; this pure step only picks the spelling.
pub fn next_unit_id(used: &HashSet<String>) -> GenerationUnitId {
    let mut n: u32 = 1;
    loop {
        let candidate = format!("u{n}");
        if !used.contains(&candidate) {
            return GenerationUnitId(candidate);
        }
        n += 1;
    }
}

/// List the unit IDs already tracked under `<root>/can.generated/`.
/// Missing root means no saved units, not an error.
pub fn scan_unit_ids(root: &Path) -> Vec<String> {
    let dir = root.join(GENERATED_DIR);
    let entries = std::fs::read_dir(&dir)
        .map(|r| r.collect::<Vec<_>>())
        .unwrap_or_default();
    let mut ids: Vec<String> = entries
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| GenerationUnitId::parse(name).is_ok())
        .collect();
    ids.sort();
    ids
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
            let id = next_unit_id(&used);
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

/// Synthesize an empty bound group for an unbound inline style seek.
///
/// Inline `$` prompts (`StyleInline`, `ViewStyleInline`) are generation
/// requests, not references to existing units: when no saved unit can be
/// adopted for the sought key, the seek lowers as an unstyled bound
/// group instead of failing coverage. The association is the live sought
/// key, provenance is [`ProvenanceOrigin::Bound`] with no generated
/// output yet (the pack stage emits an empty sheet for such groups), and
/// the unit id is deterministically derived from the key so repeated
/// compilations stage identically. Named styles, views, traits, and
/// keywords never synthesize: their missing units stay hard failures.
pub fn synthesize_inline_unit(
    key: &AssociationKey,
    evidence: &AdoptEvidence,
) -> Option<(UnitRecord, Vec<SavedFile>)> {
    if !matches!(key.kind, UnitKind::StyleInline | UnitKind::ViewStyleInline) {
        return None;
    }
    let digest = sha256_hex(key.describe().as_bytes());
    let id = GenerationUnitId(format!("inline-{}", &digest[..16]));
    let record = UnitRecord {
        abi_version: UNIT_ABI_VERSION,
        id: id.clone(),
        source: SourceAssociation {
            owner: key.owner.clone(),
            kind: key.kind,
            label: key.label.clone(),
            anchor: key.anchor.clone(),
            path: evidence.path.clone(),
            revision: evidence.revision.clone(),
            start: evidence.start,
            end: evidence.end,
        },
        contract: UnitContract {
            target: None,
            profile: None,
            prompt_sha256: sha256_hex("".as_bytes()),
            signature: None,
        },
        original: OriginalOutput {
            prompt_sha256: sha256_hex("".as_bytes()),
            files: BTreeMap::new(),
        },
        provenance: UnitProvenance {
            origin: ProvenanceOrigin::Bound,
            runner: None,
            model: None,
            note: Some(
                "inline generation request with no saved unit lowers unstyled; generate the unit for real CSS"
                    .to_string(),
            ),
        },
    };
    Some((record, Vec::new()))
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

#[cfg(test)]
mod legacy_adopt_tests {
    use super::*;
    use std::path::PathBuf;

    fn legacy_dir(tag: &str, id: &str, doc: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "can-legacy-adopt-{}-{}-{}",
            std::process::id(),
            tag,
            id
        ));
        let unit = dir.join(id);
        std::fs::create_dir_all(&unit).unwrap();
        std::fs::write(unit.join(UNIT_FILE), doc).unwrap();
        for (name, bytes) in files {
            std::fs::write(unit.join(name), bytes).unwrap();
        }
        dir
    }

    fn style_key() -> AssociationKey {
        AssociationKey {
            owner: "CanDo".to_string(),
            kind: UnitKind::Style,
            label: Some("TodoWorkspace".to_string()),
            anchor: "CanDo:style:TodoWorkspace:".to_string(),
        }
    }

    fn evidence() -> AdoptEvidence {
        AdoptEvidence {
            path: "draft/apps/CanDo/CanDo.can".to_string(),
            revision: "rev".to_string(),
            start: 0,
            end: 10,
        }
    }

    const STYLE_DOC: &str = r#"{"unit_id":"u1","abi_version":1,"kind":"style","draft":true,"origin":"handwritten-script","owner":"todo","label":"TodoWorkspace","prompt":"Readable surfaces.","target":"browser-css","profile":"frontend"}"#;

    #[test]
    fn legacy_style_adopts_for_matching_key() {
        let root = legacy_dir("ok", "u1", STYLE_DOC, &[("style.css", ".a{color:red}")]);
        let id = GenerationUnitId::parse("u1").unwrap();
        let dir = root.join("u1");
        let (record, files) = adopt_legacy_unit(&dir, &id, &style_key(), &evidence()).unwrap();
        assert_eq!(record.source.owner, "CanDo");
        assert_eq!(record.source.kind, UnitKind::Style);
        assert_eq!(record.source.label.as_deref(), Some("TodoWorkspace"));
        assert_eq!(record.provenance.origin, ProvenanceOrigin::Adopted);
        assert_eq!(record.contract.target.as_deref(), Some("browser-css"));
        assert_eq!(
            record.contract.prompt_sha256,
            sha256_hex("Readable surfaces.".as_bytes())
        );
        assert!(record.original.files.contains_key("style.css"));
        assert!(files.iter().any(|f| f.rel_path == "style.css"));
        assert!(!files.iter().any(|f| f.rel_path == UNIT_FILE));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_adopt_refuses_label_mismatch() {
        let root = legacy_dir("mismatch", "u1", STYLE_DOC, &[("style.css", ".a{}")]);
        let id = GenerationUnitId::parse("u1").unwrap();
        let mut key = style_key();
        key.label = Some("Other".to_string());
        let err = adopt_legacy_unit(&root.join("u1"), &id, &key, &evidence()).unwrap_err();
        assert!(err.contains("not bound"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_adopt_refuses_unknown_kind_and_identity_skew() {
        let root = legacy_dir(
            "kind",
            "u1",
            r#"{"unit_id":"u1","kind":"given_trait","label":"T"}"#,
            &[("contributions.can", "x")],
        );
        let id = GenerationUnitId::parse("u1").unwrap();
        let key = AssociationKey {
            owner: "A".to_string(),
            kind: UnitKind::NamedTrait,
            label: Some("T".to_string()),
            anchor: String::new(),
        };
        let err = adopt_legacy_unit(&root.join("u1"), &id, &key, &evidence()).unwrap_err();
        assert!(err.contains("no v1 unit kind"), "{err}");
        let skewed = legacy_dir(
            "skew",
            "u1",
            r#"{"unit_id":"u2","kind":"style","label":"TodoWorkspace"}"#,
            &[("style.css", ".a{}")],
        );
        let err =
            adopt_legacy_unit(&skewed.join("u1"), &id, &style_key(), &evidence()).unwrap_err();
        assert!(err.contains("does not match its directory"), "{err}");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&skewed).ok();
    }

    #[test]
    fn inline_seeks_synthesize_bound_while_named_refuse() {
        let inline_key = AssociationKey {
            owner: "CanDo".to_string(),
            kind: UnitKind::StyleInline,
            label: Some("Card".to_string()),
            anchor: "CanDo:style-inline:Card:Card".to_string(),
        };
        let (record, files) = synthesize_inline_unit(&inline_key, &evidence()).unwrap();
        assert_eq!(record.source.owner, "CanDo");
        assert_eq!(record.source.kind, UnitKind::StyleInline);
        assert_eq!(record.provenance.origin, ProvenanceOrigin::Bound);
        assert!(record.original.files.is_empty());
        assert!(files.is_empty());
        assert!(record.id.as_str().starts_with("inline-"));
        let again = synthesize_inline_unit(&inline_key, &evidence()).unwrap().0;
        assert_eq!(again.id, record.id);
        assert!(synthesize_inline_unit(&style_key(), &evidence()).is_none());
    }

    #[test]
    fn legacy_adopt_refuses_missing_primary() {
        let root = legacy_dir("noprim", "u1", STYLE_DOC, &[("notes.txt", "hi")]);
        let id = GenerationUnitId::parse("u1").unwrap();
        let err = adopt_legacy_unit(&root.join("u1"), &id, &style_key(), &evidence()).unwrap_err();
        assert!(err.contains("missing required output"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
