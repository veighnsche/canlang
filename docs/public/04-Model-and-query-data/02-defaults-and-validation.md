# Default, validate and uniquely identify expense data

Use the expense app to distinguish omitted inputs, server-owned values and normalized data. Add field bounds, business invariants and composite uniqueness, then verify both accepted and refused records.

## Continue with the expense data app

Use the complete `ExpenseData.can` listing from [models and relationships](01-models-and-relationships.md). The fragments here explain that application; do not paste duplicate model or constraint declarations into it.

Its input contract has three layers: normalize individual values, check their types and bounds, and validate the resulting stored state against invariants and uniqueness. All must succeed before an operation commits. A generated form is a convenient interface to these rules, not their enforcement boundary.

## Choose defaults deliberately

The expense model contains these field declarations:

```can
status:enum(draft,submitted)=draft
tags:text[] max=10
note:text?
```

This is a schema fragment, not an independent `Given` declaration. New expenses receive draft status, an empty tag array and a null note when those inputs are omitted. Defaults do not run again on update.

| Request | Expected behavior |
| --- | --- |
| Create omits `note` | Store null |
| Update omits `note` | Keep its existing value |
| Update supplies `note=null` | Clear the nullable note |
| Update supplies `tags=[]` | Replace the array with an empty array |
| Create omits required `purpose` | Reject the missing input |
| Create supplies `purpose=null` | Reject null for a nonnullable text field |

`=expr` supplies a create default, but does not itself prevent an allowed caller from supplying another value. The sample excludes `status` from the CRUD allowlist, so callers cannot create or edit an arbitrary status through CRUD. A submission workflow would change status through its own authorized operation.

For an explicit array-input requirement, replace `tags:text[] max=10` with `tags:text[]! max=10` in the schema. Omission would then fail, but an explicitly supplied empty array would still be valid. Add `min=1` as a separate rule if at least one tag is required. Apply installed-data changes through [schema migrations](../12-Deploy-and-operate/03-schema-migrations.md).

## Initialize values on the server

The app also declares:

```can
submitted_by:user server=actor
recorded_at:datetime server=now
```

These are fields inside `Expense`, not standalone declarations. `server=` evaluates on creation and excludes the fields from client inputs. The sample's member-only creation supplies an authenticated actor; `now` is the operation's fixed admission time. Supplying a different `submitted_by` from a browser request cannot change that authority.

A nonnullable `user server=actor` requires a nonnull actor on every creation path. A trusted handler with `actor=null` cannot use it without a valid redesign of the attribution contract. Server ownership is not a default that magically invents a user. Likewise, `server=now` records this creation event, not the date printed on a receipt or an unknown historical submission time.

