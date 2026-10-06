//! Frozen actual JavaScript observations; the four non-scalar strings stay TS-only.
use serde_json::Value as Json;
use values_semantics::codecs::numeric::{actual_wire, json_stringify};
use values_semantics::representations::numeric::Value;

fn fixture() -> Json {
    serde_json::from_str(include_str!("../../conformance/string-escape.json")).unwrap()
}
fn units(row: &Json, field: &str) -> Vec<u16> {
    row[field]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u16)
        .collect()
}
#[test]
fn frozen_valid_str_helper_and_actual_wire_with_explicit_astral_residual() {
    let f = fixture();
    let rows = f["strings"].as_array().unwrap();
    assert_eq!(rows.len(), 93);
    let (mut helper, mut wire, mut residual, mut excluded) = (0, 0, 0, 0);
    for row in rows {
        let input = units(row, "inputUnits");
        if row["rustStrAdmitted"] != true {
            assert!(String::from_utf16(&input).is_err());
            excluded += 1;
            continue;
        }
        let text = String::from_utf16(&input).unwrap();
        let output = json_stringify(&text);
        assert_eq!(
            output
                .as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            row["quotedUtf8Hex"].as_str().unwrap(),
            "bytes {}",
            row["id"]
        );
        assert_eq!(
            output.encode_utf16().collect::<Vec<_>>(),
            units(row, "quotedUnits"),
            "helper {}",
            row["id"]
        );
        helper += 1;
        let actual = actual_wire(&Value::Str(text));
        let actual_units = actual.encode_utf16().collect::<Vec<_>>();
        if row["actualWireParityAdmitted"] == true {
            assert_eq!(
                actual_units,
                units(row, "actualWireUnits"),
                "actual_wire {}",
                row["id"]
            );
            wire += 1;
        } else {
            let js = units(row, "actualWireUnits");
            assert_ne!(
                actual_units, js,
                "tagged cut must remain an actual mismatch"
            );
            assert_eq!(actual_units.len(), 66);
            assert_eq!(js.len(), 67);
            assert!((0xD800..=0xDBFF).contains(&js[63]));
            assert_eq!(&actual_units[..63], &js[..63]);
            assert_eq!(&actual_units[63..], &[46, 46, 46]);
            residual += 1;
        }
    }
    assert_eq!((helper, wire, residual, excluded), (89, 88, 1, 4));
}
#[test]
fn negative_controls_use_actual_helper_and_wire_outputs() {
    let f = fixture();
    let rows = f["strings"].as_array().unwrap();
    let (mut slash, mut hex, mut separator, mut before) = (false, false, false, false);
    for row in rows {
        if row["rustStrAdmitted"] != true {
            continue;
        }
        let text = String::from_utf16(&units(row, "inputUnits")).unwrap();
        let actual = json_stringify(&text);
        let expected = units(row, "quotedUnits");
        for (wrong, flag) in [
            (actual.replace('/', "\\/"), &mut slash),
            (
                actual
                    .replace("\\u000b", "\\u000B")
                    .replace("\\u001a", "\\u001A")
                    .replace("\\u001b", "\\u001B")
                    .replace("\\u001c", "\\u001C")
                    .replace("\\u001d", "\\u001D")
                    .replace("\\u001e", "\\u001E")
                    .replace("\\u001f", "\\u001F"),
                &mut hex,
            ),
            (actual.replace('\u{2028}', "\\u2028"), &mut separator),
        ] {
            if wrong != actual {
                assert_ne!(wrong.encode_utf16().collect::<Vec<_>>(), expected);
                *flag = true;
            }
        }
        if row["actualWireParityAdmitted"] == true && actual.encode_utf16().count() > 64 {
            let prefix: Vec<_> = text.encode_utf16().take(64).collect();
            if let Ok(prefix) = String::from_utf16(&prefix) {
                let wrong = format!("{}...", json_stringify(&prefix));
                if wrong != actual_wire(&Value::Str(text.clone())) {
                    assert_ne!(
                        wrong.encode_utf16().collect::<Vec<_>>(),
                        units(row, "actualWireUnits")
                    );
                    before = true;
                }
            }
        }
    }
    assert!(slash && hex && separator && before);
}

