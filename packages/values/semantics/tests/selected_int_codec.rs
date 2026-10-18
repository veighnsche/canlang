//! Selected TECH-V04 int/ASCII codec checks: bounded lexical preflight in
//! `decode_int64`, the derived transport admission bound, and the exact
//! ordered `SchemaError` violation surface on the real `decode-value` /
//! `encode-value` int branch. Existing exact `str`/`bigint` tags suffice;
//! only ASCII wire text is exercised here.

use num_bigint::BigInt;
use serde_json::json;
use values_semantics::codecs::numeric::{decode_value_scalar, ScalarName};
use values_semantics::representations::numeric::Value;
use values_semantics::transport::exact::{
    dispatch, handle_line, SELECTED_INT_TEXT_MAX_BYTES, SELECTED_REQUEST_MAX_BYTES,
};

fn int_wire(text: &str) -> Value {
    Value::Str(text.to_string())
}

fn decode_int(text: &str) -> Result<Value, Vec<values_semantics::codecs::numeric::Violation>> {
    decode_value_scalar(ScalarName::Int, &int_wire(text))
}

fn actual_of(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap();
    if quoted.len() > 64 {
        format!("{}...", &quoted[..64])
    } else {
        quoted
    }
}

#[test]
fn selected_bounds_derive_from_csv_admission_and_fixed_envelope() {
    assert_eq!(SELECTED_INT_TEXT_MAX_BYTES, 1_048_576);
    // Fixed two-scalar decode envelope with an empty string payload, exactly
    // as the TypeScript selected caller builds it via JSON.stringify: both
    // the scalar name and the payload travel as tagged `str` values.
    let envelope = r#"{"v":1,"op":"decode-value","args":[{"t":"str","v":"int"},{"t":"str","v":""}]}"#;
    assert_eq!(envelope.len(), 77);
    // Worst-case ASCII escape: every byte a `\u00xx` control (6x).
    assert_eq!(SELECTED_REQUEST_MAX_BYTES, 77 + 6 * SELECTED_INT_TEXT_MAX_BYTES);
}

#[test]
fn selected_int_accepts_extremes_leading_zeros_and_signed_zero() {
    for (text, want) in [
        ("0", 0i64),
        ("-0", 0),
        ("-00", 0),
        ("007", 7),
        ("-0007", -7),
        ("009223372036854775807", i64::MAX),
        ("-009223372036854775808", i64::MIN),
        ("9223372036854775807", i64::MAX),
        ("-9223372036854775808", i64::MIN),
    ] {
        assert_eq!(
            decode_int(text),
            Ok(Value::BigInt(BigInt::from(want))),
            "{text}"
        );
    }
}

#[test]
fn selected_int_malformed_keeps_ordered_format_violation() {
    for text in ["", "12x", "+1", " 1", "1.0", "--1", "-", "１２３"] {
        let violations = decode_int(text).unwrap_err();
        assert_eq!(violations.len(), 1, "{text}");
        let v = &violations[0];
        assert!(v.path.is_empty(), "{text}");
        assert_eq!(v.code.as_str(), "format", "{text}");
        assert_eq!(v.message, "int is malformed", "{text}");
        assert_eq!(
            v.expected.as_deref(),
            Some("canonical int64 decimal string"),
            "{text}"
        );
        assert_eq!(v.actual.as_deref(), Some(actual_of(text).as_str()), "{text}");
    }
}

#[test]
fn selected_int_out_of_range_refuses_before_bigint_allocation() {
    // 19 significant digits over the lexical limit, 20+ digits, and a full
    // 1 MiB digit run: all refuse as `bound` with no successful bigint parse.
    let huge = "9".repeat(SELECTED_INT_TEXT_MAX_BYTES);
    for text in [
        "9223372036854775808".to_string(),
        "-9223372036854775809".to_string(),
        "09923372036854775807".to_string(),
        "1".repeat(20),
        huge,
    ] {
        let text = text.as_str();
        let violations = decode_int(text).unwrap_err();
        assert_eq!(violations.len(), 1, "len {}", text.len());
        let v = &violations[0];
        assert!(v.path.is_empty());
        assert_eq!(v.code.as_str(), "bound");
        assert_eq!(v.message, "int is out of range");
        assert_eq!(
            v.expected.as_deref(),
            Some("int in [-9223372036854775808, 9223372036854775807]")
        );
        assert_eq!(v.actual.as_deref(), Some(actual_of(text).as_str()));
    }
}

