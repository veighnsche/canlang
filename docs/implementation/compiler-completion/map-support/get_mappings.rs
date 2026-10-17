fn main() { let map = sourcemap::SourceMapBuilder::new(None).into_sourcemap(); let _ = map.get_mappings(); }
