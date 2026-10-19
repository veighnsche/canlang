//! Source manager: canonical identities, content hashes and line index.
//!
//! Every tool in the `can` binary (check, compile, lint, fmt, LSP) shares
//! these types. Byte offsets are canonical; [`LineIndex`] converts to
//! human and LSP positions.

use std::collections::HashMap;
use std::sync::Arc;

/// Canonical identity of one source text within a [`SourceDb`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SourceId(pub u32);

/// A source cannot be represented by the compiler's byte offsets or ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceAdmissionError {
    /// The source's byte length exceeds the largest representable offset.
    TextTooLong { bytes: u64 },
    /// Every representable source id has already been issued.
    NextIdExhausted,
}

impl std::fmt::Display for SourceAdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TextTooLong { bytes } => write!(
                f,
                "source has {bytes} bytes; byte offsets support at most {} bytes",
                u32::MAX
            ),
            Self::NextIdExhausted => write!(f, "no source ids remain in the u32 range"),
        }
    }
}

impl std::error::Error for SourceAdmissionError {}

/// Admit a source byte length into the intrinsic byte-offset range.
/// A length equal to `u32::MAX` is representable and accepted.
pub fn admit_source_len(bytes: u64) -> Result<u32, SourceAdmissionError> {
    u32::try_from(bytes).map_err(|_| SourceAdmissionError::TextTooLong { bytes })
}

/// One immutable source text with its canonical content hash.
#[derive(Debug, Clone)]
pub struct Source {
    /// Workspace-relative display path, e.g. `examples/TeamTasks.can`.
    pub path: String,
    /// Full source text, exactly as read (LF or CRLF preserved).
    pub text: String,
    /// Lowercase hex SHA-256 over the UTF-8 bytes of [`Source::text`].
    pub sha256: String,
}

/// Owns every source text of one analysis session.
///
/// Sources are append-only: a [`SourceId`] always denotes the same bytes.
#[derive(Debug, Default)]
pub struct SourceDb {
    sources: Vec<Source>,
    by_path: HashMap<String, SourceId>,
    // A fresh allocation for every Default/new owner, stable across moves/adds.
    identity: Arc<()>,
    /// One frozen source/output closure shared by checking and emission.
    pub(crate) generation: Option<Arc<crate::analysis::generation_store::FrozenGeneration>>,
}

impl SourceDb {
    /// Create an empty database.
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn identity(&self) -> &Arc<()> {
        &self.identity
    }

    /// Add a source text, returning its canonical id.
    ///
    /// Adding the same path twice replaces the entry and returns a fresh id;
    /// previously issued ids keep denoting their original bytes.
    ///
    /// # Panics
    /// Panics when the text length or next id exceeds the intrinsic u32 range.
    /// Use [`SourceDb::try_add`] for fallible source intake.
    pub fn add(&mut self, path: String, text: String) -> SourceId {
        self.try_add(path, text)
            .unwrap_or_else(|error| panic!("cannot add source: {error}"))
    }

    /// Add a representable source, preserving prior immutable snapshots.
    /// Rejects an excessive byte length or exhausted id range before hashing
    /// or changing source storage and the latest-path lookup.
    pub fn try_add(
        &mut self,
        path: String,
        text: String,
    ) -> Result<SourceId, SourceAdmissionError> {
        admit_source_len(text.len() as u64)?;
        let id = SourceId(
            u32::try_from(self.sources.len()).map_err(|_| SourceAdmissionError::NextIdExhausted)?,
        );
        let sha256 = sha256_hex(text.as_bytes());
        self.by_path.insert(path.clone(), id);
        self.sources.push(Source { path, text, sha256 });
        Ok(id)
    }

    /// Look up a source by id.
    pub fn get(&self, id: SourceId) -> Option<&Source> {
        self.sources.get(id.0 as usize)
    }

    /// Look up the latest id registered for a path.
    pub fn lookup(&self, path: &str) -> Option<SourceId> {
        self.by_path.get(path).copied()
    }

    /// Source revision selector for generation association: the SHA-256 of
    /// the exact bytes `id` denotes. BGI-02 binds carry this revision so a
    /// stale selector (edited bytes) is rejected before re-association.
    pub fn revision(&self, id: SourceId) -> Option<&str> {
        self.get(id).map(|s| s.sha256.as_str())
    }

