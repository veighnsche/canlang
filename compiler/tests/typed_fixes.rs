//! Independent fixed bytes for the lint fix/rejection output contract.
use canlang_compiler::lint::driver::{
    FixRejected, LintFix, fix_to_json, fixes_to_json, rejected_to_json,
};
use canlang_compiler::source::{SourceId, Span};

fn fix() -> LintFix {
    LintFix {
        rule: "redundant-null-marker",
        title: "é😀\n\r\t\u{0}\u{8}\u{c}\"\\".into(),
        file: SourceId(u32::MAX),
        span: Span::new(SourceId(7), 0, u32::MAX),
        expected_sha256: "hash".into(),
        replacement: "".into(),
    }
}

#[test]
fn fix_field_order_controls_unicode_and_u32_bounds() {
    assert_eq!(
        fix_to_json(&fix()),
        r#"{"rule":"redundant-null-marker","title":"é😀\n\r\t\u0000\u0008\u000c\"\\","file":4294967295,"span":{"start":0,"end":4294967295},"expected_sha256":"hash","replacement":""}"#
    );
}

#[test]
fn fix_list_is_ordered_and_empty_is_brackets() {
    assert_eq!(fixes_to_json(&[]), "[]");
    let mut first = fix();
    first.title = "z".into();
    first.file = SourceId(9);
    let mut second = first.clone();
    second.title = "a".into();
    second.file = SourceId(0);
    second.replacement = "x\n".into();
    assert_eq!(
        fixes_to_json(&[first, second]),
        r#"[{"rule":"redundant-null-marker","title":"z","file":9,"span":{"start":0,"end":4294967295},"expected_sha256":"hash","replacement":""},{"rule":"redundant-null-marker","title":"a","file":0,"span":{"start":0,"end":4294967295},"expected_sha256":"hash","replacement":"x\n"}]"#
    );
}

#[test]
fn every_rejection_variant_has_fixed_order_and_span_shape() {
    assert_eq!(
        rejected_to_json(&FixRejected::Stale {
            expected: "é😀\u{8}\u{c}\n\"\\".into(),
            found: "".into()
        }),
        r#"{"status":"rejected","reason":"stale","expected":"é😀\u0008\u000c\n\"\\","found":""}"#
    );
    assert_eq!(
        rejected_to_json(&FixRejected::SpanInvalid {
            start: u32::MAX,
            end: 0,
            len: 0
        }),
        r#"{"status":"rejected","reason":"span_invalid","start":4294967295,"end":0,"len":0}"#
    );
    assert_eq!(
        rejected_to_json(&FixRejected::Overlap {
            first: Span::new(SourceId(5), 0, 7),
            second: Span::new(SourceId(9), 2, u32::MAX)
        }),
        r#"{"status":"rejected","reason":"overlap","first":{"start":0,"end":7},"second":{"start":2,"end":4294967295}}"#
    );
}

#[test]
fn fixes_serialize_as_typed_envelope_members() {
    #[derive(serde::Serialize)]
    struct Envelope<'a> {
        version: u32,
        fixes: &'a [LintFix],
    }
    let mut value = fix();
    value.title = "".into();
    value.file = SourceId(0);
    value.span = Span::new(SourceId(0), 0, 0);
    let values = [value];
    assert_eq!(
        canlang_compiler::json::to_compact_string(&Envelope {
            version: 1,
            fixes: &values
        })
        .unwrap(),
        r#"{"version":1,"fixes":[{"rule":"redundant-null-marker","title":"","file":0,"span":{"start":0,"end":0},"expected_sha256":"hash","replacement":""}]}"#
    );
}
