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

