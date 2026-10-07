/// V8-compatible JSON string escaping for one UTF-16 unit slice.
pub(super) fn append(units: &[u16], out: &mut String) {
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            0x00..=0x1F => {
                out.push_str(&format!("\\u{:04x}", u));
            }
            0xD800..0xDC00 => {
                if i + 1 < units.len() && (0xDC00..0xE000).contains(&units[i + 1]) {
                    let lo = units[i + 1];
                    let cp = 0x10000 + (((u - 0xD800) as u32) << 10) + (lo - 0xDC00) as u32;
                    out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                    i += 1;
                } else {
                    out.push_str(&format!("\\u{:04x}", u));
                }
            }
            0xDC00..0xE000 => {
                out.push_str(&format!("\\u{:04x}", u));
            }
            _ => {
                out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
            }
        }
        i += 1;
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::append;

    #[test]
    fn append_preserves_prefix_and_surrogate_boundaries() {
        let mut out = String::from("prefix:");
        append(&[0xD800, 0xD800, 0xDC00, 0xDC00, 0x22, 0x5C, 0x0A], &mut out);
        assert_eq!(out, "prefix:\"\\ud800\u{10000}\\udc00\\\"\\\\\\n\"");
        append(&[], &mut out);
        assert!(out.ends_with("\"\"\""));
    }

    #[test]
    #[ignore = "requires independently frozen V8 corpus via CAN_WORK_UTF16_CORPUS"]
    fn exhaustive_frozen_v8_corpus() {
        let path = std::env::var("CAN_WORK_UTF16_CORPUS").expect("private frozen corpus path");
        let corpus = std::fs::read_to_string(path).unwrap();
        let mut expected = corpus.lines();
        let mut out = String::new();
        let mut cases = 0;
        for unit in 0..=u16::MAX {
            out.clear();
            append(&[unit], &mut out);
            assert_eq!(out, expected.next().unwrap(), "unit {unit:04x}");
            cases += 1;
        }
        for high in 0xD800..=0xDBFF {
            for low in 0xDC00..=0xDFFF {
                out.clear();
                append(&[high, low], &mut out);
                assert_eq!(out, expected.next().unwrap(), "pair {high:04x} {low:04x}");
                cases += 1;
            }
        }
        assert_eq!(cases, 1_114_112);
        assert!(expected.next().is_none(), "exact frozen corpus closure");
    }
}
