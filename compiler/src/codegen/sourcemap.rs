//! V3 source maps from emitted JS lines to `.can` byte spans (lane-01 codegen, PR6).
//!
//! [`build`] maps every emitted line to its [`Span`](crate::source::Span)
//! through the standard base64 VLQ `mappings` encoding, plus `sources`,
//! `sourcesContent` and `names`. [`decode_mappings`] parses `mappings`
//! back so tests can prove each segment resolves to a real span.

use crate::codegen::js::JsLine;
use crate::source::{LineIndex, SourceDb};
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
pub fn build(module_path: &str, db: &SourceDb, lines: &[JsLine]) -> SourceMap {
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
        // Always use IDs returned by the library, including empty/repeated names.
        let name_id = line.name.as_ref().map(|name| {
            let id = builder.add_name(name);
            // The builder interns names in first-appearance order. A new ID
            // extends our matching wire table; existing IDs need no scan.
            if id as usize == names.len() {
                names.push(name.clone());
            }
            id
        });
        let (source_id, src_line, src_col) = match db.get(line.span.file) {
            Some(source) => {
                // Can's consumer profile uses source byte columns; LineIndex
                // owns CRLF and byte-offset interpretation.
                let (l, c) =
                    indexes[line.span.file.0 as usize].line_col(&source.text, line.span.start);
                (Some(source_ids[line.span.file.0 as usize]), l - 1, c - 1)
            }
            None => (None, 0, 0),
        };
        // A missing SourceId is an explicit unmapped generated segment.
        builder.add_raw(
            i as u32,
            0,
            src_line as u32,
            src_col as u32,
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
    SourceMap {
        file: module_path.to_string(),
        sources,
        sources_content,
        names,
        mappings,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{SourceId, Span};

    fn line(source: SourceId, start: u32, name: Option<&str>) -> JsLine {
        // build uses emitted vector order, not this advisory line number.
        JsLine {
            line: 99,
            span: Span::new(source, start, start),
            name: name.map(str::to_owned),
        }
    }

    #[test]
    fn duplicate_paths_keep_snapshot_ids_and_byte_columns() {
        let mut db = SourceDb::new();
        let first = db.add("same.can".into(), "é😀x\r\ny".into());
        let second = db.add("same.can".into(), "other\nz".into());
        let map = build(
            "out.mjs",
            &db,
            &[
                line(first, 6, Some("")),
                line(second, 6, Some("later")),
                line(first, 9, Some("")),
            ],
        );
        assert_eq!(map.sources, ["same.can", "same.can"]);
        assert_eq!(
            map.sources_content,
            [Some("é😀x\r\ny".into()), Some("other\nz".into())]
        );
        assert_eq!(map.names, ["", "later"]);
        let decoded = decode_mappings(&map.mappings).unwrap();
        assert_eq!(
            (decoded[0][0].src, decoded[0][0].src_col),
            (Some(0), Some(6))
        );
        assert_eq!(
            (decoded[1][0].src, decoded[1][0].src_line),
            (Some(1), Some(1))
        );
        assert_eq!(
            (
                decoded[2][0].src,
                decoded[2][0].src_line,
                decoded[2][0].name
            ),
            (Some(0), Some(1), Some(0))
        );
        assert!(!to_json(&map).contains("can-source:"));
    }

    #[test]
    fn empty_and_missing_sources_keep_names_and_generated_rows() {
        let db = SourceDb::new();
        let empty = build("empty.mjs", &db, &[]);
        assert!(empty.sources.is_empty());
        assert_eq!(empty.mappings, "");
        let map = build(
            "missing.mjs",
            &db,
            &[
                line(SourceId(17), 6, Some("first")),
                line(SourceId(18), 0, Some("first")),
                line(SourceId(17), 0, Some("")),
            ],
        );
        assert_eq!(map.names, ["first", ""]);
        assert_eq!(map.mappings, "A;A;A");
        for row in decode_mappings(&map.mappings).unwrap() {
            assert_eq!(row.len(), 1);
            assert_eq!(row[0].src, None);
        }
    }

    #[test]
    fn wide_name_table_reuses_first_appearance_ids_and_preserves_output() {
        let mut db = SourceDb::new();
        let source = db.add("wide.can".into(), "é😀\r\nvalue".into());
        let names: Vec<String> = std::iter::once(String::new())
            .chain((1..256).map(|i| format!("name_{i}")))
            .collect();
        let mut lines = Vec::new();
        for name in &names {
            lines.push(line(source, 6, Some(name)));
        }
        for name in names.iter().rev() {
            lines.push(line(source, 8, Some(name)));
        }
        let map = build("wide.mjs", &db, &lines);
        assert_eq!(map.names, names);
        let rows = decode_mappings(&map.mappings).unwrap();
        assert_eq!(rows.len(), 512);
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(row.len(), 1);
            let expected_name = if i < 256 { i } else { 511 - i };
            assert_eq!(row[0].name, Some(expected_name as i64));
            assert_eq!(row[0].src, Some(0));
            assert_eq!(row[0].src_line, Some(i64::from(i >= 256)));
            assert_eq!(row[0].src_col, Some(if i < 256 { 6 } else { 0 }));
        }
        let wire: serde_json::Value = serde_json::from_str(&to_json(&map)).unwrap();
        assert_eq!(wire["names"], serde_json::json!(names));
        assert_eq!(wire["sourcesContent"], serde_json::json!(["é😀\r\nvalue"]));
        assert_eq!(wire["mappings"], map.mappings);
    }

    #[test]
    fn ordered_serializer_uses_shared_escaping_and_null_contents() {
        let map = SourceMap {
            file: "a\"\\\n\0é\u{2028}😀".into(),
            sources: vec!["s".into()],
            sources_content: vec![None],
            names: vec!["".into()],
            mappings: "A".into(),
        };
        assert_eq!(
            to_json(&map),
            "{\"version\":3,\"file\":\"a\\\"\\\\\\n\\u0000é\u{2028}😀\",\"sources\":[\"s\"],\"sourcesContent\":[null],\"names\":[\"\"],\"mappings\":\"A\"}"
        );
    }

    #[test]
    fn compatibility_rows_and_unsorted_segments_remain_in_authored_order() {
        assert_eq!(
            decode_mappings("").unwrap(),
            Vec::<Vec<DecodedSegment>>::new()
        );
        let rows = decode_mappings(";G,D;;AAAA;AAAAA;").unwrap();
        assert_eq!(rows.len(), 6);
        assert!(rows[0].is_empty() && rows[2].is_empty() && rows[5].is_empty());
        assert_eq!(
            rows[1].iter().map(|s| s.gen_col).collect::<Vec<_>>(),
            [3, 2]
        );
        assert_eq!(rows[3][0].name, None);
        assert_eq!(rows[4][0].name, Some(0));
    }

    #[test]
    fn malformed_numeric_and_delta_overflow_return_errors() {
        for bad in [
            ",",
            "A,",
            ",A",
            "AA",
            "AAA",
            "AAAAAA",
            "!A",
            "éA",
            "g",
            "/////////////A",
            "////////////P",
        ] {
            assert!(decode_mappings(bad).is_err(), "accepted {bad:?}");
        }
        let large = sourcemap::vlq::generate_vlq_segment(&[(1i64 << 62) - 1]).unwrap();
        assert!(decode_mappings(&format!("{large},{large},{large}")).is_err());
        for index in 1..5 {
            let mut fields = [0; 5];
            fields[index] = (1i64 << 62) - 1;
            let segment = sourcemap::vlq::generate_vlq_segment(&fields).unwrap();
            assert!(decode_mappings(&format!("{segment};{segment};{segment}")).is_err());
        }
    }
}
