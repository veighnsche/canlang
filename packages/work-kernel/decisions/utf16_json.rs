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