Defaults and server initializers do not have a partially initialized `row` or implicit sibling-field scope. In a contained model they can use a resolved `parent` where permitted, with the same reference and read checks. A mere reference field does not create that parent binding. See [contextual variables](../02-Language-foundations/03-expressions-and-derives.md#contextual-variables-and-lexical-scope).

## Normalize before checking bounds

`purpose:text trim min=1 max=200` first trims the text, then checks inclusive length bounds. `"  Train to client  "` becomes `"Train to client"`; whitespace-only input becomes empty and fails `min=1`. `trim` does not imply lowercasing, case-insensitive identity or Unicode normalization.

| Declaration | Rule |
| --- | --- |
| `receipt_number:text trim min=1 max=80` | Trimmed, nonempty text of at most 80 characters |
| `tags:text[] max=10` | At most ten array elements; their order and duplicates remain |
| `number:int min=1` | An integer value of at least one |
| `last_four:text min=4 max=4` | Exactly four characters; not a digits-only predicate |
| `email:email?` in `Payee` | Null or a validated email value; validation does not verify account ownership |

Normalization and constraints apply through the operation boundary, including callers outside the browser. Do not duplicate them as a weaker client-only rule.

## Validate business relationships with invariants

The sample's positive-amount rule is a `Given` declaration:

```can
invariant Expense: row.amount.minor>0
```

It rejects zero and negative amounts. Use an invariant for strict inequalities and relationships that field bounds alone do not express. A line has its own corresponding invariant; the source does not infer an expense/line total rule from their names.

An invariant constrains resulting stored state. A scenario `require` controls whether an operation may proceed from its current state, and a lock restricts changes to protected values. These serve different purposes; see [invariants and locks](../05-Permissions-and-policy/04-invariants-and-locks.md). Validation failure rejects the operation before commit, including any provisional changes in the transaction.

## Enforce composite uniqueness at the owner

The app declares three different uniqueness rules:

```can
CostCentre {code:text trim min=1 max=20 unique,name:text trim min=1}
unique Expense fields=cost_centre,receipt_number
unique ExpenseLine fields=number
```

These are excerpts of declarations already present in `Given`. The first makes a cost-centre code unique within the team. The second makes the **pair** of cost-centre identity and receipt number unique within the expense's team. It does not make either field independently unique. The third makes a line number unique within its containing expense.

| Proposed records | Result |
| --- | --- |
| Code `TRAVEL`, then `  TRAVEL  ` in the same team | Conflict: trimming produces the same unique code |
| Cost centre A / receipt `R-001`, then the same pair | Conflict |
| Cost centre B / receipt `R-001` | Allowed if the pair is otherwise unused; the receipt number alone is not unique |
| Line 1 twice under one expense | Conflict |
| Line 1 under each of two different expenses | Allowed |

The selected parent, team or app defines the constraint's scope. Checks happen at the storage owner, so concurrent submissions cannot evade uniqueness by both observing an empty result before writing. An application-side search is useful feedback but cannot replace the constraint.

Retained archived records still reserve unique keys until actual disposal. Archiving an expense does not free its cost-centre/receipt pair. New references cannot target an archived cost centre. Null values do not participate in uniqueness unless the constraint's predicate explicitly includes them; the sample's composite fields are nonnullable to avoid an ambiguous optional identifier policy. See [history and retention](06-history-and-retention.md).

## Reuse field constraints in operation parameters

The app's `add_line` scenario uses `number:ExpenseLine.number` and `description:ExpenseLine.description`. Those parameters inherit the referenced fields' value type, normalization and bounds. An empty description or line number zero is rejected before a valid child can be created.

Field-type reuse does not copy create defaults, server initialization, required-array creation markers, uniqueness, ownership or permissions. The `unique ExpenseLine fields=number` declaration remains necessary, and the containing parent must still be resolved and authorized.

Explicit parameter defaults are pure and evaluated once when omitted. Admission through `by` happens before those defaults, so `by` cannot depend on their resolved values. Use a leading `require` for a business check that needs defaulted inputs. See [scenarios and effects](../06-Business-workflows/02-scenarios-and-effects.md).

## Verify accepted and refused data

Use a fresh synthetic cost centre and receipt numbers for these checks so existing retained keys do not obscure the result. In the preview, sign in as a member and select the same team throughout:

1. Create cost centre `TRAVEL` with name `Travel`. Confirm its stored code is `TRAVEL` when entered with surrounding spaces. Try the trimmed duplicate and expect a conflict without another record.
2. Create an expense using that cost centre, receipt `R-001`, purpose `Train to client`, a positive EUR amount and a payee name. Leave nullable refund/note inputs empty and omit tags where the form permits omission. Confirm draft status and the created record.
3. Try a whitespace-only purpose and a zero amount on separate new submissions. Each must fail validation without creating an expense.
4. Submit the same cost-centre/receipt pair again. Expect a conflict. Do not change the constraint merely to make the form submit.
5. On the saved expense, use `add_line` to create line 1 with a positive amount. Try line 1 again under that expense and expect a conflict; the first line remains unchanged.
6. Set a note, then explicitly clear it. Reload to confirm the null value persisted. A request that omits the note must leave it unchanged.
7. Archive the expense and retry its cost-centre/receipt pair. Expect the retained key to remain reserved.

Browser forms may submit explicit empty or default values rather than omit fields. Use authored [behavioral examples](../11-Verify-and-build/02-fixtures-and-examples.md) to distinguish omission from null and to verify supplied server-owned fields are refused. Inspect those attribution fields through an authorized read; the sample's compact list does not display every stored field.

These checks concern the data contract. Broader authorization, approval, retry and concurrent-write behavior belongs in the [workflow and interface journey](../11-Verify-and-build/04-workflow-and-interface-testing.md).
