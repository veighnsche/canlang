// Isolated source inclusion: JSON and transport only; no compiler rebuild.
extern crate self as canlang_compiler;
#[path = "../../../compiler/src/json.rs"]
pub mod json;
pub mod diagnostic {
    // Test harness string writer; current production formatter supplies escapes.
    pub fn push_json_str(out: &mut String, value: &str) {
        out.push_str(&crate::json::to_compact_string(value).unwrap());
    }
}
pub mod lsp {
    pub mod transport {
        include!(concat!(env!("DEP01_TMP"), "/transport-body.rs"));
    }
}
#[path = "../../../compiler/tests/json_input_contract.rs"]
mod input_contract;

#[test]
fn deferred_raw_failure_changes_depth_precedence() {
    let text = format!("{}0,]{}", "[".repeat(65), "]".repeat(64));
    let current = json::parse(&text).unwrap_err();
    assert_eq!(current.offset, 65);
    assert_eq!(current.message, "nesting too deep");
    let raw = serde_json::from_str::<&serde_json::value::RawValue>(&text).unwrap_err();
    assert_eq!(raw.column(), 68);
    assert!(raw.to_string().starts_with("expected value"));
    println!("precedence current={current}; raw={raw}");
}

#[test]
fn raw_borrowing_is_exact_but_not_strict_unicode_or_depth() {
    for text in [r#""\uD800""#, r#"{"\uDC00":1}"#] {
        let raw: &serde_json::value::RawValue = serde_json::from_str(text).unwrap();
        assert_eq!(raw.get(), text);
        assert!(json::parse(text).is_err());
        println!("raw accepts strict-string rejection: {text}");
    }
    let text = format!("{}0{}", "[".repeat(66), "]".repeat(66));
    assert!(serde_json::from_str::<&serde_json::value::RawValue>(&text).is_ok());
    assert_eq!(json::parse(&text).unwrap_err().message, "nesting too deep");
    for text in ["-0", "1.000", "1E-000", "1e999999999999999999999"] {
        let raw: &serde_json::value::RawValue = serde_json::from_str(text).unwrap();
        assert_eq!(raw.get(), text);
    }
}

#[test]
fn exact_origin_controls_include_depth_before_whitespace() {
    let text = format!("{} 0{}", "{\"x\":".repeat(65), "}".repeat(65));
    let error = json::parse(&text).unwrap_err();
    assert_eq!(error.offset, 325);
    assert_eq!(error.message, "nesting too deep");
    let text = format!("{} 0{}", "[".repeat(65), "]".repeat(65));
    assert_eq!(json::parse(&text).unwrap_err().offset, 66);
}
