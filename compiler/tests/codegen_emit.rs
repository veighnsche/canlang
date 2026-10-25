//! Emitted-code classifiers and the Money default fold (lane-01 codegen).
//!
//! Pins the §13 scalar/async classifiers (`scalar_family`, `is_structural`,
//! `expr_uses_async`) and the `money_default_wire` fold as observed through
//! `js::literal_json` (`money_default_wire` itself is `pub(super)` to the
//! codegen module, so the wire encoding is the public contract).

use canlang_compiler::analysis::types::{ResolvedType, Scalar};
use canlang_compiler::codegen::ir::{
    IrCallTarget, IrExpr, IrQuery, IrQueryDomain, IrUnOp, ScalarFamily, TypedExpr, expr_uses_async,
    is_structural, scalar_family,
};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceId, Span};

fn sp() -> Span {
    Span::new(SourceId(0), 0, 0)
}

fn typed(expr: IrExpr, ty: ResolvedType) -> TypedExpr {
    TypedExpr::new(expr, ty, sp())
}

fn int_ty() -> ResolvedType {
    ResolvedType::Scalar(Scalar::Int)
}

fn money_call(amount: TypedExpr, currency: &str) -> TypedExpr {
    typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "money".to_string(),
                awaited: false,
            },
            args: vec![amount, typed(IrExpr::Text(currency.to_string()), int_ty())],
        },
        ResolvedType::Scalar(Scalar::Money),
    )
}

fn wire_json(expr: &TypedExpr) -> serde_json::Value {
    let json = js::literal_json(expr).expect("money constructor folds to wire JSON");
    serde_json::from_str(&json).expect("wire JSON parses")
}

#[test]
fn scalar_family_maps_checked_types_to_lowering_family() {
    use ScalarFamily::*;
    let cases = [
        (ResolvedType::Scalar(Scalar::Int), Some(Int)),
        (ResolvedType::Scalar(Scalar::Decimal), Some(Decimal)),
        (ResolvedType::Scalar(Scalar::Money), Some(Money)),
        (ResolvedType::Scalar(Scalar::Duration), Some(Duration)),
        (ResolvedType::Scalar(Scalar::Date), Some(Date)),
        (ResolvedType::Scalar(Scalar::Datetime), Some(Datetime)),
        (ResolvedType::Scalar(Scalar::Bool), Some(Bool)),
        (ResolvedType::Scalar(Scalar::Text), Some(Text)),
        (ResolvedType::Scalar(Scalar::Email), Some(Text)),
        (ResolvedType::Scalar(Scalar::Url), Some(Text)),
        (ResolvedType::Scalar(Scalar::Locale), Some(Text)),
        (ResolvedType::Scalar(Scalar::Timezone), Some(Text)),
        (ResolvedType::Scalar(Scalar::Currency), Some(Text)),
        (ResolvedType::Scalar(Scalar::User), Some(Reference)),
        (ResolvedType::Scalar(Scalar::Member), Some(Reference)),
        (ResolvedType::Scalar(Scalar::File), Some(Reference)),
        (ResolvedType::Scalar(Scalar::Json), Some(Reference)),
        (ResolvedType::Scalar(Scalar::Bytes), Some(Reference)),
        (ResolvedType::Scalar(Scalar::Secret), Some(Secret)),
        (
            ResolvedType::Enum {
                cases: vec!["a".to_string()],
                owner: None,
            },
            Some(Enum),
        ),
        (ResolvedType::Team, Some(Reference)),
        (ResolvedType::OperationContext, Some(Reference)),
        // Nullable unwraps one layer.
        (
            ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Money))),
            Some(Money),
        ),
        (
            ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text))),
            Some(Text),
        ),
        // Null matches any nullable side during comparison lowering and
        // classifies as nothing here.
        (ResolvedType::Null, None),
        (
            ResolvedType::Array {
                element: Box::new(int_ty()),
                ordered: true,
                nonempty: false,
            },
            None,
        ),
        (
            ResolvedType::Object(vec![("a".to_string(), int_ty())]),
            None,
        ),
        (ResolvedType::Error, None),
        (ResolvedType::Unknown, None),
        (ResolvedType::Opaque("deferred"), None),
    ];
    for (ty, expected) in cases {
        assert_eq!(scalar_family(&ty), expected, "{ty:?}");
    }
}

#[test]
fn is_structural_splits_value_compared_types() {
    let structural = [
        ResolvedType::Array {
            element: Box::new(int_ty()),
            ordered: true,
            nonempty: false,
        },
        ResolvedType::Object(vec![("a".to_string(), int_ty())]),
        ResolvedType::StdNominal {
            name: "IncomingEmail",
            fields: vec![],
        },
        ResolvedType::Nullable(Box::new(ResolvedType::Object(vec![]))),
    ];
    for ty in structural {
        assert!(is_structural(&ty), "{ty:?}");
    }
    let identical = [
        ResolvedType::Scalar(Scalar::Int),
        ResolvedType::Scalar(Scalar::Money),
        ResolvedType::Scalar(Scalar::Text),
        ResolvedType::Enum {
            cases: vec!["a".to_string()],
            owner: None,
        },
        ResolvedType::Team,
        ResolvedType::Null,
        ResolvedType::Nullable(Box::new(int_ty())),
    ];
    for ty in identical {
        assert!(!is_structural(&ty), "{ty:?}");
    }
}

