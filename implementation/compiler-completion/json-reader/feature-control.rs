use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use std::fmt;

#[derive(Debug, PartialEq)]
enum Seen { Int(i64), UInt(u64), Float(f64), Text(String), Map(Vec<(String, Seen)>), Seq(Vec<Seen>), Other }
impl<'de> Deserialize<'de> for Seen {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Seen;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("value") }
            fn visit_i64<E: de::Error>(self, n: i64) -> Result<Seen,E> { Ok(Seen::Int(n)) }
            fn visit_u64<E: de::Error>(self, n: u64) -> Result<Seen,E> { Ok(Seen::UInt(n)) }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<Seen,E> { Ok(Seen::Float(n)) }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Seen,E> { Ok(Seen::Text(s.into())) }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Seen,E> { Ok(Seen::Other) }
            fn visit_unit<E: de::Error>(self) -> Result<Seen,E> { Ok(Seen::Other) }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Seen,A::Error> {
                let mut v = Vec::new(); while let Some(x) = a.next_entry()? { v.push(x); } Ok(Seen::Map(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Seen,A::Error> {
                let mut v = Vec::new(); while let Some(x) = a.next_element()? { v.push(x); } Ok(Seen::Seq(v))
            }
        }
        d.deserialize_any(V)
    }
}
fn main() {
    let mut str_stream = serde_json::Deserializer::new(serde_json::de::StrRead::new("true false")).into_iter::<Seen>();
    assert_eq!(str_stream.next().unwrap().unwrap(), Seen::Other);
    assert_eq!(str_stream.byte_offset(), 4);
    let mut slice_stream = serde_json::Deserializer::new(serde_json::de::SliceRead::new(b"true false")).into_iter::<Seen>();
    assert_eq!(slice_stream.next().unwrap().unwrap(), Seen::Other);
    assert_eq!(slice_stream.byte_offset(), 4);
    println!("public StrRead/SliceRead StreamDeserializer complete-value offsets=4");
    for text in ["-0", "1.000", "1E-000", "1E9", "1e9", "1e999999999999999999999", "9223372036854775808"] {
        let result = serde_json::from_str::<Seen>(text);
        println!("{text} => {result:?}");
    }
    #[cfg(feature="arbitrary_precision")]
    {
        assert_eq!(serde_json::from_str::<Seen>("-0").unwrap(), Seen::Int(0));
        let number = serde_json::from_str::<Seen>("1E9").unwrap();
        let object = serde_json::from_str::<Seen>(r#"{"$serde_json::private::Number":"1e+9"}"#).unwrap();
        assert_eq!(number, object);
        println!("number/map callback collision: {number:?}");
        assert_eq!(serde_json::from_str::<serde_json::Number>("1E-000").unwrap().to_string(), "1e-000");
    }
    let text = r#"{"x":1,"\u0078":2}"#;
    let ordered = serde_json::from_str::<Seen>(text).unwrap();
    assert!(matches!(ordered, Seen::Map(ref v) if v.len() == 2 && v[0].0 == "x" && v[1].0 == "x"));
    println!("generic ordered visitor preserves decoded duplicate members: {ordered:?}");
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(value["x"], 2);
    println!("blanket Value decoded duplicate => {value}");
}
