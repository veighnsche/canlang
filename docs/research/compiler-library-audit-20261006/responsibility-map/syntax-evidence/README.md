# Syntax and recovery evidence — Step 7

This packet is reviewed at the bounded [Step 7 scope](../syntax.md). It maps the
normative grammar and current compiler admission through subsequent stages, and
executes independent malformed-sibling, Unicode, string/default/description,
layout and EOF witnesses. Source inspection, public API observations, existing
harness passes and real emitted execution have separate scopes. A parse success
is not semantic or application acceptance. Demonstrated defects remain open.

[Inputs](inputs.json) pin the source/catalog/corpus and task allocation.
[Cases](cases.json) state independent outcomes before execution; the audit-only
[observer](probe.rs) reports public parse, analysis and clean-result emission.
[Runner](run.py) captures exact commands, stdout, stderr and exits after a fresh
locked/offline native build. Replay from any checkout with the pinned built
packages available: `python3 docs/research/compiler-library-audit-20261006/responsibility-map/syntax-evidence/run.py`.
Any observed assertion mismatch is retained as a finding, not rewritten into an
expectation merely to pass. Missing runtime prerequisites and skipped bodies must
remain visible. The runner chooses fresh Cargo-reported rlibs rather than an
arbitrary stale library from the build cache.

[Additional controls and corpus](extend.py) consume the recorded unchanged rlibs;
[byte CLI ingress](byte_cli.py) captures early tool error mapping;
[outcome checks](verify.py) add independent rejection/value/meaning checks after
reviewer challenge. Original sentinel assertions remain pre-execution. Use these
three scripts after `run.py`. Exact execution, assertion failures, source and
installed-runtime pins are preserved in the JSON receipts. The corpus projection
does not retain full artifacts/JS or execute them. [Inventory](inventory.json),
[form/stage trace](forms.json), [recovery](recovery.json),
[independent review](cross-review.json) and [mechanical check](validation-luna.json)
support the single coverage ledger, rather than forming another master plan.

Sol medium handles stage/recovery tracing; Luna medium inventories exact variants
and witnesses. Root owns execution, shared ledger integration and commits.
The same-day [researched allocation](../../model-allocation-20261007.md) remains
the selection reference; no stronger task setting or model benchmark is implied.
No compiler, package or dependency implementation changes are authorized by this
planning packet. No merge or living-plan checkpoint advance occurs.
