# Traits and custom keywords

Given extensions add checked model or field contributions, or define a named standalone keyword whose novel behavior is admitted through compiler-owned contracts.

## Traits

A reusable named `trait Name $"prompt"` or attached inline `trait $"prompt"` describes a model/field extension. Named applications use the bare name after the model schema or stored-field modifiers; `trait Name` is a definition, not an attachment. Definitions and inline attachments may select `agent=profile`; a named use cannot override its definition’s profile. Named applications reuse the saved definition. Contributions are checked and applied in source order; incompatible targets, duplicate contributions and contradictory defaults diagnose. Traits cannot grant permissions, create arbitrary operations or bypass canonical storage and transaction rules.

## Standalone keyword definitions

A named `keyword Name(signature) $"prompt"` defines a distinct Given declaration with named required compile-time arguments and its own checked target, inputs, outputs, reads, effects and lifecycle. The signature must be nonempty. Reference parameter kinds are `model`, dependent `field(target,type)` and `operation`; ordinary value types admit compile-time constants. Applications are standalone statements with named arguments. Definitions are local and cannot be exported. Missing, duplicate or unknown arguments are errors. There is no anonymous inline keyword prompt and no prompt on an application. Built-in words cannot be redefined.

New implicit semantics must be integrated with the normal owner that provides storage, authorization, versioning, transaction commit and replay. Metadata alone cannot grant runtime authority. See [generation lifecycle](01-generation-lifecycle.md) and [source syntax](../02-Language-foundations/01-source-syntax.md).