fn channel(v: &Json) -> Value {
    if let Some(u) = v.get("stringUnits") {
        return Value::Str(
            String::from_utf16(
                &u.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        );
    }
    if let Some(b) = v.get("bigint") {
        return Value::BigInt(b.as_str().unwrap().parse().unwrap());
    }
    if let Some(b) = v.get("numberBits") {
        return Value::Num(f64::from_bits(
            u64::from_str_radix(b.as_str().unwrap(), 16).unwrap(),
        ));
    }
    if v.get("undefined") == Some(&Json::Bool(true)) {
        return Value::Undefined;
    }
    if let Some(entries) = v.get("entries") {
        return Value::Record(
            entries
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        String::from_utf16(&units(e, "keyUnits")).unwrap(),
                        channel(&e["value"]),
                    )
                })
                .collect(),
        );
    }
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Array(a) => Value::Array(a.iter().map(channel).collect()),
        _ => panic!("unexpected input channel {v}"),
    }
}
fn string_channel(s: &str) -> Json {
    serde_json::json!({"stringUnits":s.encode_utf16().collect::<Vec<_>>(),"utf8Hex":s.as_bytes().iter().map(|b|format!("{b:02x}")).collect::<String>()})
}
fn field<'a>(o: &'a Json, key: &str) -> &'a Json {
    o["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["key"] == key)
        .unwrap()
}
#[test]
fn owning_public_money_observations_match_native_payload_layer() {
    use values_semantics::codecs::numeric::{
        decode_value_scalar, encode_value_scalar, PathSeg, ScalarName,
    };
    use values_semantics::transport::exact::dispatch;
    for c in fixture()["callers"].as_array().unwrap() {
        let observation = &c["observation"];
        assert_eq!(observation["outcome"], "throw", "{}", c["id"]);
        if c["input"]["scalar"] == "string" {
            // Original nominal string validation is outside the numeric scalar API.
            // Preserve its donor observation; do not manufacture native parity.
            assert_eq!(c["id"], "decode-scalar-string-wrong-wire");
            assert_eq!(
                field(observation, "name")["value"],
                string_channel("SchemaError")
            );
            let v = &observation["violations"][0];
            assert_eq!(field(v, "path")["value"], serde_json::json!([]));
            assert_eq!(field(v, "actual")["value"], string_channel("number 2"));
            continue;
        }
        if c["type"] == "decode" {
            let wire = channel(&serde_json::json!({"entries":c["input"]["entries"]}));
            let native = decode_value_scalar(ScalarName::Money, &wire).unwrap_err();
            let captured = observation["violations"].as_array().unwrap();
            assert_eq!(native.len(), captured.len(), "{}", c["id"]);
            let mut transport_violations = Vec::new();
            for (v, expected) in native.iter().zip(captured) {
                let path: Vec<Json> = v
                    .path
                    .iter()
                    .map(|p| match p {
                        PathSeg::Key(k) => {
                            serde_json::json!({"stringUnits":k.encode_utf16().collect::<Vec<_>>()})
                        }
                        PathSeg::Index(i) => serde_json::json!({"number":i}),
                    })
                    .collect();
                let fields = [
                    ("path", Some(Json::Array(path))),
                    ("code", Some(string_channel(v.code.as_str()))),
                    ("message", Some(string_channel(&v.message))),
                    ("expected", v.expected.as_deref().map(string_channel)),
                    ("actual", v.actual.as_deref().map(string_channel)),
                ];
                let native_own_keys: Vec<Json> = fields.iter().filter(|(_,v)|v.is_some())
                    .map(|(key,_)|serde_json::json!({"stringUnits":key.encode_utf16().collect::<Vec<_>>()})).collect();
                assert_eq!(
                    expected["ownKeys"],
                    Json::Array(native_own_keys),
                    "violation own-key order {}",
                    c["id"]
                );
                for (key, value) in fields {
                    let e = field(expected, key);
                    assert_eq!(e["present"], value.is_some(), "{} {key}", c["id"]);
                    if let Some(value) = value {
                        if c["id"] == "decode-long-currency-wire" && key == "actual" {
                            assert_eq!(c["residual"], "actualWire-64-unit-astral-surrogate-split");
                            let rust_units = units(&value, "stringUnits");
                            let js_units = units(&e["value"], "stringUnits");
                            assert_eq!(rust_units.len(), 66);
                            assert_eq!(js_units.len(), 67);
                            assert_eq!(&rust_units[..63], &js_units[..63]);
                            assert!((0xD800..=0xDBFF).contains(&js_units[63]));
                            assert_eq!(&rust_units[63..], &[46, 46, 46]);
                            assert_eq!(&js_units[64..], &[46, 46, 46]);
                            assert!(e["value"].get("utf8Hex").is_none());
                            assert_ne!(e["value"], value);
                        } else {
                            assert_eq!(e["value"], value, "{} {key}", c["id"]);
                        }
                    }
                }
                let rawpath: Vec<Json> = v
                    .path
                    .iter()
                    .map(|p| match p {
                        PathSeg::Key(k) => serde_json::json!(k),
                        PathSeg::Index(i) => serde_json::json!(i),
                    })
                    .collect();
                let mut raw =
                    serde_json::json!({"path":rawpath,"code":v.code.as_str(),"message":v.message});
                if let Some(e) = &v.expected {
                    raw["expected"] = serde_json::json!(e);
                }
                if let Some(a) = &v.actual {
                    raw["actual"] = serde_json::json!(a);
                }
                transport_violations.push(raw);
            }
            assert_eq!(
                field(observation, "name")["value"],
                string_channel("SchemaError")
            );
            assert_eq!(
                field(observation, "kind")["value"],
                string_channel("schema")
            );
            assert_eq!(field(observation, "code")["present"], false);
            assert_eq!(
                field(observation, "message")["value"],
                string_channel(&format!(
                    "schema validation failed with {} violation(s)",
                    native.len()
                ))
            );
            // Actual native transport payload, not a claim that native Failure is SchemaError.
            assert_eq!(
                dispatch("decode-value", &[Value::Str("money".into()), wire]).unwrap(),
                serde_json::json!({"ok":false,"violations":transport_violations})
            );
        } else {
            let value = channel(&c["input"]["value"]);
            let failure = encode_value_scalar(ScalarName::Money, &value).unwrap_err();
            assert_eq!(
                field(observation, "name")["value"],
                string_channel("ValueError")
            );
            assert_eq!(field(observation, "kind")["value"], string_channel("value"));
            assert_eq!(
                field(observation, "code")["value"],
                string_channel(failure.code.as_str())
            );
            assert_eq!(
                field(observation, "message")["value"],
                string_channel(&failure.message)
            );
            assert_eq!(field(observation, "violations")["present"], false);
            assert_eq!(
                dispatch("encode-value", &[Value::Str("money".into()), value]).unwrap(),
                serde_json::json!({"ok":false,"code":failure.code.as_str(),"message":failure.message})
            );
        }
    }
}
