# Working on Can

Prioritize development speed, architectural soundness, and code correctness. Do work that helps deliver correct, well-structured code. Skip work whose main purpose is to demonstrate that a process was followed. This distinction takes precedence over procedural requirements in project plans and historical records.

- Build what the user needs. Make reasonable choices, keep authorized work moving, and stop when the requested outcome works. Ask only when a missing decision or permission prevents progress.
- Keep architecture simple, cohesive, and easy to change. Give behavior a clear owner, fix defects at their source, and reuse existing mechanisms. Add abstractions and dependencies when they solve a real problem.
- Preserve required behavior, permissions, evaluation order, atomicity, and failure/recovery behavior. Address edge cases that affect the feature.
- Express app identity and composition in `.can` source. Derive dependencies and interfaces from owning declarations; use shared defaults and reusable components to keep authoring concise. Use `##` for explanatory comments and keep executable bindings inside `do`.
- Use focused tests, direct checks, and code review to catch real bugs and architectural problems. Check meaningful behavior and relevant failures. Reuse applicable passing results; repeat checks only for a relevant change, failure, or concrete concern. Preserve useful inline behavior examples. Unit testing is banned: never add unit tests — no new `*.test.ts` outside `tools/unitban/allow-ts.txt`, no `#[test]`/`#[cfg(test)]` in Rust crate sources, no test-runner imports in production code. Verify through integration and end-to-end tests against real systems (`scripts/check-no-unit-tests.sh` and `bun scripts/check-ts-unitban.ts` enforce this; the Rust crates enforce it at compile time).
- Judge designs by whether they satisfy the intended workflows simply and correctly. Keep assumptions open to revision and distinguish proposed behavior from implemented behavior.
- Delegate independent work when it helps delivery. Avoid conflicting edits and protect other workers' in-progress work. Wait for concrete dependencies, not unrelated reviews or completion of another owner's whole plan.
- Write documentation when it helps someone understand, use, or change the system. Explain consequential, non-obvious design choices in [DECISIONS.md](docs/specification/DECISIONS.md) when useful. Use a short plan when it helps manage complex work; routine changes need neither plans nor decision entries.
- Finish satisfied work without reopening it for bookkeeping. Revisit it when a defect or changed requirement warrants it. Keep optional improvements optional.
- Report what changed, what was checked, and any remaining functional gap briefly and honestly.

## Consult JEV frequently

JEV usage is free and calls are preauthorized. Consult it often for architecture, design, correctness, trade-offs, and uncertain assumptions, especially before settling on a consequential choice. Do not avoid consultation to save cost.

- For each consultation, ask the same substantive question three times in independently written prose. Keep the facts, constraints, options, and decision criteria equivalent across all three requests.
- Actively counterbalance your own bias: present the strongest case and drawbacks for each viable option, vary option order and emphasis, and challenge assumptions favoring your initial preference. Avoid leading language, loaded labels, unequal detail, or framing one option as the obvious answer.
- Keep the requests independent: do not supply earlier replies or suggest the answer JEV should give. Compare all three responses, investigate material disagreement, and revise your position when warranted. Agreement is advice, not proof of correctness.
- Use the advice to improve the implementation or decision. Do not create response archives, proof packets, or extra bookkeeping merely to document the consultations.

## Avoid bureaucracy

Tests, reviews, documentation, plans, and advice are tools for development, not separate deliverables or completion gates by default. Use them to solve a concrete development need or fulfill an explicit user request.

- Do not create proof packets, evidence bundles, verification snapshots, hash/provenance chains, tests that merely mirror implementation, or machinery to verify ordinary checks.
- Do not require reviews of reviews, fixed review rounds, formal task/owner/acceptance forms, duplicate status records, merge ceremonies, coverage ledgers, checkpoint reconciliation, history reconstruction, or bookkeeping commits. Read history and resolve integration issues when the code needs it.
- Do not introduce version pinning, environment freezing, or reproducibility projects by default. Maintain ordinary lockfiles and fix actual compatibility or build reliability problems as needed.

## Build resources

Reuse compatible build and dependency caches, avoid conflicting writers, and keep memory and disk use reasonable. Choose build settings for the actual workload; do not treat particular flags as compliance requirements. Preserve required features, assertions, and test stack sizes. Clean only your own unused, rebuildable outputs; protect source, Git data, needed artifacts, and other workers' work.
