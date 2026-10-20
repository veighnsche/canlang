# Calculate money and choose rounding boundaries

Calculate expense totals with exact money values, keep currencies compatible, and understand half-even rounding. Choose whether the business rounds each line or the final total and preserve that decision.

## Construct an amount with its currency

`money(25,"EUR")` represents EUR 25.00, not 25 cents. It constructs a typed value whose `minor` is an integer and whose `currency` carries the ISO currency code. Use money for amounts, not binary floating point, formatted text or an unlabelled decimal.

These are value expressions for an expected money value:

```can
money(12.50,"EUR")
```

```can
money(5,"USD")
```

The first has `minor=1250`; the second has `minor=500`. Currency minor-unit scales are pinned by the language's currency data, so do not assume every currency has two decimal places. Display formatting does not change stored precision.

## Add, subtract, scale and compare

| Expression | Result |
| --- | --- |
| `money(12.50,"EUR")+money(7.50,"EUR")` | EUR 20.00 |
| `money(20,"EUR")-money(7.50,"EUR")` | EUR 12.50 |
| `money(12.50,"EUR")*3` | EUR 37.50 |
| `money(12.50,"EUR")*0.8` | EUR 10.00 |
| `money(20,"EUR")/4` | EUR 5.00 |
| `money(20,"EUR")/money(5,"EUR")` | Decimal ratio `4`, without a currency |
| `money(12.50,"EUR")>money(7.50,"EUR")` | True |

Addition, subtraction, ordering, aggregation and money/money ratios require matching currencies. `money(10,"EUR")+money(5,"USD")` fails; it does not select a rate or add the underlying minor integers. Dividing by zero and overflowing supported numeric bounds also fail.

For a money sum over a possibly empty query, specify its currency and filter the input appropriately, as in the [expense query lesson](03-queries-and-aggregates.md#aggregate-without-mixing-currencies). A currency argument is not conversion.

## Understand half-even rounding

Decimal arithmetic is exact within the supported representation: at most 38 significant digits and 18 fractional places. Arithmetic rounds half-even at its result boundary and checks representation bounds. `round(value,scale)` explicitly rounds an integer or decimal to scale 0–18 and returns a decimal.

Half-even chooses the nearest result; an exact halfway tie chooses the one with an even last retained digit:

| Expression | Result |
| --- | --- |
| `round(2.345,2)` | `2.34` |
| `round(2.355,2)` | `2.36` |
| `money(1.005,"EUR")` | EUR 1.00 |
| `money(1.015,"EUR")` | EUR 1.02 |

Money construction and each money arithmetic operation round once to the currency's minor-unit scale, also half-even. `round` is not a money overload; choose the decimal calculation before constructing an amount when that is the intended business boundary. Decimal literals are validated representations, not silently rounded inputs.

## Choose the business rounding boundary

Three lines priced at a decimal EUR 0.335 illustrate why order matters:

```can
money(0.335,"EUR")*3
```

This rounds each unit to EUR 0.34 before scaling, giving EUR 1.02.

```can
money(0.335*3,"EUR")
```

This multiplies the decimal first, then rounds EUR 1.005 once, giving EUR 1.00. Neither expression decides the business policy for you. State whether the invoice prices each line in money or computes a decimal total before conversion, and apply that rule consistently.

Here is a complete calculation-only app you can save as `MoneyCalculations.can` and check with `can check MoneyCalculations.can`:

```can
app MoneyCalculations
Given
 derive per_unit_total():money = money(0.335,"EUR")*3
 derive final_total():money = money(0.335*3,"EUR")
 derive rounded_rate():decimal = round(2.355,2)
When
Then
 page / title="Money calculations"
  text per_unit_total()
  text final_total()
```

The page displays the two different totals. This app does not persist invoices or make payments. When storing an obligation, snapshot the agreed amount, currency and any relevant original quote or rate so later catalog changes cannot rewrite it.

## Keep conversion and settlement explicit

A cross-currency conversion needs an explicit source, rate, time and rounding policy. Preserve the source amount, destination amount and rate evidence needed for audit. Do not infer conversion by changing the currency field or relabeling minor units.

A successful money calculation or business transaction does not prove external settlement. Use [payments](../08-Connect-services/05-payments.md) and [deliveries and recovery](../08-Connect-services/02-deliveries-and-recovery.md) for provider outcomes. Exact overloads and bounds live in [types and builtins](../13-Language-reference/02-types-and-builtins.md).