#[test]
fn expr_uses_async_detects_awaited_sources() {
    let sync_leaf = || typed(IrExpr::Int(1), int_ty());
    assert!(!expr_uses_async(&sync_leaf()));
    // A plain builtin call stays synchronous.
    let plain = typed(
        IrExpr::Call {
            target: IrCallTarget::Builtin {
                id: "money".to_string(),
                awaited: false,
            },
            args: vec![sync_leaf()],
        },
        int_ty(),
    );
    assert!(!expr_uses_async(&plain));
    // Awaited builtins, capability ops, derive calls, and delivery reads
    // all need the async carrier.
    for expr in [
        typed(
            IrExpr::Call {
                target: IrCallTarget::Builtin {
                    id: "count".to_string(),
                    awaited: true,
                },
                args: vec![],
            },
            int_ty(),
        ),
        typed(
            IrExpr::Call {
                target: IrCallTarget::CapabilityOp("pkg.Op".to_string()),
                args: vec![],
            },
            int_ty(),
        ),
        typed(
            IrExpr::Call {
                target: IrCallTarget::DeriveFn("App.fn".to_string()),
                args: vec![],
            },
            int_ty(),
        ),
        typed(
            IrExpr::DeliveryRead {
                record: Box::new(sync_leaf()),
                field: "status".to_string(),
                props: vec![],
                callback: None,
            },
            int_ty(),
        ),
    ] {
        assert!(expr_uses_async(&expr), "{:?}", expr.expr);
    }
    // Async propagates through wrappers.
    let awaited = || {
        typed(
            IrExpr::Call {
                target: IrCallTarget::Builtin {
                    id: "count".to_string(),
                    awaited: true,
                },
                args: vec![],
            },
            int_ty(),
        )
    };
    let nested = [
        typed(
            IrExpr::Unary {
                op: IrUnOp::Neg,
                operand: Box::new(awaited()),
            },
            int_ty(),
        ),
        typed(IrExpr::Array(vec![sync_leaf(), awaited()]), int_ty()),
        typed(
            IrExpr::Lambda {
                param: "row".to_string(),
                body: Box::new(awaited()),
            },
            int_ty(),
        ),
        typed(
            IrExpr::Query(IrQuery {
                source: None,
                collection_call: None,
                contract_collection_call: None,
                domain: IrQueryDomain::Model("App.Thing".to_string()),
                parent: None,
                where_param: "row".to_string(),
                where_pred: None,
                where_async: false,
                order: vec![],
                value_order: None,
                limit: None,
                archived: None,
                select: None,
                select_param: None,
            }),
            int_ty(),
        ),
    ];
    for expr in nested {
        assert!(expr_uses_async(&expr), "{:?}", expr.expr);
    }
    // A value-domain query over a sync base stays synchronous.
    let value_query = typed(
        IrExpr::Query(IrQuery {
            source: None,
            collection_call: None,
            contract_collection_call: None,
            domain: IrQueryDomain::Value {
                base: Box::new(sync_leaf()),
                alias: "row".to_string(),
            },
            parent: None,
            where_param: "row".to_string(),
            where_pred: None,
            where_async: false,
            order: vec![],
            value_order: None,
            limit: None,
            archived: None,
            select: None,
            select_param: None,
        }),
        int_ty(),
    );
    assert!(!expr_uses_async(&value_query));
}

#[test]
fn money_constructor_default_folds_to_owner_wire_value() {
    // Fraction, integer, and negative-decimal spellings agree with the
    // owning public Values API (see `money_defaults.rs`).
    let cases = [
        ("0.20", "EUR", "20"),
        ("2", "EUR", "200"),
        ("-1.005", "EUR", "-100"),
        ("1.5", "JPY", "2"),
    ];
    for (spelling, currency, minor) in cases {
        let amount = if let Ok(int) = spelling.parse::<i128>() {
            typed(IrExpr::Int(int), int_ty())
        } else {
            let (negated, digits) = match spelling.strip_prefix('-') {
                Some(rest) => (true, rest),
                None => (false, spelling),
            };
            let decimal = typed(
                IrExpr::Decimal(digits.to_string()),
                ResolvedType::Scalar(Scalar::Decimal),
            );
            if negated {
                typed(
                    IrExpr::Unary {
                        op: IrUnOp::Neg,
                        operand: Box::new(decimal),
                    },
                    ResolvedType::Scalar(Scalar::Decimal),
                )
            } else {
                decimal
            }
        };
        let value = wire_json(&money_call(amount, currency));
        assert_eq!(value["minor"], minor, "{spelling} {currency}");
        assert_eq!(value["currency"], currency, "{spelling} {currency}");
    }
    // Named-argument (bound) calls fold through their slots too.
    let bound = typed(
        IrExpr::BoundCall {
            target: IrCallTarget::Builtin {
                id: "money".to_string(),
                awaited: false,
            },
            args: vec![
                typed(
                    IrExpr::Decimal("0.10".to_string()),
                    ResolvedType::Scalar(Scalar::Decimal),
                ),
                typed(IrExpr::Text("EUR".to_string()), int_ty()),
            ],
            slots: vec![Some(0), Some(1)],
        },
        ResolvedType::Scalar(Scalar::Money),
    );
    let value = wire_json(&bound);
    assert_eq!(value["minor"], "10");
    assert_eq!(value["currency"], "EUR");
    // Dynamic amounts and non-money shapes retain explicit refusal.
    let dynamic = money_call(typed(IrExpr::Name("amount".to_string()), int_ty()), "EUR");
    assert_eq!(js::literal_json(&dynamic), None);
    let bare = typed(IrExpr::Name("amount".to_string()), int_ty());
    assert_eq!(js::literal_json(&bare), None);
}