#[test]
fn selected_int_control_text_keeps_json_escaped_actual() {
    let violations = decode_int("1\x007").unwrap_err();
    assert_eq!(violations[0].actual.as_deref(), Some("\"1\\u00007\""));
}

#[test]
fn selected_transport_int_branch_preserves_violations_and_strictness() {
    let name = Value::Str("int".to_string());
    let ok = dispatch("decode-value", &[name.clone(), int_wire("007")]).unwrap();
    assert_eq!(ok, json!({"ok": true, "value": {"t": "bigint", "v": "7"}}));
    let malformed = dispatch("decode-value", &[name.clone(), int_wire("12x")]).unwrap();
    assert_eq!(
        malformed,
        json!({"ok": false, "violations": [{
            "path": [], "code": "format", "message": "int is malformed",
            "expected": "canonical int64 decimal string", "actual": "\"12x\"",
        }]})
    );
    let out_of_range = dispatch(
        "decode-value",
        &[name.clone(), int_wire("9223372036854775808")],
    )
    .unwrap();
    assert_eq!(
        out_of_range,
        json!({"ok": false, "violations": [{
            "path": [], "code": "bound", "message": "int is out of range",
            "expected": "int in [-9223372036854775808, 9223372036854775807]",
            "actual": "\"9223372036854775808\"",
        }]})
    );
    let encoded = dispatch(
        "encode-value",
        &[name.clone(), Value::BigInt(BigInt::from(-7))],
    )
    .unwrap();
    assert_eq!(encoded, json!({"ok": true, "value": {"t": "str", "v": "-7"}}));
    // Strict arity/scalar/tag checks refuse before any usable native decode.
    assert!(dispatch("decode-value", &[name.clone()]).is_err());
    assert!(
        dispatch(
            "decode-value",
            &[name.clone(), int_wire("1"), int_wire("2")]
        )
        .is_err()
    );
    assert!(
        dispatch(
            "decode-value",
            &[Value::Str("integer".to_string()), int_wire("1")]
        )
        .is_err()
    );
}

#[test]
fn selected_transport_refuses_over_bound_requests_before_parsing() {
    let text = "7".repeat(SELECTED_INT_TEXT_MAX_BYTES);
    let line = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"str","v":"{text}"}}]}}"#
    );
    assert!(line.len() <= SELECTED_REQUEST_MAX_BYTES);
    let response = handle_line(&line);
    assert_eq!(response["ok"], json!(false));
    assert!(response.get("violations").is_some());

    // Worst-case escape expansion that exactly fills the derived bound is
    // still admitted (compliant callers always fit); one more byte refuses
    // before any parsing, with no semantic verdict. The fill is the
    // pre-escaped `\u0001` six-byte form, exactly as `JSON.stringify`
    // emits control bytes on the wire.
    let fill = "\\u0001".repeat(SELECTED_INT_TEXT_MAX_BYTES);
    let fill_line = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"str","v":"{fill}"}}]}}"#
    );
    assert_eq!(fill_line.len(), SELECTED_REQUEST_MAX_BYTES);
    let fill_response = handle_line(&fill_line);
    assert_eq!(fill_response["ok"], json!(false));
    assert!(fill_response.get("violations").is_some());

    let over = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"str","v":"{fill}{extra}"}}]}}"#,
        extra = "\\u0001",
    );
    assert!(over.len() > SELECTED_REQUEST_MAX_BYTES);
    let refused = handle_line(&over);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
    assert!(refused.get("violations").is_none());
    assert!(refused.get("value").is_none());
}

#[test]
fn selected_gate_refuses_decoded_text_over_the_original_bound() {
    // 1,048,577 admitted-alphabet zeros: one byte past the original text
    // bound. The encoded request still fits the outer raw cap, so only
    // the decoded-text gate refuses it, as transport, never success.
    let text = "0".repeat(SELECTED_INT_TEXT_MAX_BYTES + 1);
    let line = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"str","v":"{text}"}}]}}"#
    );
    assert!(line.len() <= SELECTED_REQUEST_MAX_BYTES);
    let refused = handle_line(&line);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
    assert!(refused.get("violations").is_none());
    assert!(refused.get("value").is_none());
}

