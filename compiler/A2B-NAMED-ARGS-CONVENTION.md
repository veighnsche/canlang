# A2b: named-arguments convention — evidence + proposal (for C stdlib review)

Compiler-side draft (A2b scope, base `d93fc4b`). No checker/emitter
edits. Implementation follows C's review + a later grant.

## 1. Corpus evidence (all 12 sites)

Every `named arguments have no §13 lowering` diagnostic in the B8 raw
list (`evidence/G-b8-raw-diags.json` rows 56–67) is one shape in
`tests/e2e/fixtures/patched-pilot/Locations.can`:

```can
local_instant(<date>, <time-text>, <timezone>, fold=<enum>)
```

3 positional args + exactly one named arg (`fold=`), in rule
predicates (`policy_open` body, `WeeklyHours`/`DateHours`
invariants, `dated_open` body). No other builtin, no other named
parameter, no named-before-positional, no duplicates appear.

## 2. What each side already guarantees

- DESIGN:259 fixes the signature:
  `local_instant(date:date,time:text,zone:timezone,fold:enum(earlier,later))->datetime`.
- DESIGN:230 requires `fold=earlier|later` for ambiguous local times;
  DESIGN:277 enforces "named/positional argument order, unique
  argument names and these exact arities".
- Analysis binds named args today (`bind_arguments`,
  `compiler/src/analysis/types.rs:13928`): positional fill the next
  unfilled parameter in order, named fill by name; check is green.
- The stdlib JS function is positional today:
  `local_instant(date, "12:00", "UTC", "earlier")`
  (`packages/values/test/timezone.test.ts:68`).
- The emitter rejects **all** named args up front (`ir.rs:2788`),
  except the `format` locale carve-out (named locale consumed
  specially below that gate).

So the gap is purely the call-lowering mapping, and the only live
shape is trailing-`fold=`.

## 3. Proposal: named → positional in signature order

The compiler keeps one rule for every builtin call: after analysis
binds arguments to catalog-signature parameters, the emitter passes
values **positionally in signature order**. Names never reach the
wire:

```js
local_instant(day, opens, tz, fold)   // from fold=<expr> 4th
```

Consequences:

- `local_instant` needs no stdlib change (4 positional params
  already).
- The `format` carve-out stays as the single documented exception
  (locale is not a positional parameter of its JS shape).
- Duplicates, unknown names, missing/extra args stay analysis
  errors (already enforced); the emitter never reorders
  ambiguously.
- Future builtins with named params lower by the same rule at no
  per-builtin cost, as long as their JS signatures stay positional.

## 4. Questions for C

1. Confirm stdlib JS signatures stay positional (no options-object
   overloads), so the compiler rule holds for all builtins.
2. Confirm the `fold` enum wire spelling (`"earlier"`/`"later"`
   strings, as the timezone tests show).
3. Is there any current/future builtin whose named argument must
   NOT be positionalized (a second `format`-style exception)?

## 5. Rejected alternative

Emit named args as an options object (`f(a,b,{fold:d})`): rejected
because the stdlib is positional, and per-builtin wire shapes would
split the compiler rule. If C prefers options objects anywhere,
that builtin joins the `format` carve-out list explicitly instead.
