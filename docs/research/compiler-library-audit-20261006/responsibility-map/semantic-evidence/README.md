# Step 8 semantic evidence

Bounded audit of resolution, typing, effects, permissions and owning value policies. This directory supports the shared `../coverage.jsonl`; it is not a second coverage ledger. No compiler/package implementation changes or new policy selections are authorized by these planning results.

`inputs.json` pins the collection baseline and rechecks the previous compiler/runtime manifests. `resolution.json`, `authority.json` and `values.json` contain separate source review slices, not executed-result claims. `cases.json` defines independent contracts before execution; disagreement with a runtime library is an observation rather than a sole correctness oracle.

`run.py` builds the current locked compiler offline and selects the reported rlibs, compiles the audit-only public API observer, runs finite native cases and twelve fresh graph processes, then runs the selected integration suites. It saves exact commands, process exits and raw streams. Expected mismatches are retained as audit evidence. `probe.rs` observes compact checked facts and selected emitted modules, with no full CST/artifact duplication.

Host/release, complete generated-code runtime behavior, resource limits and installed-application acceptance remain bounded by their later audit steps and existing parent gates. Source maps, unavailable capabilities and other rejected emission paths must not be reported as successful runtime operations merely because checking was clean.
