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

/// Lowercase hex SHA-256 of `bytes`.
///
/// Hash the exact bytes without text or newline normalization.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;

    format!("{:x}", sha2::Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Multi-block input (> 55 bytes).
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // Padding boundaries, verified against `sha256sum`: 55 bytes pad to
        // one block, 56 and 64 bytes need two.
        assert_eq!(
            sha256_hex(&[b'a'; 55]),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            sha256_hex(&[b'c'; 56]),
            "f6c7b87acd114115d66897c8cb138c16a8b886673d1b93737f4918be472ea878"
        );
        assert_eq!(
            sha256_hex(&[b'b'; 64]),
            "a0fab1377f49a759b57f63318262ebe89fabfc990e8e93ceac2984561482b9d4"
        );
    }

    #[test]
    fn sha256_preserves_exact_bytes_and_hex_contract() {
        // Expected answers generated independently with Python hashlib.
        let binary: Vec<u8> = (0..=255).collect();
        let cases: &[(&[u8], &str)] = &[
            (
                &binary,
                "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
            ),
            (
                "Can é 🦀\n".as_bytes(),
                "0a021c1915ff753cc720fc774db726f07ef76618d8f1161d1b91dbad72a60b99",
            ),
            (
                b"Can\r\nsource\r\n",
                "6d2d22400bccb766467fb7b3741f9f5c412edbcb4c1cc012fac4d8f80261c65e",
            ),
            (
                b"Can\nsource\n",
                "259f86950e13f8df6daca23cf20310cbc441ad6594d4393eb3fa36a0ede94f07",
            ),
        ];
        for (bytes, expected) in cases {
            let actual = sha256_hex(bytes);
            assert_eq!(&actual, expected);
            assert_eq!(actual.len(), 64);
            assert!(
                actual
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            );
        }
    }

    #[test]
    fn sha256_padding_and_large_input() {
        // Fixed byte-boundary answers from Python hashlib, not the adapter.
        let cases = [
            (
                55,
                "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
            ),
            (
                56,
                "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
            ),
            (
                63,
                "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34",
            ),
            (
                64,
                "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
            ),
            (
                65,
                "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0",
            ),
            (
                127,
                "c57e9278af78fa3cab38667bef4ce29d783787a2f731d4e12200270f0c32320a",
            ),
            (
                128,
                "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e",
            ),
            (
                129,
                "c12cb024a2e5551cca0e08fce8f1c5e314555cc3fef6329ee994a3db752166ae",
            ),
            (
                1000000,
                "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
            ),
        ];
        for (length, expected) in cases {
            assert_eq!(sha256_hex(&vec![b'a'; length]), expected);
        }
    }

    #[test]
    fn line_index_lf_crlf() {
        let text = "ab\r\ncde\nf";
        let idx = LineIndex::new(text);
        assert_eq!(idx.line_col(text, 0), (1, 1));
        assert_eq!(idx.line_col(text, 2), (1, 3)); // at \r: line 1 end
        assert_eq!(idx.line_col(text, 3), (1, 3)); // at \n: \r not a column
        assert_eq!(idx.line_col(text, 4), (2, 1));
        assert_eq!(idx.line_col(text, 8), (3, 1));
        assert_eq!(idx.line_col(text, 99), (3, 2)); // clamped past end
        // LSP excludes the CRLF break from the character offset.
        assert_eq!(idx.to_lsp(text, 3, true), (0, 2));
        // Bare \r is a lexer error, but locations stay accurate.
        let bare = "a\rb";
        let bare_idx = LineIndex::new(bare);
        assert_eq!(bare_idx.line_col(bare, 2), (1, 3));
        assert_eq!(bare_idx.to_lsp(bare, 2, true), (0, 2));
    }

    #[test]
    fn line_index_lsp_utf16() {
        let text = "a\u{1F600}b\ncd";
        let idx = LineIndex::new(text);
        // 'a' is 1 byte, emoji is 4 bytes / 2 UTF-16 units.
        assert_eq!(idx.to_lsp(text, 1, true), (0, 1));
        assert_eq!(idx.to_lsp(text, 5, true), (0, 3));
        assert_eq!(idx.to_lsp(text, 5, false), (0, 5));
        assert_eq!(idx.to_lsp(text, 7, true), (1, 0));
        // Offset splitting the emoji clamps back to its start.
        assert_eq!(idx.to_lsp(text, 3, true), (0, 1));
    }

    #[test]
    fn source_db_ids_stable() {
        let mut db = SourceDb::new();
        let a = db.add("a.can".into(), "app A\n".into());
        let b = db.add("b.can".into(), "app B\n".into());
        assert_ne!(db.get(a).unwrap().sha256, db.get(b).unwrap().sha256);
        let a2 = db.add("a.can".into(), "app A2\n".into());
        assert_ne!(a, a2);
        assert_eq!(db.get(a).unwrap().text, "app A\n");
        assert_eq!(db.lookup("a.can"), Some(a2));
    }
}