    /// Iterate all sources in id order.
    pub fn iter(&self) -> impl Iterator<Item = (SourceId, &Source)> {
        self.sources
            .iter()
            .enumerate()
            .map(|(i, s)| (SourceId(i as u32), s))
    }

    /// Number of sources stored.
    pub fn len(&self) -> usize {
        self.sources.len()
    }

    /// Whether no source has been added.
    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }
}

/// A half-open byte range `[start, end)` inside one source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Span {
    /// Source containing the range.
    pub file: SourceId,
    /// Inclusive start byte offset.
    pub start: u32,
    /// Exclusive end byte offset.
    pub end: u32,
}

impl Span {
    /// Create a span; callers must uphold `start <= end`.
    pub fn new(file: SourceId, start: u32, end: u32) -> Self {
        debug_assert!(start <= end, "span start must not exceed end");
        Self { file, start, end }
    }

    /// Length in bytes. Saturates so an inverted span (debug-only
    /// assertion in [`Span::new`]) cannot wrap in release builds.
    pub fn len(&self) -> u32 {
        self.end.saturating_sub(self.start)
    }

    /// Whether the span is empty.
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

/// Maps byte offsets to line/column positions for one source text.
///
/// Built once per source; queries are `O(log n)` in line count.
/// Position queries must receive the same text used to build the index.
#[derive(Debug, Clone)]
pub struct LineIndex {
    /// Byte offset where each 0-based line starts. Always starts with 0.
    starts: Vec<u32>,
}

impl LineIndex {
    /// Build the index. Lines end at `\n`; a preceding `\r` belongs to the
    /// line break for column purposes (CRLF counts as one break).
    ///
    /// # Panics
    /// Panics when the text length exceeds the intrinsic u32 offset range.
    /// Use [`LineIndex::try_new`] for fallible standalone construction.
    pub fn new(text: &str) -> Self {
        Self::try_new(text).unwrap_or_else(|error| panic!("cannot build line index: {error}"))
    }

    /// Build an index after admitting its text into the byte-offset range.
    pub fn try_new(text: &str) -> Result<Self, SourceAdmissionError> {
        admit_source_len(text.len() as u64)?;
        let mut starts = vec![0u32];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push((i + 1) as u32);
            }
        }
        Ok(Self { starts })
    }

    /// Convert a byte offset to 1-based `(line, column)`.
    ///
    /// The column counts bytes from the line start; a `\r` immediately
    /// before `\n` is not part of either line's columns. Offsets past the
    /// end clamp to the final position.
    pub fn line_col(&self, text: &str, offset: u32) -> (usize, usize) {
        let offset = offset.min(text.len() as u32);
        let line0 = self.starts.partition_point(|&s| s <= offset) - 1;
        let mut col = (offset - self.starts[line0]) as usize + 1;
        // A CRLF line break: the \r is not an addressable column. A bare \r
        // (a lexer error, but locations must stay accurate) counts normally.
        let bytes = text.as_bytes();
        if offset > 0
            && bytes.get(offset as usize - 1) == Some(&b'\r')
            && bytes.get(offset as usize) == Some(&b'\n')
        {
            col = col.saturating_sub(1).max(1);
        }
        (line0 + 1, col)
    }

    /// Convert a byte offset to an LSP position for the negotiated encoding.
    ///
    /// Returns 0-based `(line, character)` where `character` counts UTF-16
    /// code units by default. Pass `utf16=false` for UTF-8 byte units.
    /// Offsets past the end clamp; offsets inside a scalar clamp back to the
    /// scalar start so positions never split a character.
    pub fn to_lsp(&self, text: &str, offset: u32, utf16: bool) -> (u32, u32) {
        let mut offset = offset.min(text.len() as u32) as usize;
        // If offset splits a scalar, back up to its start first so every
        // slice below lands on a char boundary.
        while offset > 0 && !text.is_char_boundary(offset) {
            offset -= 1;
        }
        let line0 = self.starts.partition_point(|&s| s <= offset as u32) - 1;
        let line_start = self.starts[line0] as usize;
        let mut prefix = &text[line_start..offset.max(line_start)];
        // A \r ending the prefix is part of a CRLF break, not a character;
        // a bare \r (lexer error, but locations stay accurate) counts.
        if text.as_bytes().get(offset) == Some(&b'\n') {
            prefix = prefix.strip_suffix('\r').unwrap_or(prefix);
        }
        let character = if utf16 {
            prefix.encode_utf16().count() as u32
        } else {
            prefix.len() as u32
        };
        (line0 as u32, character)
    }
}

