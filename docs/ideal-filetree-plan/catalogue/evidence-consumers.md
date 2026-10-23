# Evidence and documentation consumers

Read-only literal reference scan found the following existing parent consumers. References include comments/document links as well as executable test inputs: they are navigation and retirement safeguards, not proof that a file is imported or executed. No no-caller/dead-code conclusion follows from absence here. Embedded programs remain distinct from production modules.

| Retained input | Literal external consumers |
| --- | --- |
| `docs/design/UI-COMPONENTS.md` | `README.md`, `editors/vscode/check-highlighting.cjs`, `packages/contracts/src/presentation.ts`, `packages/ui/src/catalog.ts`, `scripts/pack-tools.mjs`, `tests/fixtures/prompt-pipeline/README.md` |
| `docs/design/can-dev-server.md` | `README.md` |
| `docs/design/complex-apps/decide.md` | `compiler/tests/b4_witness.rs` |
| `docs/design/proposals/build-generation/implementation-plan.md` | `tests/fixtures/prompt-pipeline/README.md` |
| `docs/design/research-ai-capabilities-20261004.md` | `packages/contracts/src/services.ts`, `packages/services/src/models/ollama.ts` |
| `docs/dev-setup.md` | `README.md`, `tests/fixtures/prompt-pipeline/README.md` |
| `docs/ideal-filetree-plan.md` | `README.md` |
| `docs/ideal-filetree-plan/finished-product/ownership.md` | `README.md` |
| `docs/ideal-filetree-plan/finished-product/target-tree.md` | `README.md` |
| `docs/implementation/CONTRACTS.md` | `packages/cloudflare/src/runtime/executors.ts`, `packages/files/src/catalog.ts`, `packages/work/src/catalog.ts`, `tests/e2e/apps/teamtasks-mcp.spec.ts` |
| `docs/implementation/D3B-OBSERVER-SEAM-CONTRACT.md` | `packages/cloudflare/src/runtime/invoke.ts` |
| `docs/implementation/DESCRIPTION-REFERENCE-PLAN.md` | `compiler/src/analysis/effects.rs` |
| `docs/implementation/DIAGNOSTICS.md` | `compiler/src/diagnostic.rs`, `compiler/src/lint/driver.rs` |
| `docs/implementation/REMAINING-WORK.md` | `README.md` |
| `docs/implementation/capability-roadmap-20261008/f1-invocation/NumericControl.can` | `packages/state/test/fixtures/numeric-control/artifact.json` |
| `docs/implementation/challenge-audit-run/evidence/execution-contract.md` | `packages/cloudflare/preparation/tests/modules.rs`, `packages/contracts/src/state.ts` |
| `docs/implementation/compiler-completion/bdd-facts/independent-review/sequence-alias.can` | `compiler/tests/bdd_binding_runtime.rs` |
| `docs/implementation/compiler-completion/email-admission/implementation/probe.mjs` | `compiler/tests/email_admission.rs` |
| `docs/implementation/compiler-completion/release-prerequisites/archives.json` | `compiler/third-party-notices/manifest.json` |
| `docs/implementation/compiler-completion/release-prerequisites/supplemental-notices.json` | `compiler/third-party-notices/manifest.json` |
| `docs/implementation/compiler-completion/release-prerequisites/target-closures.json` | `compiler/third-party-notices/manifest.json` |
| `docs/implementation/compiler-completion/temporal-presentation-join/ui-freeze/packages/ui/test/messages.test.ts` | `tools/unitban/allow-ts.txt` |
| `docs/implementation/compiler-completion/view-reuse/agenda-consumer.mjs` | `compiler/tests/calendar_agenda.rs` |
| `docs/implementation/compiler-completion/view-reuse/consumer.mjs` | `compiler/tests/view_reuse.rs` |
| `docs/implementation/compiler-completion/view-reuse/history-consumer.mjs` | `compiler/tests/row_history.rs` |
| `docs/implementation/compiler-completion/view-reuse/table-filter-consumer.mjs` | `compiler/tests/table_filters.rs` |
| `docs/implementation/compiler-completion/view-reuse/table-order-consumer.mjs` | `compiler/tests/table_order.rs` |
| `docs/implementation/compiler-completion/view-reuse/table-time-consumer.mjs` | `compiler/tests/table_time.rs` |
| `docs/implementation/evidence/b3-i5.md` | `examples/expenseflow-demo/README.md` |
| `docs/implementation/evidence/mcp-p2.md` | `packages/cloudflare/preparation/tests/modules.rs`, `packages/cloudflare/src/runtime/mcp-registry.ts` |
| `docs/implementation/evidence/mcpd-a.md` | `packages/cloudflare/src/worker/main.ts` |
| `docs/implementation/rust-port-orchestration/contracts-20261007/oracles/frozen-oracle.json.gz` | `packages/values/conformance/numeric-text.json`, `packages/values/conformance/numeric-text.oracle.mjs`, `packages/values/conformance/string-escape.json`, `packages/values/conformance/string-escape.oracle.mjs` |
| `docs/install.md` | `README.md`, `compiler/README.md`, `compiler/src/cli.rs`, `editors/vscode/README.md`, `packages/cloudflare/preparation/src/release.rs`, `packages/cloudflare/scripts/package-preparation.mjs`, `packages/cloudflare/src/preparation/executable-manifest.ts` |
| `docs/public/01-Get-started/01-index.md` | `README.md` |
| `docs/public/01-Get-started/03-installation.md` | `README.md` |
| `docs/public/01-Get-started/06-local-development.md` | `README.md` |
| `docs/research/compiler-library-audit-20261006/pass3/url/vectors.json` | `compiler/tests/analysis.rs` |
| `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/transport-contracts.json` | `packages/testkit/conformance/ports/transport-vectors.mjs` |
| `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-decisions.md` | `packages/values/conformance/owned-input/v1/README.md`, `packages/values/conformance/owned-input/v1/cases.json`, `packages/values/conformance/owned-input/v2/README.md`, `packages/values/conformance/owned-input/v2/cases.json` |
| `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-vectors.json` | `packages/values/conformance/owned-input/v1/README.md`, `packages/values/conformance/owned-input/v1/cases.json`, `packages/values/conformance/owned-input/v2/README.md`, `packages/values/conformance/owned-input/v2/cases.json` |
| `docs/research/package-subsystem-ports-20261006/implementation-plans/README.md` | `README.md` |
| `docs/specification/CONSTRUCT-HELP.md` | `dev-server/src/app.rs`, `dev-server/src/cli.rs`, `dev-server/src/construct.rs`, `packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts`, `packages/cloudflare/src/runtime/native-local-rules.integration.test.ts`, `packages/cloudflare/src/runtime/native-reference-arrays-d1.integration.test.ts`, `packages/cloudflare/src/runtime/native-scenario-receipts-d1.integration.test.ts`, `packages/cloudflare/src/runtime/promptlab-native-acceptance.integration.test.ts`, `packages/cloudflare/test/app-owned-preview.integration.test.ts`, `packages/cloudflare/test/compiler-check.integration.test.ts`, `packages/cloudflare/test/first-profile-browser.integration.test.ts`, `packages/cloudflare/test/model-free-preview.integration.test.ts`, `packages/cloudflare/test/native-original-canchat.pending.ts`, `scripts/pack-install.mjs`, `scripts/pack-tools.mjs`, `scripts/verify-native-runtime.mjs`, `scripts/verify-preview-persistence.mjs` |
| `docs/specification/DECISIONS.md` | `AGENTS.md`, `README.md` |
| `docs/specification/DESIGN.md` | `README.md`, `packages/values/README.md` |
| `docs/specification/GRAMMAR.md` | `README.md`, `dev-server/src/construct.rs`, `dev-server/src/inventory.rs`, `editors/vscode/README.md`, `tools/README.md` |
| `docs/specification/REQUIREMENTS.md` | `README.md` |
