//! V3 source maps from emitted JS lines to `.can` byte spans (lane-01 codegen, PR6).
//!
//! [`build`] maps every emitted line to its [`Span`](crate::source::Span)
//! through the standard base64 VLQ `mappings` encoding, plus `sources`,
//! `sourcesContent` and `names`. [`decode_mappings`] parses `mappings`
//! back so tests can prove each segment resolves to a real span.

use crate::codegen::js::JsLine;
use crate::diagnostic::push_json_str;
use crate::source::{LineIndex, SourceDb};
use std::fmt::Write as _;

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
pub fn build(module_path: &str, db: &SourceDb, lines: &[JsLine]) -> SourceMap {
    let mut indexes: Vec<LineIndex> = Vec::new();
    let mut sources = Vec::new();
    let mut sources_content = Vec::new();
    for (_id, source) in db.iter() {
        indexes.push(LineIndex::new(&source.text));
        sources.push(source.path.clone());
        sources_content.push(Some(source.text.clone()));
    }
    let mut names: Vec<String> = Vec::new();
    let mut mappings = String::new();
    let mut prev_src = 0i64;
    let mut prev_line = 0i64;
    let mut prev_col = 0i64;
    let mut prev_name = 0i64;
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            mappings.push(';');
        }
        let src = line.span.file.0 as i64;
        let (src_line, src_col) = match db.get(line.span.file) {
            Some(source) => {
                let (l, c) =
                    indexes[line.span.file.0 as usize].line_col(&source.text, line.span.start);
                ((l as i64) - 1, (c as i64) - 1)
            }
            None => (0, 0),
        };
        encode_vlq(&mut mappings, 0);
        encode_vlq(&mut mappings, src - prev_src);
        encode_vlq(&mut mappings, src_line - prev_line);
        encode_vlq(&mut mappings, src_col - prev_col);
        prev_src = src;
        prev_line = src_line;
        prev_col = src_col;
        if let Some(name) = &line.name {
            let index = match names.iter().position(|n| n == name) {
                Some(index) => index,
                None => {
                    names.push(name.clone());
                    names.len() - 1
                }
            };
            encode_vlq(&mut mappings, index as i64 - prev_name);
            prev_name = index as i64;
        }
    }
    SourceMap {
        file: module_path.to_string(),
        sources,
        sources_content,
        names,
        mappings,
    }
}

/// Render a source map as compact JSON.
pub fn to_json(map: &SourceMap) -> String {
    let mut out = String::new();
    out.push_str("{\"version\":3,\"file\":");
    push_json_str(&mut out, &map.file);
    out.push_str(",\"sources\":[");
    for (i, source) in map.sources.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_json_str(&mut out, source);
    }
    out.push_str("],\"sourcesContent\":[");
    for (i, content) in map.sources_content.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match content {
            Some(text) => push_json_str(&mut out, text),
            None => out.push_str("null"),
        }
    }
    out.push_str("],\"names\":[");
    for (i, name) in map.names.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_json_str(&mut out, name);
    }
    out.push_str("],\"mappings\":");
    push_json_str(&mut out, &map.mappings);
    out.push('}');
    out
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
/// Returns an error string naming the failure; the encoder only emits
/// 4- and 5-field segments but the decoder accepts 1- and 5-field forms.
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
                let fields = decode_segment(segment)?;
                if fields.is_empty() || fields.len() == 2 || fields.len() == 3 || fields.len() > 5 {
                    return Err(format!("bad segment field count {}", fields.len()));
                }
                gen_col += fields[0];
                let mut decoded = DecodedSegment {
                    gen_col,
                    src: None,
                    src_line: None,
                    src_col: None,
                    name: None,
                };
                if fields.len() >= 4 {
                    prev_src += fields[1];
                    prev_line += fields[2];
                    prev_col += fields[3];
                    decoded.src = Some(prev_src);
                    decoded.src_line = Some(prev_line);
                    decoded.src_col = Some(prev_col);
                }
                if fields.len() == 5 {
                    prev_name += fields[4];
                    decoded.name = Some(prev_name);
                }
                segments.push(decoded);
            }
        }
        lines.push(segments);
    }
    Ok(lines)
}

/// Base64 alphabet for VLQ.
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Append one VLQ value.
fn encode_vlq(out: &mut String, value: i64) {
    let mut vlq = if value < 0 {
        ((-value) as u64) * 2 + 1
    } else {
        (value as u64) * 2
    };
    loop {
        let digit = (vlq & 0x1f) as usize;
        vlq >>= 5;
        if vlq == 0 {
            let _ = out.write_char(BASE64[digit] as char);
            break;
        }
        let _ = out.write_char(BASE64[digit | 0x20] as char);
    }
}

/// Decode one segment into its fields.
fn decode_segment(segment: &str) -> Result<Vec<i64>, String> {
    let mut fields = Vec::new();
    let mut value = 0i64;
    let mut shift = 0u32;
    let mut started = false;
    for byte in segment.bytes() {
        let digit = BASE64
            .iter()
            .position(|b| *b == byte)
            .ok_or_else(|| format!("bad VLQ character {byte}"))? as i64;
        started = true;
        value |= (digit & 0x1f) << shift;
        shift += 5;
        if digit & 0x20 == 0 {
            let signed = if value & 1 == 1 {
                -(value >> 1)
            } else {
                value >> 1
            };
            fields.push(signed);
            value = 0;
            shift = 0;
        }
    }
    if !started {
        return Err("empty segment".to_string());
    }
    if shift != 0 {
        return Err("truncated VLQ value".to_string());
    }
    Ok(fields)
}
