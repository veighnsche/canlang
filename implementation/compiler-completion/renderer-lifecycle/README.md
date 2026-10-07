# Renderer handoff and finite duplex correction

`can docs` left its renderer alive after an early input write failed. It also deadlocked when finite startup output filled a pipe before the child read the reference model. The owning adapter now drains stdout and stderr concurrently with input, closes stdin before waiting, and terminates/reaps a child after failed handoff or wait. E7004, output suppression on failure and ordinary success mapping remain intact.

Eighteen focused CLI tests pass. [Eight actual CLI controls](current.json) check a clean 262226-byte source, success, nonzero/signal, invalid UTF-8/empty output, early pipe closure and both startup output streams. [Independent review](independent-review.json) adds source-pinned baseline/current cleanup and exact finite duplex checks. [The supervised deadlock receipt](duplex-baseline.json) and [observer corrections](observation-notes.json) retain earlier failures separately.

This accepts the handoff/duplex closure within FAIL-R05. Renderer time/capture policy, process descendants, arbitrary blocking behavior and other-host profiles remain open. No new resource cap or timeout is selected.
