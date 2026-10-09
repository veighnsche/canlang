//! Independent byte contracts for descriptor Serde adapters and exact literals.
use canlang_compiler::analysis::types::ResolvedType;
use canlang_compiler::codegen::ir::{IrCallTarget, IrExpr, IrUnOp, TypedExpr};
use canlang_compiler::codegen::js::*;
use canlang_compiler::source::{SourceId, Span};

fn expr(value: IrExpr) -> TypedExpr {
    TypedExpr::new(value, ResolvedType::Unknown, Span::new(SourceId(0), 0, 0))
}
fn delivery() -> JsDeliveryDescriptor {
    JsDeliveryDescriptor {
        capability: "std.EmailV1".into(),
        operation: "send".into(),
        version: 1,
        result: JsNominalResult {
            name: "Receipt".into(),
            fields: vec![
                JsNominalLeaf {
                    name: "z".into(),
                    declared: "text?".into(),
                    constraints: JsValueConstraints::default(),
                },
                JsNominalLeaf {
                    name: "a".into(),
                    declared: "file[]".into(),
                    constraints: JsValueConstraints::default(),
                },
            ],
        },
    }
}
#[test]
fn nested_delivery_and_nominal_order() {
    let expected = r#"{"kind":"delivery","capability":"std.EmailV1","operation":"send","version":1,"result":{"name":"Receipt","fields":[{"name":"z","type":"text?"},{"name":"a","type":"file[]"}]}}"#;
    assert_eq!(delivery().to_json(), expected);
    assert_eq!(JsMcpField::Delivery(delivery()).to_json(), expected);
    assert_eq!(JsModelFieldType::Delivery(delivery()).to_json(), expected);
}
#[test]
fn operation_order_omissions_and_present_empty_metadata() {
    let mut input = JsOperationField {
        name: "id".into(),
        value_type: None,
        computed_default: false,
        field: JsMcpField::Ref {
            model: "P.Row".into(),
            require_version: false,
        },
        required: true,
        nullable: false,
        array_required: None,
        default: None,
        description: None,
        choices: None,
    };
    assert_eq!(
        input.to_json(),
        r#"{"name":"id","field":{"kind":"ref","model":"P.Row","requireVersion":false},"required":true}"#
    );
    input.nullable = true;
    input.array_required = Some(false);
    input.default = Some(JsFieldDefault::Literal(
        r#"{"z":["9223372036854775807",null],"a":true}"#.into(),
    ));
    input.description = Some("".into());
    let operation = JsOperation {
        name: "P.go".into(),
        kind: JsOperationKind::Scenario,
        description: "é😀\n\t\u{8}\u{c}\u{1}\"\\".into(),
        inputs: vec![input],
        result: None,
    };
    assert_eq!(
        operations_json(&[operation]),
        r#"[{"name":"P.go","kind":"scenario","description":"é😀\n\t\u0008\u000c\u0001\"\\","inputs":{"fields":[{"name":"id","field":{"kind":"ref","model":"P.Row","requireVersion":false},"required":true,"nullable":true,"array":{"required":false},"default":{"kind":"literal","value":{"z":["9223372036854775807",null],"a":true}},"description":""}]}}]"#
    );
    assert_eq!(operations_json(&[]), "[]");
}
#[test]
fn all_tags_and_defaults_are_closed() {
    let fields = [
        JsMcpField::String,
        JsMcpField::Integer,
        JsMcpField::Decimal,
        JsMcpField::Money,
        JsMcpField::Datetime,
        JsMcpField::Boolean,
        JsMcpField::File,
    ];
    for (field, tag) in fields.iter().zip([
        "string", "integer", "decimal", "money", "datetime", "boolean", "file",
    ]) {
        assert_eq!(field.to_json(), format!(r#"{{"kind":"{tag}"}}"#));
    }
    assert_eq!(
        JsMcpField::Enum {
            values: vec!["z".into(), "a".into()]
        }
        .to_json(),
        r#"{"kind":"enum","values":["z","a"]}"#
    );
    let fields = [
        JsModelFieldType::String,
        JsModelFieldType::Integer,
        JsModelFieldType::Decimal,
        JsModelFieldType::Money,
        JsModelFieldType::Datetime,
        JsModelFieldType::Boolean,
        JsModelFieldType::File,
        JsModelFieldType::Date,
        JsModelFieldType::Duration,
        JsModelFieldType::Secret,
        JsModelFieldType::User,
        JsModelFieldType::Member,
        JsModelFieldType::Json,
        JsModelFieldType::Bytes,
    ];
    for (field, tag) in fields.iter().zip([
        "string", "integer", "decimal", "money", "datetime", "boolean", "file", "date", "duration",
        "secret", "user", "member", "json", "bytes",
    ]) {
        assert_eq!(field.to_json(), format!(r#"{{"kind":"{tag}"}}"#));
    }
    assert_eq!(
        JsModelFieldType::Ref {
            model: "P.Row".into()
        }
        .to_json(),
        r#"{"kind":"ref","model":"P.Row"}"#
    );
    assert_eq!(
        JsModelFieldType::Enum { values: vec![] }.to_json(),
        r#"{"kind":"enum","values":[]}"#
    );
    assert_eq!(
        JsModelFieldType::Other {
            type_id: "P.X".into()
        }
        .to_json(),
        r#"{"kind":"other","type":"P.X"}"#
    );
    assert_eq!(
        JsFieldDefault::Parent {
            path: "parent.user".into()
        }
        .to_json(),
        r#"{"kind":"parent","path":"parent.user"}"#
    );
    assert_eq!(JsFieldDefault::Derived.to_json(), r#"{"kind":"derived"}"#);
    for (init, tag) in [
        (JsServerInit::Actor, "actor"),
        (JsServerInit::Now, "now"),
        (JsServerInit::RandomSecret, "random_secret"),
        (JsServerInit::Computed, "computed"),
    ] {
        assert_eq!(
            JsFieldDefault::Server(init).to_json(),
            format!(r#"{{"kind":"server","init":"{tag}"}}"#)
        );
        assert_eq!(serde_json::to_string(&init).unwrap(), init.to_json());
    }
    assert!(serde_json::to_string(&JsFieldDefault::Literal("invalid".into())).is_err());
}
#[test]
fn model_order_optional_members_and_array_false() {
    let mut model = JsModel {
        name: "P.Row".into(),
        fields: vec![JsModelField {
            value_type: None,
            name: "value".into(),
            field: JsModelFieldType::Integer,
            required: false,
            nullable: false,
            trim: None,
            min: None,
            max: None,
            server_only: true,
            array_required: None,
            default: None,
            description: None,
            machine: None,
        }],
        delete_mode: "none".into(),
        unique_keys: vec![],
        parent: None,
        scope_app: false,
    };
    assert_eq!(
        model.to_json(),
        r#"{"name":"P.Row","fields":[{"name":"value","field":{"kind":"integer"},"required":false,"serverOnly":true}],"deleteMode":"none"}"#
    );
    model.fields[0].nullable = true;
    model.fields[0].array_required = Some(false);
    model.fields[0].default = Some(JsFieldDefault::Literal("null".into()));
    model.fields[0].description = Some("".into());
    model.unique_keys = vec!["z".into(), "a".into()];
    model.parent = Some("".into());
    model.scope_app = true;
    assert_eq!(
        models_json(&[model]),
        r#"[{"name":"P.Row","fields":[{"name":"value","field":{"kind":"integer"},"required":false,"serverOnly":true,"nullable":true,"array":{"required":false},"default":{"kind":"literal","value":null},"description":""}],"deleteMode":"none","uniqueKeys":["z","a"],"parent":"","scope":"app"}]"#
    );
    assert_eq!(models_json(&[]), "[]");
}
#[test]
fn exact_literal_scalars_nested_order_and_controls() {
    let literal = expr(IrExpr::Object(vec![
        (
            "z".into(),
            expr(IrExpr::Array(vec![
                expr(IrExpr::Int(9223372036854775807)),
                expr(IrExpr::Decimal("12345678901234567890.1200".into())),
                expr(IrExpr::DurationMs(1200)),
                expr(IrExpr::Money {
                    minor: 9223372036854775807,
                    currency: "EUR".into(),
                }),
                expr(IrExpr::Bool(true)),
                expr(IrExpr::Null),
            ])),
        ),
        (
            "a\n".into(),
            expr(IrExpr::Text("é😀\u{0}\u{8}\u{c}\r\t\"\\".into())),
        ),
        ("z".into(), expr(IrExpr::Date("2026-10-07".into()))),
    ]));
    assert_eq!(
        literal_json(&literal).unwrap(),
        r#"{"z":["9223372036854775807","12345678901234567890.1200","1200",{"minor":"9223372036854775807","currency":"EUR"},true,null],"a\n":"é😀\u0000\u0008\u000c\r\t\"\\","z":"2026-10-07"}"#
    );
    for (value, expected) in [
        (IrExpr::Int(i128::MAX), format!("\"{}\"", i128::MAX)),
        (IrExpr::Int(i128::MIN), format!("\"{}\"", i128::MIN)),
        (IrExpr::Bool(false), "false".into()),
        (
            IrExpr::Datetime("2030-01-01T00:00:00Z".into()),
            "\"2030-01-01T00:00:00.000Z\"".into(),
        ),
    ] {
        assert_eq!(literal_json(&expr(value)).unwrap(), expected);
    }
}
#[test]
fn unary_overflow_and_nonliteral_rejection_and_constructor_calls() {
    let neg = |value| {
        expr(IrExpr::Unary {
            op: IrUnOp::Neg,
            operand: Box::new(expr(value)),
        })
    };
    assert_eq!(literal_json(&neg(IrExpr::Int(42))), Some("\"-42\"".into()));
    assert_eq!(
        literal_json(&neg(IrExpr::Decimal("1.500".into()))),
        Some("\"-1.500\"".into())
    );
    assert_eq!(literal_json(&neg(IrExpr::Int(i128::MIN))), None);
    assert_eq!(
        literal_json(&expr(IrExpr::Array(vec![expr(IrExpr::Name("x".into()))]))),
        None
    );
    let call = |id: &str, args| {
        expr(IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: id.into(),
                awaited: false,
            },
            args,
        })
    };
    assert_eq!(
        literal_json(&call(
            "money",
            vec![expr(IrExpr::Int(7)), expr(IrExpr::Text("EUR".into()))]
        )),
        Some(r#"{"minor":"700","currency":"EUR"}"#.into())
    );
    for (id, source, expected) in [
        ("date", "2026-10-07", "\"2026-10-07\""),
        (
            "datetime",
            "2030-01-01T01:00:00+01:00",
            "\"2030-01-01T00:00:00.000Z\"",
        ),
    ] {
        assert_eq!(
            literal_json(&call(id, vec![expr(IrExpr::Text(source.into()))])),
            Some(expected.into())
        );
    }
}
