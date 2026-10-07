fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    for value in ["AAAA", "!A", "éA", "g", "/////////////A", "////////////P", "////////////H", "///////////H"] {
        match std::panic::catch_unwind(|| sourcemap::vlq::parse_vlq_segment(value)) {
            Ok(result) => println!("{value:?}: {result:?}"),
            Err(_) => println!("{value:?}: PANIC in library parser"),
        }
    }
    let mut builder = sourcemap::SourceMapBuilder::new(Some("plain.mjs"));
    let source = builder.add_source("can-source:0");
    builder.set_source(source, "plain.can");
    builder.set_source_contents(source, Some("app Plain\nnote Note\nrule allow\n"));
    let name = builder.add_name("appDefinition");
    for line in 0..3 {
        builder.add_raw(line, 0, line, 0, Some(source), if line == 0 { Some(name) } else { None }, false);
    }
    let mut bytes = Vec::new();
    builder.into_sourcemap().to_writer(&mut bytes).unwrap();
    println!("projection_fixture_bytes={}; {}", bytes.len(), String::from_utf8(bytes).unwrap());
}