#[test]
fn selected_gate_refuses_inexact_selected_shapes_before_materialization() {
    let payload = r#"{"t":"str","v":"7"}"#;
    let scalar = r#"{"t":"str","v":"int"}"#;
    // Extra top-level envelope field.
    let extra_top = format!(
        r#"{{"v":1,"op":"decode-value","args":[{scalar},{payload}],"x":1}}"#
    );
    // Extra field on the scalar tag.
    let extra_scalar = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int","x":1}},{payload}]}}"#
    );
    // Extra field on the payload tag.
    let extra_payload = format!(
        r#"{{"v":1,"op":"decode-value","args":[{scalar},{{"t":"str","v":"7","x":1}}]}}"#
    );
    // Wrong arity on a selected call.
    let arity = format!(r#"{{"v":1,"op":"decode-value","args":[{scalar}]}}"#);
    for line in [extra_top, extra_scalar, extra_payload, arity] {
        let refused = handle_line(&line);
        assert_eq!(refused["ok"], json!(false), "{line}");
        assert!(refused.get("transport").is_some(), "{line}");
        assert!(refused.get("violations").is_none(), "{line}");
        assert!(refused.get("value").is_none(), "{line}");
    }
}

#[test]
fn selected_gate_refuses_huge_bigint_magnitudes_without_parsing() {
    // A 6M-digit bigint value fits the outer raw cap, so only the
    // significant-digits gate refuses it, before any
    // arbitrary-precision parse (the legacy parse-first order took
    // minutes here); small out-of-range magnitudes keep the legacy
    // semantic failure envelope instead.
    let huge = "9".repeat(6_000_000);
    let line = format!(
        r#"{{"v":1,"op":"encode-value","args":[{{"t":"str","v":"int"}},{{"t":"bigint","v":"{huge}"}}]}}"#
    );
    let refused = handle_line(&line);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
    assert!(refused.get("violations").is_none());
    assert!(refused.get("value").is_none());

    // Any significant magnitude above int64 refuses as transport without
    // parsing, small or huge alike: more than 19 significant digits can
    // never be in range, so no parse is needed to know it fails.
    let small = format!(
        r#"{{"v":1,"op":"encode-value","args":[{{"t":"str","v":"int"}},{{"t":"bigint","v":"99999999999999999999"}}]}}"#
    );
    let failed = handle_line(&small);
    assert_eq!(failed["ok"], json!(false));
    assert!(failed.get("transport").is_some());
    assert!(failed.get("violations").is_none());
    assert!(failed.get("value").is_none());
}

#[test]
fn selected_gate_walks_nested_bigint_magnitudes_without_parsing() {
    // A nested decimal coef with millions of digits on a selected call
    // refuses before any parse; a small one keeps the legacy semantic
    // violation order (wrong tag for int, not a malformed envelope).
    let huge_coef = "9".repeat(6_000_000);
    let nested_huge = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"decimal","coef":"{huge_coef}","scale":0}}]}}"#
    );
    let refused = handle_line(&nested_huge);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
    assert!(refused.get("violations").is_none());

    let nested_small = r#"{"v":1,"op":"decode-value","args":[{"t":"str","v":"int"},{"t":"decimal","coef":"15","scale":1}]}"#;
    let semantic = handle_line(nested_small);
    assert_eq!(semantic["ok"], json!(false));
    assert!(semantic.get("transport").is_none());
    assert_eq!(semantic["violations"][0]["code"], json!("type"));
}

#[test]
fn non_selected_ops_keep_legacy_verdicts_above_the_selected_raw_cap() {
    // R01-CONTINUE-006 probe 1: the derived raw-bytes bound is
    // selected-scoped. A 6,291,534-byte `str` on `is-decimal` keeps the
    // exact legacy verdict (accepted `false`, never a transport fault).
    let big = "x".repeat(6_291_534);
    let line = format!(r#"{{"v":1,"op":"is-decimal","args":[{{"t":"str","v":"{big}"}}]}}"#);
    assert!(line.len() > SELECTED_REQUEST_MAX_BYTES);
    let response = handle_line(&line);
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["value"], json!({"t": "bool", "v": false}));
    assert!(response.get("transport").is_none());
}

