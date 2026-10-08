//! Constant constructor defaults reuse the owning exact Values semantics.

use super::ir::{IrCallTarget, IrExpr, IrUnOp, TypedExpr};
use values_semantics::codecs::numeric::{ScalarName, WireValue, encode_value_scalar};
use values_semantics::numeric::{decimal::parse_decimal, money::make_money_value};
use values_semantics::representations::numeric::Value;

/// Fold only checked Money constructors with literal scalar arguments.
/// Dynamic expressions and owner-rejected values retain explicit refusal.
pub(super) fn money_default_wire(expr: &TypedExpr) -> Option<WireValue> {
    let (target, amount, currency) = match &expr.expr {
        IrExpr::Call { target, args } => {
            let [amount, currency] = args.as_slice() else {
                return None;
            };
            (target, amount, currency)
        }
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => {
            let [Some(amount), Some(currency)] = slots.as_slice() else {
                return None;
            };
            (target, args.get(*amount)?, args.get(*currency)?)
        }
        _ => return None,
    };
    if !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "money") {
        return None;
    }
    let IrExpr::Text(currency) = &currency.expr else {
        return None;
    };
    let amount = literal_amount(amount)?;
    let value = make_money_value(&amount, &Value::Str(currency.clone())).ok()?;
    encode_value_scalar(ScalarName::Money, &Value::Money(value)).ok()
}

fn literal_amount(expr: &TypedExpr) -> Option<Value> {
    match &expr.expr {
        IrExpr::Int(value) => Some(Value::BigInt((*value).into())),
        IrExpr::Decimal(spelling) => parse_decimal(&Value::Str(spelling.clone()))
            .ok()
            .map(Value::Decimal),
        IrExpr::Unary {
            op: IrUnOp::Neg,
            operand,
        } => match &operand.expr {
            IrExpr::Int(value) => Some(Value::BigInt(value.checked_neg()?.into())),
            IrExpr::Decimal(spelling) => parse_decimal(&Value::Str(format!("-{spelling}")))
                .ok()
                .map(Value::Decimal),
            _ => None,
        },
        _ => None,
    }
}
