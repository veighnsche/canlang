# Author CanLang with an AI assistant

Give a coding assistant concrete business outcomes, review its source and authority assumptions, and verify the resulting application through checks and real workflows.

## Describe the intended outcome

A coding agent can draft CanLang source, trace declarations, and explain diagnostics. Keep the application contract in `.can` files and review the generated result as a consequence of those declarations. Give the agent the business outcome, actors, data boundaries, and failure cases; ask it to link every permission and lifecycle assumption to its owning source.

## Review in layers

First check app and package identity, then data ownership and field types. Review operation admission separately from read policy: a caller who can invoke a command does not automatically gain broad reads. Confirm guards are ordered before effects, child and external work have clear ownership, and retries cannot repeat a business outcome. Review pages as projections of existing authority, never as security barriers.

## Verify the change and its limits

Ask the agent to make a focused change, run the source check and relevant real workflow checks, and report the exact commands and scope. Treat successful compilation as syntax/type evidence, not proof of business correctness or deployment success. Do not accept invented language constructs, CLI commands, providers, or generated code changes without checking the [grammar](../13-Language-reference/01-syntax-reference.md) and [build lifecycle](../03-Generate-implementation/01-generation-lifecycle.md).
