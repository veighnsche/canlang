# Query and summarize expense records

Filter, order, project and group the expense app's authorized records. Build totals with explicit currencies, handle empty results, and distinguish query aliases from interface selectors.

## Start with the expense data model

Use the complete [ExpenseData app](01-models-and-relationships.md). The expressions below require its `Expense` and `CostCentre` models; they are expression fragments, not standalone files or new permissions. Add the complete helper block later on this page inside that app's `Given` section.

For the expected results below, assume these are the only readable, unarchived expenses. Create the two cost centres first, use a valid payee for each expense, and retain the app's draft status. `recorded_at` comes from the server; create records in the displayed order when testing creation order.

| Receipt | Cost centre | Amount | Purpose |
| --- | --- | --- | --- |
| `E-001` | Travel | EUR 12.50 | Train to client |
| `E-002` | Travel | EUR 7.50 | Taxi to station |
| `E-003` | Office | EUR 30.00 | Printer paper |
| `U-001` | Office | USD 5.00 | Reference guide |

## Filter with a named alias

```can
Expense as expense where expense.amount.currency=="EUR"
```

This returns the three EUR expense records. `as expense` binds each record for the clauses that follow; it does not bind a current record before the query or outside it. Conditions can combine typed expressions:

```can
Expense as expense where expense.amount.currency=="EUR" and contains(lower(expense.purpose),"train")
```

This selects `E-001`. `and` evaluates left to right and short-circuits. A filter narrows the already authorized dataset; it cannot grant access to a hidden amount or purpose. A row missing a required filter-field grant is excluded before that condition is evaluated, not exposed through a count.

## Order and project the result

```can
Expense as expense where expense.amount.currency=="EUR" order=expense.receipt_number select expense.purpose
```

This returns the text array `["Train to client","Taxi to station","Printer paper"]`. Omitting `select` returns records. Projection produces the selected values; it does not update stored fields or implicitly flatten arrays.

Use a leading minus for descending ordering:

```can
Expense as expense order=-expense.recorded_at select expense.receipt_number
```

The minus marks descending order; it does not negate a datetime. Records use `created,id` by default, and an ID tie-breaker makes record ordering stable. If creation timestamps tie, do not infer their order from the order in which you clicked controls. Use an explicit field such as receipt number when that is the required business order.

Array queries have the same clauses but preserve original input position for equal-key ties. For example:

```can
[3,1,3,2] as value where value>1 order=-value select value*10
```

The result is `[30,30,20]`. The input array is unchanged and its duplicate values remain. Filtering precedes ordering, which precedes projection. Ordering keys are evaluated once per surviving item; failures stop the query rather than silently dropping bad values.

## Keep the clause order explicit

The query tail order is `archived=include`, `as`, `where`, `order=`, then `select`, each at most once. Omit clauses you do not need, but do not reorder or repeat them. There is no SQL-style `group by`, query-tail `limit` or implicit join.

This expression includes archived expenses that the caller may read:

```can
Expense archived=include as expense order=expense.receipt_number
```

Expired content remains excluded. Parenthesize a query used inside a larger expression. Call commas separate arguments, not query order keys; `sum(query,currency)` has two arguments. Query `order=` takes one expression, whereas UI collection attributes can take field-selector lists. See [expressions and scopes](../02-Language-foundations/03-expressions-and-derives.md#queries-introduce-explicit-aliases).

## Aggregate without mixing currencies

Add this block to `Given` in `ExpenseData.can`, retaining the existing declarations and sections:

```can
derive expense_count():int = count(Expense)
derive euro_total():money = sum(Expense as expense where expense.amount.currency=="EUR" select expense.amount,currency="EUR")
derive euro_receipts():text[] = Expense as expense where expense.amount.currency=="EUR" order=expense.receipt_number select expense.receipt_number
derive first_euro():Expense? = first(Expense as expense where expense.amount.currency=="EUR" order=expense.receipt_number)
derive has_large_euro():bool = any(Expense as expense,expense.amount.currency=="EUR" and expense.amount>money(20,"EUR"))
```

The sample results are `4`, EUR `50.00`, `["E-001","E-002","E-003"]`, the `E-001` record and `true`. The USD amount is excluded before the EUR sum or comparison. Passing `currency="EUR"` tells the sum how to represent an empty result; it does not convert USD values into EUR.

Call these helpers only where their record-read dependencies and team context are available. A pure helper does not turn a viewer query into a privileged report. Save the file and run `can check ExpenseData.can`; to display results, add `text expense_count()` or `text euro_total()` inside its page and check/refresh the preview.

## Group expenses by a typed key

```can
group(Expense as expense where expense.amount.currency=="EUR",expense.cost_centre)
```

`group` binds the first argument's alias in its second argument. It returns groups with exactly `key` and `items`: here, `key` is a cost-centre reference and `items` contains that centre's EUR expenses. Travel has two items and Office has one. Group order follows first encounter; item order is preserved. The builtin does not invent a `total` field or dereference the cost centre without permission.

Project the groups to totals with a second explicit alias:

```can
group(Expense as expense where expense.amount.currency=="EUR",expense.cost_centre) as bucket select sum(bucket.items as item select item.amount,currency="EUR")
```

For the sample group's first-encounter order, the result is `[money(20,"EUR"),money(30,"EUR")]`. Do not rely on that group order for a label unless it is the ordering your report intends. Keep each group's `key` beside its calculated total in a report contract or presentation; a total alone loses its category identity.

## Define empty-result behavior

| Expression family | Empty result |
| --- | --- |
| `count(domain)` | `0` |
| `sum` over int, decimal or duration | Typed zero |
| `sum` over money with explicit currency | Zero in that currency |
| General `min(domain)` or `max(domain)` | Null |
| `first(orderedDomain)` | Null |
| `any(domain as item,predicate)` | False |
| `all(domain as item,predicate)` | True |
| `group(domain as item,key)` | Empty group collection |

If a rule means “there is at least one expense and all are EUR”, combine `count(Expense)>0` with the `all` predicate; `all` alone passes for no expenses. `first` requires stable ordering and still returns a nullable record. Use `?.` and `??` or a nonnull guard before reading it. Nonempty array literals can make `min`/`max` nonnullable; do not assume a stored query is nonempty.

Query and aggregate work is bounded. Exceeding a bound fails explicitly rather than returning a silently truncated total. Money sums require an explicit currency unless a statically nonempty array literal proves the currency, and every included amount must match it.

## Query authority and provisional state

A viewer-facing list uses current row and field policies. A privileged report must declare operation admission and the authority under which its data is read, and explain the information it exposes. A query across owners is not a consistency mechanism; cross-owner read views are eventual and mutations cannot atomically span incompatible owners.

A CRUD `when` predicate sees its proposed candidate as `row`, but model scans see provisional owner state immediately before that write: earlier staged effects are visible, while this candidate is not yet staged. During an update, a scan still sees the old stored row. Final invariants inspect completed provisional state. Do not use a pre-write query as a substitute for [storage uniqueness](02-defaults-and-validation.md#enforce-composite-uniqueness-at-the-owner).

Continue with [money calculations](04-money-and-currency.md), [dates and calendar calculations](05-dates-and-timezones.md), or [transactions](../06-Business-workflows/03-transactions-and-concurrency.md).
