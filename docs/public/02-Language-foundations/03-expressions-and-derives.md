# Expressions, scopes, and derives

Write predictable calculations with explicit precedence, handle nullable values safely, and reuse pure derives. Learn which names each context supplies and how guards narrow values without granting access.

## Evaluate typed expressions

Expressions include literals, lexical names, field reads, structural values, arrays, calls, operators and bounded queries. They compute typed values; effects belong in an operation's `do` body. There is no assignment expression, arbitrary JavaScript, implicit truthiness or general string/number coercion.

For example, `2+3*4` yields `14`, while `(2+3)*4` yields `20`. `"2"+3` does not mean numeric addition or automatic formatting. Use the [builtin reference](../13-Language-reference/02-types-and-builtins.md) to select an operation supported by the operand types.

## Operators and precedence

The table is ordered from lowest binding strength to highest:

| Precedence | Operators | Grouping |
| --- | --- | --- |
| 1 | `??` | Right-associative null fallback |
| 2 | `or` | Left-associative, short-circuit |
| 3 | `and` | Left-associative, short-circuit |
| 4 | Prefix `not` | Negates the following comparison or negation |
| 5 | `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `is` | One comparison; chains are invalid |
| 6 | `+`, `-` | Left-associative |
| 7 | `*`, `/`, `%` | Left-associative |
| 8 | Unary `-` | Negates a numeric or other admitted signed value |
| 9 | `.`, `?.`, calls | Member access and calls |

`not todo.done==true` means `not (todo.done==true)`. Prefer explicit parentheses when they make a rule easier to read. Write `low<value and value<high`, not `low<value<high`. `is` tests an admitted type alternative; it is not a cast. `in` tests membership in a compatible collection.

Arithmetic must match its operand types. Integer division produces a decimal; integer remainder uses a quotient truncated toward zero. Integer overflow and division by zero fail. Money arithmetic requires compatible currencies; bytes have comparison but no arithmetic. See the [type reference](../13-Language-reference/02-types-and-builtins.md) for numeric bounds and [money](../04-Model-and-query-data/04-money-and-currency.md) for currency behavior.

Do not mix `??` with `and` or `or` in one unparenthesized expression segment. With `enabled:bool?` and `allowed:bool`, write `(enabled ?? false) and allowed`. The parentheses explicitly finish the fallback before the Boolean operation.

## Null fallback and optional access

`left ?? right` evaluates `left` once and evaluates `right` only when `left` is null. The left side must be nullable, and both sides must have compatible underlying types. A nonnullable fallback makes the result nonnullable. False, zero, empty text and an empty array do not trigger the fallback.

This complete app demonstrates null fallback, safe member reads and checked array access:

```can
app TaskExpressions
Given
 contract TaskSummary {title:text}
 derive title_or_default(task:TaskSummary?):text = task?.title ?? "Untitled"
 derive first_label(labels:text[]):text = at(labels,0) ?? "No labels"
When
Then
 page / title="Expressions"
  text title_or_default(null)
  text title_or_default(TaskSummary {title="Review draft"})
  text first_label([])
