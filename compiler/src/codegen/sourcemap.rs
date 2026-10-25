//! V3 source maps from emitted JS lines to `.can` byte spans (lane-01 codegen, PR6).
//!
//! [`build`] maps every emitted line to its [`Span`](crate::source::Span)
//! through the standard base64 VLQ `mappings` encoding, plus `sources`,
//! `sourcesContent` and `names`. [`decode_mappings`] parses `mappings`
//! back so tests can prove each segment resolves to a real span.

use crate::codegen::js::JsLine;
use crate::diagnostic::Diagnostic;
use crate::source::{LineIndex, SourceDb, SourceId, Span};
use serde::{Deserialize, Serialize, Serializer};

/// Minimal V3 source map (the `SourceMap` shape of `artifact.ts`).
#[derive(Debug, Clone)]
pub struct SourceMap {
    /// Generated file name (`ArtifactModule.path`).
    pub file: String,
    /// Source paths in [`SourceDb`] id order.
    pub sources: Vec<String>,
    /// Source texts in id order (`None` renders `null`).
    pub sources_content: Vec<Option<String>>,
    /// Deduplicated names in first-appearance order.
    pub names: Vec<String>,
    /// VLQ `mappings`, one `;`-separated line per emitted line.
    pub mappings: String,
}

/// Build a source map for one emitted module.
///
/// Every entry of `lines` becomes one mappings line with a single segment
/// at generated column 0. Source indexes are [`SourceDb`] ids; names
/// deduplicate in first-appearance order.
///
/// # Panics
/// Panics deterministically on numeric source-map capacity exhaustion. Use
/// [`try_build`] to receive an `E6012` diagnostic instead.
pub fn build(module_path: &str, db: &SourceDb, lines: &[JsLine]) -> SourceMap {
    try_build(module_path, db, lines)
        .unwrap_or_else(|diagnostic| panic!("cannot build source map: {}", diagnostic.message))
}

