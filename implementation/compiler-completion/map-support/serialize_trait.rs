fn requires<T: serde::Serialize>() {} fn main() { requires::<sourcemap::SourceMap>(); }