#[test]
fn selected_long_unknown_keys_keep_preflight_before_serde() {
    // R01-CONTINUE-006 probe 2: a 65-character unknown field on the first
    // scalar tag plus 1,048,577 payload zeros refuses as transport (the
    // inexact tag is recognized borrow-only) without materializing the
    // oversized string and without any semantic verdict.
    let zeros = "0".repeat(SELECTED_INT_TEXT_MAX_BYTES + 1);
    let long_key = "k".repeat(65);
    let line = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int","{long_key}":1}},{{"t":"str","v":"{zeros}"}}]}}"#
    );
    let refused = handle_line(&line);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
    assert!(refused.get("violations").is_none());
    assert!(refused.get("value").is_none());

    // A 65-character unknown top-level key on an otherwise selected call
    // likewise refuses as an inexact envelope before serde allocation.
    let top = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"str","v":"7"}}],"{long_key}":1}}"#
    );
    let refused_top = handle_line(&top);
    assert_eq!(refused_top["ok"], json!(false));
    assert!(refused_top.get("transport").is_some());
    assert!(refused_top.get("violations").is_none());
    assert!(refused_top.get("value").is_none());

    // A huge extra trailing argument cannot push a recognizable selected
    // call into the serde-first path: arity refuses before allocation.
    let huge = "1".repeat(5_000_000);
    let arity = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"str","v":"7"}},"{huge}"]}}"#
    );
    let refused_arity = handle_line(&arity);
    assert_eq!(refused_arity["ok"], json!(false));
    assert!(refused_arity.get("transport").is_some());
    assert!(refused_arity.get("violations").is_none());
    assert!(refused_arity.get("value").is_none());

    // A megabyte string smuggled in a mistyped (non-selected-carrier)
    // payload tag on a selected call refuses before serde materializes
    // it; the committed small `num`-tag pin below is unaffected.
    let nested = format!(
        r#"{{"v":1,"op":"decode-value","args":[{{"t":"str","v":"int"}},{{"t":"other","tag":"x","v":"{zeros}"}}]}}"#
    );
    let refused_nested = handle_line(&nested);
    assert_eq!(refused_nested["ok"], json!(false));
    assert!(refused_nested.get("transport").is_some());
    assert!(refused_nested.get("violations").is_none());
}

#[test]
fn selected_encode_carrier_and_lexical_boundary_refuse_before_parse() {
    // R01-CONTINUE-006 probe 3: 1,048,577 zeros plus `7` as an encode
    // bigint payload cannot come from the canonical actual-bigint
    // caller, so it refuses as transport before any bigint parse.
    let zeros7 = format!("{}7", "0".repeat(SELECTED_INT_TEXT_MAX_BYTES + 1));
    let line = format!(
        r#"{{"v":1,"op":"encode-value","args":[{{"t":"str","v":"int"}},{{"t":"bigint","v":"{zeros7}"}}]}}"#
    );
    let refused = handle_line(&line);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
    assert!(refused.get("violations").is_none());
    assert!(refused.get("value").is_none());

    // A 19-digit magnitude above signed64 refuses on encode before any
    // bigint parse; the in-range 19-digit maximum still encodes.
    for (text, transport) in [
        ("9999999999999999999", true),
        ("-9999999999999999999", true),
        ("9223372036854775807", false),
        ("-9223372036854775808", false),
    ] {
        let probe = format!(
            r#"{{"v":1,"op":"encode-value","args":[{{"t":"str","v":"int"}},{{"t":"bigint","v":"{text}"}}]}}"#
        );
        let response = handle_line(&probe);
        if transport {
            assert_eq!(response["ok"], json!(false), "{text}");
            assert!(response.get("transport").is_some(), "{text}");
            assert!(response.get("violations").is_none(), "{text}");
        } else {
            assert_eq!(response["ok"], json!(true), "{text}");
            assert_eq!(response["value"], json!({"t": "str", "v": text}), "{text}");
        }
    }

    // Decode keeps the accepted contract: a 19-digit above-bound text is
    // a semantic bound violation, never transport.
    let bad_decode = r#"{"v":1,"op":"decode-value","args":[{"t":"str","v":"int"},{"t":"str","v":"9999999999999999999"}]}"#;
    let semantic = handle_line(bad_decode);
    assert_eq!(semantic["ok"], json!(false));
    assert!(semantic.get("transport").is_none());
    assert_eq!(semantic["violations"][0]["code"], json!("bound"));
}

#[test]
fn non_selected_calls_keep_the_legacy_decode_first_order() {
    // A non-selected scalar keeps legacy leniency (extra envelope fields
    // ignored) and the legacy scalar/arity checks after inputs decode.
    let lenient = r#"{"v":1,"op":"decode-value","args":[{"t":"str","v":"decimal"},{"t":"str","v":"1.5"}],"x":1}"#;
    let ok = handle_line(lenient);
    assert_eq!(ok["ok"], json!(true));
    let bad_scalar = r#"{"v":1,"op":"decode-value","args":[{"t":"str","v":"nope"},{"t":"str","v":"1"}]}"#;
    let refused = handle_line(bad_scalar);
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("transport").is_some());
}
