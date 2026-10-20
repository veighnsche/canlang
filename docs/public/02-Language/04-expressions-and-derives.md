# Expressions, scopes, and derives

Expressions are typed values evaluated in an explicitly defined scope. Literals, paths, calls, field access, optional access, comparisons, boolean operators, conditionals, and bounded query expressions are available according to the grammar. `and` and `or` short-circuit in written order. Query clauses bind to their query; they are not arbitrary SQL.

## Reusable pure computation

A derive declares reusable pure computation. It has typed parameters and a typed result, and can be called where its dependencies are available. A helper does not create authority: record access, caller context, and expression evaluation restrictions still apply through its dependency graph. In a mutation, guards and effects execute in source order; the complete effect model belongs to [scenarios and effects](../05-Workflows/02-scenarios-and-effects.md).

Nullability must be handled before using a nullable value as non-null. Finite enum `match` is exhaustive; `if` remains useful for intentional fallbacks. A derived value cannot turn opaque identifiers into readable records. See [the exact expression and builtin catalog](../12-Reference/07-types-and-builtins.md).