/// Build a source map, rejecting unrepresentable numeric fields with `E6012`.
///
/// The pinned library reserves `u32::MAX` as its absent source/name id, so
/// their tables admit at most `u32::MAX` entries. Zero-based coordinates admit
/// `u32::MAX` itself. Row/name diagnostics retain the supplied line span,
/// including intentionally unmapped spans; source-count errors use the first
/// source id that the library cannot represent.
pub fn try_build(
    module_path: &str,
    db: &SourceDb,
    lines: &[JsLine],
) -> Result<SourceMap, Diagnostic> {
    if db.len() > u32::MAX as usize {
        return Err(capacity_error(
            "source table exceeds the source-map library id range",
            Span::new(SourceId(u32::MAX), 0, 0),
        ));
    }
    if let Some(last_row) = lines.len().checked_sub(1)
        && u32::try_from(last_row).is_err()
    {
        return Err(capacity_error(
            "generated row exceeds the source-map coordinate range",
            lines[last_row].span,
        ));
    }
    let mut builder = sourcemap::SourceMapBuilder::new(Some(module_path));
    let mut indexes = Vec::new();
    let mut sources = Vec::new();
    let mut sources_content = Vec::new();
    let mut source_ids = Vec::new();
    for (id, source) in db.iter() {
        // Builder paths deduplicate. Register only private, collision-free IDs,
        // then replace the display path without changing the library ID. This
        // preserves immutable snapshots even when their authored paths match.
        let library_id = builder.add_source(&format!("can-source:{}", id.0));
        builder.set_source(library_id, &source.path);
        source_ids.push(library_id);
        indexes.push(LineIndex::new(&source.text));
        sources.push(source.path.clone());
        sources_content.push(Some(source.text.clone()));
    }
    let mut names: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        // Admit coordinates before interning names or mutating mappings.
        let generated_row = u32::try_from(i).map_err(|_| {
            capacity_error(
                "generated row exceeds the source-map coordinate range",
                line.span,
            )
        })?;
        let (source_id, src_line, src_col) = match db.get(line.span.file) {
            Some(source) => {
                // Can's consumer profile uses source byte columns; LineIndex
                // owns CRLF and byte-offset interpretation.
                let (l, c) =
                    indexes[line.span.file.0 as usize].line_col(&source.text, line.span.start);
                let src_line = u32::try_from(l - 1).map_err(|_| {
                    capacity_error(
                        "source row exceeds the source-map coordinate range",
                        line.span,
                    )
                })?;
                let src_col = u32::try_from(c - 1).map_err(|_| {
                    capacity_error(
                        "source byte column exceeds the source-map coordinate range",
                        line.span,
                    )
                })?;
                (
                    Some(source_ids[line.span.file.0 as usize]),
                    src_line,
                    src_col,
                )
            }
            None => (None, 0, 0),
        };
        // Ordinary interning stays in the library. Only at its sentinel boundary
        // scan our existing wire table, admitting reuse without adding a new id.
        let name_id = if let Some(name) = &line.name {
            let id = if names.len() == u32::MAX as usize {
                match names.iter().position(|existing| existing == name) {
                    Some(id) => u32::try_from(id).expect("existing name id is below the sentinel"),
                    None => {
                        return Err(capacity_error(
                            "name table exceeds the source-map library id range",
                            line.span,
                        ));
                    }
                }
            } else {
                builder.add_name(name)
            };
            if id as usize == names.len() {
                names.push(name.clone());
            }
            Some(id)
        } else {
            None
        };
        // A missing SourceId is an explicit unmapped generated segment.
        builder.add_raw(
            generated_row,
            0,
            src_line,
            src_col,
            source_id,
            name_id,
            false,
        );
    }
    // The library exposes encoded mappings through its JSON writer only. This
    // one-time build adapter serializes the library map and projects just the
    // mappings string. Contents stay in our typed map, so this temporary does
    // not copy or encode all source text; final artifact serialization borrows it.
    #[derive(Deserialize)]
    struct EncodedMappings {
        mappings: String,
    }
    let mut encoded = Vec::new();
    builder
        .into_sourcemap()
        .to_writer(&mut encoded)
        .expect("in-memory library source-map encoding is infallible");
    let mappings = serde_json::from_slice::<EncodedMappings>(&encoded)
        .expect("library source-map output contains encoded mappings")
        .mappings;
    Ok(SourceMap {
        file: module_path.to_string(),
        sources,
        sources_content,
        names,
        mappings,
    })
}

fn capacity_error(message: &str, span: Span) -> Diagnostic {
    Diagnostic::error("E6012", message.to_string(), span)
}

impl Serialize for SourceMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Declaration order is the stable compiler artifact wire order.
        #[derive(Serialize)]
        struct MapWire<'a> {
            version: u32,
            file: &'a str,
            sources: &'a [String],
            #[serde(rename = "sourcesContent")]
            sources_content: &'a [Option<String>],
            names: &'a [String],
            mappings: &'a str,
        }
        MapWire {
            version: 3,
            file: &self.file,
            sources: &self.sources,
            sources_content: &self.sources_content,
            names: &self.names,
            mappings: &self.mappings,
        }
        .serialize(serializer)
    }
}

/// Render a source map with the shared compact JSON string-escape policy.
pub fn to_json(map: &SourceMap) -> String {
    crate::json::to_compact_string(map).expect("source-map DTO serialization is infallible")
}

/// BGI-11 identity map over one saved generated module: maps locate
/// actual saved JavaScript, never invented positions inside the
/// natural-language prompt. Each saved line maps to itself in the
/// saved file as its own source; the owning `.can` intent travels as
/// a separate owner link (see `artifact::CanOwnerLink`).
#[derive(Debug, Clone)]
pub struct SavedJsMap {
    /// Saved module path as staged (e.g. `can.generated/u3/server.js`).
    pub js_path: String,
    /// Lowercase hex SHA-256 over the exact saved bytes mapped here.
    pub js_sha256: String,
    /// Identity source map: generated line N maps to saved line N.
    pub map: SourceMap,
}

