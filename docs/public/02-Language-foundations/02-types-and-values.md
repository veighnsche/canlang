# Types, schemas and values

Distinguish declarations from supplied values, write typed literals and collections, and understand null, omission and defaults without treating record identities as ordinary strings.

## Schemas and value objects

A schema declares field names and types with colons. A value object supplies expressions with equals signs. This complete app declares a structural contract and returns a value of that contract:

```can
app TaskValues
Given
 contract TaskInput {title:text,done:bool}
 derive new_task(title:text):TaskInput = TaskInput {title,done=false}
When
Then
 page / title="Values"
  text new_task("Review draft").title
```

`new_task("Review draft")` returns `TaskInput {title="Review draft",done=false}`. The shorthand `{title}` reads the existing parameter and means `{title=title}`. It does not create a variable. `TaskInput` values are structural data, not stored `Todo` records.

| Form | Meaning |
| --- | --- |
| `Todo {title:text,done:bool=false}` in `Given` | Stored model schema, with a create default |
| `contract TaskInput {title:text,done:bool}` | Named structural schema |
| `{title="Review draft",done=false}` in a value position | Object with supplied values |
| `TaskInput {title="Review draft",done=false}` | A value checked against the named contract |
| `{title}` in a value position | Shorthand for `{title=title}` using a bound value |

Colons are not object-value syntax, and equals signs do not replace the colon between a schema field and its type. Creating a structural value does not persist a model; storage changes use the [operation effects](../06-Business-workflows/02-scenarios-and-effects.md).

## Literal values

| Literal | Type and interpretation |
| --- | --- |
| `"Review draft"` | Text; strings use JSON double quotes and escapes |
| `true`, `false` | Boolean values, not strings |
| `null` | Absence where the expected type admits null |
| `42`, `-3` | Integer expression; the minus sign is an operator |
| `1.25` | Exact decimal literal |
| `30m`, `250ms` | Elapsed durations with adjacent integer unit suffixes |
| `2MiB` | Byte quantity with an adjacent unit suffix |
| `["Draft","Review"]` | Ordered text array; duplicates are preserved |

There are no exponent-number literals or numeric separators. `5 m` and `5minutes` are not duration spellings. Byte quantities support comparison, not arithmetic. Constructors such as `date("2026-10-20")`, `datetime("2026-10-20T09:00:00Z")` and `money(25,"EUR")` supply typed values with validation; strings do not automatically become arbitrary dates or money.

A literal may inhabit an expected validated string-like type such as email, URL or currency after validation. That does not permit an arbitrary text variable to coerce to that type. Use the [type and builtin reference](../13-Language-reference/02-types-and-builtins.md) for supported constructors, bounds and operations.

## Nullable values, arrays and enum domains

A trailing `?` admits null. `T[]` is an ordered homogeneous array. `T[]?` makes the array itself nullable; its elements are still nonnullable. Nullable elements (`T?[]`), nested array suffixes and repeated nullable suffixes are invalid. An empty array is a value, distinct from null.

This fragment belongs in `Given`:

```can
Ticket {title:text trim,priority:enum(low,normal,urgent)=normal,due:date?,tags:text[]}
```

Each new ticket requires a title. Omitting `priority` uses `normal`, omitting `due` uses null, and omitting `tags` uses an empty array. Enum cases belong to their declaring field or parameter, not a global set of strings. Reuse `Ticket.priority` to preserve that exact domain; `Ticket.priority.urgent` names its case explicitly. A bare `urgent` needs a uniquely expected enum type. Two enum declarations with the same case names remain different domains. There is no standalone enum declaration.

Named unions express alternatives where the type contract permits them. The [reference](../13-Language-reference/02-types-and-builtins.md#value-types) gives the bounded union/array/nullable combinations; this is not general authored generics or arbitrary primitive unions.

## Identity, omission, and defaults

Model references carry canonical identity and, for mutation inputs, an expected record version. User references identify stable accounts without a model mutation version. Neither is an ordinary string you can turn into authority by copying an ID. Contract values are structural; operation, delivery and invocation values are distinct typed references.

Omission and null are different inputs:

| Input situation | Behavior |
| --- | --- |
| Create omits a field with `=expr` | Evaluate its create default |
| Create omits a nullable field without another default | Initialize it to null |
| Create omits an ordinary stored array | Initialize it to `[]` |
| Create omits a stored array marked `[]!` | Reject the missing required input |
| Input explicitly supplies null | Accept only if the type permits null; do not substitute a default |
| Update omits a field | Preserve its old value |

A `server=expr` initializer belongs to the server and excludes that field from client input. Reusing a field's type carries its representation, nullability, normalization and bounds, but not its defaults, server initializer, ownership, uniqueness or permissions. See [defaults and validation](../04-Model-and-query-data/02-defaults-and-validation.md) and [models](../04-Model-and-query-data/01-models-and-relationships.md).
