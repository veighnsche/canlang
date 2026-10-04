//! Source manager: canonical identities, content hashes and line index.
//!
//! Every tool in the `can` binary (check, compile, lint, fmt, LSP) shares
//! these types. Byte offsets are canonical; [`LineIndex`] converts to
//! human and LSP positions.

use std::collections::HashMap;

/// Canonical identity of one source text within a [`SourceDb`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SourceId(pub u32);

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
}

impl SourceDb {
    /// Create an empty database.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a source text, returning its canonical id.
    ///
    /// Adding the same path twice replaces the entry and returns a fresh id;
    /// previously issued ids keep denoting their original bytes.
    pub fn add(&mut self, path: String, text: String) -> SourceId {
        let sha256 = sha256_hex(text.as_bytes());
        let id = SourceId(self.sources.len() as u32);
        self.by_path.insert(path.clone(), id);
        self.sources.push(Source { path, text, sha256 });
        id
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
#[derive(Debug, Clone)]
pub struct LineIndex {
    /// Byte offset where each 0-based line starts. Always starts with 0.
    starts: Vec<u32>,
}

impl LineIndex {
    /// Build the index. Lines end at `\n`; a preceding `\r` belongs to the
    /// line break for column purposes (CRLF counts as one break).
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0u32];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push((i + 1) as u32);
            }
        }
        Self { starts }
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
/// Dependency-free implementation (FIPS 180-4) so content hashes never
/// depend on the platform hasher, which is not stable across versions.
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().enumerate().take(16) {
            *word = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (h, v) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *h = h.wrapping_add(v);
        }
    }

    let mut out = String::with_capacity(64);
    for word in h {
        out.push_str(&format!("{word:08x}"));
    }
    out
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
