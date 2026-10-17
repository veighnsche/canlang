//! Public message checking preserves calendar dates without inventing a time.
use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn check(declaration: &str) -> (String, Vec<Diagnostic>) {
    let source = format!("app TemporalMessages\nGiven\n message {declaration}\nWhen\nThen\n");
    let mut db = SourceDb::new();
    let id = db.add("temporal-messages.can".into(), source.clone());
    let (_, diagnostics) = check_program(&db, &[id], None);
    (source, diagnostics)
}

#[test]
fn calendar_dates_and_instants_have_distinct_message_formats() {
    for declaration in [
        "calendar(day:date) = \"{day,date}\"@{}",
        "instantDay(at:datetime) = \"{at,date}\"@{}",
        "instantTime(at:datetime) = \"{at,time}\"@{}",
        "translated(day:date) = \"{day,date}\"@{nl=\"{day,date,long}\"}",
        "nested(at:datetime,kind:text) = \"{kind,select,other {{at,time,short}}}\"@{}",
    ] {
        let (_, diagnostics) = check(declaration);
        assert!(diagnostics.is_empty(), "{declaration}: {diagnostics:?}");
    }
    for style in ["short", "medium", "long", "full"] {
        for (ty, format) in [("date", "date"), ("datetime", "date"), ("datetime", "time")] {
            let declaration = format!("styled(value:{ty}) = \"{{value,{format},{style}}}\"@{{}}");
            let (_, diagnostics) = check(&declaration);
            assert!(diagnostics.is_empty(), "{declaration}: {diagnostics:?}");
        }
    }
}

#[test]
fn calendar_date_time_is_rejected_at_the_authored_literal() {
    for (declaration, literal) in [
        (
            "calendarTime(day:date) = \"{day,time}\"@{}",
            "\"{day,time}\"",
        ),
        (
            "translated(day:date) = \"{day,date}\"@{nl=\"{day,time,short}\"}",
            "\"{day,time,short}\"",
        ),
        (
            "nested(day:date,kind:text) = \"{kind,select,other {{day,time}}}\"@{}",
            "\"{kind,select,other {{day,time}}}\"",
        ),
        (
            "translatedNested(day:date,kind:text) = \"{day,date} {kind}\"@{nl=\"{kind,select,other {{day,time}}}\"}",
            "\"{kind,select,other {{day,time}}}\"",
        ),
    ] {
        let (source, diagnostics) = check(declaration);
        assert_eq!(diagnostics.len(), 1, "{declaration}: {diagnostics:?}");
        let diagnostic = &diagnostics[0];
        assert_eq!(diagnostic.code, "E5007");
        assert!(
            diagnostic
                .message
                .contains("time argument 'day' has an incompatible type")
        );
        let start = source.find(literal).unwrap();
        assert_eq!(diagnostic.primary.start as usize, start);
        assert_eq!(diagnostic.primary.end as usize, start + literal.len());
    }
}

#[test]
fn temporal_formats_preserve_coverage_type_and_style_diagnostics() {
    for (declaration, code, message) in [
        (
            "missing(day:date) = \"{unknown,time} {day,date}\"@{}",
            "E3016",
            "names no message parameter",
        ),
        (
            "textTime(value:text) = \"{value,time}\"@{}",
            "E5007",
            "time argument 'value' has an incompatible type",
        ),
        (
            "intDate(value:int) = \"{value,date}\"@{}",
            "E5007",
            "date argument 'value' has an incompatible type",
        ),
        (
            "dateStyle(day:date) = \"{day,date,xx}\"@{}",
            "E5007",
            "unsupported date style 'xx'",
        ),
        (
            "timeStyle(at:datetime) = \"{at,time,xx}\"@{}",
            "E5007",
            "unsupported time style 'xx'",
        ),
        (
            "dateTimeStyle(day:date) = \"{day,time,xx}\"@{}",
            "E5007",
            "time argument 'day' has an incompatible type",
        ),
        (
            "selector(day:date) = \"{day,select,other {day}}\"@{}",
            "E5007",
            "select argument 'day' has an incompatible type",
        ),
    ] {
        let (_, diagnostics) = check(declaration);
        assert_eq!(diagnostics.len(), 1, "{declaration}: {diagnostics:?}");
        assert_eq!(diagnostics[0].code, code);
        assert!(diagnostics[0].message.contains(message), "{diagnostics:?}");
    }
}
