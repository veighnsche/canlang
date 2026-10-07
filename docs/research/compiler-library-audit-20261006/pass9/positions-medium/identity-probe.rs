use std::path::{Path,PathBuf};
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


pub fn offset_at_position(text: &str, line: u32, character: u32) -> Option<u32> {
    let mut offset = 0usize;
    for _ in 0..line {
        let newline = text[offset..].find('\n')?;
        offset += newline + 1;
    }
    let line_end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
    let mut line_text = &text[offset..line_end];
    if text.as_bytes().get(line_end) == Some(&b'\n') {
        line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
    }
    let mut walked_units = 0u32;
    let mut walked_bytes = 0usize;
    for c in line_text.chars() {
        let units = c.len_utf16() as u32;
        if walked_units + units > character {
            break;
        }
        walked_units += units;
        walked_bytes += c.len_utf8();
    }
    Some((offset + walked_bytes) as u32)
}
pub fn portable_source_id(path: &str, root: &Path) -> String {
    let candidate = Path::new(path);
    let joined: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if let Ok(canonical_path) = std::fs::canonicalize(&joined) {
        if let Ok(rel) = canonical_path.strip_prefix(&canonical_root) {
            return rel_to_portable(rel);
        }
        return format!("external:{}", canonical_path.to_string_lossy());
    }
    let normalized = lexical_normalize(&joined);
    if let Ok(rel) = normalized.strip_prefix(&canonical_root) {
        return rel_to_portable(rel);
    }
    let lexical_root = lexical_normalize(root);
    if let Ok(rel) = normalized.strip_prefix(&lexical_root) {
        return rel_to_portable(rel);
    }
    format!("external:{}", normalized.to_string_lossy())
}
fn lexical_normalize(path: &Path) -> PathBuf {
    use std::path::Component::{CurDir, ParentDir};
    let mut out = PathBuf::new();
    for component in path.components() {
        if component == CurDir {
            continue;
        }
        if component == ParentDir {
            if matches!(out.components().next_back(), Some(std::path::Component::ParentDir)) || !out.pop() {
                out.push("..");
            }
            continue;
        }
        out.push(component.as_os_str());
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}
fn rel_to_portable(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
fn main(){
println!("{} | {} => {}","existing.can","/private/tmp/canlang-pass9-positions-medium/identity-real",portable_source_id("existing.can",Path::new("/private/tmp/canlang-pass9-positions-medium/identity-real")));
println!("{} | {} => {}","existing.can","/private/tmp/canlang-pass9-positions-medium/identity-link",portable_source_id("existing.can",Path::new("/private/tmp/canlang-pass9-positions-medium/identity-link")));
println!("{} | {} => {}","missing.can","/private/tmp/canlang-pass9-positions-medium/identity-real",portable_source_id("missing.can",Path::new("/private/tmp/canlang-pass9-positions-medium/identity-real")));
println!("{} | {} => {}","/private/tmp/canlang-pass9-positions-medium/identity-link/missing.can","/private/tmp/canlang-pass9-positions-medium/identity-real",portable_source_id("/private/tmp/canlang-pass9-positions-medium/identity-link/missing.can",Path::new("/private/tmp/canlang-pass9-positions-medium/identity-real")));
println!("{} | {} => {}","../../x","../missing",portable_source_id("../../x",Path::new("../missing")));
println!("{} | {} => {}","../../x","../../missing",portable_source_id("../../x",Path::new("../../missing")));
println!("{} | {} => {}","../x","/private/tmp/canlang-pass9-positions-medium/missing/root",portable_source_id("../x",Path::new("/private/tmp/canlang-pass9-positions-medium/missing/root")));
println!("{} | {} => {}","/../../x","/missing/root",portable_source_id("/../../x",Path::new("/missing/root")));
}