/// BGI-04 read-lease hook: snapshot consumed build inputs for compilation.
///
/// Refuses while any run journal is unresolved, takes brief read leases in
/// canonical lock order, and returns immutable copies. Ordinary builds
/// compile this snapshot — never live files — so an in-flight promotion
/// cannot serve a mixed group. Thin wrapper over
/// [`crate::leases::snapshot_inputs`], placed here beside the source intake
/// every build reader already uses.
pub fn snapshot_consumed_inputs(
    root: &std::path::Path,
    holder: &str,
    paths: &[&str],
) -> Result<Vec<crate::leases::ConsumedInput>, crate::leases::LeaseError> {
    crate::leases::snapshot_inputs(root, holder, paths)
}

/// BGI-11 validation input binding: the exact consumed closure one
/// validation run checks, bound to captured inputs and current bytes.
///
/// A validation envelope reports these path/SHA-256 pairs so a later
/// promotion (BGI-12) compares the same bytes the validator consumed.
/// Binding reads files only — no settings, provider, login, model, MCP
/// server, or ambient state is consulted, so a clean checkout with
/// saved files validates with zero AI processes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationInputFile {
    /// Workspace-relative path exactly as the caller named it.
    pub path: String,
    /// Current bytes, exactly as read.
    pub bytes: Vec<u8>,
    /// Lowercase hex SHA-256 over [`ValidationInputFile::bytes`].
    pub sha256: String,
}

/// An immutable validation closure: bound files in caller-sorted order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidationInputs {
    /// Bound files sorted by path, so envelopes are deterministic.
    pub files: Vec<ValidationInputFile>,
}

/// A validation input that could not be bound: the exact path plus why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationInputError {
    /// Path that failed to bind.
    pub path: String,
    /// Why the bind failed (missing, unreadable, not a file).
    pub detail: String,
}

impl std::fmt::Display for ValidationInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "cannot bind validation input `{}`: {}",
            self.path, self.detail
        )
    }
}

impl std::error::Error for ValidationInputError {}

impl ValidationInputs {
    /// Bind `paths` (workspace-relative, resolved under `root`) to their
    /// current bytes. Duplicate paths bind once; entries sort by path.
    /// The first unreadable path fails the whole bind with its exact
    /// path — validation never checks a partial closure silently.
    pub fn bind(root: &std::path::Path, paths: &[String]) -> Result<Self, ValidationInputError> {
        let mut seen = std::collections::BTreeSet::new();
        let mut files = Vec::new();
        for path in paths {
            if !seen.insert(path.clone()) {
                continue;
            }
            let full = root.join(path);
            let bytes = std::fs::read(&full).map_err(|err| ValidationInputError {
                path: path.clone(),
                detail: err.to_string(),
            })?;
            if !full.is_file() {
                return Err(ValidationInputError {
                    path: path.clone(),
                    detail: "not a regular file".to_string(),
                });
            }
            let sha256 = sha256_hex(&bytes);
            files.push(ValidationInputFile {
                path: path.clone(),
                bytes,
                sha256,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Self { files })
    }

    /// SHA-256 of one bound path, if it was bound.
    pub fn sha256_of(&self, path: &str) -> Option<&str> {
        self.files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.sha256.as_str())
    }

    /// Whether the bound bytes at `path` still match `revision`.
    ///
    /// Source/interface drift detection: `revision` is the SHA-256 a
    /// bind or capture recorded, and these are the current bytes.
    /// Unbound paths report drift (nothing consumed matches).
    pub fn drifted(&self, path: &str, revision: &str) -> bool {
        self.sha256_of(path) != Some(revision)
    }
}

/// Lowercase hex SHA-256 of `bytes`.
///
/// Hash the exact bytes without text or newline normalization.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;

    format!("{:x}", sha2::Sha256::digest(bytes))
}

