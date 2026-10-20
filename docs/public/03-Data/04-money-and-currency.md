# Money and currency

Represent monetary values with the exact money value type, not binary floating point or formatted text. A money amount carries a currency; comparisons and arithmetic must respect that boundary. Currency conversion is an explicit business operation with an explicit rate source and timing, not an implicit coercion.

## Choose the business rounding boundary

Choose a rounding rule at the business boundary where a fractional minor unit must be resolved, and preserve the original amount, currency, and relevant rate or quote when later audit depends on them. For invoices and payments, snapshot the agreed amount so a changed catalog price cannot rewrite an existing obligation. Display formatting does not change stored precision.

The language's exact numeric and money helpers are listed in [types and builtins](../12-Reference/07-types-and-builtins.md). External settlement is a separate outcome from a successful business transaction; see [payments](../07-Integrations/05-payments.md) and [deliveries and recovery](../07-Integrations/02-deliveries-and-recovery.md).
