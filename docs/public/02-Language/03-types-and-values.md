# Types and values

Types describe the values a declaration accepts and returns. Built-in scalar types include text, booleans, numeric values, dates, instants, durations, and quantities; finite `enum(...)` types express closed alternatives. A trailing `?` admits null. An array suffix `[]` preserves ordered elements and duplicates. A union names alternative declared types where the contract allows it. Enums belong to their declaring field or parameter; reuse `Ticket.priority` to preserve that exact enum domain. There is no standalone enum declaration.

## Identity, omission, and defaults

Model references carry canonical identity and, for mutation inputs, the expected record version. User references identify stable accounts; they do not carry a model mutation version. They are not ordinary strings and cannot be fabricated into authority by copying an ID. Contracts define named structural values. Operation, delivery, and invocation values are typed references with distinct purposes. Omission is distinct from explicit null; defaults run only when omitted. See [defaults and validation](../03-Data/02-defaults-and-validation.md).

```can
Given
 Ticket { title:text trim, priority:enum(low,normal,urgent)=normal, due:date? }
```

This is a fragment requiring an app/package and matching section context. Use [types and builtins](../12-Reference/07-types-and-builtins.md) for the source-visible type set, constraints, operators, and builtin signatures. Storage-specific ownership belongs to [models](../03-Data/01-models-and-relationships.md).
