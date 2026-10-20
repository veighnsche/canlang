# Types and builtin values

Look up value types, constraints and all 36 source-visible builtins. Worked expressions show expected results, empty-input behavior, numeric precision and the context required for protected operations.

This reference lists the finite source-visible types and builtin signatures. The notation in the signature block describes checking rules; `C<T>`, `O`, `S`, `K`, and `Display` are explanatory variables, not authored generic types or callbacks.

## Value types

| Type | Meaning |
| --- | --- |
| `text`, `bool` | Unicode text and boolean |
| `int`, `decimal` | Checked signed 64-bit integer; exact decimal with at most 38 significant and 18 fractional digits |
| `email`, `url`, `locale` | Validated email; HTTP(S) URL; canonical BCP 47 locale |
| `date`, `datetime`, `duration`, `timezone` | Civil date; millisecond UTC instant; elapsed integer milliseconds; IANA zone |
| `currency`, `money` | Validated ISO currency; exact `{minor:int,currency:currency}` with pinned minor-unit scales |
| `bytes` | Byte quantity for checked limits; comparisons, without arithmetic |
| `user`, `member` | Stable account reference; team membership reference |
| `file`, `secret`, `json` | Finalized immutable file reference; server-only opaque secret; bounded opaque JSON |
| `Model`, `Contract`, `Event` | Stored record reference; named structural value; named event value |
| `Owner.field` | Reused field value type, normalization, and constraints |
| `enum(a,b)` | Closed declaration-owned enum domain |
| `action(Operation,...)` | Finite operation reference with protected record bindings |
| `delivery(Operation)` | Opaque association to one durable delivery |
| `invocation(Operation,...)` | Complete immutable call value for enabled local user mutations |
| `T[]`, `T?`, `A\|B` | Ordered homogeneous array; nullable value; tagged union of supported named types |

Apply at most one array suffix, then an optional nullable-container suffix. `A|B[]?` is a nullable array of union values; nested arrays, nullable elements (`T?[]`), grouped types, primitive unions, and repeated suffixes are invalid. Reuse of `Owner.field` preserves enum identity; identical labels declared elsewhere do not make enum types interchangeable. `Owner.field.case` explicitly names a case of a visible model/contract's singular nonnullable enum field.

## Constraints and initialization

Stored `field:T` requires a create value; `field:T?` defaults to null and `field:T[]` to `[]`. Stored `field:T[]!` requires an explicit array input. `=expr` supplies a create default; `server=expr` initializes a server-owned field excluded from client inputs. Omission on update preserves the old value. Field reuse does not copy defaults, server initialization, required-array creation metadata, uniqueness, ownership, or permissions.

`trim` normalizes text before constraints. `min=expr` and `max=expr` are inclusive length bounds on text/arrays and value bounds on numeric types. `unique` is storage uniqueness; composite uniqueness uses a separate `unique Model fields=...` declaration. Secret fields require server initialization.

## Builtin signatures

`C<T>` is a bounded ordered homogeneous array/query domain. `O` is a nonnullable ordered scalar: int, decimal, duration, money, date, datetime, text, email, url, locale, timezone, currency, or bytes. `S` is text/email/url/locale/timezone/currency. `K` is text/bool/int/decimal/enum/email/url/locale/timezone/currency/date/datetime/duration/money/user/member/same-model identity, optionally nullable. `Display` is nonnull text/email/url/locale/timezone/currency/bool/enum/int/date.

```text
count(domain:C<T>)->int
flatten(domain:C<C<T>>)->T[]
sum(domain:C<int>)->int; sum(domain:C<decimal>)->decimal
sum(domain:C<duration>)->duration; sum(domain:C<money>,currency:currency)->money; sum(domain:nonempty C<money>)->money
min(domain:C<O>)->O?; max(domain:C<O>)->O?; min(domain:nonempty C<O>)->O; max(domain:nonempty C<O>)->O
any(domain:C<T> as x,predicate:bool in x scope)->bool; all(domain:C<T> as x,predicate:bool in x scope)->bool
first(domain:ordered C<T>)->T?
group(domain:C<T> as x,key:K in x scope)->C<{key:K,items:T[]}>
at(array:T[],index:int)->T?
choose(condition:bool,yes:T,no:T)->T
abs(value:int)->int; abs(value:decimal)->decimal; abs(value:duration)->duration; abs(value:money)->money
round(value:int,scale:int)->decimal; round(value:decimal,scale:int)->decimal
lower(value:S)->text; upper(value:S)->text; trim(value:S)->text
contains(value:S,needle:text)->bool; starts_with(value:S,prefix:text)->bool; join(values:C<S>,separator:text)->text
format(template:text,values:closed object of Display)->text; format(descriptor:message,locale:locale?)->text
app_url(path:text)->url
active_member(person:user,team:Team)->bool
overlaps(aStart:date,aEnd:date,bStart:date,bEnd:date)->bool; overlaps(aStart:datetime,aEnd:datetime,bStart:datetime,bEnd:datetime)->bool
local_date(value:datetime,zone:timezone)->date
local_instant(date:date,time:text,zone:timezone,fold:enum(earlier,later))->datetime
add_days(value:date,days:int)->date; add_months(value:date,months:int)->date
date_year(value:date)->int; weekday(value:date)->int; dates(from:date,until:date,limit:int)->date[]
money(value:int,currency:currency)->money; money(value:decimal,currency:currency)->money
date(value:text)->date; datetime(value:text)->datetime
action(target:canonical user mutation,bindings:closed object of every record parameter)->singleton action(target)
invocation(target:canonical local user mutation,arguments:complete owning input object)->singleton invocation(target)
random_secret()->secret
```

