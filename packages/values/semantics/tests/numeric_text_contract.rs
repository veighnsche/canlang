//! Immutable actual Node String and owning-caller witnesses; no candidate-derived expectations.
use num_bigint::BigInt;
use serde_json::{json, Value as Json};
use values_semantics::codecs::numeric::{decode_value_scalar, PathSeg, ScalarName, Violation};
use values_semantics::failures::Failure;
use values_semantics::numeric::{decimal::round_decimal, money::make_money_structural};
use values_semantics::representations::numeric::{format_js_number, make_date, Value};
use values_semantics::transport::exact::dispatch;

fn fixture() -> Json {
    serde_json::from_str(include_str!("../../conformance/numeric-text.json")).unwrap()
}
fn input(v: &Json) -> Value {
    if let Some(bits) = v.get("numberBits").and_then(Json::as_str) {
        return Value::Num(f64::from_bits(u64::from_str_radix(bits, 16).unwrap()));
    }
    if let Some(n) = v.get("bigint").and_then(Json::as_str) {
        return Value::BigInt(n.parse::<BigInt>().unwrap());
    }
    if v.get("invalidOperand").is_some() {
        return Value::Null;
    }
    match v {
        Json::String(s) => Value::Str(s.clone()),
        Json::Number(n) => Value::Num(n.as_f64().unwrap()),
        Json::Object(o) => Value::Record(o.iter().map(|(k, v)| (k.clone(), input(v))).collect()),
        _ => panic!("unexpected fixture input {v}"),
    }
}
fn number(v: &Value) -> f64 {
    if let Value::Num(n) = v {
        *n
    } else {
        panic!("not number")
    }
}
fn field<'a>(c: &'a Json, key: &str) -> Option<&'a Json> {
    c["observation"]["fields"]
        .as_array()?
        .iter()
        .find(|f| f["key"] == key)
        .and_then(|f| f.get("value"))
}
fn violations(vs: &[Violation]) -> Json {
    Json::Array(
        vs.iter()
            .map(|v| {
                let path: Vec<Json> = v
                    .path
                    .iter()
                    .map(|p| match p {
                        PathSeg::Key(k) => json!(k),
                        PathSeg::Index(i) => json!(i),
                    })
                    .collect();
                let mut o = json!({"path":path,"code":v.code.as_str(),"message":v.message});
                if let Some(e) = &v.expected {
                    o["expected"] = json!(e);
                }
                if let Some(a) = &v.actual {
                    o["actual"] = json!(a);
                }
                o
            })
            .collect(),
    )
}
fn failure(c: &Json, f: Failure) {
    assert_eq!(c["observation"]["outcome"], "throw", "{}", c["id"]);
    assert_eq!(field(c, "name"), Some(&json!("ValueError")));
    assert_eq!(field(c, "kind"), Some(&json!("value")));
    assert_eq!(
        field(c, "code"),
        Some(&json!(f.code.as_str())),
        "{}",
        c["id"]
    );
    assert_eq!(field(c, "message"), Some(&json!(f.message)), "{}", c["id"]);
    assert!(field(c, "violations").is_none());
}
#[test]
fn frozen_builtin_bytes_and_original_ieee_bits() {
    let f = fixture();
    let rows = f["numbers"].as_array().unwrap();
    assert_eq!(f["seededDistinctCount"], 10000);
    assert_eq!(rows.len(), 10213);
    for row in rows {
        let bits = u64::from_str_radix(row["inputBits"].as_str().unwrap(), 16).unwrap();
        let n = f64::from_bits(bits);
        let retained = Value::Num(n);
        assert_eq!(
            format_js_number(n).as_bytes(),
            row["stringText"].as_str().unwrap().as_bytes(),
            "{}",
            row["id"]
        );
        assert_eq!(n.to_bits(), bits);
        assert_eq!(number(&retained).to_bits(), bits);
    }
}
#[test]
fn actual_donor_failures_precedence_violation_presence_and_transport() {
    for c in fixture()["callers"].as_array().unwrap() {
        let args: Vec<Value> = c["args"].as_array().unwrap().iter().map(input).collect();
        let before: Vec<Option<u64>> = args
            .iter()
            .map(|v| {
                if let Value::Num(n) = v {
                    Some(n.to_bits())
                } else {
                    None
                }
            })
            .collect();
        let op = c["operation"].as_str().unwrap();
        match op {
            "date" => match make_date(number(&args[0]), number(&args[1]), number(&args[2])) {
                Err(f) => failure(c, f),
                Ok(d) => {
                    assert_eq!(c["observation"]["outcome"], "return");
                    assert_eq!(d.year, 2024);
                    assert_eq!(d.month, 2);
                    assert_eq!(d.day, 29);
                }
            },
            "round" => match round_decimal(&args[0], &args[1]) {
                Err(f) => failure(c, f),
                Ok(d) => {
                    assert_eq!(c["observation"]["outcome"], "return");
                    assert_eq!(
                        d.coef.to_string(),
                        c["observation"]["value"]["coef"]["bigint"]
                            .as_str()
                            .unwrap()
                    );
                    // Native u8 stored scale cannot certify the separately open decimal-scale -0 residual.
                    let expected = input(&c["observation"]["value"]["scale"]);
                    assert_eq!(d.scale as f64, number(&expected));
                }
            },
            "currency" => failure(c, make_money_structural(&args[0], &args[1]).unwrap_err()),
            "decode" => {
                let name = match c["args"][0].as_str().unwrap() {
                    "int" => ScalarName::Int,
                    "decimal" => ScalarName::Decimal,
                    "money" => ScalarName::Money,
                    "date" => ScalarName::Date,
                    "datetime" => ScalarName::Datetime,
                    "duration" => ScalarName::Duration,
                    _ => unreachable!(),
                };
                let native = violations(&decode_value_scalar(name, &args[1]).unwrap_err());
                assert_eq!(field(c, "name"), Some(&json!("SchemaError")));
                assert_eq!(field(c, "kind"), Some(&json!("schema")));
                assert!(field(c, "code").is_none());
                assert_eq!(field(c, "violations"), Some(&native), "{}", c["id"]);
                assert_eq!(
                    field(c, "message"),
                    Some(&json!(format!(
                        "schema validation failed with {} violation(s)",
                        native.as_array().unwrap().len()
                    )))
                );
                for (actual, fields) in native
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(c["observation"]["violationFields"].as_array().unwrap())
                {
                    for f in fields.as_array().unwrap() {
                        let key = f["key"].as_str().unwrap();
                        assert_eq!(actual.get(key).is_some(), f["present"].as_bool().unwrap());
                        if let Some(value) = actual.get(key) {
                            assert_eq!(value, &f["value"]);
                        }
                    }
                }
            }
            _ => unreachable!(),
        }
        let transport_op = match op {
            "date" => "make-date",
            "round" => "round-decimal",
            "currency" => "make-money",
            "decode" => "decode-value",
            _ => unreachable!(),
        };
        let transport = dispatch(transport_op, &args).unwrap();
        if c["observation"]["outcome"] == "throw" {
            let expected = if op == "decode" {
                json!({"ok":false,"violations":field(c,"violations").unwrap()})
            } else {
                json!({"ok":false,"code":field(c,"code").unwrap(),"message":field(c,"message").unwrap()})
            };
            assert_eq!(transport, expected, "transport {}", c["id"]);
        } else {
            assert_eq!(transport["ok"], true);
        }
        let after: Vec<Option<u64>> = args
            .iter()
            .map(|v| {
                if let Value::Num(n) = v {
                    Some(n.to_bits())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(before, after);
    }
}
#[test]
fn negative_controls_reject_text_bit_error_and_order_mutations() {
    let f = fixture();
    let rows = f["numbers"].as_array().unwrap();
    for (n, wrong) in [
        (1e20_f64, "9223372036854775807"),
        (-1e20, "-9223372036854775808"),
        (-0.0, "-0"),
        (1e21, "1e21"),
        (1e-6, "1e-6"),
    ] {
        let bits = format!("{:016x}", n.to_bits());
        let row = rows.iter().find(|r| r["inputBits"] == bits).unwrap();
        assert_ne!(row["stringText"], wrong);
    }
    let nan = rows.iter().find(|r| r["classification"] == "nan").unwrap();
    assert_ne!(nan["jsonTokenText"], "NaN");
    let row = &rows[0];
    let bits = u64::from_str_radix(row["inputBits"].as_str().unwrap(), 16).unwrap();
    assert_ne!(
        format_js_number(f64::from_bits(bits ^ 1)),
        row["stringText"]
    );
    let c = f["callers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| field(c, "code") == Some(&json!("out-of-range")))
        .unwrap();
    assert_ne!(field(c, "code"), Some(&json!("overflow")));
    assert_ne!(
        field(c, "message").unwrap().as_str().unwrap().to_owned() + ".",
        field(c, "message").unwrap().as_str().unwrap()
    );
    let shape = f["callers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| field(c, "violations").is_some_and(|v| v.as_array().unwrap().len() > 1))
        .unwrap();
    let v = field(shape, "violations").unwrap();
    let mut reversed = v.as_array().unwrap().clone();
    reversed.reverse();
    assert_ne!(json!(reversed), *v);
    let mut absent = v.clone();
    absent[0].as_object_mut().unwrap().remove("code");
    assert_ne!(absent, *v);
}
