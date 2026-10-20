# Apps, packages, and composition

An app is a stable logical owner for source declarations, users' entry points, and persisted business state. An implicit app contains its own `Given`, `When`, and `Then` sections. A package is a reusable named owner with those sections indented below its declaration. Package identity and app identity remain distinct when packages are composed.

A composition app explicitly selects packages with `uses=[...]` and imports explicitly exported named declarations with `use owner {Name}`; bound imports add `from=deployment.name` for remote interfaces. Composition does not copy or retag another package's source, identity, authority, or storage. Imports resolve to declared members; visibility alone grants no call or read permission. Use a package's canonical operations for cross-package mutation, rather than writing its model directly.

Choose one implicit app for a small standalone system. Split into packages when ownership is genuinely separable and compose them explicitly. Shared [defaults and context resources](../12-Reference/05-context-and-defaults.md) have one owner; avoid shadow configurations that make runtime identity ambiguous. See [source syntax](01-source-syntax.md) for layout and [the syntax reference](../12-Reference/06-syntax-reference.md) for exact composition forms.