## Worked uses of all 36 builtins

Each expression below is public Can source, not a runtime helper API. The complete [BuiltinLookup source](../examples/builtin-lookup/BuiltinLookup.can) supplies `Todo`, contained `Step`, a guarded `finish` operation and the typed parameters used by contextual examples. Run `can check BuiltinLookup.can` after saving that source. Its read operation checks the expressions in context; its result is the membership boolean, not a report of every intermediate value.

Literal examples state their expected values. Record queries use currently readable data: for flattening, two tasks with child titles [A,B] and [C] produce steps [A,B,C] in the corresponding encounter order. No records are seeded by this reference.

| Builtin | Worked source expression | Result or boundary |
| --- | --- | --- |
| `count` | `count([4,7,4])` | `3`; duplicates count. |
| `flatten` | `flatten(Todo as task select task.Step)` | All steps in outer-task then child order; no implicit flattening of ordinary projections. |
| `sum` | `sum([4,7,4])` | `15`. For a possibly empty money query, supply its currency explicitly. |
| `min` | `min([4,7,4])` | `4`; a general possibly empty domain instead yields a nullable result. |
| `max` | `max([4,7,4])` | `7`; incompatible currencies are an error, not a conversion. |
| `any` | `any([4,7,4] as n,n>5)` | `true`; stops at the first match. Empty input yields false. |
| `all` | `all([4,7,4] as n,n>0)` | `true`; empty input also yields true. |
| `first` | `first([4,7,4])` | `4` with nullable result type. Empty input yields null. |
| `group` | `group([4,7,4] as n,n)` | Groups in encounter order: key 4 with items [4,4], then key 7 with items [7]. |
| `at` | `at([4,7,4],1)` | `7`; zero-based. A negative/out-of-range index yields null. |
| `choose` | `choose(true,"Open","Closed")` | `"Open"`; both branch arguments evaluate eagerly. |
| `abs` | `abs(-7)` | `7`; negating the signed minimum cannot produce a representable positive int. |
| `round` | `round(2.345,2)` | Decimal `2.34` by half-even rounding; scale must be 0–18. |
| `lower` | `lower("TASK")` | `"task"`; ordinary text, not a locale-tailored identifier. |
| `upper` | `upper("Task")` | `"TASK"`; result is text. |
| `trim` | `trim("  task  ")` | `"task"`; does not mutate the input. |
| `contains` | `contains("Release checklist","check")` | `true`; literal text matching. |
| `starts_with` | `starts_with("EXP-001","EXP-")` | `true`; the predicate alone does not store normalized data. |
| `join` | `join(["Review","Publish"]," / ")` | `"Review / Publish"`; preserves order. |
| `format` | `format("Task {n}: {name}",{n=3,name="Review"})` | `"Task 3: Review"`; named substitutions, not executable expressions. |
| `app_url` | `app_url("/tasks")` | A URL under the trusted deployed app origin/mount; no access grant. |
| `overlaps` | `overlaps(date("2026-10-20"),date("2026-10-22"),date("2026-10-21"),date("2026-10-23"))` | `true`; half-open ranges sharing only an endpoint do not overlap. |
| `local_date` | `local_date(datetime("2026-10-20T23:30:00.000Z"),"Europe/Brussels")` | Civil date `2026-10-21`. |
| `local_instant` | `local_instant(date("2026-10-20"),"09:00","Europe/Brussels",earlier)` | Instant `2026-10-20T07:00:00.000Z`; a gap fails and an ambiguous fold must be resolved. |
| `add_days` | `add_days(date("2026-10-20"),2)` | Civil date `2026-10-22`; calendar days, not a timezone-dependent instant shift. |
| `add_months` | `add_months(date("2024-01-31"),1)` | `2024-02-29`; month-end clamping. Cycle 2 from the original anchor is March 31. |
| `date_year` | `date_year(date("2026-10-20"))` | `2026`. |
| `weekday` | `weekday(date("2026-10-20"))` | `2` (Tuesday), with Monday=1. |
| `dates` | `dates(date("2026-10-20"),date("2026-10-23"),3)` | October 20, 21 and 22, excluding the end. Limit 2 would fail rather than truncate. |
| `money` | `money(12.345,"EUR")` | EUR 12.34: minor units 1234 after half-even rounding. |
| `date` | `date("2024-02-29")` | A valid leap-day civil date; `date("2025-02-29")` fails. |
| `datetime` | `datetime("2026-10-20T09:00:00+02:00")` | UTC instant `2026-10-20T07:00:00.000Z`. |
| `active_member` | `active_member(person,team)` | True only for a currently active member of the verified team; `person:user` is an input, not an account-directory grant. |
| `action` | `action(finish,{task})` | Binds the task's protected identity/version for the canonical operation; constructing it does not finish the task. |
| `invocation` | `invocation(finish,{task})` | Complete call value because finish has only that task input; later `call value {}` still checks authority and versions. |
| `random_secret` | `Credential {token:secret server=random_secret()}` | A Given declaration, not an expression to call in a page; server-owned initialization produces a stable secret for the committed operation identity. |

