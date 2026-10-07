// Independent bounded controls; no compiler crate or production source edits.
#[path = "../../../../compiler/src/json.rs"]
pub mod json;
pub mod diagnostic {
    pub fn push_json_str(out: &mut String, value: &str) {
        out.push_str(&crate::json::to_compact_string(value).unwrap());
    }
}
use serde::{Deserialize, de::{self, MapAccess, SeqAccess, Visitor}};
use std::fmt;

#[derive(Debug, PartialEq)]
enum Event { Signed(i64), Unsigned(u64), Float(f64), String(String), Object(Vec<(String, Event)>), Array(Vec<Event>), Scalar }
#[cfg(feature = "arbitrary_precision")]
#[derive(Debug, PartialEq)]
enum StringMode { Owned, Borrowed, Transient }
#[cfg(feature = "arbitrary_precision")]
impl<'de> Deserialize<'de> for StringMode {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StringMode;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("string callback mode") }
            fn visit_string<E: de::Error>(self, _: String) -> Result<StringMode, E> { Ok(StringMode::Owned) }
            fn visit_borrowed_str<E: de::Error>(self, _: &'de str) -> Result<StringMode, E> { Ok(StringMode::Borrowed) }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<StringMode, E> { Ok(StringMode::Transient) }
        }
        d.deserialize_any(V)
    }
}
#[cfg(feature = "arbitrary_precision")]
fn map_string_mode(text: &str) -> StringMode {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = StringMode;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("single map entry") }
        fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<StringMode, A::Error> {
            let (_, mode): (String, StringMode) = a.next_entry()?.unwrap();
            assert!(a.next_entry::<String, StringMode>()?.is_none());
            Ok(mode)
        }
    }
    let mut d = serde_json::Deserializer::from_str(text);
    de::Deserializer::deserialize_any(&mut d, V).unwrap()
}
impl<'de> Deserialize<'de> for Event {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Event;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("JSON event") }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Event, E> { Ok(Event::Signed(v)) }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Event, E> { Ok(Event::Unsigned(v)) }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Event, E> { Ok(Event::Float(v)) }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Event, E> { Ok(Event::String(v.to_owned())) }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Event, E> { Ok(Event::Scalar) }
            fn visit_unit<E: de::Error>(self) -> Result<Event, E> { Ok(Event::Scalar) }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Event, A::Error> {
                let mut values = Vec::new();
                while let Some(v) = a.next_entry()? { values.push(v); }
                Ok(Event::Object(values))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Event, A::Error> {
                let mut values = Vec::new();
                while let Some(v) = a.next_element()? { values.push(v); }
                Ok(Event::Array(values))
            }
        }
        d.deserialize_any(V)
    }
}
fn main() {
    let text = r#"{"a":2,"\u0061":3}"#;
    let ordered = serde_json::from_str::<Event>(text).unwrap();
    assert!(matches!(&ordered, Event::Object(v) if v.len() == 2 && v[0].0 == "a" && v[1].0 == "a"));
    assert_eq!(json::parse(text).unwrap().get("a"), Some(&json::Json::Num("2".into())));
    let collapsed: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(collapsed["a"], 3);
    println!("ordered duplicates={ordered:?}; blanket Value={collapsed}");

    for token in ["-0", "2.500", "2E03", "2e+03", "2e99999999999999999999"] {
        assert_eq!(json::render(&json::parse(token).unwrap()), token);
        println!("{token}: {:?}", serde_json::from_str::<Event>(token));
    }
    #[cfg(feature = "arbitrary_precision")]
    {
        assert_eq!(serde_json::from_str::<Event>("-0").unwrap(), Event::Signed(0));
        assert_eq!(serde_json::from_str::<serde_json::Number>("2.500").unwrap().to_string(), "2.500");
        let numeric = serde_json::from_str::<Event>("2E03").unwrap();
        let authored = serde_json::from_str::<Event>(r#"{"$serde_json::private::Number":"2e+03"}"#).unwrap();
        assert_eq!(numeric, authored);
        assert_ne!(json::parse("2E03").unwrap(), json::parse(r#"{"$serde_json::private::Number":"2e+03"}"#).unwrap());
        println!("arbitrary precision preserves scale but collides numeric/authored map={numeric:?}");
        let number_mode = map_string_mode("2E03");
        let object_mode = map_string_mode(r#"{"$serde_json::private::Number":"2e+03"}"#);
        assert_eq!(number_mode, StringMode::Owned);
        assert_eq!(object_mode, StringMode::Borrowed);
        println!("collision is decoded generic Event only; lower-level string callbacks differ: numeric={number_mode:?}, authored={object_mode:?}");
    }

    // Successful raw capture can subsequently undergo strict string decoding.
    let surrogate = r#"["\uDC00"]"#;
    let raw: &serde_json::value::RawValue = serde_json::from_str(surrogate).unwrap();
    assert_eq!(raw.get(), surrogate);
    assert!(serde_json::from_str::<Vec<String>>(raw.get()).is_err());
    assert!(json::parse(surrogate).is_err());
    // A later invalid tail fails raw capture before such a strict pass can run.
    let mixed = r#"["\uDC00",]"#;
    let early = json::parse(mixed).unwrap_err();
    let deferred = serde_json::from_str::<&serde_json::value::RawValue>(mixed).unwrap_err();
    assert_eq!(early.offset, 7);
    assert!(early.message.contains("surrogate"));
    assert!(deferred.to_string().starts_with("expected value"));
    println!("Unicode first-error current={early}; raw={deferred}");

    let deep = format!("{}false{}", "[".repeat(67), "]".repeat(67));
    let raw: &serde_json::value::RawValue = serde_json::from_str(&deep).unwrap();
    assert_eq!(raw.get(), deep);
    assert_eq!(json::parse(&deep).unwrap_err().offset, 65);
    let late = format!("{}false,]{}", "[".repeat(67), "]".repeat(66));
    let early = json::parse(&late).unwrap_err();
    let deferred = serde_json::from_str::<&serde_json::value::RawValue>(&late).unwrap_err();
    assert_eq!(early.offset, 65);
    assert_eq!(early.message, "nesting too deep");
    assert!(deferred.to_string().starts_with("expected value"));
    // Child RawValue has the same subtree issue, despite a visited outer array.
    assert!(serde_json::from_str::<Vec<&serde_json::value::RawValue>>(&late).is_err());
    println!("depth first-error current={early}; raw={deferred}; root/child raw whole-subtree capture confirmed");

    // Both public readers, including a borrowed reader, construct successfully.
    let mut reader = serde_json::de::StrRead::new("[1] [2]");
    {
        let mut stream = serde_json::Deserializer::new(&mut reader).into_iter::<Event>();
        assert_eq!(stream.byte_offset(), 0);
        stream.next().unwrap().unwrap();
        assert_eq!(stream.byte_offset(), 3);
    }
    let mut stream = serde_json::Deserializer::new(serde_json::de::SliceRead::new(b"[1] [2]")).into_iter::<Event>();
    stream.next().unwrap().unwrap();
    assert_eq!(stream.byte_offset(), 3);
    println!("public owned SliceRead/borrowed StrRead usable; stream offset 3 after complete [1]");
}
