# Current review lanes and implementation handoffs

The audit has coordinator plus three reviewer slots. These are source-review roles and future handoffs, not a scheduler or running implementation team. The product pin is `8d48f969`; a documentation commit does not demand a product rebuild or another source-baseline cycle.

| Lane | Ready review work | Exclusive document / later production handoff |
| --- | --- | --- |
| A — language | L-REVIEW-CHECK/EMIT/DEV and exact remaining NATIVE duties; Given/authoring source traces complete with GEN-C1/AUTHOR-C1 open; completed bounded PROOF source pass with open LANG-PROOF-C; V-ORDER-C1; compiler half of L-REVIEW-PROFILES | `reviews/language-current.md`. Inspect source read-only. Any later compiler correction names its exact collector/pass writer; `codegen/mod.rs`, Cargo/export/install selectors remain coordinator handoffs |
| B — runtime | RT-RECEIPT/PROVIDER/VALUES-REVIEW; RT-AUTHORITY-FOLLOWUP. Bounded migration/setup/authority source reviews complete; MIG-CONTRACT/C1 and SETUP-C1/V1 remain | `reviews/runtime-current.md`. State receipt/session/issuance and Identity custody retain their owners. A later `scenario-receipt.ts` writer must be exclusive; index/schema/fixture changes coordinated |
| C — platform | P-R01–03/05–06 and P-CODEC compatibility investigation; P-R04 source review complete, SETUP-C1/V1 open | `reviews/platform-current.md`. Any later `invoke.ts`, host/setup, browser or packaging change has one actual writer; no independent changes to manifests/locks/pinned/runtime inventory |
| Coordinator | REPO-REVIEW-CONTRACTS/EVIDENCE/DELIVERY; shared findings, coverage, target tree and task reconciliation | Entry guide, baseline, catalogue, slice matrix, ownership, integration, findings, task/lane files. Commit coherent reviewed documentation checkpoints; do not sweep unrelated changes into commits |

## Connected challenge and useful ordering

- Current refresh challenge rotated platform → language → runtime → platform, with a direct platform/runtime check of Identity setup. Reuse the recorded bounded conclusions; do not schedule reviews of reviews.
- Independent checker/emitter, migration/provider, browser and upgrade source review can proceed together. The bounded proof boundary pass is complete; LANG-PROOF-C is a named original-source correspondence correction, not another generic review or implementation launch. Completing one monolith review is not a repository-wide barrier.
- Cross-profile critical path: compiler original-source/query/effect census + State actual observation/return/File authority + host original bindings → one complete family contract → RT-C1 correction specification. Source/current semantics, complete domains and the parent-max permission refusal stay explicit. No recipe retirement or diagnostic suppression precedes that contract.
- Bounded migration/setup/authority reviews have independent challenge and retained exact ownership. Their corrections and qualification gates live in tasks; no production lane is launched.
- Setup critical path: platform stopped-writer/private-token/admin/receipt-file custody + Identity atomic consumed-claim/owner records + D1 acknowledgement/expiry/retry → any named custody correction. Atomic database state does not imply atomic completion-file publication.
- Codec critical path: actual historical/current Work row acceptance + CF consumer projection and ordered faults → explicit compatibility decision → P-CODEC. The stricter reader is not a mechanical drop-in.
- Values review pairs native ABI/assets with public JS inputs/errors/host domains. A regenerated binary or an opt-in route does not settle unsupported host semantics.
- Finished mechanical moves, grammar/CI coverage, dev policy migration, currency reuse and executor retirement have no lane reservation or pending build barrier.

## Verification and resources

This audit runs read-only document/path checks only. Retained implementation evidence is reused at its exact source, fixture and binding scope. Once a concrete correction is separately authorized: decisive real owner/error/refusal cases → affected imports/types/fixtures/source guards → integrated producer graph → matching installed/native/provider journey where required. A move does not itself close a semantic defect.

Reserve one operator per compiler/catalog cache, package dist writer and heavy native/browser fixture. Never rewrite emitted State/Cloudflare code while checks consume it. Shared protocol/index/schema/manifest/lock/binary/payload/fixture changes have one integration writer. No new unit tests, proof framework, synthetic capability constructor, service topology or scheduler follows from this plan.