`Credential` has no public read policy or CRUD in this example. Never display its secret as a worked output. The full [forms tutorial](../07-Build-interfaces/04-forms-and-inputs.md) shows action/invocation execution; this lookup only constructs them.

### Important overloads

| Use | Source example | Interpretation |
| --- | --- | --- |
| Empty money aggregate | `sum(Todo as task select money(0,"EUR"),"EUR")` | EUR zero even when no readable tasks exist; real totals should project their actual money field |
| Localized human text | `format("Task reminder"@{nl="Taakherinnering"},locale="nl")` | `"Taakherinnering"` for a permitted presentation/outbound sink |
| Duration arithmetic input | `abs(-5m)` | Positive elapsed duration of five minutes |
| Nullable lookup fallback | `at([4,7,4],9) ?? 0` | `0`; a missing index is null, not an unchecked access |

Localized format results cannot become business keys, guards or ordinary business fields. Use [recipient-localized notices](../07-Build-interfaces/06-localization.md#send-notices-in-the-recipients-language) for a complete outbound example. Money, temporal and collection details have worked chapters in [queries](../04-Model-and-query-data/03-queries-and-aggregates.md), [money](../04-Model-and-query-data/04-money-and-currency.md) and [dates](../04-Model-and-query-data/05-dates-and-timezones.md).

## Evaluation and result boundaries

Ordinary arguments evaluate eagerly once in written order, including both alternatives of `choose`; `choose` does not narrow nullability or short-circuit an unauthorized read. Positional arguments precede named arguments. `and`, `or`, `??`, safe access, and alias-scoped query predicates keep their specified lazy behavior. There is no `coalesce` builtin or unchecked array indexing.

`count` returns zero for an empty domain. Empty int/decimal/duration sums yield typed zero. Money sums need an explicit currency unless a statically nonempty array literal proves a value exists; all currencies must match. General `min`/`max` and `first` return null on empty input. A nonempty array literal makes `min`/`max` nonnullable; `first` still requires stable ordering and returns nullable. `any` and `all` stop at the first decisive predicate, giving false and true respectively for empty input. `group` preserves first-encounter group order and item order, and supplies exactly `{key,items}`. `flatten` expands one collection layer while preserving order and duplicates. Bounds fail explicitly rather than truncate.

`round` accepts scale 0–18 and rounds half-even. Money construction/arithmetic rounds once to the currency's minor-unit scale, half-even. Cross-currency addition, subtraction, ordering, aggregation, or money ratios fail; conversion is explicit. Integer and duration overflow, decimal overflow, and zero divisors fail. Text helpers operate on Unicode scalars, with no implicit normalization or locale tailoring; transformation results are ordinary text.

Plain `format` accepts named substitutions with a closed `Display` object; decimal/money/datetime plain interpolation is excluded. The message overload requires explicit `locale=`, with null selecting the app default; its result retains presentation-only restrictions. `app_url` accepts an app-relative slash-prefixed path against trusted deployment origin/mount context, rejects paths escaping that prefix, and grants no access.

`date` accepts checked `YYYY-MM-DD` text, and `datetime` a checked RFC3339 instant; nonzero sub-millisecond fractions fail. Duration literals use `ms`, `s`, `m`, `h`, or `d` (exactly 24 hours); bytes use `B`, `KiB`, `MiB`, or `GiB`. `dates` uses a half-open interval and fails on reversed ranges, nonpositive limits, or excess work. `weekday` is Monday=1 through Sunday=7. `add_months` clamps to the target month's last day; recurring calculations use the original anchor and absolute cycle offset. `local_instant` rejects nonexistent local times and requires earlier/later fold resolution for ambiguity.

`active_member` is a contextual state read, not a context-free constant or historical-membership predicate. `random_secret` is allowed only in server defaults and yields a stable 32-byte secret for a committed operation identity. Action/invocation construction grants no permission; canonical execution checks current admission, versions, and rules.

See [expressions](../02-Language-foundations/03-expressions-and-derives.md), [queries](../04-Model-and-query-data/03-queries-and-aggregates.md), and [defaults](../04-Model-and-query-data/02-defaults-and-validation.md). These signatures follow the [language design](https://github.com/veighnsche/canlang/blob/main/docs/specification/DESIGN.md#3-expressions-queries-and-scopes) and [source-visible Values catalog](https://github.com/veighnsche/canlang/blob/main/packages/values/src/catalog.ts); internal lowering helpers are not additional source builtins.
