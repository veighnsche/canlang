use canlang_compiler::diagnostic::{Diagnostic, Related, Severity};
use canlang_compiler::source::{SourceId, Span};
use canlang_compiler::syntax::lex_fragment;

fn main() {
    let file = SourceId(91);
    let cases = [
        "alpha_0", "123", "1.5", "5ms", "7KiB", "5m2x", "1.2ms",
        "== != <= >= ?? ?. ->", "()[]{}.,:;=!|+-*/%<>?@", "é", "🦀",
        "\"é🦀\"", "\"\\n\\t\\u0041\"", "\"\\uD83E\\uDD80\"",
        "\"\\x\"", "\"\\u12\"", "\"\\uD800\"", "\"\\uDC00\"",
        "\"a\t\"", "\"a\u{0000}\"", "\"\\\"", "\\", "a\\b", "\t#$",
        "a\r", "a\n", "   ", " a + \"é\" ",
    ];
    let mut previous = Diagnostic::error("E7777", "prior observer diagnostic".into(), Span::new(SourceId(5), 7, 9));
    previous.related.push(Related { span: Span::new(SourceId(6), 2, 3), message: "prior related".into() });
    previous.tags.push("prior-tag".into());
    let prior_repr = format!("{previous:?}");
    for (index, fragment) in cases.iter().enumerate() {
        let len = u32::try_from(fragment.len()).unwrap();
        let base = u32::MAX - len;
        let mut low_diags = Vec::new();
        let low = lex_fragment(file, fragment, 0, &mut low_diags);
        let mut high_diags = vec![previous.clone()];
        let high = lex_fragment(file, fragment, base, &mut high_diags);
        assert_eq!(format!("{:?}", high_diags[0]), prior_repr);
        assert_eq!(high.len(), low.len(), "case {index}");
        assert_eq!(high_diags.len(), low_diags.len() + 1, "case {index}");
        for (l, h) in low.iter().zip(&high) {
            assert_eq!(h.kind, l.kind);
            assert_eq!(h.string_value, l.string_value);
            assert!(l.span.end <= len);
            assert_eq!(h.span, Span::new(file, base + l.span.start, base + l.span.end));
        }
        for (l, h) in low_diags.iter().zip(&high_diags[1..]) {
            assert_ne!(h.code, "E1008");
            assert_eq!((h.code, h.severity, &h.message, &h.tags), (l.code, l.severity, &l.message, &l.tags));
            assert!(l.primary.end <= len);
            assert_eq!(h.primary, Span::new(file, base + l.primary.start, base + l.primary.end));
            assert!(l.related.is_empty() && h.related.is_empty());
        }
        let mut refusal_diags = vec![previous.clone()];
        let refused = lex_fragment(file, fragment, base + 1, &mut refusal_diags);
        assert!(refused.is_empty());
        assert_eq!(refusal_diags.len(), 2);
        assert_eq!(format!("{:?}", refusal_diags[0]), prior_repr);
        let refusal = &refusal_diags[1];
        assert_eq!(refusal.code, "E1008");
        assert_eq!(refusal.severity, Severity::Error);
        assert_eq!(refusal.primary, Span::new(file, base + 1, base + 1));
        assert!(refusal.related.is_empty() && refusal.tags.is_empty());
        println!("case={index} bytes={len} low_tokens={} low_diagnostics={} exact_max_fit=pass next_byte_refusal=pass", low.len(), low_diags.len());
    }
    let mut empty_diags = vec![previous];
    assert!(lex_fragment(file, "", u32::MAX, &mut empty_diags).is_empty());
    assert_eq!(empty_diags.len(), 1);
    assert_eq!(format!("{:?}", empty_diags[0]), prior_repr);
    let info = canlang_compiler::explain::lookup("E1008").unwrap();
    assert_eq!(info.severity, Severity::Error);
    assert_eq!(info.title, "fragment-offset-range");
    let json = canlang_compiler::explain::entry_to_json(info);
    let text = canlang_compiler::explain::entry_to_text(info);
    assert!(json.contains("\"code\":\"E1008\"") && !json.contains('\n'));
    assert!(text.contains("E1008") && text.contains("fragment-offset-range"));
    println!("empty_max_preserves_prior=pass E1008_public_catalog_json_text=pass all_28_offset_controls=pass");
}
