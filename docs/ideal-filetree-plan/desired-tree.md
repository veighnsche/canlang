# Complete selected desired tree

Every retained/successor leaf is enumerated. `[+]` is proposed; `[D]` is independent draft content; `[B]` is plan bookkeeping excluded from recursive source inventory. Current provenance retains its recorded ownership. Late-arrival source has explicit review limits in [inventory](inventory.json). Conditional retirements remain in the target until proven.

[Ownership](ownership.md), [responsibility reviews](slices.md), [allocations](allocations.json), [tasks](tasks.md) and [machine allocation](target-tree.json) define duties, cutovers and exclusive writers. Every current predecessor has a retained/successor leaf; no directory placeholders conceal allocation. Proposed exports/APIs and final sizes are unverified.

```text
.github/workflows/b1-join.yml
.github/workflows/b2-join.yml
.github/workflows/e2e.yml
.github/workflows/integration.yml
.github/workflows/lane-01.yml
.github/workflows/lane-02.yml
.github/workflows/lane-03.yml
.github/workflows/lane-04.yml
.github/workflows/lane-05.yml
.github/workflows/lane-06.yml
.github/workflows/release.yml
.gitignore
.gitmodules
AGENTS.md
DECISIONS.md
DESIGN.md
EVALUATION.md
GRAMMAR.md
LICENSE
README.md
REQUIREMENTS.md
bun.lock
compiler/.gitignore
compiler/Cargo.lock
compiler/Cargo.toml
compiler/README.md
compiler/build.rs
compiler/can-completions.bash
compiler/can-completions.fish
compiler/can-completions.zsh
compiler/src/analysis/catalog.rs
compiler/src/analysis/catalog/provider_tests.rs [+]
compiler/src/analysis/catalog/providers.rs [+]
compiler/src/analysis/check.rs
compiler/src/analysis/effects/declarations.rs [+]
compiler/src/analysis/effects/descriptions.rs [+]
compiler/src/analysis/effects/handlers.rs [+]
compiler/src/analysis/effects/migrations.rs [+]
compiler/src/analysis/effects/mod.rs [+]
compiler/src/analysis/effects/rules.rs [+]
compiler/src/analysis/effects/statements.rs [+]
compiler/src/analysis/effects/tables.rs [+]
compiler/src/analysis/examples/fixtures.rs [+]
compiler/src/analysis/examples/messages.rs [+]
compiler/src/analysis/examples/mod.rs [+]
compiler/src/analysis/examples/selectors.rs [+]
compiler/src/analysis/examples/sequences.rs [+]
compiler/src/analysis/examples/tables.rs [+]
compiler/src/analysis/migrate_check.rs
compiler/src/analysis/mod.rs
compiler/src/analysis/resolve/bodies.rs [+]
compiler/src/analysis/resolve/cycles.rs [+]
compiler/src/analysis/resolve/declarations.rs [+]
compiler/src/analysis/resolve/expressions.rs [+]
compiler/src/analysis/resolve/imports.rs [+]
compiler/src/analysis/resolve/mod.rs [+]
compiler/src/analysis/resolve/modules.rs [+]
compiler/src/analysis/resolve/scopes.rs [+]
compiler/src/analysis/resolve/tables.rs [+]
compiler/src/analysis/resolve/types.rs [+]
compiler/src/analysis/types/calls.rs [+]
compiler/src/analysis/types/constructs.rs [+]
compiler/src/analysis/types/context.rs [+]
compiler/src/analysis/types/declarations.rs [+]
compiler/src/analysis/types/effect_calls.rs [+]
compiler/src/analysis/types/expressions.rs [+]
compiler/src/analysis/types/fixtures.rs [+]
compiler/src/analysis/types/literals.rs [+]
compiler/src/analysis/types/members.rs [+]
compiler/src/analysis/types/mod.rs [+]
compiler/src/analysis/types/model.rs [+]
compiler/src/analysis/types/mutations.rs [+]
compiler/src/analysis/types/narrowing.rs [+]
compiler/src/analysis/types/operators.rs [+]
compiler/src/analysis/types/overloads.rs [+]
compiler/src/analysis/types/queries.rs [+]
compiler/src/analysis/types/rules.rs [+]
compiler/src/analysis/types/scenarios.rs [+]
compiler/src/analysis/types/schemas.rs [+]
compiler/src/analysis/types/statements.rs [+]
compiler/src/analysis/types/ui.rs [+]
compiler/src/cli/docs.rs [+]
compiler/src/cli/format.rs [+]
compiler/src/cli/mod.rs [+]
compiler/src/cli/tests.rs [+]
compiler/src/codegen/artifact.rs
compiler/src/codegen/bdd.rs
compiler/src/codegen/ir/build.rs [+]
compiler/src/codegen/ir/decode_effects.rs [+]
compiler/src/codegen/ir/decode_examples.rs [+]
compiler/src/codegen/ir/decode_expr.rs [+]
compiler/src/codegen/ir/decode_fixtures.rs [+]
compiler/src/codegen/ir/decode_forms.rs [+]
compiler/src/codegen/ir/decode_items.rs [+]
compiler/src/codegen/ir/decode_pages.rs [+]
compiler/src/codegen/ir/decode_rules.rs [+]
compiler/src/codegen/ir/decode_ui.rs [+]
compiler/src/codegen/ir/literals.rs [+]
compiler/src/codegen/ir/mod.rs [+]
compiler/src/codegen/ir/model.rs [+]
compiler/src/codegen/js/definition.rs [+]
compiler/src/codegen/js/descriptors.rs [+]
compiler/src/codegen/js/effects.rs [+]
compiler/src/codegen/js/expressions.rs [+]
compiler/src/codegen/js/mod.rs [+]
compiler/src/codegen/js/packages.rs [+]
compiler/src/codegen/js/pages.rs [+]
compiler/src/codegen/js/registry.rs [+]
compiler/src/codegen/js/scalars.rs [+]
compiler/src/codegen/js/schema.rs [+]
compiler/src/codegen/js/writer.rs [+]
compiler/src/codegen/mod.rs
compiler/src/codegen/sourcemap.rs
compiler/src/diagnostic.rs
compiler/src/docs/descriptions.rs [+]
compiler/src/docs/examples.rs [+]
compiler/src/docs/json.rs [+]
compiler/src/docs/mod.rs [+]
compiler/src/docs/model.rs [+]
compiler/src/docs/source.rs [+]
compiler/src/explain.rs
compiler/src/format.rs
compiler/src/ide/fixes.rs
compiler/src/ide/mod.rs
compiler/src/ide/queries.rs
compiler/src/ide/tokens.rs
compiler/src/json.rs
compiler/src/lib.rs
compiler/src/lint/driver.rs
compiler/src/lint/mod.rs
compiler/src/lint/rules.rs
compiler/src/lsp/mod.rs
compiler/src/lsp/server/backend.rs [+]
compiler/src/lsp/server/mod.rs [+]
compiler/src/lsp/server/protocol.rs [+]
compiler/src/lsp/server/session.rs [+]
compiler/src/lsp/server/tests.rs [+]
compiler/src/lsp/transport.rs
compiler/src/main.rs
compiler/src/policy.rs
compiler/src/source.rs
compiler/src/syntax/cst.rs
compiler/src/syntax/inspect.rs [+]
compiler/src/syntax/layout.rs
compiler/src/syntax/lexer.rs
compiler/src/syntax/mod.rs
compiler/src/syntax/parser/attributes.rs [+]
compiler/src/syntax/parser/builder.rs [+]
compiler/src/syntax/parser/cursor.rs [+]
compiler/src/syntax/parser/examples.rs [+]
compiler/src/syntax/parser/expressions.rs [+]
compiler/src/syntax/parser/given.rs [+]
compiler/src/syntax/parser/migrations.rs [+]
compiler/src/syntax/parser/mod.rs [+]
compiler/src/syntax/parser/modules.rs [+]
compiler/src/syntax/parser/recovery.rs [+]
compiler/src/syntax/parser/types.rs [+]
compiler/src/syntax/parser/ui.rs [+]
compiler/src/syntax/parser/when.rs [+]
compiler/tests/analysis.rs
compiler/tests/analysis/catalog.rs [+]
compiler/tests/analysis/corpus.rs [+]
compiler/tests/analysis/resolve.rs [+]
compiler/tests/analysis/support.rs [+]
compiler/tests/analysis/types.rs [+]
compiler/tests/authoring.rs
compiler/tests/b1_join.rs
compiler/tests/b3_authoring_join.rs
compiler/tests/b3_i5.rs
compiler/tests/b3_migrate.rs
compiler/tests/b3_s4.rs
compiler/tests/b4_check.rs
compiler/tests/b4_examples.rs
compiler/tests/b4_parse.rs
compiler/tests/b4_resolve.rs
compiler/tests/b4_setparent.rs
compiler/tests/b4_witness.rs
compiler/tests/check.rs
compiler/tests/codegen.rs
compiler/tests/codegen/capabilities.rs [+]
compiler/tests/codegen/examples.rs [+]
compiler/tests/codegen/goldens.rs [+]
compiler/tests/codegen/items.rs [+]
compiler/tests/codegen/pages.rs [+]
compiler/tests/codegen/scalars.rs [+]
compiler/tests/codegen/sourcemap.rs [+]
compiler/tests/codegen/support.rs [+]
compiler/tests/common/lsp_driver.rs
compiler/tests/data/AuthoringDemo.can
compiler/tests/data/s4_fix.can
compiler/tests/docs.rs
compiler/tests/effects.rs
compiler/tests/exe.rs
compiler/tests/format.rs
compiler/tests/foundation.rs
compiler/tests/ide.rs
compiler/tests/lint.rs
compiler/tests/mcp_p1.rs
compiler/tests/mcp_p4.rs
compiler/tests/syntax.rs
compiler/tests/syntax/corpus.rs [+]
compiler/tests/syntax/layout.rs [+]
compiler/tests/syntax/lexer.rs [+]
compiler/tests/syntax/parser.rs [+]
design/AI-AND-SERVICE-DRAFTS.md
design/COMPLEX-APPS.md
design/UI-COMPONENTS.md
design/canonical-exposure-20261004.md
design/canonical-exposure-20261004/witness.can
design/canonical-exposure-20261004/witness.mjs
design/company-policy-review-20261004.md
design/complex-apps/chat-media.md
design/complex-apps/completion-verification.json
design/complex-apps/decide.md
design/complex-apps/discover.md
design/complex-apps/enrich.md
design/complex-apps/inbox.md
design/complex-apps/knowledge.md
design/complex-apps/nine-app-verification.json
design/complex-apps/sync.md
design/complex-apps/workbench.md
design/delivery-association-20261004.md
design/delivery-error-20261004.md
design/delivery-leaf-grants-20261004.md
design/delivery-recipe-overrides-20261004.md
design/evaluation/ADOPTION.md
design/evaluation/INTERFACES.md
design/evaluation/LANGUAGE.md
design/evaluation/baseline-20261004T041647Z/README.md
design/evaluation/baseline-20261004T041647Z/SHA256SUMS
design/evaluation/baseline-20261004T041647Z/snapshot/AGENTS.md
design/evaluation/baseline-20261004T041647Z/snapshot/DECISIONS.md
design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md
design/evaluation/baseline-20261004T041647Z/snapshot/EVALUATION.md
design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md
design/evaluation/baseline-20261004T041647Z/snapshot/REQUIREMENTS.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/ADMIN_SURFACES.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanAffiliate.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanAffiliate.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanApprove.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanApprove.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanApprove.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBoard.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBoard.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBoard.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBook.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBook.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCRM.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCRM.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCRM.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCatch.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCatch.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCheck.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCheck.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCheck.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanContract.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanContract.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCustomer.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCustomer.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanDesk.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanDesk.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanDo.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanDo.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanEvent.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanEvent.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanExpense.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanExpense.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanExpense.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanFeedback.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanFeedback.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanFeedback.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanField.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanField.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanGrant.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanGrant.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanGrant.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanHire.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanHire.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanHire.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanInvoice.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanInvoice.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLearn.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLearn.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLeave.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLeave.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLeave.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLoyalty.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLoyalty.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLoyalty.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMail.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMail.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMail.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMaintain.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMaintain.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMaintain.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMember.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMember.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanOnboard.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanOnboard.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanOnboard.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPropose.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPropose.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPurchase.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPurchase.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPurchase.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanReception.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanReception.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRefer.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRefer.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRefer.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRent.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRent.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRent.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanReport.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanReport.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanShift.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanShift.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanShift.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanStats.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanStats.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanStock.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanStock.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanStock.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanSuccess.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanSuccess.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTable.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTable.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTable.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTime.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTime.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTime.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTrade.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTrade.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanVolunteer.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanVolunteer.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanVolunteer.mjs
design/evaluation/baseline-20261004T041647Z/snapshot/draft/MIGRATION.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/PORTFOLIO.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/README.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/WORKSPACE_OPERATOR.md
design/evaluation/baseline-20261004T041647Z/snapshot/draft/shared/Employees.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/shared/Locations.can
design/evaluation/baseline-20261004T041647Z/snapshot/draft/shared/Suppliers.can
design/evaluation/baseline-20261004T041647Z/snapshot/examples/ExpenseFlow.can
design/evaluation/baseline-20261004T041647Z/snapshot/examples/TeamTasks.can
design/evaluation/briefs/ADOPTION.md
design/evaluation/briefs/INTERFACES.md
design/evaluation/briefs/LANGUAGE.md
design/evaluation/evidence/adoption/consolidation.md
design/evaluation/evidence/adoption/economics/assumptions.md
design/evaluation/evidence/adoption/economics/model.py
design/evaluation/evidence/adoption/economics/results.json
design/evaluation/evidence/adoption/experiment-protocol.md
design/evaluation/evidence/adoption/experiments/C/assumptions.md
design/evaluation/evidence/adoption/experiments/C/change-1/app.can
design/evaluation/evidence/adoption/experiments/C/change-1/notes.md
design/evaluation/evidence/adoption/experiments/C/change-1/source.diff
design/evaluation/evidence/adoption/experiments/C/change-2/app.can
design/evaluation/evidence/adoption/experiments/C/change-2/notes.md
design/evaluation/evidence/adoption/experiments/C/change-2/source.diff
design/evaluation/evidence/adoption/experiments/C/change-2/transition.md
design/evaluation/evidence/adoption/experiments/C/change-3/app.can
design/evaluation/evidence/adoption/experiments/C/change-3/notes.md
design/evaluation/evidence/adoption/experiments/C/change-3/source.diff
design/evaluation/evidence/adoption/experiments/C/changes-context.md
design/evaluation/evidence/adoption/experiments/C/changes-metadata.json
design/evaluation/evidence/adoption/experiments/C/changes-notes.md
design/evaluation/evidence/adoption/experiments/C/context.md
design/evaluation/evidence/adoption/experiments/C/initial.can
design/evaluation/evidence/adoption/experiments/C/metadata.json
design/evaluation/evidence/adoption/experiments/C/review-changes.md
design/evaluation/evidence/adoption/experiments/C/supplied-docs.json
design/evaluation/evidence/adoption/experiments/D/assumptions.md
design/evaluation/evidence/adoption/experiments/D/change-1/behavior.md
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/__init__.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/chat_auth.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/forms.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/mcp_server.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/models.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/service.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/base.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/error.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/form.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/intake.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/list.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/token.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/equipment/upload.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/templates/registration/login.html
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/tests.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/urls.py
design/evaluation/evidence/adoption/experiments/D/change-1/equipment/views.py
design/evaluation/evidence/adoption/experiments/D/change-1/requirements.txt
design/evaluation/evidence/adoption/experiments/D/change-1/test_settings.py
design/evaluation/evidence/adoption/experiments/D/change-1/transition.md
design/evaluation/evidence/adoption/experiments/D/change-1/wiring.md
design/evaluation/evidence/adoption/experiments/D/change-2/behavior.md
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/__init__.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/chat_auth.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/forms.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/mcp_server.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/models.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/service.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/base.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/error.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/form.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/intake.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/list.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/token.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/equipment/upload.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/templates/registration/login.html
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/tests.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/urls.py
design/evaluation/evidence/adoption/experiments/D/change-2/equipment/views.py
design/evaluation/evidence/adoption/experiments/D/change-2/requirements.txt
design/evaluation/evidence/adoption/experiments/D/change-2/test_settings.py
design/evaluation/evidence/adoption/experiments/D/change-2/transition.md
design/evaluation/evidence/adoption/experiments/D/change-2/transition_operations.py
design/evaluation/evidence/adoption/experiments/D/change-2/wiring.md
design/evaluation/evidence/adoption/experiments/D/change-3/behavior.md
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/__init__.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/chat_auth.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/forms.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/mcp_server.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/models.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/service.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/base.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/detail.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/error.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/form.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/intake.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/list.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/reviews.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/token.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/equipment/upload.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/templates/registration/login.html
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/tests.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/urls.py
design/evaluation/evidence/adoption/experiments/D/change-3/equipment/views.py
design/evaluation/evidence/adoption/experiments/D/change-3/permission-transition.md
design/evaluation/evidence/adoption/experiments/D/change-3/requirements.txt
design/evaluation/evidence/adoption/experiments/D/change-3/test_settings.py
design/evaluation/evidence/adoption/experiments/D/change-3/transition.md
design/evaluation/evidence/adoption/experiments/D/change-3/transition_operations.py
design/evaluation/evidence/adoption/experiments/D/change-3/wiring.md
design/evaluation/evidence/adoption/experiments/D/changes-checks.json
design/evaluation/evidence/adoption/experiments/D/changes-context.md
design/evaluation/evidence/adoption/experiments/D/changes-metadata.json
design/evaluation/evidence/adoption/experiments/D/changes-notes.md
design/evaluation/evidence/adoption/experiments/D/context.md
design/evaluation/evidence/adoption/experiments/D/initial/behavior.md
design/evaluation/evidence/adoption/experiments/D/initial/checks.json
design/evaluation/evidence/adoption/experiments/D/initial/equipment/__init__.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/chat_auth.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/forms.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/mcp_server.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/models.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/service.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/base.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/error.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/form.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/intake.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/list.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/token.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/equipment/upload.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/templates/registration/login.html
design/evaluation/evidence/adoption/experiments/D/initial/equipment/tests.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/urls.py
design/evaluation/evidence/adoption/experiments/D/initial/equipment/views.py
design/evaluation/evidence/adoption/experiments/D/initial/requirements.txt
design/evaluation/evidence/adoption/experiments/D/initial/test_settings.py
design/evaluation/evidence/adoption/experiments/D/initial/wiring.md
design/evaluation/evidence/adoption/experiments/D/metadata.json
design/evaluation/evidence/adoption/experiments/D/review-changes.md
design/evaluation/evidence/adoption/experiments/D/review-initial.md
design/evaluation/evidence/adoption/experiments/D/supplied-docs.json
design/evaluation/evidence/adoption/experiments/assessment.md
design/evaluation/evidence/adoption/experiments/changes-brief.md
design/evaluation/evidence/adoption/experiments/layout-assessment.md
design/evaluation/evidence/adoption/experiments/layout/brief.md
design/evaluation/evidence/adoption/experiments/layout/layout-inputs.json
design/evaluation/evidence/adoption/experiments/layout/packages/after/CanExpense.can
design/evaluation/evidence/adoption/experiments/layout/packages/after/Employees.can
design/evaluation/evidence/adoption/experiments/layout/packages/after/Locations.can
design/evaluation/evidence/adoption/experiments/layout/packages/before/CanExpense.can
design/evaluation/evidence/adoption/experiments/layout/packages/before/Employees.can
design/evaluation/evidence/adoption/experiments/layout/packages/before/Locations.can
design/evaluation/evidence/adoption/experiments/layout/packages/context.md
design/evaluation/evidence/adoption/experiments/layout/packages/metadata.json
design/evaluation/evidence/adoption/experiments/layout/packages/notes.md
design/evaluation/evidence/adoption/experiments/layout/single/after/ExpenseWorkspace.can
design/evaluation/evidence/adoption/experiments/layout/single/before/ExpenseWorkspace.can
design/evaluation/evidence/adoption/experiments/layout/single/context.md
design/evaluation/evidence/adoption/experiments/layout/single/metadata.json
design/evaluation/evidence/adoption/experiments/layout/single/notes.md
design/evaluation/evidence/adoption/experiments/provider/CanMail.can
design/evaluation/evidence/adoption/experiments/provider/replacement.md
design/evaluation/evidence/adoption/jev/README.md
design/evaluation/evidence/adoption/jev/egress-check.md
design/evaluation/evidence/adoption/jev/mock-1.request.json
design/evaluation/evidence/adoption/jev/mock-1.result.json
design/evaluation/evidence/adoption/jev/mock-2.request.json
design/evaluation/evidence/adoption/jev/mock-2.result.json
design/evaluation/evidence/adoption/jev/mock-3.request.json
design/evaluation/evidence/adoption/jev/mock-3.result.json
design/evaluation/evidence/adoption/jev/prepare_requests.py
design/evaluation/evidence/adoption/jev/wording.md
design/evaluation/evidence/adoption/journeys.md
design/evaluation/evidence/adoption/measurements/METHOD.md
design/evaluation/evidence/adoption/measurements/corpus.json
design/evaluation/evidence/adoption/measurements/environment.txt
design/evaluation/evidence/adoption/measurements/experiments.json
design/evaluation/evidence/adoption/measurements/measure.py
design/evaluation/evidence/adoption/measurements/measure_experiments.py
design/evaluation/evidence/adoption/measurements/repetition.json
design/evaluation/evidence/adoption/methods.md
design/evaluation/evidence/adoption/ownership.md
design/evaluation/evidence/interfaces/C-initial-review.md
design/evaluation/evidence/interfaces/CanCRM-inline-caption.can
design/evaluation/evidence/interfaces/TeamTasks-de-message-edit.can
design/evaluation/evidence/interfaces/TeamTasks-de.can
design/evaluation/evidence/interfaces/corpus-scan.json
design/evaluation/evidence/interfaces/external-interface-facts.md
design/evaluation/evidence/interfaces/inline-caption-experiment.py
design/evaluation/evidence/interfaces/inline-caption-measurements.json
design/evaluation/evidence/interfaces/jev/README.md
design/evaluation/evidence/interfaces/jev/request-1.json
design/evaluation/evidence/interfaces/jev/request-2.json
design/evaluation/evidence/interfaces/jev/request-3.json
design/evaluation/evidence/interfaces/jev/requests.py
design/evaluation/evidence/interfaces/jev/response-1.json
design/evaluation/evidence/interfaces/jev/response-2.json
design/evaluation/evidence/interfaces/jev/response-3.json
design/evaluation/evidence/interfaces/locale-experiment.py
design/evaluation/evidence/interfaces/locale-measurements.json
design/evaluation/evidence/interfaces/message-scan.json
design/evaluation/evidence/interfaces/provider-facts.md
design/evaluation/evidence/interfaces/target-correspondence.md
design/evaluation/evidence/language/alternatives.md
design/evaluation/evidence/language/corpus.json
design/evaluation/evidence/language/experiment-c-review.md
design/evaluation/evidence/language/experiment-final-review.md
design/evaluation/evidence/language/findings.md
design/evaluation/evidence/language/jev/e102-a.questions.json
design/evaluation/evidence/language/jev/e102-a.result.json
design/evaluation/evidence/language/jev/e102-b.questions.json
design/evaluation/evidence/language/jev/e102-b.result.json
design/evaluation/evidence/language/jev/e102-c.questions.json
design/evaluation/evidence/language/jev/e102-c.result.json
design/evaluation/evidence/language/jev/wording.md
design/evaluation/evidence/language/rules.md
design/evaluation/evidence/language/traces.md
design/evaluation/evidence/language/verification.json
design/evaluation/verification.json
design/field-type-reuse-20261004.md
design/historical-intake-20261004.md
design/historical-intake-20261004/application-checks.json
design/historical-intake-20261004/witness.can
design/historical-intake-20261004/witness.mjs
design/jev/01-foundations.questions.json
design/jev/01-foundations.result.json
design/jev/02-boundaries.questions.json
design/jev/02-boundaries.result.json
design/jev/03-consistency.questions.json
design/jev/03-consistency.result.json
design/jev/04-inline-tests.questions.json
design/jev/04-inline-tests.result.json
design/jev/05-fragments.questions.json
design/jev/05-fragments.result.json
design/jev/06-migration-boundaries.questions.json
design/jev/06-migration-boundaries.result.json
design/jev/07-source-ownership.questions.json
design/jev/07-source-ownership.result.json
design/jev/08-app-composition-b.questions.json
design/jev/08-app-composition-b.result.json
design/jev/08-app-composition-c.questions.json
design/jev/08-app-composition-c.result.json
design/jev/08-app-composition.questions.json
design/jev/08-app-composition.result.json
design/jev/09-repetition-b.questions.json
design/jev/09-repetition-b.result.json
design/jev/09-repetition-c.questions.json
design/jev/09-repetition-c.result.json
design/jev/09-repetition.questions.json
design/jev/09-repetition.result.json
design/jev/10-noul-repetition-b.questions.json
design/jev/10-noul-repetition-b.result.json
design/jev/10-noul-repetition-c.questions.json
design/jev/10-noul-repetition-c.result.json
design/jev/10-noul-repetition.questions.json
design/jev/10-noul-repetition.result.json
design/jev/11-wide-layout-b.questions.json
design/jev/11-wide-layout-b.result.json
design/jev/11-wide-layout-c.questions.json
design/jev/11-wide-layout-c.result.json
design/jev/11-wide-layout.questions.json
design/jev/11-wide-layout.result.json
design/jev/12-wide-layout-balanced-b.questions.json
design/jev/12-wide-layout-balanced-b.result.json
design/jev/12-wide-layout-balanced-c.questions.json
design/jev/12-wide-layout-balanced-c.result.json
design/jev/12-wide-layout-balanced.questions.json
design/jev/12-wide-layout-balanced.result.json
design/jev/13-direct-scenario-body-b.questions.json
design/jev/13-direct-scenario-body-b.result.json
design/jev/13-direct-scenario-body-c.questions.json
design/jev/13-direct-scenario-body-c.result.json
design/jev/13-direct-scenario-body.questions.json
design/jev/13-direct-scenario-body.result.json
design/jev/14-do-body-b.questions.json
design/jev/14-do-body-b.result.json
design/jev/14-do-body-c.questions.json
design/jev/14-do-body-c.result.json
design/jev/14-do-body.questions.json
design/jev/14-do-body.result.json
design/jev/15-syntax-borrowings-b.questions.json
design/jev/15-syntax-borrowings-b.result.json
design/jev/15-syntax-borrowings-c.questions.json
design/jev/15-syntax-borrowings-c.result.json
design/jev/15-syntax-borrowings.questions.json
design/jev/15-syntax-borrowings.result.json
design/jev/16-required-null-grammar-b.questions.json
design/jev/16-required-null-grammar-b.result.json
design/jev/16-required-null-grammar-c.questions.json
design/jev/16-required-null-grammar-c.result.json
design/jev/16-required-null-grammar.questions.json
design/jev/16-required-null-grammar.result.json
design/jev/17-remaining-syntax-b.questions.json
design/jev/17-remaining-syntax-b.result.json
design/jev/17-remaining-syntax-c.questions.json
design/jev/17-remaining-syntax-c.result.json
design/jev/17-remaining-syntax.questions.json
design/jev/17-remaining-syntax.result.json
design/jev/18-team-defaults-b.questions.json
design/jev/18-team-defaults-b.result.json
design/jev/18-team-defaults-c.questions.json
design/jev/18-team-defaults-c.result.json
design/jev/18-team-defaults.questions.json
design/jev/18-team-defaults.result.json
design/jev/19-implicit-app-identity-b.questions.json
design/jev/19-implicit-app-identity-b.result.json
design/jev/19-implicit-app-identity-c.questions.json
design/jev/19-implicit-app-identity-c.result.json
design/jev/19-implicit-app-identity.questions.json
design/jev/19-implicit-app-identity.result.json
design/jev/20-primitive-contracts-b.questions.json
design/jev/20-primitive-contracts-b.result.json
design/jev/20-primitive-contracts-c.questions.json
design/jev/20-primitive-contracts-c.result.json
design/jev/20-primitive-contracts-d.questions.json
design/jev/20-primitive-contracts-d.result.json
design/jev/20-primitive-contracts-e.questions.json
design/jev/20-primitive-contracts-e.result.json
design/jev/20-primitive-contracts-f.questions.json
design/jev/20-primitive-contracts-f.result.json
design/jev/20-primitive-contracts.questions.json
design/jev/20-primitive-contracts.result.json
design/jev/2026-10-04-purchase-stock/1.request.json
design/jev/2026-10-04-purchase-stock/1.result.json
design/jev/2026-10-04-purchase-stock/2.request.json
design/jev/2026-10-04-purchase-stock/2.result.json
design/jev/2026-10-04-purchase-stock/3.request.json
design/jev/2026-10-04-purchase-stock/3.result.json
design/jev/2026-10-04-purchase-stock/README.md
design/jev/2026-10-04-purchase-stock/wording-check.txt
design/jev/21-file-fixtures-b.questions.json
design/jev/21-file-fixtures-b.result.json
design/jev/21-file-fixtures-c.questions.json
design/jev/21-file-fixtures-c.result.json
design/jev/21-file-fixtures.questions.json
design/jev/21-file-fixtures.result.json
design/jev/22-schema-evolution-b.questions.json
design/jev/22-schema-evolution-b.result.json
design/jev/22-schema-evolution-c.questions.json
design/jev/22-schema-evolution-c.result.json
design/jev/22-schema-evolution.questions.json
design/jev/22-schema-evolution.result.json
design/jev/23-exact-grammar-b.questions.json
design/jev/23-exact-grammar-b.result.json
design/jev/23-exact-grammar-c.questions.json
design/jev/23-exact-grammar-c.result.json
design/jev/23-exact-grammar.questions.json
design/jev/23-exact-grammar.result.json
design/jev/24-i18n-b.questions.json
design/jev/24-i18n-b.result.json
design/jev/24-i18n-c.questions.json
design/jev/24-i18n-c.result.json
design/jev/24-i18n.questions.json
design/jev/24-i18n.result.json
design/jev/25-draft-i18n.questions.json
design/jev/26-frontend-requirements-b.questions.json
design/jev/26-frontend-requirements-b.result.json
design/jev/26-frontend-requirements-c.questions.json
design/jev/26-frontend-requirements-c.result.json
design/jev/26-frontend-requirements.questions.json
design/jev/26-frontend-requirements.result.json
design/jev/27-frontend-source-b.questions.json
design/jev/27-frontend-source-b.result.json
design/jev/27-frontend-source-c.questions.json
design/jev/27-frontend-source-c.result.json
design/jev/27-frontend-source.questions.json
design/jev/27-frontend-source.result.json
design/jev/28-history-default-b.questions.json
design/jev/28-history-default-b.result.json
design/jev/28-history-default-c.questions.json
design/jev/28-history-default-c.result.json
design/jev/28-history-default.questions.json
design/jev/28-history-default.result.json
design/jev/29-inline-i18n-b.questions.json
design/jev/29-inline-i18n-b.result.json
design/jev/29-inline-i18n-c.questions.json
design/jev/29-inline-i18n-c.result.json
design/jev/29-inline-i18n.questions.json
design/jev/29-inline-i18n.result.json
design/jev/30-inline-contract-b.questions.json
design/jev/30-inline-contract-b.result.json
design/jev/30-inline-contract-c.questions.json
design/jev/30-inline-contract-c.result.json
design/jev/30-inline-contract.questions.json
design/jev/30-inline-contract.result.json
design/jev/31-compiler-target-b.questions.json
design/jev/31-compiler-target-b.result.json
design/jev/31-compiler-target-c.questions.json
design/jev/31-compiler-target-c.result.json
design/jev/31-compiler-target.questions.json
design/jev/31-compiler-target.result.json
design/jev/32-toolchain-b.questions.json
design/jev/32-toolchain-c.questions.json
design/jev/32-toolchain.questions.json
design/jev/33-server-ui-b.questions.json
design/jev/33-server-ui-b.result.json
design/jev/33-server-ui-c.questions.json
design/jev/33-server-ui-c.result.json
design/jev/33-server-ui.questions.json
design/jev/33-server-ui.result.json
design/jev/README.md
design/jev/business-ai-boundary-20261004/1.request.json
design/jev/business-ai-boundary-20261004/1.result.json
design/jev/business-ai-boundary-20261004/2.request.json
design/jev/business-ai-boundary-20261004/2.result.json
design/jev/business-ai-boundary-20261004/3.request.json
design/jev/business-ai-boundary-20261004/3.result.json
design/jev/business-ai-boundary-20261004/review.md
design/jev/cafe-completion-20261004/analysis.md
design/jev/cafe-completion-20261004/equivalence.md
design/jev/cafe-completion-20261004/request-1.json
design/jev/cafe-completion-20261004/request-2.json
design/jev/cafe-completion-20261004/request-3.json
design/jev/cafe-completion-20261004/result-1.json
design/jev/cafe-completion-20261004/result-2.json
design/jev/cafe-completion-20261004/result-3.json
design/jev/canonical-exposure-20261004/1.request.json
design/jev/canonical-exposure-20261004/1.result.json
design/jev/canonical-exposure-20261004/2.request.json
design/jev/canonical-exposure-20261004/2.result.json
design/jev/canonical-exposure-20261004/3.request.json
design/jev/canonical-exposure-20261004/3.result.json
design/jev/catch-intake-20261004/1.request.json
design/jev/catch-intake-20261004/1.result.json
design/jev/catch-intake-20261004/2.request.json
design/jev/catch-intake-20261004/2.result.json
design/jev/catch-intake-20261004/3.request.json
design/jev/catch-intake-20261004/3.result.json
design/jev/catch-intake-20261004/assessment.md
design/jev/catch-intake-20261004/wording-check.md
design/jev/check-completion-20261004/1.request.json
design/jev/check-completion-20261004/1.result.json
design/jev/check-completion-20261004/2.request.json
design/jev/check-completion-20261004/2.result.json
design/jev/check-completion-20261004/3.request.json
design/jev/check-completion-20261004/3.result.json
design/jev/check-completion-20261004/decision.md
design/jev/check-completion-20261004/wording-check.md
design/jev/complex-chat-media-20261004/1.request.json
design/jev/complex-chat-media-20261004/1.result.json
design/jev/complex-chat-media-20261004/2.request.json
design/jev/complex-chat-media-20261004/2.result.json
design/jev/complex-chat-media-20261004/3.request.json
design/jev/complex-chat-media-20261004/3.result.json
design/jev/complex-chat-media-20261004/4.request.json
design/jev/complex-chat-media-20261004/4.result.json
design/jev/complex-chat-media-20261004/5.request.json
design/jev/complex-chat-media-20261004/5.result.json
design/jev/complex-chat-media-20261004/6.request.json
design/jev/complex-chat-media-20261004/6.result.json
design/jev/complex-chat-media-20261004/assessment.md
design/jev/complex-chat-media-20261004/check-descriptors.cjs
design/jev/complex-chat-media-20261004/descriptor-check.json
design/jev/complex-chat-media-20261004/syntax-projections/CanChat.can
design/jev/complex-chat-media-20261004/syntax-projections/CanChat.changes.txt
design/jev/complex-chat-media-20261004/syntax-projections/CanCreative.can
design/jev/complex-chat-media-20261004/syntax-projections/CanCreative.changes.txt
design/jev/complex-chat-media-20261004/syntax-projections/CanGallery.can
design/jev/complex-chat-media-20261004/syntax-projections/CanGallery.changes.txt
design/jev/complex-decide-20261004/1.request.json
design/jev/complex-decide-20261004/1.result.json
design/jev/complex-decide-20261004/2.request.json
design/jev/complex-decide-20261004/2.result.json
design/jev/complex-decide-20261004/3.request.json
design/jev/complex-decide-20261004/3.result.json
design/jev/complex-decide-20261004/assessment.md
design/jev/complex-decide-20261004/check-descriptors.cjs
design/jev/complex-decide-20261004/syntax-projection-changes.txt
design/jev/complex-decide-20261004/syntax-projection.can
design/jev/complex-discover-20261004/1.request.json
design/jev/complex-discover-20261004/1.result.json
design/jev/complex-discover-20261004/2.request.json
design/jev/complex-discover-20261004/2.result.json
design/jev/complex-discover-20261004/3.request.json
design/jev/complex-discover-20261004/3.result.json
design/jev/complex-enrich-20261004/1.request.json
design/jev/complex-enrich-20261004/1.result.json
design/jev/complex-enrich-20261004/2.request.json
design/jev/complex-enrich-20261004/2.result.json
design/jev/complex-enrich-20261004/3.request.json
design/jev/complex-enrich-20261004/3.result.json
design/jev/complex-enrich-20261004/assessment.md
design/jev/complex-enrich-20261004/final-verification.json
design/jev/complex-enrich-20261004/wording.md
design/jev/complex-inbox-20261004/1.request.json
design/jev/complex-inbox-20261004/1.result.json
design/jev/complex-inbox-20261004/2.request.json
design/jev/complex-inbox-20261004/2.result.json
design/jev/complex-inbox-20261004/3.request.json
design/jev/complex-inbox-20261004/3.result.json
design/jev/complex-inbox-20261004/authoring-comparison.md
design/jev/complex-inbox-20261004/check-draft.py
design/jev/complex-inbox-20261004/static-verification.json
design/jev/complex-inbox-20261004/verification.md
design/jev/complex-knowledge-20261004/1.request.json
design/jev/complex-knowledge-20261004/1.result.json
design/jev/complex-knowledge-20261004/2.request.json
design/jev/complex-knowledge-20261004/2.result.json
design/jev/complex-knowledge-20261004/3.request.json
design/jev/complex-knowledge-20261004/3.result.json
design/jev/complex-knowledge-20261004/check-draft.py
design/jev/complex-knowledge-20261004/final-descriptor-review.cjs
design/jev/complex-knowledge-20261004/static-verification.json
design/jev/complex-knowledge-20261004/verification.md
design/jev/complex-sync-20261004/1.request.json
design/jev/complex-sync-20261004/1.result.json
design/jev/complex-sync-20261004/2.request.json
design/jev/complex-sync-20261004/2.result.json
design/jev/complex-sync-20261004/3.request.json
design/jev/complex-sync-20261004/3.result.json
design/jev/complex-sync-20261004/assessment.md
design/jev/complex-sync-20261004/wording.md
design/jev/complex-workbench-20261004/1.request.json
design/jev/complex-workbench-20261004/1.result.json
design/jev/complex-workbench-20261004/2.request.json
design/jev/complex-workbench-20261004/2.result.json
design/jev/complex-workbench-20261004/3.request.json
design/jev/complex-workbench-20261004/3.result.json
design/jev/complex-workbench-20261004/final-descriptor-review.cjs
design/jev/complex-workbench-20261004/final-verification.json
design/jev/crm-connections-reschedule-20261004/README.md
design/jev/crm-connections-reschedule-20261004/request-1.json
design/jev/crm-connections-reschedule-20261004/request-2.json
design/jev/crm-connections-reschedule-20261004/request-3.json
design/jev/crm-connections-reschedule-20261004/response-1.json
design/jev/crm-connections-reschedule-20261004/response-2.json
design/jev/crm-connections-reschedule-20261004/response-3.json
design/jev/crm-connections-reschedule-20261004/verification.md
design/jev/crm-connections-reschedule-20261004/wording-check.txt
design/jev/daisyui-catalog-20261004/1.request.json
design/jev/daisyui-catalog-20261004/1.result.json
design/jev/daisyui-catalog-20261004/2.request.json
design/jev/daisyui-catalog-20261004/2.result.json
design/jev/daisyui-catalog-20261004/3.request.json
design/jev/daisyui-catalog-20261004/3.result.json
design/jev/daisyui-catalog-20261004/assessment.md
design/jev/daisyui-catalog-20261004/wording-check.md
design/jev/delivery-association-20261004/1.request.json
design/jev/delivery-association-20261004/1.result.json
design/jev/delivery-association-20261004/2.request.json
design/jev/delivery-association-20261004/2.result.json
design/jev/delivery-association-20261004/3.request.json
design/jev/delivery-association-20261004/3.result.json
design/jev/delivery-leaf-grants-20261004/1.request.json
design/jev/delivery-leaf-grants-20261004/1.result.json
design/jev/delivery-leaf-grants-20261004/2.request.json
design/jev/delivery-leaf-grants-20261004/2.result.json
design/jev/delivery-leaf-grants-20261004/3.request.json
design/jev/delivery-leaf-grants-20261004/3.result.json
design/jev/delivery-recipe-overrides-20261004/1.request.json
design/jev/delivery-recipe-overrides-20261004/1.result.json
design/jev/delivery-recipe-overrides-20261004/2.request.json
design/jev/delivery-recipe-overrides-20261004/2.result.json
design/jev/delivery-recipe-overrides-20261004/3.request.json
design/jev/delivery-recipe-overrides-20261004/3.result.json
design/jev/delivery-recipe-overrides-20261004/verification.md
design/jev/delivery-recipe-overrides-20261004/witness.can
design/jev/delivery-recipe-overrides-20261004/witness.mjs
design/jev/delivery-recipe-overrides-20261004/wording-check.md
design/jev/description-reference-20261005/README.md
design/jev/description-reference-20261005/request-1.json
design/jev/description-reference-20261005/request-2.json
design/jev/description-reference-20261005/request-3.json
design/jev/description-reference-20261005/result-1.json
design/jev/description-reference-20261005/result-2.json
design/jev/description-reference-20261005/result-3.json
design/jev/desk-handoff-20261004/1.request.json
design/jev/desk-handoff-20261004/1.result.json
design/jev/desk-handoff-20261004/2.request.json
design/jev/desk-handoff-20261004/2.result.json
design/jev/desk-handoff-20261004/3.request.json
design/jev/desk-handoff-20261004/3.result.json
design/jev/desk-handoff-20261004/review.md
design/jev/desk-handoff-20261004/wording-check.md
design/jev/draft-billing-evidence-20261004-a.questions.json
design/jev/draft-billing-evidence-20261004-a.result.json
design/jev/draft-billing-evidence-20261004-b.questions.json
design/jev/draft-billing-evidence-20261004-b.result.json
design/jev/draft-billing-evidence-20261004-c.questions.json
design/jev/draft-billing-evidence-20261004-c.result.json
design/jev/draft-billing-evidence-20261004-wording.md
design/jev/draft-import-links-20261004-a.questions.json
design/jev/draft-import-links-20261004-a.result.json
design/jev/draft-import-links-20261004-b.questions.json
design/jev/draft-import-links-20261004-b.result.json
design/jev/draft-import-links-20261004-c.questions.json
design/jev/draft-import-links-20261004-c.result.json
design/jev/draft-import-links-20261004-wording.md
design/jev/draft-payment-boundary-20261004-a.questions.json
design/jev/draft-payment-boundary-20261004-a.result.json
design/jev/draft-payment-boundary-20261004-b.questions.json
design/jev/draft-payment-boundary-20261004-b.result.json
design/jev/draft-payment-boundary-20261004-c.questions.json
design/jev/draft-payment-boundary-20261004-c.result.json
design/jev/draft-payment-boundary-20261004-wording.md
design/jev/draft-query-admission-20261004-a.questions.json
design/jev/draft-query-admission-20261004-a.result.json
design/jev/draft-query-admission-20261004-b.questions.json
design/jev/draft-query-admission-20261004-b.result.json
design/jev/draft-query-admission-20261004-c.questions.json
design/jev/draft-query-admission-20261004-c.result.json
design/jev/draft-query-admission-20261004-wording.md
design/jev/draft-role-subject-20261004-a.questions.json
design/jev/draft-role-subject-20261004-a.result.json
design/jev/draft-role-subject-20261004-b.questions.json
design/jev/draft-role-subject-20261004-b.result.json
design/jev/draft-role-subject-20261004-c.questions.json
design/jev/draft-role-subject-20261004-c.result.json
design/jev/draft-role-subject-20261004-wording.md
design/jev/draft-static-20261004-a.questions.json
design/jev/draft-static-20261004-a.response.json
design/jev/draft-static-20261004-b.questions.json
design/jev/draft-static-20261004-b.response.json
design/jev/draft-static-20261004-c.questions.json
design/jev/draft-static-20261004-c.response.json
design/jev/draft-static-20261004-self-check.json
design/jev/draft-ui-20261004-a.questions.json
design/jev/draft-ui-20261004-a.result.json
design/jev/draft-ui-20261004-b.questions.json
design/jev/draft-ui-20261004-b.result.json
design/jev/draft-ui-20261004-c.questions.json
design/jev/draft-ui-20261004-c.result.json
design/jev/draft-ui-20261004-evidence.json
design/jev/draft-ui-20261004-review.json
design/jev/draft-ui-20261004-wording-check.json
design/jev/draft-work-refresh-20261004-a.questions.json
design/jev/draft-work-refresh-20261004-a.result.json
design/jev/draft-work-refresh-20261004-b.questions.json
design/jev/draft-work-refresh-20261004-b.result.json
design/jev/draft-work-refresh-20261004-c.questions.json
design/jev/draft-work-refresh-20261004-c.result.json
design/jev/draft-work-refresh-20261004-wording-check.md
design/jev/draft-workflow-20261004-a.questions.json
design/jev/draft-workflow-20261004-a.result.json
design/jev/draft-workflow-20261004-b.questions.json
design/jev/draft-workflow-20261004-b.result.json
design/jev/draft-workflow-20261004-c.questions.json
design/jev/draft-workflow-20261004-c.result.json
design/jev/draft-workflow-20261004-equivalence.md
design/jev/draft-workflow-20261004-review.json
design/jev/event-completion-20261004/investigation.txt
design/jev/event-completion-20261004/request-1.json
design/jev/event-completion-20261004/request-2.json
design/jev/event-completion-20261004/request-3.json
design/jev/event-completion-20261004/response-1.json
design/jev/event-completion-20261004/response-2.json
design/jev/event-completion-20261004/response-3.json
design/jev/event-completion-20261004/wording-check.txt
design/jev/feedback-completion-20261004/analysis.md
design/jev/feedback-completion-20261004/equivalence.md
design/jev/feedback-completion-20261004/final-request-1.json
design/jev/feedback-completion-20261004/final-request-2.json
design/jev/feedback-completion-20261004/final-request-3.json
design/jev/feedback-completion-20261004/final-result-1.json
design/jev/feedback-completion-20261004/final-result-2.json
design/jev/feedback-completion-20261004/final-result-3.json
design/jev/feedback-completion-20261004/request-1.json
design/jev/feedback-completion-20261004/request-2.json
design/jev/feedback-completion-20261004/request-3.json
design/jev/feedback-completion-20261004/result-1.json
design/jev/fixture-actors-20261004/1.request.json
design/jev/fixture-actors-20261004/1.result.json
design/jev/fixture-actors-20261004/2.request.json
design/jev/fixture-actors-20261004/2.result.json
design/jev/fixture-actors-20261004/3.request.json
design/jev/fixture-actors-20261004/3.result.json
design/jev/fixture-actors-20261004/assessment.md
design/jev/fixture-journeys-20261004/1.request.json
design/jev/fixture-journeys-20261004/1.result.json
design/jev/fixture-journeys-20261004/2.request.json
design/jev/fixture-journeys-20261004/2.result.json
design/jev/fixture-journeys-20261004/3.request.json
design/jev/fixture-journeys-20261004/3.result.json
design/jev/fixture-journeys-20261004/assessment.md
design/jev/grant-completion/request-1.json
design/jev/grant-completion/request-2.json
design/jev/grant-completion/request-3.json
design/jev/grant-completion/review-1.json
design/jev/grant-completion/review-2.json
design/jev/grant-completion/review-3.json
design/jev/grant-review-recovery/request-1.json
design/jev/grant-review-recovery/request-2.json
design/jev/grant-review-recovery/request-3.json
design/jev/grant-review-recovery/review-1.json
design/jev/grant-review-recovery/review-2.json
design/jev/grant-review-recovery/review-3.json
design/jev/hire-onboard-20261004/assessment.md
design/jev/hire-onboard-20261004/request-1.json
design/jev/hire-onboard-20261004/request-2.json
design/jev/hire-onboard-20261004/request-3.json
design/jev/hire-onboard-20261004/response-1.json
design/jev/hire-onboard-20261004/response-2.json
design/jev/hire-onboard-20261004/response-3.json
design/jev/hire-onboard-20261004/wording-check.md
design/jev/hire-retention-20261004/assessment.md
design/jev/hire-retention-20261004/corrected-request-1.json
design/jev/hire-retention-20261004/corrected-request-2.json
design/jev/hire-retention-20261004/corrected-request-3.json
design/jev/hire-retention-20261004/corrected-response-1.json
design/jev/hire-retention-20261004/corrected-response-2.json
design/jev/hire-retention-20261004/corrected-response-3.json
design/jev/hire-retention-20261004/corrected-wording-check.md
design/jev/hire-retention-20261004/correction.md
design/jev/hire-retention-20261004/request-1.json
design/jev/hire-retention-20261004/request-2.json
design/jev/hire-retention-20261004/request-3.json
design/jev/hire-retention-20261004/response-1.json
design/jev/hire-retention-20261004/response-2.json
design/jev/hire-retention-20261004/response-3.json
design/jev/hire-retention-20261004/wording-check.md
design/jev/historical-intake-20261004/1.request.json
design/jev/historical-intake-20261004/1.result.json
design/jev/historical-intake-20261004/2.request.json
design/jev/historical-intake-20261004/2.result.json
design/jev/historical-intake-20261004/3.request.json
design/jev/historical-intake-20261004/3.result.json
design/jev/leave-shift-completion-20261004/request-1.json
design/jev/leave-shift-completion-20261004/request-2.json
design/jev/leave-shift-completion-20261004/request-3.json
design/jev/leave-shift-completion-20261004/result-1.json
design/jev/leave-shift-completion-20261004/result-2.json
design/jev/leave-shift-completion-20261004/result-3.json
design/jev/leave-shift-completion-20261004/review.json
design/jev/leave-shift-completion-20261004/wording-check.txt
design/jev/loyalty-eligibility-20261004/assessment.md
design/jev/loyalty-eligibility-20261004/request-1.json
design/jev/loyalty-eligibility-20261004/request-2.json
design/jev/loyalty-eligibility-20261004/request-3.json
design/jev/loyalty-eligibility-20261004/response-1.json
design/jev/loyalty-eligibility-20261004/response-2.json
design/jev/loyalty-eligibility-20261004/response-3.json
design/jev/loyalty-eligibility-20261004/wording-check.md
design/jev/mail-completion-20261004/request-1.json
design/jev/mail-completion-20261004/request-2.json
design/jev/mail-completion-20261004/request-3.json
design/jev/mail-completion-20261004/response-1.json
design/jev/mail-completion-20261004/response-2.json
design/jev/mail-completion-20261004/response-3.json
design/jev/mail-completion-20261004/review.txt
design/jev/mail-completion-20261004/wording-review.txt
design/jev/maintain-inspection-progress/decision.md
design/jev/maintain-inspection-progress/generic-request-1.json
design/jev/maintain-inspection-progress/generic-request-2.json
design/jev/maintain-inspection-progress/generic-request-3.json
design/jev/maintain-inspection-progress/generic-response-1.json
design/jev/maintain-inspection-progress/generic-response-2.json
design/jev/maintain-inspection-progress/generic-response-3.json
design/jev/maintain-inspection-progress/request-1.json
design/jev/maintain-inspection-progress/request-2.json
design/jev/maintain-inspection-progress/request-3.json
design/jev/maintain-inspection-progress/response-2.json
design/jev/maintain-inspection-progress/response-3.json
design/jev/maintain-inspection-progress/review-evidence.json
design/jev/maintain-inspection-progress/verification.md
design/jev/maintain-recovery-20261004/1.request.json
design/jev/maintain-recovery-20261004/1.result.json
design/jev/maintain-recovery-20261004/2.request.json
design/jev/maintain-recovery-20261004/2.result.json
design/jev/maintain-recovery-20261004/3.request.json
design/jev/maintain-recovery-20261004/3.result.json
design/jev/maintain-recovery-20261004/review.md
design/jev/maintain-recovery-20261004/wording-check.md
design/jev/mcp-file-handoff-20261004/1.request.json
design/jev/mcp-file-handoff-20261004/1.result.json
design/jev/mcp-file-handoff-20261004/2.request.json
design/jev/mcp-file-handoff-20261004/2.result.json
design/jev/mcp-file-handoff-20261004/3.request.json
design/jev/mcp-file-handoff-20261004/3.result.json
design/jev/mcp-file-handoff-20261004/assessment.md
design/jev/mcp-file-handoff-20261004/wording-check.md
design/jev/member-consumed-stage-20261004/assessment.md
design/jev/member-consumed-stage-20261004/request-1.json
design/jev/member-consumed-stage-20261004/request-2.json
design/jev/member-consumed-stage-20261004/request-3.json
design/jev/member-consumed-stage-20261004/response-1.json
design/jev/member-consumed-stage-20261004/response-2.json
design/jev/member-consumed-stage-20261004/response-3.json
design/jev/member-consumed-stage-20261004/wording-check.md
design/jev/member-owner-20261004/assessment.md
design/jev/member-owner-20261004/request-1.json
design/jev/member-owner-20261004/request-2.json
design/jev/member-owner-20261004/request-3.json
design/jev/member-owner-20261004/response-1.json
design/jev/member-owner-20261004/response-2.json
design/jev/member-owner-20261004/response-3.json
design/jev/member-owner-20261004/wording-check.md
design/jev/migration-expense-recovery-1.questions.json
design/jev/migration-expense-recovery-1.result.json
design/jev/migration-expense-recovery-2.questions.json
design/jev/migration-expense-recovery-2.result.json
design/jev/migration-expense-recovery-3.questions.json
design/jev/migration-expense-recovery-3.result.json
design/jev/migration-expense-recovery.md
design/jev/muse-dependency-20261004/STATUS.md
design/jev/muse-feedback-20261004/assessment.md
design/jev/muse-feedback-20261004/bounded-review.md
design/jev/muse-feedback-20261004/request-1.json
design/jev/muse-feedback-20261004/request-2.json
design/jev/muse-feedback-20261004/request-3.json
design/jev/muse-feedback-20261004/result-1.json
design/jev/muse-feedback-20261004/result-2.json
design/jev/muse-feedback-20261004/result-3.json
design/jev/muse-feedback-20261004/syntax-checks.json
design/jev/muse-mail-recovery-20261004/1.request.json
design/jev/muse-mail-recovery-20261004/1.result.json
design/jev/muse-mail-recovery-20261004/2.request.json
design/jev/muse-mail-recovery-20261004/2.result.json
design/jev/muse-mail-recovery-20261004/3.request.json
design/jev/muse-mail-recovery-20261004/3.result.json
design/jev/optional-dependency-closure-20261004/1.request.json
design/jev/optional-dependency-closure-20261004/1.result.json
design/jev/optional-dependency-closure-20261004/2.request.json
design/jev/optional-dependency-closure-20261004/2.result.json
design/jev/optional-dependency-closure-20261004/3.rejected.request.json
design/jev/optional-dependency-closure-20261004/3.rejection.md
design/jev/optional-dependency-closure-20261004/3.request.json
design/jev/optional-dependency-closure-20261004/3.result.json
design/jev/owner-fanout-20261004/1.request.json
design/jev/owner-fanout-20261004/1.result.json
design/jev/owner-fanout-20261004/2.blocked.json
design/jev/owner-fanout-20261004/2.request.json
design/jev/owner-fanout-20261004/3.request.json
design/jev/owner-fanout-20261004/3.result.json
design/jev/owner-fanout-20261004/review.md
design/jev/page-discovery-20261004/1.request.json
design/jev/page-discovery-20261004/1.result.json
design/jev/page-discovery-20261004/2.request.json
design/jev/page-discovery-20261004/2.result.json
design/jev/page-discovery-20261004/3.request.json
design/jev/page-discovery-20261004/3.result.json
design/jev/page-discovery-20261004/assessment.md
design/jev/parent-field-default-20261004/1.request.json
design/jev/parent-field-default-20261004/1.result.json
design/jev/parent-field-default-20261004/2.request.json
design/jev/parent-field-default-20261004/2.result.json
design/jev/parent-field-default-20261004/3.request.json
design/jev/parent-field-default-20261004/3.result.json
design/jev/parent-field-default-20261004/review.md
design/jev/person-selection-20261004/1.request.json
design/jev/person-selection-20261004/1.result.json
design/jev/person-selection-20261004/2.request.json
design/jev/person-selection-20261004/2.result.json
design/jev/person-selection-20261004/3.request.json
design/jev/person-selection-20261004/3.result.json
design/jev/record-input-admission-20261004/1.request.json
design/jev/record-input-admission-20261004/1.result.json
design/jev/record-input-admission-20261004/2.request.json
design/jev/record-input-admission-20261004/2.result.json
design/jev/record-input-admission-20261004/3.request.json
design/jev/record-input-admission-20261004/3.result.json
design/jev/record-input-admission-20261004/assessment.md
design/jev/record-input-admission-20261004/wording-check.md
design/jev/referral-commercial-history-20261004-a.questions.json
design/jev/referral-commercial-history-20261004-a.result.json
design/jev/referral-commercial-history-20261004-a.sandbox-failure.json
design/jev/referral-commercial-history-20261004-b.questions.json
design/jev/referral-commercial-history-20261004-b.result.json
design/jev/referral-commercial-history-20261004-b.sandbox-failure.json
design/jev/referral-commercial-history-20261004-c.questions.json
design/jev/referral-commercial-history-20261004-c.result.json
design/jev/referral-commercial-history-20261004-c.sandbox-failure.json
design/jev/rent-final-gaps-20261004-a.questions.json
design/jev/rent-final-gaps-20261004-a.result.json
design/jev/rent-final-gaps-20261004-assessment.md
design/jev/rent-final-gaps-20261004-b.questions.json
design/jev/rent-final-gaps-20261004-b.result.json
design/jev/rent-final-gaps-20261004-c.questions.json
design/jev/rent-final-gaps-20261004-c.result.json
design/jev/rent-final-gaps-20261004-wording-check.md
design/jev/rent-history-growth-20261004/1.request.json
design/jev/rent-history-growth-20261004/1.result.json
design/jev/rent-history-growth-20261004/2.request.json
design/jev/rent-history-growth-20261004/2.result.json
design/jev/rent-history-growth-20261004/3.request.json
design/jev/rent-history-growth-20261004/3.result.json
design/jev/rent-history-growth-20261004/4.request.json
design/jev/rent-history-growth-20261004/4.result.json
design/jev/rent-history-growth-20261004/5.rejection.txt
design/jev/rent-history-growth-20261004/5.request.json
design/jev/rent-history-growth-20261004/6.request.json
design/jev/rent-history-growth-20261004/6.result.json
design/jev/rent-history-growth-20261004/capture-sites.json
design/jev/rent-reception-20261004-a.questions.json
design/jev/rent-reception-20261004-a.result.json
design/jev/rent-reception-20261004-b.questions.json
design/jev/rent-reception-20261004-b.result.json
design/jev/rent-reception-20261004-c.questions.json
design/jev/rent-reception-20261004-c.result.json
design/jev/rent-reception-20261004-equivalence.md
design/jev/rent-sales-producer-20261004/assessment.md
design/jev/rent-sales-producer-20261004/request-1.json
design/jev/rent-sales-producer-20261004/request-2.json
design/jev/rent-sales-producer-20261004/request-3.json
design/jev/rent-sales-producer-20261004/response-1.json
design/jev/rent-sales-producer-20261004/response-2.json
design/jev/rent-sales-producer-20261004/response-3.json
design/jev/rent-sales-producer-20261004/wording-check.md
design/jev/rent-sales-version-boundary-20261004/assessment.md
design/jev/rent-sales-version-boundary-20261004/request-1.json
design/jev/rent-sales-version-boundary-20261004/request-2.json
design/jev/rent-sales-version-boundary-20261004/request-3.json
design/jev/rent-sales-version-boundary-20261004/response-1.json
design/jev/rent-sales-version-boundary-20261004/response-2.json
design/jev/rent-sales-version-boundary-20261004/response-3.json
design/jev/rent-sales-version-boundary-20261004/wording-check.md
design/jev/rent-venue-20261004-a.questions.json
design/jev/rent-venue-20261004-a.result.json
design/jev/rent-venue-20261004-b.questions.json
design/jev/rent-venue-20261004-b.result.json
design/jev/rent-venue-20261004-c.questions.json
design/jev/rent-venue-20261004-c.result.json
design/jev/rent-venue-20261004-equivalence.md
design/jev/rent-workflows-20261004-a.questions.json
design/jev/rent-workflows-20261004-a.result.json
design/jev/rent-workflows-20261004-b.questions.json
design/jev/rent-workflows-20261004-b.result.json
design/jev/rent-workflows-20261004-c.questions.json
design/jev/rent-workflows-20261004-c.result.json
design/jev/rent-workflows-20261004-equivalence.md
design/jev/rent-workflows-20261004-investigation.md
design/jev/report-completion-20261004/request-1.json
design/jev/report-completion-20261004/request-2.json
design/jev/report-completion-20261004/request-3.json
design/jev/report-completion-20261004/response-1.json
design/jev/report-completion-20261004/response-2.json
design/jev/report-completion-20261004/response-3.json
design/jev/report-completion-20261004/wording-check.txt
design/jev/require-naming-20261004-a.questions.json
design/jev/require-naming-20261004-a.result.json
design/jev/require-naming-20261004-b.questions.json
design/jev/require-naming-20261004-b.result.json
design/jev/require-naming-20261004-c.questions.json
design/jev/require-naming-20261004-c.result.json
design/jev/require-naming-20261004-review.md
design/jev/require-naming-20261004-wording.md
design/jev/shared-attribution-capture-20261004-a.questions.json
design/jev/shared-attribution-capture-20261004-a.result.json
design/jev/shared-attribution-capture-20261004-b.questions.json
design/jev/shared-attribution-capture-20261004-b.result.json
design/jev/shared-attribution-capture-20261004-c.questions.json
design/jev/shared-attribution-capture-20261004-c.result.json
design/jev/stats-breakdown-20261004/1.request.json
design/jev/stats-breakdown-20261004/1.result.json
design/jev/stats-breakdown-20261004/2.request.json
design/jev/stats-breakdown-20261004/2.result.json
design/jev/stats-breakdown-20261004/3.request.json
design/jev/stats-breakdown-20261004/3.result.json
design/jev/stats-breakdown-20261004/assessment.md
design/jev/stats-breakdown-20261004/wording-check.md
design/jev/t33-context-correction-20261006/README.md
design/jev/t33-context-correction-20261006/request-1.json
design/jev/t33-context-correction-20261006/request-2.json
design/jev/t33-context-correction-20261006/request-3.json
design/jev/t33-context-correction-20261006/result-1.json
design/jev/t33-context-correction-20261006/result-2.json
design/jev/t33-context-correction-20261006/result-3.json
design/jev/time-completion-20261004/analysis.md
design/jev/time-completion-20261004/request-1.json
design/jev/time-completion-20261004/request-2.json
design/jev/time-completion-20261004/request-3.json
design/jev/time-completion-20261004/result-1.json
design/jev/time-completion-20261004/result-2.json
design/jev/time-completion-20261004/result-3.json
design/jev/time-completion-20261004/wording-check.md
design/muse-migration-20261004/dependency-design.md
design/muse-migration-20261004/extraction-design.md
design/muse-migration-20261004/feedback-design.md
design/muse-migration-20261004/history-design.md
design/muse-migration-20261004/inbox.md
design/muse-migration-20261004/mail-recovery-design.md
design/muse-migration-20261004/monitor.md
design/muse-migration-20261004/progress-design.md
design/muse-migration-20261004/review.md
design/muse-migration-20261004/tasks.md
design/optional-dependency-closure-20261004.md
design/optional-dependency-closure-20261004/closure.json
design/optional-dependency-closure-20261004/value-witness.can
design/optional-dependency-closure-20261004/value-witness.mjs
design/optional-dependency-closure-20261004/witness.can
design/optional-dependency-closure-20261004/witness.mjs
design/owner-fanout-20261004.md
design/person-selection-20261004.md
design/propose-delivery-20261004.md
design/rent-history-growth-20261004.md
design/rent-history-growth-20261004/checks.json
design/rent-history-growth-20261004/current-mechanism.can.txt
design/rent-history-growth-20261004/current-mechanism.mjs.txt
design/rent-history-growth-20261004/current-report-handler.mjs.txt
design/rent-history-growth-20261004/history-mechanism.can.txt
design/rent-history-growth-20261004/history-mechanism.mjs.txt
design/rent-history-growth-20261004/history-rows.mjs.txt
design/rent-history-growth-20261004/input-hashes.json
design/rent-history-growth-20261004/measurements.json
design/rent-history-growth-20261004/negative-cases.json
design/rent-history-growth-20261004/witness.can
design/rent-history-growth-20261004/witness.mjs
design/research-ai-capabilities-20261004.md
design/research-demanding-apps-20261004.md
docs/authoring-demo.md
docs/dev-setup.md
docs/e2e.md
docs/ideal-filetree-plan.md
docs/ideal-filetree-plan/allocations.json [B]
docs/ideal-filetree-plan/backlog.json [B]
docs/ideal-filetree-plan/baseline.md [B]
docs/ideal-filetree-plan/consultations.md [B]
docs/ideal-filetree-plan/desired-tree.md [B]
docs/ideal-filetree-plan/findings.md [B]
docs/ideal-filetree-plan/inventory.json [B]
docs/ideal-filetree-plan/lanes.md [B]
docs/ideal-filetree-plan/ownership.md [B]
docs/ideal-filetree-plan/prior-review.md [B]
docs/ideal-filetree-plan/reviews/compiler-coverage.json [B]
docs/ideal-filetree-plan/reviews/compiler.md [B]
docs/ideal-filetree-plan/reviews/platform-coverage.json [B]
docs/ideal-filetree-plan/reviews/platform.md [B]
docs/ideal-filetree-plan/reviews/repository.md [B]
docs/ideal-filetree-plan/reviews/runtime-coverage.json [B]
docs/ideal-filetree-plan/reviews/runtime.md [B]
docs/ideal-filetree-plan/slices.md [B]
docs/ideal-filetree-plan/target-tree.json [B]
docs/ideal-filetree-plan/tasks.md [B]
docs/ideal-filetree-plan/verification.json [B]
docs/install.md
draft
draft/.gitignore [D]
draft/ADMIN_SURFACES.md [D]
draft/CanAffiliate.can [D]
draft/CanAffiliate.md [D]
draft/CanApprove.can [D]
draft/CanApprove.md [D]
draft/CanApprove.mjs [D]
draft/CanBoard.can [D]
draft/CanBoard.md [D]
draft/CanBoard.mjs [D]
draft/CanBook.can [D]
draft/CanBook.md [D]
draft/CanCRM.can [D]
draft/CanCRM.md [D]
draft/CanCRM.mjs [D]
draft/CanCatch.can [D]
draft/CanCatch.md [D]
draft/CanChat.can [D]
draft/CanChat.md [D]
draft/CanChat.mjs [D]
draft/CanCheck.can [D]
draft/CanCheck.md [D]
draft/CanCheck.mjs [D]
draft/CanContract.can [D]
draft/CanContract.md [D]
draft/CanCreative.can [D]
draft/CanCreative.md [D]
draft/CanCreative.mjs [D]
draft/CanCustomer.can [D]
draft/CanCustomer.md [D]
draft/CanDecide.can [D]
draft/CanDecide.md [D]
draft/CanDecide.mjs [D]
draft/CanDesk.can [D]
draft/CanDesk.md [D]
draft/CanDiscover.can [D]
draft/CanDiscover.md [D]
draft/CanDiscover.mjs [D]
draft/CanDo.can [D]
draft/CanDo.md [D]
draft/CanDo.mjs [D]
draft/CanEnrich.can [D]
draft/CanEnrich.md [D]
draft/CanEnrich.mjs [D]
draft/CanEvent.can [D]
draft/CanEvent.md [D]
draft/CanExpense.can [D]
draft/CanExpense.md [D]
draft/CanExpense.mjs [D]
draft/CanFeedback.can [D]
draft/CanFeedback.md [D]
draft/CanFeedback.mjs [D]
draft/CanField.can [D]
draft/CanField.md [D]
draft/CanGallery.can [D]
draft/CanGallery.md [D]
draft/CanGallery.mjs [D]
draft/CanGrant.can [D]
draft/CanGrant.md [D]
draft/CanGrant.mjs [D]
draft/CanHire.can [D]
draft/CanHire.md [D]
draft/CanHire.mjs [D]
draft/CanInbox.can [D]
draft/CanInbox.md [D]
draft/CanInbox.mjs [D]
draft/CanInvoice.can [D]
draft/CanInvoice.md [D]
draft/CanInvoice.mjs [D]
draft/CanKnowledge.can [D]
draft/CanKnowledge.md [D]
draft/CanKnowledge.mjs [D]
draft/CanLearn.can [D]
draft/CanLearn.md [D]
draft/CanLearn.mjs [D]
draft/CanLeave.can [D]
draft/CanLeave.md [D]
draft/CanLeave.mjs [D]
draft/CanLoyalty.can [D]
draft/CanLoyalty.md [D]
draft/CanLoyalty.mjs [D]
draft/CanMail.can [D]
draft/CanMail.md [D]
draft/CanMail.mjs [D]
draft/CanMaintain.can [D]
draft/CanMaintain.md [D]
draft/CanMaintain.mjs [D]
draft/CanMember.can [D]
draft/CanMember.md [D]
draft/CanMember.mjs [D]
draft/CanOnboard.can [D]
draft/CanOnboard.md [D]
draft/CanOnboard.mjs [D]
draft/CanPropose.can [D]
draft/CanPropose.md [D]
draft/CanPropose.mjs [D]
draft/CanPurchase.can [D]
draft/CanPurchase.md [D]
draft/CanPurchase.mjs [D]
draft/CanReception.can [D]
draft/CanReception.md [D]
draft/CanReception.mjs [D]
draft/CanRefer.can [D]
draft/CanRefer.md [D]
draft/CanRefer.mjs [D]
draft/CanRent.can [D]
draft/CanRent.md [D]
draft/CanRent.mjs [D]
draft/CanReport.can [D]
draft/CanReport.md [D]
draft/CanReport.mjs [D]
draft/CanShift.can [D]
draft/CanShift.md [D]
draft/CanShift.mjs [D]
draft/CanStats.can [D]
draft/CanStats.md [D]
draft/CanStats.mjs [D]
draft/CanStock.can [D]
draft/CanStock.md [D]
draft/CanStock.mjs [D]
draft/CanSuccess.can [D]
draft/CanSuccess.md [D]
draft/CanSuccess.mjs [D]
draft/CanSync.can [D]
draft/CanSync.md [D]
draft/CanSync.mjs [D]
draft/CanTable.can [D]
draft/CanTable.md [D]
draft/CanTable.mjs [D]
draft/CanTime.can [D]
draft/CanTime.md [D]
draft/CanTime.mjs [D]
draft/CanTrade.can [D]
draft/CanTrade.md [D]
draft/CanTrade.mjs [D]
draft/CanVolunteer.can [D]
draft/CanVolunteer.md [D]
draft/CanVolunteer.mjs [D]
draft/CanWorkbench.can [D]
draft/CanWorkbench.md [D]
draft/CanWorkbench.mjs [D]
draft/MIGRATION.md [D]
draft/PORTFOLIO.md [D]
draft/README.md [D]
draft/WORKSPACE_OPERATOR.md [D]
draft/shared/Employees.can [D]
draft/shared/Locations.can [D]
draft/shared/Suppliers.can [D]
editors/vscode/.empty-typeroot/.gitkeep
editors/vscode/.vscodeignore
editors/vscode/AUDIT-RESOLUTION.md
editors/vscode/GRAMMAR-AUDIT.md
editors/vscode/PALETTE.md
editors/vscode/README.md
editors/vscode/audit-astra/REPORT.md
editors/vscode/audit-astra/build-inventory.py
editors/vscode/audit-astra/changed-during-audit.json
editors/vscode/audit-astra/changed-rule-current-path.txt
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/RECHECK.md
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/inline-require-probe.cjs
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/inline-require-theme-evidence.json
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/inline-require-theme-result.md
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/manifest.json
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/probe-results.json
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/probes.json
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/results.txt
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/snapshot/GRAMMAR.md
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/snapshot/editors/vscode/package.json
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/snapshot/editors/vscode/syntaxes/can.tmLanguage.json
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/inline-do-require.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/multiline-parenthesized-form.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/owned-model-app.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/owned-model-capability.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/owned-model-contract.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/owned-model-event.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/owned-model-package.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/owned-model-role.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/sources/qualified-migration-targets.can
editors/vscode/audit-astra/changed-rule-recheck-20261004T020201Z/tokenize.cjs
editors/vscode/audit-astra/corpus-tokens.json
editors/vscode/audit-astra/description-probe.cjs
editors/vscode/audit-astra/description-results.json
editors/vscode/audit-astra/description-results.txt
editors/vscode/audit-astra/execution-presentation-latest-results.json
editors/vscode/audit-astra/execution-presentation-probe-results.json
editors/vscode/audit-astra/execution-presentation-probes.json
editors/vscode/audit-astra/execution-presentation-tokenize.cjs
editors/vscode/audit-astra/final-changed-files/DECISIONS.md
editors/vscode/audit-astra/final-changed-files/DESIGN.md
editors/vscode/audit-astra/final-changed-files/draft/CanField.can
editors/vscode/audit-astra/final-changed-files/draft/CanMaintain.can
editors/vscode/audit-astra/final-changed-files/draft/CanMember.can
editors/vscode/audit-astra/final-changed-files/draft/CanRent.can
editors/vscode/audit-astra/final-changed-files/draft/shared/Locations.can
editors/vscode/audit-astra/final-changed-files/editors/vscode/README.md
editors/vscode/audit-astra/final-changed-files/editors/vscode/check-highlighting.cjs
editors/vscode/audit-astra/final-changed-files/editors/vscode/package.json
editors/vscode/audit-astra/final-changed-files/editors/vscode/syntaxes/can.tmLanguage.json
editors/vscode/audit-astra/final-file-drift.json
editors/vscode/audit-astra/final-palette-swap-settings.json
editors/vscode/audit-astra/followup-013-theme-evidence.json
editors/vscode/audit-astra/followup-013-theme-probe.cjs
editors/vscode/audit-astra/followup-013-theme.md
editors/vscode/audit-astra/followup-013/manifest.json
editors/vscode/audit-astra/followup-013/package.json
editors/vscode/audit-astra/followup-013/syntaxes/can.tmLanguage.json
editors/vscode/audit-astra/inventory-execution-presentation.md
editors/vscode/audit-astra/inventory-foundation.md
editors/vscode/audit-astra/latest-corpus-tokens.json
editors/vscode/audit-astra/latest-extension/package.json
editors/vscode/audit-astra/latest-extension/syntaxes/can.tmLanguage.json
editors/vscode/audit-astra/latest-probe-results.json
editors/vscode/audit-astra/latest-probe-results.txt
editors/vscode/audit-astra/probe-results.json
editors/vscode/audit-astra/probe-results.txt
editors/vscode/audit-astra/probe-tokenization.cjs
editors/vscode/audit-astra/probes.json
editors/vscode/audit-astra/production-coverage.csv
editors/vscode/audit-astra/recheck-20261004T014855Z/RECHECK.md
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-probes.json
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-recheck.md
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-results.json
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-results.txt
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-backend-context.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-contextual-models.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-crud-examples.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-inline-structural-guards.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-joined-query.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-operation-slots.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-operator-operand-boundaries.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-owned-contextual-models.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-qualified-operation-parentheses.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-query-contextual-names.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-scenario-examples-contextual.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-sources/valid-ui-query-and-guards.can
editors/vscode/audit-astra/recheck-20261004T014855Z/execution-tokenize.cjs
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F4-inline-contextual-type-atoms.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F4-multiline-contextual-type-atoms.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F4-multiline-signature-types.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F6-selector-literal-prefix-names.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F6-spaced-signed-and-qualified-selectors.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F7-multiline-values-shorthand.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F7-route-type-subroles.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F7-whitespace-array-suffixes.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F8-model-field-handler-shapes.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F8-original-maintenance.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-can-probes/F8-qualified-target-paths.can
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-probes.json
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-recheck.md
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-results.json
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-results.txt
editors/vscode/audit-astra/recheck-20261004T014855Z/foundation-tokenize.cjs
editors/vscode/audit-astra/recheck-20261004T014855Z/inline-require-evidence.json
editors/vscode/audit-astra/recheck-20261004T014855Z/manifest.json
editors/vscode/audit-astra/recheck-20261004T014855Z/original-probe-results.txt
editors/vscode/audit-astra/recheck-20261004T014855Z/original-probes.json
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-probes.json
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-results.json
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-results.txt
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-sources/app.can
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-sources/capability.can
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-sources/contract.can
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-sources/event.can
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-sources/package.can
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal-sources/role.can
editors/vscode/audit-astra/recheck-20261004T014855Z/owned-model-minimal.cjs
editors/vscode/audit-astra/recheck-20261004T014855Z/probe-results.json
editors/vscode/audit-astra/recheck-20261004T014855Z/replay-original.cjs
editors/vscode/audit-astra/recheck-20261004T014855Z/root-focused-probes.json
editors/vscode/audit-astra/recheck-20261004T014855Z/root-focused-results.json
editors/vscode/audit-astra/recheck-20261004T014855Z/root-focused-results.txt
editors/vscode/audit-astra/recheck-20261004T014855Z/root-focused.cjs
editors/vscode/audit-astra/recheck-20261004T014855Z/snapshot/AGENTS.md
editors/vscode/audit-astra/recheck-20261004T014855Z/snapshot/GRAMMAR.md
editors/vscode/audit-astra/recheck-20261004T014855Z/snapshot/editors/vscode/package.json
editors/vscode/audit-astra/recheck-20261004T014855Z/snapshot/editors/vscode/syntaxes/can.tmLanguage.json
editors/vscode/audit-astra/recheck-20261004T014855Z/source-drift.json
editors/vscode/audit-astra/recheck-20261004T014855Z/theme-evidence.json
editors/vscode/audit-astra/recheck-20261004T014855Z/theme-probe.cjs
editors/vscode/audit-astra/recheck-20261004T014855Z/theme-report.md
editors/vscode/audit-astra/recheck-current-path.txt
editors/vscode/audit-astra/snapshot-manifest.json
editors/vscode/audit-astra/snapshot/AGENTS.md
editors/vscode/audit-astra/snapshot/DECISIONS.md
editors/vscode/audit-astra/snapshot/DESIGN.md
editors/vscode/audit-astra/snapshot/GRAMMAR.md
editors/vscode/audit-astra/snapshot/draft/CanAffiliate.can
editors/vscode/audit-astra/snapshot/draft/CanApprove.can
editors/vscode/audit-astra/snapshot/draft/CanBoard.can
editors/vscode/audit-astra/snapshot/draft/CanBook.can
editors/vscode/audit-astra/snapshot/draft/CanCRM.can
editors/vscode/audit-astra/snapshot/draft/CanCatch.can
editors/vscode/audit-astra/snapshot/draft/CanCheck.can
editors/vscode/audit-astra/snapshot/draft/CanContract.can
editors/vscode/audit-astra/snapshot/draft/CanCustomer.can
editors/vscode/audit-astra/snapshot/draft/CanDesk.can
editors/vscode/audit-astra/snapshot/draft/CanDo.can
editors/vscode/audit-astra/snapshot/draft/CanEvent.can
editors/vscode/audit-astra/snapshot/draft/CanExpense.can
editors/vscode/audit-astra/snapshot/draft/CanFeedback.can
editors/vscode/audit-astra/snapshot/draft/CanField.can
editors/vscode/audit-astra/snapshot/draft/CanGrant.can
editors/vscode/audit-astra/snapshot/draft/CanHire.can
editors/vscode/audit-astra/snapshot/draft/CanInvoice.can
editors/vscode/audit-astra/snapshot/draft/CanLearn.can
editors/vscode/audit-astra/snapshot/draft/CanLeave.can
editors/vscode/audit-astra/snapshot/draft/CanLoyalty.can
editors/vscode/audit-astra/snapshot/draft/CanMail.can
editors/vscode/audit-astra/snapshot/draft/CanMaintain.can
editors/vscode/audit-astra/snapshot/draft/CanMember.can
editors/vscode/audit-astra/snapshot/draft/CanOnboard.can
editors/vscode/audit-astra/snapshot/draft/CanPropose.can
editors/vscode/audit-astra/snapshot/draft/CanPurchase.can
editors/vscode/audit-astra/snapshot/draft/CanReception.can
editors/vscode/audit-astra/snapshot/draft/CanRefer.can
editors/vscode/audit-astra/snapshot/draft/CanRent.can
editors/vscode/audit-astra/snapshot/draft/CanReport.can
editors/vscode/audit-astra/snapshot/draft/CanShift.can
editors/vscode/audit-astra/snapshot/draft/CanStats.can
editors/vscode/audit-astra/snapshot/draft/CanStock.can
editors/vscode/audit-astra/snapshot/draft/CanSuccess.can
editors/vscode/audit-astra/snapshot/draft/CanTable.can
editors/vscode/audit-astra/snapshot/draft/CanTime.can
editors/vscode/audit-astra/snapshot/draft/CanTrade.can
editors/vscode/audit-astra/snapshot/draft/CanVolunteer.can
editors/vscode/audit-astra/snapshot/draft/shared/Employees.can
editors/vscode/audit-astra/snapshot/draft/shared/Locations.can
editors/vscode/audit-astra/snapshot/draft/shared/Suppliers.can
editors/vscode/audit-astra/snapshot/editors/vscode/GRAMMAR-AUDIT.md
editors/vscode/audit-astra/snapshot/editors/vscode/README.md
editors/vscode/audit-astra/snapshot/editors/vscode/check-highlighting.cjs
editors/vscode/audit-astra/snapshot/editors/vscode/package.json
editors/vscode/audit-astra/snapshot/editors/vscode/syntaxes/can.tmLanguage.json
editors/vscode/audit-astra/snapshot/examples/ExpenseFlow.can
editors/vscode/audit-astra/snapshot/examples/TeamTasks.can
editors/vscode/audit-astra/theme-installation-evidence-005813.json
editors/vscode/audit-astra/theme-installation-evidence-010004.json
editors/vscode/audit-astra/theme-installation-evidence-010146.json
editors/vscode/audit-astra/theme-installation-evidence.json
editors/vscode/audit-astra/theme-installation.md
editors/vscode/audit-astra/theme-probe.cjs
editors/vscode/audit-resolution-evidence.json
editors/vscode/check-highlighting.cjs
editors/vscode/generate-file-icons.cjs
editors/vscode/images/file-icon-dark.svg
editors/vscode/images/file-icon-light.svg
editors/vscode/images/icon-dark.png
editors/vscode/images/icon.png
editors/vscode/images/logo.svg
editors/vscode/images/previews/README.md
editors/vscode/images/previews/browser-dark-dark-512.png
editors/vscode/images/previews/browser-dark-white-512.png
editors/vscode/images/previews/browser-light-dark-512.png
editors/vscode/images/previews/browser-light-white-512.png
editors/vscode/images/previews/browser-media-verification.json
editors/vscode/images/previews/dark-dark-16.png
editors/vscode/images/previews/dark-dark-48.png
editors/vscode/images/previews/dark-dark-512.png
editors/vscode/images/previews/dark-white-16.png
editors/vscode/images/previews/dark-white-48.png
editors/vscode/images/previews/dark-white-512.png
editors/vscode/images/previews/file-icon-offset.png
editors/vscode/images/previews/file-icon-verification.json
editors/vscode/images/previews/geometry-verification.json
editors/vscode/images/previews/light-dark-16.png
editors/vscode/images/previews/light-dark-48.png
editors/vscode/images/previews/light-dark-512.png
editors/vscode/images/previews/light-white-16.png
editors/vscode/images/previews/light-white-48.png
editors/vscode/images/previews/light-white-512.png
editors/vscode/images/previews/master-dark-1254.png
editors/vscode/images/previews/package-verification.json
editors/vscode/images/previews/renderer-comparison.json
editors/vscode/images/previews/side-by-side-1254.png
editors/vscode/images/previews/small-sizes.png
editors/vscode/images/previews/themes-512.png
editors/vscode/images/previews/vector-dark-1254.png
editors/vscode/images/previews/vector-transparent-1254.png
editors/vscode/package.json
editors/vscode/palette-evidence.json
editors/vscode/section-style-evidence.json
editors/vscode/src/client.ts
editors/vscode/src/diagnostics.ts [+]
editors/vscode/src/extension.ts
editors/vscode/src/protocol.ts [+]
editors/vscode/src/providers.ts [+]
editors/vscode/syntaxes/can.tmLanguage.json
editors/vscode/test/corpus.cjs [+]
editors/vscode/test/engine.cjs [+]
editors/vscode/test/lsp-capabilities.can
editors/vscode/test/lsp-capabilities.cjs
editors/vscode/test/lsp-codeaction.can
editors/vscode/test/palette.cjs [+]
editors/vscode/test/syntax.cjs [+]
editors/vscode/token-colors.json
examples/ExpenseFlow.can
examples/TeamTasks.can
examples/expenseflow-demo/README.md
examples/expenseflow-demo/demo.mjs
examples/expenseflow-demo/expenses.policy.json
examples/expenseflow-demo/prove.mjs
implementation/CHALLENGE-AUDIT-PLAN.md
implementation/CONTRACTS.md
implementation/DESCRIPTION-REFERENCE-PLAN.md
implementation/DESIGN-DELTA-20261004.md
implementation/DIAGNOSTICS.md
implementation/PLAN.md
implementation/UI-CATALOG-ADOPTION.md
implementation/WORKFLOW.md
implementation/briefs/05-ui.md
implementation/briefs/08-frontend-catalog-migration.md
implementation/challenge-audit-run/evidence/app-intent.md
implementation/challenge-audit-run/evidence/containment-decision.md
implementation/challenge-audit-run/evidence/continuation-contract.md
implementation/challenge-audit-run/evidence/execution-contract.md
implementation/challenge-audit-run/evidence/fanout-decision.md
implementation/challenge-audit-run/evidence/hook-decision.md
implementation/challenge-audit-run/evidence/interface-inventory.md
implementation/challenge-audit-run/evidence/jev-t28-20261005/README.md
implementation/challenge-audit-run/evidence/jev-t28-20261005/request-1.json
implementation/challenge-audit-run/evidence/jev-t28-20261005/request-2.json
implementation/challenge-audit-run/evidence/jev-t28-20261005/request-3.json
implementation/challenge-audit-run/evidence/jev-t28-20261005/result-1.json
implementation/challenge-audit-run/evidence/jev-t28-20261005/result-2.json
implementation/challenge-audit-run/evidence/jev-t28-20261005/result-3.json
implementation/challenge-audit-run/evidence/jev-t31a-20261005/README.md
implementation/challenge-audit-run/evidence/jev-t31a-20261005/request-1.json
implementation/challenge-audit-run/evidence/jev-t31a-20261005/request-2.json
implementation/challenge-audit-run/evidence/jev-t31a-20261005/request-3.json
implementation/challenge-audit-run/evidence/jev-t31a-20261005/result-1.json
implementation/challenge-audit-run/evidence/jev-t31a-20261005/result-2.json
implementation/challenge-audit-run/evidence/jev-t31a-20261005/result-3.json
implementation/challenge-audit-run/evidence/jev-t32a-20261005/README.md
implementation/challenge-audit-run/evidence/jev-t32a-20261005/request-1.json
implementation/challenge-audit-run/evidence/jev-t32a-20261005/request-2.json
implementation/challenge-audit-run/evidence/jev-t32a-20261005/request-3.json
implementation/challenge-audit-run/evidence/jev-t32a-20261005/result-1.json
implementation/challenge-audit-run/evidence/jev-t32a-20261005/result-2.json
implementation/challenge-audit-run/evidence/jev-t32a-20261005/result-3.json
implementation/challenge-audit-run/evidence/jev-t33-20261006/README.md
implementation/challenge-audit-run/evidence/jev-t33-20261006/request-1.json
implementation/challenge-audit-run/evidence/jev-t33-20261006/request-2.json
implementation/challenge-audit-run/evidence/jev-t33-20261006/request-3.json
implementation/challenge-audit-run/evidence/jev-t33-20261006/result-1.json
implementation/challenge-audit-run/evidence/jev-t33-20261006/result-2.json
implementation/challenge-audit-run/evidence/jev-t33-20261006/result-3.json
implementation/challenge-audit-run/evidence/read-decision.md
implementation/challenge-audit-run/evidence/root-causes.md
implementation/challenge-audit-run/evidence/t34-plan.md
implementation/challenge-audit-run/monitor.md
implementation/challenge-audit-run/t33-resolution.md
implementation/challenge-audit-run/tasks.md
implementation/description-reference-run/evidence/independent-acceptance-20261005.json
implementation/description-reference-run/evidence/independent-locale-recheck-20261005.json
implementation/description-reference-run/evidence/integration.md
implementation/description-reference-run/review.md
implementation/description-reference-run/tasks.md
implementation/evidence/b2-follow-through.md
implementation/evidence/b3-i1.md
implementation/evidence/b3-i2.md
implementation/evidence/b3-i3.md
implementation/evidence/b3-i4.md
implementation/evidence/b3-i5.md
implementation/evidence/b3-i6.md
implementation/evidence/b4-draft-defects.md
implementation/evidence/b4-f1.md
implementation/evidence/b4-f2.md
implementation/evidence/b4-f3.md
implementation/evidence/b4-f4.md
implementation/evidence/b4-proposals.md
implementation/evidence/b5-j1.md
implementation/evidence/b5-j2.md
implementation/evidence/b5-j3.md
implementation/evidence/jev/lane-03-s7-20261004/1.request.json
implementation/evidence/jev/lane-03-s7-20261004/1.result.json
implementation/evidence/jev/lane-03-s7-20261004/2.request.json
implementation/evidence/jev/lane-03-s7-20261004/2.result.json
implementation/evidence/jev/lane-03-s7-20261004/3.request.json
implementation/evidence/jev/lane-03-s7-20261004/3.result.json
implementation/evidence/jev/lane-05-c7-20261004/1.request.json
implementation/evidence/jev/lane-05-c7-20261004/1.result.json
implementation/evidence/jev/lane-05-c7-20261004/2.request.json
implementation/evidence/jev/lane-05-c7-20261004/2.result.json
implementation/evidence/jev/lane-05-c7-20261004/3.request.json
implementation/evidence/jev/lane-05-c7-20261004/3.result.json
implementation/evidence/jev/lane-05-c7-20261004/review.md
implementation/evidence/jev/lane-05-s5-20261004/1.request.json
implementation/evidence/jev/lane-05-s5-20261004/1.result.json
implementation/evidence/jev/lane-05-s5-20261004/2.request.json
implementation/evidence/jev/lane-05-s5-20261004/2.result.json
implementation/evidence/jev/lane-05-s5-20261004/3.request.json
implementation/evidence/jev/lane-05-s5-20261004/3.result.json
implementation/evidence/jev/lane-05-s5-20261004/review.md
implementation/evidence/jev/lane-07-seed-design-20261004/q1.json
implementation/evidence/jev/lane-07-seed-design-20261004/q2.json
implementation/evidence/jev/lane-07-seed-design-20261004/q3.json
implementation/evidence/jev/lanes-20261004/1.request.json
implementation/evidence/jev/lanes-20261004/1.result.json
implementation/evidence/jev/lanes-20261004/2.request.json
implementation/evidence/jev/lanes-20261004/2.result.json
implementation/evidence/jev/lanes-20261004/3.request.json
implementation/evidence/jev/lanes-20261004/3.result.json
implementation/evidence/jev/lanes-20261004/4.request.json
implementation/evidence/jev/lanes-20261004/4.result.json
implementation/evidence/jev/lanes-20261004/5.request.json
implementation/evidence/jev/lanes-20261004/5.result.json
implementation/evidence/jev/lanes-20261004/6.request.json
implementation/evidence/jev/lanes-20261004/6.result.json
implementation/evidence/jev/lanes-20261004/five-lane-review.md
implementation/evidence/jev/lanes-20261004/review.md
implementation/evidence/jev/lanes-20261004/wording.md
implementation/evidence/jev/values-20261004/context.md
implementation/evidence/jev/values-20261004/values-20261004-a.questions.json
implementation/evidence/jev/values-20261004/values-20261004-a.result.json
implementation/evidence/jev/values-20261004/values-20261004-b.questions.json
implementation/evidence/jev/values-20261004/values-20261004-b.result.json
implementation/evidence/jev/values-20261004/values-20261004-c.questions.json
implementation/evidence/jev/values-20261004/values-20261004-c.result.json
implementation/evidence/jev/values-20261004/values-20261004-review.md
implementation/evidence/lane-01-b1/phase2.md
implementation/evidence/lane-01-b1/runtime.md
implementation/evidence/mcp-p1.md
implementation/evidence/mcp-p2.md
implementation/evidence/mcp-p3.md
implementation/evidence/mcp-p4.md
implementation/evidence/mcpd-a.md
implementation/evidence/mcpd-b.md
implementation/evidence/mcpd-c.md
implementation/evidence/plan-review.md
implementation/prompts/01-language.md
implementation/prompts/02-values.md
implementation/prompts/03-state.md
implementation/prompts/04-work-services-files.md
implementation/prompts/05-ui-steering.md
implementation/prompts/05-ui.md
implementation/prompts/06-identity-interfaces.md
implementation/prompts/07-platform.md
implementation/prompts/08-frontend-catalog-migration.md
implementation/prompts/08-frontend-catalog-steering.md
implementation/status/frontend-catalog-migration.md
implementation/status/lane-01.md
implementation/status/lane-02.md
implementation/status/lane-03.md
implementation/status/lane-04.md
implementation/status/lane-05.md
implementation/status/lane-06.md
implementation/status/lane-07.md
output/build-in-public/canlang-example-do-white-20261004-51f2d7ef.png
output/build-in-public/canlang-example-do-white-20261004-51f2d7ef.prompt.txt
output/build-in-public/canlang-new-direction-20261003-ab21457b.png
output/build-in-public/canlang-new-direction-20261003-ab21457b.prompt.txt
output/build-in-public/canlang-new-direction-v2-20261003-ac77e429.description.txt
output/build-in-public/canlang-new-direction-v2-20261003-ac77e429.png
output/build-in-public/canlang-new-direction-v2-20261003-ac77e429.prompt.txt
output/editor/invariant-category-0.1.7.json
output/editor/invariant-migration-0.1.6.json
package.json
packages/cloudflare/README.md
packages/cloudflare/package.json
packages/cloudflare/src/build/artifact.ts [+]
packages/cloudflare/src/build/modules.ts [+]
packages/cloudflare/src/cli/docs.ts
packages/cloudflare/src/cli/platform.ts
packages/cloudflare/src/deploy/activate.ts
packages/cloudflare/src/deploy/bundle.ts
packages/cloudflare/src/deploy/bundle/modules.ts [+]
packages/cloudflare/src/deploy/bundle/scan.ts [+]
packages/cloudflare/src/deploy/bundle/vendors.ts [+]
packages/cloudflare/src/deploy/compat.ts
packages/cloudflare/src/deploy/installed.ts
packages/cloudflare/src/deploy/plan.ts
packages/cloudflare/src/deploy/render.ts
packages/cloudflare/src/deploy/review.ts
packages/cloudflare/src/dev/local-run.ts
packages/cloudflare/src/dev/zero-config.ts
packages/cloudflare/src/index.ts
packages/cloudflare/src/release/manifest.ts
packages/cloudflare/src/release/stamp.ts
packages/cloudflare/src/runtime/callable.ts [+]
packages/cloudflare/src/runtime/canonical/descriptors.ts [+]
packages/cloudflare/src/runtime/canonical/mutation.ts [+]
packages/cloudflare/src/runtime/canonical/overlay.ts [+]
packages/cloudflare/src/runtime/canonical/policy.ts [+]
packages/cloudflare/src/runtime/canonical/read.ts [+]
packages/cloudflare/src/runtime/canonical/scenario.ts [+]
packages/cloudflare/src/runtime/context.ts
packages/cloudflare/src/runtime/dispatch/drive.ts [+]
packages/cloudflare/src/runtime/dispatch/producer.ts [+]
packages/cloudflare/src/runtime/dispatch/recovery.ts [+]
packages/cloudflare/src/runtime/dispatch/rows.ts [+]
packages/cloudflare/src/runtime/dispatch/stage.ts [+]
packages/cloudflare/src/runtime/env-assembly.ts
packages/cloudflare/src/runtime/executors.ts
packages/cloudflare/src/runtime/grant-route.ts
packages/cloudflare/src/runtime/invoke.ts
packages/cloudflare/src/runtime/mcp-permissions.ts
packages/cloudflare/src/runtime/mcp-registry.ts
packages/cloudflare/src/runtime/sourcemap.ts
packages/cloudflare/src/runtime/state-producers.ts [+]
packages/cloudflare/src/runtime/stdlib.ts
packages/cloudflare/src/runtime/t16b-canonical.test.ts
packages/cloudflare/src/runtime/t17b-cloudflare-flip.test.ts
packages/cloudflare/src/runtime/t17b-durable.test.ts
packages/cloudflare/src/runtime/t24b-dispatch-durable.test.ts
packages/cloudflare/src/runtime/t24b-dispatch-execution.test.ts
packages/cloudflare/src/runtime/t32b-cloudflare-durable.test.ts
packages/cloudflare/src/runtime/t32b-cloudflare.test.ts
packages/cloudflare/src/upgrade/apply.ts
packages/cloudflare/src/worker/assembly.ts
packages/cloudflare/src/worker/dispatch.ts [+]
packages/cloudflare/src/worker/entry.ts
packages/cloudflare/src/worker/invoker.ts [+]
packages/cloudflare/src/worker/main.ts
packages/cloudflare/src/worker/registry.ts [+]
packages/cloudflare/test/activate-cli.test.ts
packages/cloudflare/test/activate.test.ts
packages/cloudflare/test/activation-refusal.test.ts
packages/cloudflare/test/artifact-field-descriptions.test.ts
packages/cloudflare/test/artifact-operations.test.ts
packages/cloudflare/test/artifact.test.ts
packages/cloudflare/test/assembly.test.ts
packages/cloudflare/test/cli.test.ts
packages/cloudflare/test/compat.test.ts
packages/cloudflare/test/deploy-apply.test.ts
packages/cloudflare/test/deploy-bundle.test.ts
packages/cloudflare/test/deploy-cli.test.ts
packages/cloudflare/test/deploy-plan.test.ts
packages/cloudflare/test/dev-smoke.test.ts
packages/cloudflare/test/file-journey.test.ts [+]
packages/cloudflare/test/fixtures/assembly.ts [+]
packages/cloudflare/test/fixtures/smoke-worker.mjs
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-bad.artifact.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-bad.descriptor.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-bad.local.environment.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-bad.target.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-good.artifact.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-good.descriptor.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-good.local.environment.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-good.store.json
packages/cloudflare/test/fixtures/teamtasks-activate/teamtasks-good.target.json
packages/cloudflare/test/installed.test.ts
packages/cloudflare/test/invoke.test.ts
packages/cloudflare/test/mcp-grant-route.test.ts
packages/cloudflare/test/mcp-permissions.test.ts
packages/cloudflare/test/mcp-route.test.ts
packages/cloudflare/test/mcpd-env-assembly.test.ts
packages/cloudflare/test/modules.test.ts
packages/cloudflare/test/plan.test.ts
packages/cloudflare/test/release.test.ts
packages/cloudflare/test/review.test.ts
packages/cloudflare/test/runtime-context.test.ts
packages/cloudflare/test/runtime-executors.test.ts
packages/cloudflare/test/runtime-stdlib.test.ts
packages/cloudflare/test/sourcemap.test.ts
packages/cloudflare/test/worker-boundary.test.ts
packages/cloudflare/test/worker-main.test.ts
packages/cloudflare/test/zero-config.test.ts
packages/cloudflare/tsconfig.json
packages/contracts/README.md
packages/contracts/package.json
packages/contracts/src/artifact.ts
packages/contracts/src/deployment.ts
packages/contracts/src/diagnostic.ts
packages/contracts/src/examples.ts
packages/contracts/src/files.ts
packages/contracts/src/identity.ts
packages/contracts/src/index.ts
packages/contracts/src/presentation.ts
packages/contracts/src/presentation/catalog.ts [+]
packages/contracts/src/presentation/collections.ts [+]
packages/contracts/src/presentation/components.ts [+]
packages/contracts/src/presentation/context.ts [+]
packages/contracts/src/presentation/controls.ts [+]
packages/contracts/src/presentation/forms.ts [+]
packages/contracts/src/presentation/groups.ts [+]
packages/contracts/src/presentation/htmx.ts [+]
packages/contracts/src/presentation/leaves.ts [+]
packages/contracts/src/presentation/media.ts [+]
packages/contracts/src/presentation/messages.ts [+]
packages/contracts/src/presentation/navigation.ts [+]
packages/contracts/src/presentation/overlays.ts [+]
packages/contracts/src/presentation/page.ts [+]
packages/contracts/src/presentation/panels.ts [+]
packages/contracts/src/presentation/review.ts [+]
packages/contracts/src/presentation/settings.ts [+]
packages/contracts/src/presentation/shell.ts [+]
packages/contracts/src/reference.ts
packages/contracts/src/services.ts
packages/contracts/src/state.ts
packages/contracts/src/state/commit.ts [+]
packages/contracts/src/state/execution.ts [+]
packages/contracts/src/state/identity.ts [+]
packages/contracts/src/state/invocation.ts [+]
packages/contracts/src/state/migration.ts [+]
packages/contracts/src/state/mutation.ts [+]
packages/contracts/src/state/query.ts [+]
packages/contracts/src/state/storage.ts [+]
packages/contracts/src/values.ts
packages/contracts/src/wire.ts
packages/contracts/src/work.ts
packages/contracts/test/assembly.test.ts
packages/contracts/test/deployment.test.ts
packages/contracts/test/examples.test.ts
packages/contracts/test/provider-ratification.test.ts
packages/contracts/tsconfig.json
packages/files/.gitignore
packages/files/README.md
packages/files/package.json
packages/files/src/bridge.ts
packages/files/src/catalog.ts
packages/files/src/finalize/index.ts
packages/files/src/ports.ts
packages/files/src/provenance/index.ts
packages/files/src/retention/index.ts
packages/files/src/scenarios.ts
packages/files/src/storage/fs.ts [+]
packages/files/src/storage/key.ts [+]
packages/files/src/testing.ts [+]
packages/files/src/upload/content.ts [+]
packages/files/src/upload/index.ts
packages/files/src/upload/intent.ts [+]
packages/files/src/upload/shared.ts [+]
packages/files/src/upload/validation.ts [+]
packages/files/test/bridge.test.ts
packages/files/test/contract-shapes.test.ts
packages/files/test/finalize.test.ts
packages/files/test/foreign.test.ts
packages/files/test/helpers.ts
packages/files/test/retention.test.ts
packages/files/test/scenarios.test.ts
packages/files/test/upload-journey.test.ts
packages/files/test/validation.test.ts
packages/files/tsconfig.json
packages/identity/.gitignore
packages/identity/README.md
packages/identity/package.json
packages/identity/src/accounts/passwords.ts
packages/identity/src/accounts/recovery.ts
packages/identity/src/accounts/registration.ts
packages/identity/src/authentication/audience.ts
packages/identity/src/authentication/context.ts
packages/identity/src/authentication/grants.ts
packages/identity/src/authentication/oauth.ts
packages/identity/src/authentication/revocation.ts
packages/identity/src/authentication/t16b-context.test.ts
packages/identity/src/authentication/t32b-revocation.test.ts
packages/identity/src/index.ts
packages/identity/src/ports.ts
packages/identity/src/sessions/cookies.ts
packages/identity/src/sessions/csrf.ts
packages/identity/src/sessions/presession.ts
packages/identity/src/sessions/tokens.ts
packages/identity/src/storage/d1.ts
packages/identity/src/storage/d1/rows.ts [+]
packages/identity/src/storage/d1/schema.ts [+]
packages/identity/src/storage/d1/store.ts [+]
packages/identity/src/teams/invitations.ts
packages/identity/src/teams/membership.ts
packages/identity/src/teams/roles.ts
packages/identity/src/teams/selection.ts
packages/identity/src/testing.ts
packages/identity/src/testing/helpers.ts [+]
packages/identity/test/accounts.test.ts
packages/identity/test/context.test.ts
packages/identity/test/contracts.test.ts
packages/identity/test/d1.test.ts
packages/identity/test/fixtures/revoked-session.json
packages/identity/test/fixtures/two-user-team.json
packages/identity/test/grants.test.ts
packages/identity/test/oauth.test.ts
packages/identity/test/presession.test.ts
packages/identity/test/sessions.test.ts
packages/identity/test/teams.test.ts
packages/identity/tsconfig.json
packages/interfaces/.gitignore
packages/interfaces/README.md
packages/interfaces/package.json
packages/interfaces/src/docs/anchors.ts [+]
packages/interfaces/src/docs/markdown.ts [+]
packages/interfaces/src/docs/reference.ts
packages/interfaces/src/envelope/refs.ts
packages/interfaces/src/envelope/validate.ts
packages/interfaces/src/envelope/versions.ts
packages/interfaces/src/errors/envelope.ts
packages/interfaces/src/errors/logging.ts
packages/interfaces/src/errors/redact.ts
packages/interfaces/src/errors/safe.ts
packages/interfaces/src/http/auth.ts
packages/interfaces/src/http/context.ts
packages/interfaces/src/http/formErrors.ts
packages/interfaces/src/http/fragments.ts
packages/interfaces/src/http/limits.ts
packages/interfaces/src/http/operations.ts
packages/interfaces/src/http/pages.ts
packages/interfaces/src/http/presentation.ts
packages/interfaces/src/http/routes.ts
packages/interfaces/src/index.ts
packages/interfaces/src/ingress/mapping.ts
packages/interfaces/src/ingress/routes.ts
packages/interfaces/src/mcp/discovery.ts
packages/interfaces/src/mcp/schemas.ts
packages/interfaces/src/mcp/server.ts
packages/interfaces/src/mcp/tools.ts
packages/interfaces/src/oauth/metadata.ts
packages/interfaces/src/oauth/routes.ts
packages/interfaces/src/ports.ts
packages/interfaces/src/projection/project.ts
packages/interfaces/src/testing.ts
packages/interfaces/src/testing/http.ts [+]
packages/interfaces/src/testing/identity.ts [+]
packages/interfaces/src/testing/ingress.ts [+]
packages/interfaces/src/testing/mcp.ts [+]
packages/interfaces/src/testing/oauth.ts [+]
packages/interfaces/src/testing/uploads.ts [+]
packages/interfaces/src/uploads/kernel.ts
packages/interfaces/src/uploads/principals.ts
packages/interfaces/src/uploads/routes.ts
packages/interfaces/test/docs-reference.test.ts
packages/interfaces/test/envelope.test.ts
packages/interfaces/test/errors.test.ts
packages/interfaces/test/fixtures/action-handle.json
packages/interfaces/test/fixtures/business-error.json
packages/interfaces/test/fixtures/mutation-envelope.json
packages/interfaces/test/fixtures/upload-intent.json
packages/interfaces/test/http-auth.test.ts
packages/interfaces/test/http-operations.test.ts
packages/interfaces/test/http-pages.test.ts
packages/interfaces/test/http-presentation.test.ts
packages/interfaces/test/ingress.test.ts
packages/interfaces/test/integration-lifecycle.test.ts
packages/interfaces/test/integration-parity.test.ts
packages/interfaces/test/mcp-field-descriptions.test.ts
packages/interfaces/test/mcp-server.test.ts
packages/interfaces/test/mcp-tools.test.ts
packages/interfaces/test/oauth.test.ts
packages/interfaces/test/projection.test.ts
packages/interfaces/test/uploads-kernel.test.ts
packages/interfaces/test/uploads.test.ts
packages/interfaces/test/wire.test.ts
packages/interfaces/tsconfig.json
packages/services/.gitignore
packages/services/README.md
packages/services/package.json
packages/services/src/catalog.ts
packages/services/src/completion.ts [+]
packages/services/src/errors.ts [+]
packages/services/src/http/body.ts [+]
packages/services/src/http/client.ts
packages/services/src/http/errors.ts
packages/services/src/http/pagination.ts
packages/services/src/http/redirects.ts [+]
packages/services/src/http/request.ts [+]
packages/services/src/http/stream.ts [+]
packages/services/src/judgments/systemone.ts
packages/services/src/judgments/systemone/adapter.ts [+]
packages/services/src/judgments/systemone/request.ts [+]
packages/services/src/judgments/systemone/response.ts [+]
packages/services/src/mail/adapter.ts
packages/services/src/mail/request.ts [+]
packages/services/src/mail/response.ts [+]
packages/services/src/media/comfyui.ts
packages/services/src/media/comfyui/adapter.ts [+]
packages/services/src/media/comfyui/download.ts [+]
packages/services/src/media/comfyui/response.ts [+]
packages/services/src/media/mapping.ts
packages/services/src/models/ollama.ts
packages/services/src/models/ollama/adapter.ts [+]
packages/services/src/models/ollama/request.ts [+]
packages/services/src/models/ollama/response.ts [+]
packages/services/src/models/ollama/run.ts [+]
packages/services/src/ports.ts
packages/services/src/runtime.ts [+]
packages/services/src/scenarios.ts
packages/services/src/testing/harness/judgments.ts [+]
packages/services/src/testing/harness/mail.ts [+]
packages/services/src/testing/harness/media.ts [+]
packages/services/src/testing/harness/models.ts [+]
packages/services/src/testing/helpers.ts [+]
packages/services/src/testing/scenarios/index.ts [+]
packages/services/src/testing/scenarios/judgments.ts [+]
packages/services/src/testing/scenarios/mail.ts [+]
packages/services/src/testing/scenarios/media.ts [+]
packages/services/src/testing/scenarios/models.ts [+]
packages/services/src/testing/scenarios/schema.ts [+]
packages/services/test/contract-shapes.test.ts
packages/services/test/http-client.test.ts
packages/services/test/judgments-systemone.test.ts
packages/services/test/mail-adapter.test.ts
packages/services/test/mail-redaction.test.ts
packages/services/test/media-comfyui.test.ts
packages/services/test/models-ollama.test.ts
packages/services/test/pagination.test.ts
packages/services/test/scenarios.test.ts
packages/services/tsconfig.json
packages/state/.gitignore
packages/state/README.md
packages/state/package.json
packages/state/src/catalog.ts
packages/state/src/effects/staging.ts
packages/state/src/errors.ts
packages/state/src/index.ts
packages/state/src/internal/json.ts
packages/state/src/invocation/admission.ts
packages/state/src/invocation/artifact-descriptors.ts [+]
packages/state/src/invocation/context.ts
packages/state/src/invocation/descriptors.ts [+]
packages/state/src/invocation/fence.ts [+]
packages/state/src/invocation/index.ts
packages/state/src/invocation/inputs.ts [+]
packages/state/src/invocation/invoke-read.ts [+]
packages/state/src/invocation/invoke.ts
packages/state/src/invocation/registry.ts
packages/state/src/invocation/replay.ts
packages/state/src/migration/activate.ts
packages/state/src/migration/directives.ts [+]
packages/state/src/migration/disposition.ts [+]
packages/state/src/migration/evidence.ts [+]
packages/state/src/migration/flip.ts [+]
packages/state/src/migration/index.ts
packages/state/src/migration/mapper.ts
packages/state/src/migration/model-plan.ts [+]
packages/state/src/migration/owner-plan.ts [+]
packages/state/src/migration/publish.ts [+]
packages/state/src/migration/recover.ts
packages/state/src/migration/retain.ts
packages/state/src/migration/stage.ts
packages/state/src/migration/transition.ts
packages/state/src/migration/validate.ts
packages/state/src/migration/validation/drops.ts [+]
packages/state/src/migration/validation/index.ts [+]
packages/state/src/migration/validation/locks.ts [+]
packages/state/src/migration/validation/references.ts [+]
packages/state/src/migration/validation/rows.ts [+]
packages/state/src/migration/validation/uniques.ts [+]
packages/state/src/mutation/candidate.ts [+]
packages/state/src/mutation/constraints.ts [+]
packages/state/src/mutation/crud.ts
packages/state/src/mutation/history.ts [+]
packages/state/src/mutation/hooks.ts [+]
packages/state/src/mutation/index.ts
packages/state/src/mutation/models.ts
packages/state/src/mutation/pipeline.ts
packages/state/src/mutation/provisional.ts [+]
packages/state/src/mutation/t18-defaults.test.ts
packages/state/src/mutation/t18-shop.artifact.ts
packages/state/src/mutation/t18-shop.can
packages/state/src/policy/grants.ts
packages/state/src/policy/path.ts [+]
packages/state/src/policy/predicate.ts [+]
packages/state/src/policy/roles.ts
packages/state/src/ports/index.ts
packages/state/src/ports/read.ts
packages/state/src/ports/system.ts
packages/state/src/ports/transact.ts
packages/state/src/query/aggregates.ts [+]
packages/state/src/query/engine.ts
packages/state/src/query/index.ts
packages/state/src/query/order.ts [+]
packages/state/src/query/projection.ts [+]
packages/state/src/storage/d1.ts
packages/state/src/storage/durable-object.ts
packages/state/src/storage/index.ts
packages/state/src/storage/port.ts
packages/state/src/storage/schema.ts
packages/state/src/storage/sql/commit-plan.ts [+]
packages/state/src/storage/sql/migration-plan.ts [+]
packages/state/src/storage/sql/query.ts [+]
packages/state/src/storage/sql/row-codecs.ts [+]
packages/state/src/testing/memory-probe.ts [+]
packages/state/src/testing/memory-query.ts [+]
packages/state/src/testing/memory-storage.ts [+]
packages/state/test/invocation/admission.test.ts
packages/state/test/invocation/context.test.ts
packages/state/test/invocation/descriptor-join.test.ts [+]
packages/state/test/invocation/fixtures.ts
packages/state/test/invocation/invoke-read.test.ts [+]
packages/state/test/invocation/invoke.test.ts
packages/state/test/invocation/replay.test.ts
packages/state/test/invocation/roles.test.ts
packages/state/test/invocation/t32b-fence.test.ts [+]
packages/state/test/invocation/t32b-wire.test.ts [+]
packages/state/test/migration/activate.test.ts
packages/state/test/migration/adapters.test.ts
packages/state/test/migration/fixtures.ts
packages/state/test/migration/invalidate.test.ts
packages/state/test/migration/recover.test.ts
packages/state/test/migration/resume.test.ts
packages/state/test/migration/retain.test.ts
packages/state/test/migration/stage.test.ts
packages/state/test/migration/transition.test.ts
packages/state/test/mutation/create.test.ts
packages/state/test/mutation/fixtures.ts
packages/state/test/mutation/generated-crud.test.ts [+]
packages/state/test/mutation/history.test.ts
packages/state/test/mutation/invariants.test.ts
packages/state/test/mutation/locks.test.ts
packages/state/test/mutation/models.test.ts
packages/state/test/mutation/rejected.test.ts
packages/state/test/mutation/remove.test.ts
packages/state/test/mutation/staged-durable.test.ts
packages/state/test/mutation/staged.test.ts
packages/state/test/mutation/t32b-wire-durable.test.ts [+]
packages/state/test/mutation/t32b-wire-transitive.test.ts [+]
packages/state/test/mutation/update.test.ts
packages/state/test/ports/atomicity.test.ts
packages/state/test/ports/data-plane.test.ts [+]
packages/state/test/ports/fixtures.ts
packages/state/test/ports/read.test.ts
packages/state/test/ports/staging.test.ts
packages/state/test/ports/system.test.ts
packages/state/test/ports/t24a-dispatch-join-durable.test.ts
packages/state/test/ports/t24a-dispatch-join.test.ts
packages/state/test/ports/t32b-read.test.ts [+]
packages/state/test/ports/transact.test.ts
packages/state/test/query/aggregates.test.ts
packages/state/test/query/authority.test.ts
packages/state/test/query/fixtures.ts
packages/state/test/query/projection.test.ts
packages/state/test/query/scope.test.ts
packages/state/test/query/t32b-fence.test.ts [+]
packages/state/test/query/visibility.test.ts
packages/state/test/scaffold.test.ts
packages/state/test/storage/conformance.ts
packages/state/test/storage/d1.test.ts
packages/state/test/storage/data-plane-durable.test.ts [+]
packages/state/test/storage/do-test-worker.js
packages/state/test/storage/do.test.ts
packages/state/test/storage/memory.test.ts
packages/state/tsconfig.json
packages/stdlib/README.md
packages/stdlib/package.json
packages/stdlib/src/index.ts
packages/stdlib/test/assembly.test.ts
packages/stdlib/tsconfig.json
packages/testkit/README.md
packages/testkit/package.json
packages/testkit/src/assertions/equal.ts
packages/testkit/src/fixtures/accounts.ts
packages/testkit/src/fixtures/b2-delivery.ts
packages/testkit/src/fixtures/b2-revocation.ts
packages/testkit/src/fixtures/b2-storage.ts
packages/testkit/src/fixtures/playback.ts
packages/testkit/src/fixtures/seeds.ts
packages/testkit/src/index.ts
packages/testkit/src/playback/body.ts [+]
packages/testkit/src/playback/handler.ts [+]
packages/testkit/src/playback/judgments.ts [+]
packages/testkit/src/playback/mail.ts [+]
packages/testkit/src/playback/media.ts [+]
packages/testkit/src/playback/models.ts [+]
packages/testkit/src/playback/worker.ts [+]
packages/testkit/src/reporting/report.ts
packages/testkit/src/runner/loader.ts
packages/testkit/src/runner/table.ts
packages/testkit/src/scopes/local.ts
packages/testkit/test/accounts.test.ts
packages/testkit/test/equal.test.ts
packages/testkit/test/fixtures/scope-worker.mjs
packages/testkit/test/isolation.test.ts
packages/testkit/test/loader.test.ts
packages/testkit/test/playback.test.ts
packages/testkit/test/report.test.ts
packages/testkit/test/seeds.test.ts
packages/testkit/test/table.test.ts
packages/testkit/tsconfig.json
packages/ui/.gitignore
packages/ui/README.md
packages/ui/package.json
packages/ui/src/appearance.ts
packages/ui/src/catalog.ts
packages/ui/src/collections.ts
packages/ui/src/collections/board.ts [+]
packages/ui/src/collections/controls.ts [+]
packages/ui/src/collections/csv-import.ts [+]
packages/ui/src/collections/internal.ts [+]
packages/ui/src/collections/rows.ts [+]
packages/ui/src/components.ts
packages/ui/src/controls.ts
packages/ui/src/controls/calendar.ts [+]
packages/ui/src/controls/choice.ts [+]
packages/ui/src/controls/file.ts [+]
packages/ui/src/controls/numeric.ts [+]
packages/ui/src/controls/scalar.ts [+]
packages/ui/src/controls/unit.ts [+]
packages/ui/src/escape.ts
packages/ui/src/format.ts [+]
packages/ui/src/forms.ts
packages/ui/src/forms/actions.ts [+]
packages/ui/src/forms/field-binding.ts [+]
packages/ui/src/forms/field-value.ts [+]
packages/ui/src/forms/form.ts [+]
packages/ui/src/forms/outcomes.ts [+]
packages/ui/src/groups.ts
packages/ui/src/htmx.ts
packages/ui/src/index.ts
packages/ui/src/leaves.ts
packages/ui/src/media.ts
packages/ui/src/messages.ts
packages/ui/src/navigation.ts
packages/ui/src/navigation/controls.ts [+]
packages/ui/src/navigation/discovery.ts [+]
packages/ui/src/overlays.ts
packages/ui/src/panels.ts
packages/ui/src/policyPage.ts
packages/ui/src/review.ts
packages/ui/src/selectors/readable.ts [+]
packages/ui/src/settings.ts
packages/ui/src/shell.ts
packages/ui/test/appearance.test.ts
packages/ui/test/catalog.test.ts
packages/ui/test/collections.test.ts
packages/ui/test/components.test.ts
packages/ui/test/controls.test.ts
packages/ui/test/escape.test.ts
packages/ui/test/fixtures/descriptors.ts
packages/ui/test/forms.test.ts
packages/ui/test/groups.test.ts
packages/ui/test/harness.ts
packages/ui/test/htmx.test.ts
packages/ui/test/journeys.test.ts
packages/ui/test/leaves.test.ts
packages/ui/test/media.test.ts
packages/ui/test/messages.test.ts
packages/ui/test/navigation.test.ts
packages/ui/test/overlays.test.ts
packages/ui/test/panels.test.ts
packages/ui/test/policyPage.test.ts
packages/ui/test/review.test.ts
packages/ui/test/settings.test.ts
packages/ui/test/shell.test.ts
packages/ui/test/themes.test.ts
packages/ui/themes.css
packages/ui/tsconfig.json
packages/values/.gitignore
packages/values/README.md
packages/values/conformance/v1/README.md
packages/values/conformance/v1/values.json
packages/values/package.json
packages/values/scripts/emit-catalog.mjs
packages/values/src/array.ts
packages/values/src/catalog.ts
packages/values/src/currency-data.ts
packages/values/src/decimal.ts
packages/values/src/equality.ts
packages/values/src/errors.ts
packages/values/src/icu.ts
packages/values/src/icu/descriptor.ts [+]
packages/values/src/icu/number.ts [+]
packages/values/src/icu/parser.ts [+]
packages/values/src/icu/render.ts [+]
packages/values/src/icu/validation.ts [+]
packages/values/src/index.ts
packages/values/src/int.ts
packages/values/src/kinds.ts
packages/values/src/locale.ts
packages/values/src/money.ts
packages/values/src/schema.ts
packages/values/src/schema/bounds.ts [+]
packages/values/src/schema/descriptor.ts [+]
packages/values/src/schema/normalize.ts [+]
packages/values/src/schema/omission.ts [+]
packages/values/src/schema/validate.ts [+]
packages/values/src/stdlib-pure.ts
packages/values/src/temporal.ts
packages/values/src/temporal/calendar.ts [+]
packages/values/src/temporal/duration.ts [+]
packages/values/src/temporal/instant.ts [+]
packages/values/src/text.ts
packages/values/src/timezone.ts
packages/values/src/types.ts
packages/values/src/wire.ts
packages/values/src/wire/decode.ts [+]
packages/values/src/wire/encode.ts [+]
packages/values/src/wire/errors.ts [+]
packages/values/test/array.test.ts
packages/values/test/catalog.test.ts
packages/values/test/conformance.test.ts
packages/values/test/decimal-oracle.test.ts
packages/values/test/decimal.test.ts
packages/values/test/equality.test.ts
packages/values/test/errors.test.ts
packages/values/test/exports-conformance.test.ts
packages/values/test/icu.test.ts
packages/values/test/index.test.ts
packages/values/test/int.test.ts
packages/values/test/kinds.test.ts
packages/values/test/locale.test.ts
packages/values/test/money.test.ts
packages/values/test/schema.test.ts
packages/values/test/stdlib-pure.test.ts
packages/values/test/temporal.test.ts
packages/values/test/text.test.ts
packages/values/test/timezone.test.ts
packages/values/test/types.test.ts
packages/values/test/wire.test.ts
packages/values/tsconfig.json
packages/work/.gitignore
packages/work/README.md
packages/work/package.json
packages/work/src/catalog.ts
packages/work/src/dispatch/index.ts
packages/work/src/event/index.ts
packages/work/src/intent/index.ts
packages/work/src/kernel/commands.ts
packages/work/src/kernel/commands/arguments.ts [+]
packages/work/src/kernel/commands/dispatch.ts [+]
packages/work/src/kernel/commands/every.ts [+]
packages/work/src/kernel/commands/occurrence.ts [+]
packages/work/src/kernel/commands/recovery.ts [+]
packages/work/src/kernel/commands/schedule.ts [+]
packages/work/src/kernel/commands/staging.ts [+]
packages/work/src/kernel/tables.ts
packages/work/src/kernel/tables/dispatch.ts [+]
packages/work/src/kernel/tables/every.ts [+]
packages/work/src/kernel/tables/occurrence.ts [+]
packages/work/src/kernel/tables/row.ts [+]
packages/work/src/kernel/tables/schedule.ts [+]
packages/work/src/kernel/tables/supersession.ts [+]
packages/work/src/observation/association.ts
packages/work/src/observation/observation.ts
packages/work/src/observation/ports.ts
packages/work/src/observation/testing.ts [+]
packages/work/src/ports.ts
packages/work/src/receipt/index.ts
packages/work/src/recovery/index.ts
packages/work/src/schedule/every.ts
packages/work/src/schedule/index.ts
packages/work/src/testing.ts [+]
packages/work/test/contract-shapes.test.ts
packages/work/test/dispatch.test.ts
packages/work/test/dispatch/t32b-fence.test.ts [+]
packages/work/test/event.test.ts
packages/work/test/every.test.ts
packages/work/test/intent.test.ts
packages/work/test/kernel-commands.test.ts
packages/work/test/kernel-tables.test.ts
packages/work/test/observation-association.test.ts
packages/work/test/observation.test.ts
packages/work/test/observation/t25a-progress.test.ts [+]
packages/work/test/observation/t25a-selected.test.ts [+]
packages/work/test/receipt.test.ts
packages/work/test/receipt/t25a-consistency.test.ts [+]
packages/work/test/recovery.test.ts
packages/work/test/schedule.test.ts
packages/work/test/t24a-staging-join.test.ts
packages/work/tsconfig.json
playwright.config.ts
tests/e2e/apps/compiled-identity.spec.ts
tests/e2e/apps/compiled-journey.spec.ts
tests/e2e/apps/scaffold.spec.ts
tests/e2e/apps/teamtasks-mcp.spec.ts
tests/e2e/apps/teamtasks.spec.ts
tests/e2e/bridges/http-bridge.ts
tests/e2e/bridges/mcp-bridge.ts
tests/e2e/fixtures/artifact-loader.ts
tests/e2e/fixtures/compiled-seed.ts
tests/e2e/fixtures/compiled-shop.can
tests/e2e/fixtures/e2e-test.ts
tests/e2e/fixtures/handbuilt/mcp-bundle-entry.js
tests/e2e/fixtures/handbuilt/teamtasks-worker.mjs
tests/e2e/fixtures/handbuilt/teamtasks.ts
tests/e2e/fixtures/mcp-grants.ts
tests/e2e/fixtures/seed.ts
tests/e2e/tsconfig.json
tests/integration/README.md
tests/integration/b1-team-tasks.md
tests/integration/b2-d1-fence.test.ts
tests/integration/b2-delivery.test.ts
tests/integration/b2-do-local.test.ts
tests/integration/b2-revocation.test.ts
tests/integration/lane02-values.test.ts
tests/integration/readiness.test.ts
tools/README.md
tools/b3-s4-demo.sh
tools/can_parser.py
tools/jev.py
tools/test_can_parser.py
tools/test_jev.py
tsconfig.base.json
tsconfig.check.json
vitest.config.ts
docs/ideal-filetree-plan/main-merge-20261006.json [B]
implementation/REMAINING-IMPLEMENTATION-LANES.md
implementation/challenge-audit-run/recovery-checkpoint.md
packages/cloudflare/test/runtime/t34-f7-fanout-durable.test.ts [+]
packages/cloudflare/test/runtime/t34-f7-fanout.test.ts [+]
packages/contracts/test/fanout-records.test.ts
packages/contracts/test/t19a-derived-inputs.test.ts
packages/contracts/test/t19b-depth.test.ts
packages/contracts/test/t20a-presentation.test.ts
packages/contracts/test/t26-progress-relations.test.ts
packages/interfaces/test/t19a-derivation.test.ts
packages/interfaces/test/t19b-depth.test.ts
packages/interfaces/test/t20a-presentation.test.ts
packages/state/src/fanout/cohort.ts
packages/state/src/fanout/lifecycle.ts
packages/state/src/fanout/membership.ts
packages/state/src/fanout/outcome.ts
packages/state/src/fanout/progress.ts
packages/state/src/fanout/tables.ts
packages/state/src/receipt/grants.ts
packages/state/src/receipt/join.ts
packages/state/src/receipt/tables.ts
packages/state/test/fanout/t34-f5-admission.test.ts [+]
packages/state/test/fanout/t34-f5-child-join.test.ts [+]
packages/state/test/fanout/t34-f5-durable.test.ts [+]
packages/state/test/fanout/t34-f5-lifecycle.test.ts [+]
packages/state/test/fanout/t34-f5-membership.test.ts [+]
packages/state/test/fanout/t34-f5-progress.test.ts [+]
packages/state/test/fanout/test-driver.ts [+]
packages/state/test/fanout/work-loader.ts [+]
packages/state/test/mutation/t18-defaults-durable.test.ts [+]
packages/state/test/receipt/t25-receipt-durable.test.ts [+]
packages/state/test/receipt/t25-receipt-join.test.ts [+]
packages/state/test/receipt/work-loader.ts [+]
packages/ui/test/t20a-generated-forms.test.ts
packages/work/test/dispatch/t34-f3-claim.test.ts [+]
packages/work/test/dispatch/t34-f3-progress.test.ts [+]
packages/work/test/dispatch/t34-f3-record.test.ts [+]
packages/work/test/kernel/t34-f2-durable.test.ts [+]
packages/work/test/kernel/t34-f2-tables.test.ts [+]
packages/work/test/observation/t26-progress.test.ts [+]
packages/work/test/recovery/t26-durable.test.ts [+]
packages/work/test/recovery/t26-resume.test.ts [+]
packages/work/test/recovery/t34-f4-durable.test.ts [+]
packages/work/test/recovery/t34-f4-scan.test.ts [+]
```