```

The page displays `Untitled`, `Review draft` and `No labels`. `at` uses a zero-based index and returns a nullable item; unchecked `labels[0]` indexing is not available.

`receiver?.field` evaluates the receiver once. Null yields null; a present receiver performs the ordinary typed field read. Its result is the field's type made nullable, without nesting nullable wrappers. Each nullable hop needs `?.`; a statically nonnull receiver uses `.`. Safe access is read-only: it cannot be a mutation target, optional method call or optional index.

Safe access does not convert authorization failures, invalid fields or business failures into null. It does not grant access to records or account-directory fields. `value ?? fallback` is the null-fallback spelling; there is no `coalesce` builtin.

## Narrow values before using them

A preceding nonnull check lets a continuation use the value with its nonnullable type. `and` evaluates left to right and skips its right operand when the left is false. This `Given` fragment defines a helper whose right-hand read is therefore safe:

```can
contract TaskSummary {title:text}
derive has_title(task:TaskSummary?):bool = task!=null and task.title!=""
```

For null it returns false without reading `task.title`. The same principle applies after a successful `require` or in the corresponding `if` branch. Keep the check before the read; an expression does not move guards ahead of earlier effects.

A true equality between a safe-access result and a statically nonnull value also proves the traversed nullable receivers nonnull in that continuation. For example, in the same `Given` context:

```can
derive matches_title(task:TaskSummary?,expected:text):bool = task?.title==expected and task.title!=""
```

Equality to null or to a nullable value does not establish that fact. Nor does `task?.title!=""`: a not-equal comparison is not the safe-access equality rule. Use explicit nonnull checks where needed. Type narrowing never creates business permission or field-read authority.

## Calls are eager; Boolean guards are not

Ordinary calls evaluate arguments once, in authored order, before assigning them to formal parameter slots. A failure stops later argument evaluation. Positional arguments may be followed by named arguments, but a positional argument cannot follow a named one; names must be unique.

`choose(condition,yes,no)` is an ordinary eager call. Both alternatives evaluate before selection. Do not use `choose(task!=null,task.title,"Untitled")` to protect a nullable read: the condition does not narrow the other arguments. Use `task?.title ?? "Untitled"`, or an operation branch with an explicit check.

Likewise, putting an unauthorized read in an unused helper argument does not make it safe. `and`, `or`, `?.` and `??` retain their specified short-circuit behavior, but every expression must still type-check and obey its dependency and disclosure rules.

## Reusable pure computation

A derived field is read-only computation in its model's `row` scope. A derived function has its own explicitly typed parameters and result. This complete Tasks app shows both forms:

```can
app Tasks
Given
 Todo {title:text trim,done:bool=false}
 policy Todo read=members
 derive Todo.is_open:bool = not row.done
 derive normalized_title(value:text):text = lower(trim(value))
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
  list Todo columns=title,done,is_open
   text normalized_title(row.title)
```

`is_open` is computed from the task's current readable `done` value; it is not a separately writable field. `normalized_title` returns normalized text for display without rewriting the stored title. It does not capture a caller's arbitrary local variables.

Derives cannot recurse or perform effects. Their dependencies must be legal at the consuming site, including any required actor, team or readable record context; moving a read into a helper or importing it cannot increase authority. Model derives cannot depend on incidental UI state. Presentation-only preferences retain their own scope restrictions even through helpers.

## Contextual variables and lexical scope

Names resolve through actual parameters, local `let` bindings, query aliases and declarations. There is no fallback search through unrelated records for a field of the same name. Executable `let` bindings belong inside `do`; a derive instead names its typed inputs in its signature.

| Name | Where it is available and what it means |
| --- | --- |
| `actor` | Nullable authenticated account (`user?`); authenticated/member/role admission narrows it to nonnull. Trusted handlers have null actor. `actor.id` is stable identity, not account-directory access. |
| `team` | The verified team where the evaluation context supplies one; exposes `id` and `timezone`. It is not a team selected by an arbitrary payload. |
| `now` | Admission-time instant, fixed across internal retries of the operation |
| `operation` | Read-only operation context with `id` and `source`, where supplied |
| `row` | Model policy, invariant, derive or lock context, or a presentation collection child; scenario bodies use their named record parameters |
| `parent` | Actual containment context, including nested parent navigation; not an implicit binding for top-level models or contracts |
| `event` | The declared event payload inside its handler |
| `before`, `row` in a migration mapper | Frozen predecessor row and partially initialized desired row; mapper restrictions still apply |
| `preferences` | Presentation configuration and its validation; cannot flow into business mutations or authority through a helper |

Active contextual bindings are protected from authored shadowing. Helpers have their own parameter scope. Signature defaults may reference earlier parameters, not later parameters or body locals, and must meet that evaluation site's restrictions. Do not assume an authorization gate has already narrowed a value while evaluating a pre-authorization default.

UI attributes such as `columns=title,done` are schema selectors, not general expressions looking for local variables named `title` and `done`. In the collection body, `row.title` explicitly reads the bound record.

## Queries introduce explicit aliases

This expression assumes the `Todo` model from the preceding app:

```can
count(Todo as task where not task.done)
```

It counts authorized open tasks. A query alias scopes over following clauses, not backward into its domain or into unrelated sibling expressions. The clause order is `archived=include`, `as`, `where`, `order=`, then `select`, each at most once. Omitted `select` yields records. Parenthesize a query used as part of a larger arithmetic expression.

`any(domain as item,predicate)`, `all(domain as item,predicate)` and `group(domain as item,key)` also expose the first argument's alias in their second argument; ordinary calls do not introduce that scope. Loop bindings are separate from query aliases. All reads and aggregates operate within the caller's permitted data. See [queries and aggregates](../04-Model-and-query-data/03-queries-and-aggregates.md) for ordering, empty results and collection examples.