/// Build the identity map for one saved module's exact bytes.
///
/// Deterministic: the same bytes always produce the same map. Empty
/// input maps to empty mappings. Lines split on `\n`; a trailing
/// `\r` belongs to its line break for column purposes, matching
/// [`LineIndex`].
pub fn build_saved_js_map(js_path: &str, js_text: &str) -> SavedJsMap {
    let js_sha256 = crate::source::sha256_hex(js_text.as_bytes());
    let mut db = SourceDb::new();
    let id = db.add(js_path.to_string(), js_text.to_string());
    let mut lines = Vec::new();
    if !js_text.is_empty() {
        // One identity line per saved line: text without a trailing
        // newline still ends a final line, and text ending in `\n`
        // ends no further line.
        let mut start = 0u32;
        for part in js_text.split_inclusive('\n') {
            lines.push(JsLine {
                line: 0,
                span: Span::new(id, start, start),
                name: None,
            });
            start += part.len() as u32;
        }
    }
    let map = build(js_path, &db, &lines);
    SavedJsMap {
        js_path: js_path.to_string(),
        js_sha256,
        map,
    }
}

/// One decoded mappings segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedSegment {
    /// Generated column.
    pub gen_col: i64,
    /// Source index, if the segment has one.
    pub src: Option<i64>,
    /// 0-based source line, if the segment has one.
    pub src_line: Option<i64>,
    /// 0-based source column, if the segment has one.
    pub src_col: Option<i64>,
    /// Name index, if the segment has one.
    pub name: Option<i64>,
}

/// Decode VLQ `mappings` into per-line segments.
///
/// A test compatibility view, not a full source-map parser: preserve authored
/// row order and empty rows, accepting 1-, 4-, and 5-field segments. Numeric
/// VLQ parsing belongs to the library; row/delta accumulation belongs here.
/// Malformed numeric errors use library detail strings.
pub fn decode_mappings(mappings: &str) -> Result<Vec<Vec<DecodedSegment>>, String> {
    let mut lines = Vec::new();
    let mut prev_src = 0i64;
    let mut prev_line = 0i64;
    let mut prev_col = 0i64;
    let mut prev_name = 0i64;
    if mappings.is_empty() {
        return Ok(lines);
    }
    for line in mappings.split(';') {
        let mut segments = Vec::new();
        let mut gen_col = 0i64;
        if !line.is_empty() {
            for segment in line.split(',') {
                validate_vlq_envelope(segment)?;
                let fields = sourcemap::vlq::parse_vlq_segment(segment)
                    .map_err(|error| error.to_string())?;
                if fields.is_empty() || fields.len() == 2 || fields.len() == 3 || fields.len() > 5 {
                    return Err(format!("bad segment field count {}", fields.len()));
                }
                gen_col = add_delta(gen_col, fields[0])?;
                let mut decoded = DecodedSegment {
                    gen_col,
                    src: None,
                    src_line: None,
                    src_col: None,
                    name: None,
                };
                if fields.len() >= 4 {
                    prev_src = add_delta(prev_src, fields[1])?;
                    prev_line = add_delta(prev_line, fields[2])?;
                    prev_col = add_delta(prev_col, fields[3])?;
                    decoded.src = Some(prev_src);
                    decoded.src_line = Some(prev_line);
                    decoded.src_col = Some(prev_col);
                }
                if fields.len() == 5 {
                    prev_name = add_delta(prev_name, fields[4])?;
                    decoded.name = Some(prev_name);
                }
                segments.push(decoded);
            }
        }
        lines.push(segments);
    }
    Ok(lines)
}

fn add_delta(value: i64, delta: i64) -> Result<i64, String> {
    value
        .checked_add(delta)
        .ok_or_else(|| "mapping delta overflow".to_string())
}

/// Defensive envelope for the library numeric parser: it can accept an invalid
/// alphabet byte before a terminator, and its signed accumulator can overflow.
/// This checks alphabet and representable encoded width without decoding values.
fn validate_vlq_envelope(segment: &str) -> Result<(), String> {
    let mut width = 0;
    for byte in segment.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("bad VLQ character {byte}")),
        };
        width += 1;
        if width > 13 || (width == 13 && digit & 31 > 7) {
            return Err("VLQ value overflow".to_string());
        }
        if digit & 32 == 0 {
            width = 0;
        }
    }
    Ok(())
}
