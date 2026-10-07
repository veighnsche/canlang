use percent_encoding::{percent_encode, AsciiSet, NON_ALPHANUMERIC};
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~')
    .remove(b'*').remove(b'\'').remove(b'(').remove(b')');
pub(crate) fn encode(units: &[u16]) -> Result<Vec<u16>, std::char::DecodeUtf16Error> {
    let mut out = Vec::new();
    for scalar in std::char::decode_utf16(units.iter().copied()) {
        let scalar = scalar?;
        let mut buffer = [0u8; 4];
        out.extend(percent_encode(scalar.encode_utf8(&mut buffer).as_bytes(), COMPONENT)
            .flat_map(|chunk| chunk.bytes().map(u16::from)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn component_bytes_preserve_punctuation_controls_and_astral_text() {
        let input: Vec<u16> = "AZaz09-_.!~*'() /%é😀\u{0000}".encode_utf16().collect();
        let encoded = encode(&input).unwrap();
        assert_eq!(String::from_utf16(&encoded).unwrap(),
            "AZaz09-_.!~*'()%20%2F%25%C3%A9%F0%9F%98%80%00");
        assert_eq!(encode(&[]).unwrap(), Vec::<u16>::new());
    }

    #[test]
    fn malformed_utf16_is_refused_without_replacement_characters() {
        for input in [vec![0xd800], vec![0xdc00], vec![0xd800, 0x61],
            vec![0xdc00, 0xd800], vec![0x61, 0xd800, 0x78]] {
            assert!(encode(&input).is_err());
        }
    }
}
