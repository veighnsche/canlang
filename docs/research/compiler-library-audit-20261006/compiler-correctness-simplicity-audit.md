# Compiler correctness and simplicity

The compiler should give each language fact and standard mechanism a clear owner. Libraries should implement standard parsing, encoding and transport mechanisms through supported APIs. Can should own its grammar, semantics, permission rules, diagnostics and product contracts. An adapter earns its place by translating a real boundary; a small custom mechanism can be simpler than a library plus extensive glue.

Use these questions when a change calls for a broader compiler review. They are engineering prompts, not a mandatory sequence or a requirement to produce audit artifacts.

- Follow a relevant workflow from source through checking and lowering to its actual consumer. Include editor and library callers when the change affects them.
- Distinguish required public behavior from incidental implementation details. Preserve compatibility that callers need; fix incorrect behavior at its source.
- Reuse checked semantic facts across stages. Repeated representations may serve different purposes, so remove duplication only when their meanings and lifetimes agree.
- Check syntax recovery, source locations, scope, type checking, effects, permissions and diagnostics where the change crosses those boundaries.
- Preserve evaluation order, short circuiting, defaults, exact values, mutation atomicity, authorization, retry and recovery behavior in generated execution.
- Give cancellation, resource ownership and failure cleanup explicit owners in compiler, language-server and tool integrations.
- Test observable outcomes and relevant failures. Use independent expected results or a trusted standard implementation where that catches a real bug; generated snapshots alone do not establish correctness.
- Evaluate library substitutions across the complete adapter and caller implementation. Prefer fewer owned mechanisms and less glue; moving code, adding metadata or weakening contracts does not simplify the system.
- Distinguish source inspection, a bounded repro and an end-to-end supported workflow when describing results.

The [research conclusions](README.md), retained responsibility analyses and repros provide context. [Remaining work](../../implementation/REMAINING-WORK.md) tracks functional gaps. Investigate the affected area and stop when the requested outcome works; unrelated historical audit steps need not be reopened.
