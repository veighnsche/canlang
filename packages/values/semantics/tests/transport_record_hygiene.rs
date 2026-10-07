use serde_json::{json, Value};
use values_semantics::transport::exact::{decode_input, handle_line};

fn decode_money(entries: Value) -> Value {
    handle_line(
        &json!({
            "v": 1, "op": "decode-value", "args": [
                {"t": "str", "v": "money"}, {"t": "record", "entries": entries}
            ]
        })
        .to_string(),
    )
}

#[test]
fn duplicate_money_member_is_refused_regardless_of_first_value() {
    for (first, second) in [("1", "bad"), ("bad", "1")] {
        assert_eq!(
            decode_money(json!([
                ["minor", {"t":"str", "v":first}],
                ["minor", {"t":"str", "v":second}],
                ["currency", {"t":"str", "v":"USD"}]
            ])),
            json!({"ok":false, "transport":"record keys must not repeat"})
        );
    }
}

#[test]
fn duplicate_unknown_member_does_not_become_repeated_semantic_violations() {
    assert_eq!(
        decode_money(json!([
            ["extra", {"t":"str", "v":"a"}], ["extra", {"t":"str", "v":"b"}],
            ["minor", {"t":"str", "v":"1"}], ["currency", {"t":"str", "v":"USD"}]
        ])),
        json!({"ok":false, "transport":"record keys must not repeat"})
    );
}

#[test]
fn nested_duplicate_is_refused_before_scalar_guard() {
    assert_eq!(
        decode_money(json!([
            ["minor", {"t":"record", "entries":[["x", {"t":"null"}], ["x", {"t":"null"}]]}],
            ["currency", {"t":"str", "v":"USD"}]
        ])),
        json!({"ok":false, "transport":"record keys must not repeat"})
    );
}

#[test]
fn transport_keeps_left_to_right_key_then_value_error_order() {
    for (entries, expected) in [
        (
            json!([["x", {"t":"bad"}], ["x", {"t":"null"}]]),
            "unknown input tag in transport: \"bad\"",
        ),
        (
            json!([["x", {"t":"null"}], ["x", {"t":"bad"}]]),
            "record keys must not repeat",
        ),
        (
            json!([["x", {"t":"null"}], [7, {"t":"bad"}]]),
            "record keys must be strings",
        ),
        (
            json!([["x", {"t":"null"}], ["x"]]),
            "record entries must be [key, value] pairs",
        ),
    ] {
        assert_eq!(
            decode_input(&json!({"t":"record", "entries":entries}))
                .unwrap_err()
                .0,
            expected
        );
    }
}

#[test]
fn unique_money_and_ordered_errors_are_unchanged() {
    assert_eq!(
        decode_money(json!([
            ["minor", {"t":"str", "v":"001"}], ["currency", {"t":"str", "v":"USD"}]
        ])),
        json!({"ok":true, "value":{"t":"money", "minor":"1", "currency":"USD"}})
    );
    let result = decode_money(json!([
        ["extra", {"t":"bool", "v":true}], ["minor", {"t":"str", "v":"bad"}],
        ["currency", {"t":"str", "v":"XXX"}]
    ]));
    assert_eq!(result["ok"], false);
    assert_eq!(
        result["violations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["path"][0].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["extra", "minor", "currency"]
    );
    assert!(result.get("transport").is_none());
}

#[test]
fn special_keys_stay_distinct_ordinary_transport_data() {
    assert!(decode_input(&json!({"t":"record", "entries":[
        ["__proto__", {"t":"null"}], ["constructor", {"t":"null"}],
        ["", {"t":"null"}], ["e\u{301}", {"t":"null"}], ["é", {"t":"null"}]
    ]}))
    .is_ok());
    assert_eq!(
        decode_input(&json!({"t":"record", "entries":[
            ["__proto__", {"t":"null"}], ["__proto__", {"t":"null"}]
        ]}))
        .unwrap_err()
        .0,
        "record keys must not repeat"
    );
}
