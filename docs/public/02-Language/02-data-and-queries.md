# Data, types and queries

Model the records your company stores, distinguish them from structured values, and query only the data the current operation is allowed to use.

## Declare records and values

Place model declarations in `Given`. These fragments assume an owning app or package:

```can
Todo { title:text trim max=200, done:bool=false }
contract Summary { count:int, total:money }
```

A model describes stored records with identity, version and lifecycle. A contract describes a typed structured value without introducing a stored record. Use a model reference such as `customer:Customer` for a relationship; copying a customer's name into a text field is a separate business snapshot.

Frequently used types include `text`, `bool`, `int`, `decimal`, `money`, `date`, `datetime`, `duration`, `email`, `url`, `locale`, `timezone`, `currency`, `user`, `member` and `file`. Use `T?` for a nullable value and `T[]` for an array. An `enum(draft,submitted,approved)` restricts a value to named cases.

Use decimal and money types for exact business quantities. Construct money as `money(25,"EUR")`; adding or comparing money requires matching currencies. Do not model currency conversion as a bare arithmetic operation: record an explicit provider result and its business decision.

## Defaults, constraints and server-owned values

`done:bool=false` supplies a create default. A nullable field can be absent. `trim`, `min`, `max` and `unique` express supported constraints. Defaults run on creation; an omitted update leaves an existing value unchanged, and explicit null clears a nullable value.

A server initializer such as `submitted_by:user server=actor` binds trusted context instead of accepting a caller's claim. Do not put a server-owned field into a form's editable fields. Put rules that must hold across every mutation path into [invariants and locks](03-permissions.md).

Parameter and field types remain explicit. Using a model field type on a parameter inherits its value constraints rather than its stored default or server ownership.

## Query a model

These are expression fragments in a scope where Todo is visible:

```can
Todo as task where not task.done
Todo as task where task.done order=title
count(Todo)
first(Todo as task where task.title=="Ship prototype")
```

Bind rows with `as` when you need a name in a filter or projection. `first` can return no result, so handle null before reading the row. `count`, `sum`, `any` and `all` provide typed collection operations. A query's row scope is distinct from the `row` exposed by a presentation list or a model rule.

Viewer queries apply row and field permissions before filtering, search, ordering, counts and serialization. An aggregate does not make confidential data public. A derived result must have readable dependencies. Read [permissions](03-permissions.md) before writing reports that summarize sensitive records.

## Use typed expressions

Boolean operations are `not`, `and` and `or`. Comparisons include `==`, `!=`, `<`, `<=`, `>` and `>=`; `in` tests membership. Use `?.` for safe access and `??` for a fallback where the types permit them. Boolean operators preserve short-circuit evaluation.

Strings use JSON escapes and have no general source interpolation. Use typed formatting or localized messages. Duration literals such as `5m` and `2h` require the unit next to the integer. Treat a calendar date and an instant as different types; local scheduling must specify its timezone and daylight-saving behavior.

The [language references](../04-Reference/01-cli.md#language-reference) own the complete type, operator and builtin definitions.
