
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


fn main() {
    assert_eq!(decode_mappings("").unwrap(), Vec::<Vec<DecodedSegment>>::new());
    let rows = decode_mappings(";G,D;;AAAA;AAAAA;").unwrap();
    assert_eq!(rows.len(), 6);
    assert!(rows[0].is_empty() && rows[2].is_empty() && rows[5].is_empty());
    assert_eq!(rows[1].iter().map(|s| s.gen_col).collect::<Vec<_>>(), [3, 2]);
    assert_eq!(rows[3][0].name, None);
    assert_eq!(rows[4][0].name, Some(0));
    for bad in [",", "A,", ",A", "AA", "AAA", "AAAAAA", "!A", "éA", "g", "/////////////A", "////////////P"] {
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
    assert_eq!(sourcemap::vlq::generate_vlq_segment(&[0,0,0,0]).unwrap(), "AAAA");
    assert_eq!(sourcemap::vlq::generate_vlq_segment(&[0,0,0,2]).unwrap(), "AAAE");
    let mut builder = sourcemap::SourceMapBuilder::new(Some("probe.mjs"));
    let src = builder.add_source("probe.can");
    builder.add_raw(0,0,0,0,Some(src),None,false);
    builder.add_raw(1,0,0,2,Some(src),None,false);
    let map = builder.into_sourcemap();
    let mut output = Vec::new();
    map.to_writer(&mut output).unwrap();
    let wire = String::from_utf8(output).unwrap();
    assert!(wire.contains("\"mappings\":\"AAAA;AAAE\""));
    assert!(map.to_data_url().unwrap().starts_with("data:application/json;charset=utf-8;base64,"));
    println!("current decoder extracted verbatim: authored rows/order, 11 malformed cases, all 5 accumulation-overflow dimensions PASS");
    println!("public numeric encoding + full-map to_writer/to_data_url PASS: {wire}");
}

