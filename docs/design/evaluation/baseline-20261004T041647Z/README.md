# Shared evaluation baseline

Captured from `/Users/vince/Projects/canlang` at 2026-10-04T04:16:47+00:00; capture verified at 2026-10-04T04:16:47+00:00.

This is the common reference for evaluating whether companies can economically adopt AI-generated business applications tailored to their operations. Capture preserves the current evidence without judging its correctness or changing its design.

## Use

Read files under [snapshot](snapshot/). Cite this baseline ID and snapshot-relative path/line in findings. Keep the capture unchanged; identify later changes and additional evidence explicitly rather than silently mixing versions. The working files can continue to evolve independently.

The workspace is not a Git checkout. [SHA256SUMS](SHA256SUMS) records SHA-256 hashes for all 115 captured files. Its own SHA-256 is `3d853e5a13a3c3eac7f150dfa742e26e0d9bf6c652b20fb05da4aa0b2b576106`. To check the captured bytes, run `shasum -a 256 -c SHA256SUMS` from this baseline directory.

## Captured inventory

| Material | Count |
| --- | ---: |
| Root requirements, design, grammar, decisions and evaluation instructions | 6 |
| App Can source files | 39 |
| Matching app requirement documents | 39 |
| Desired JavaScript targets | 21 |
| Shared Can packages | 3 |
| Reference Can examples | 2 |
| Supporting draft documents | 5 |
| Total files | 115 |

All app source files have matching requirements; every JavaScript target has a matching app source. 18 apps have no JavaScript target in this capture. This is target coverage inventory, not a finding that those targets are required or that existing pairs agree semantically. File counts do not count additional app compositions declared inside files.

## Design and evaluation sources

- [REQUIREMENTS.md](snapshot/REQUIREMENTS.md): product goals, audience and requirements.
- [DESIGN.md](snapshot/DESIGN.md): current semantic design and desired JavaScript conventions.
- [GRAMMAR.md](snapshot/GRAMMAR.md): syntax specification.
- [DECISIONS.md](snapshot/DECISIONS.md): design decisions and historical proposals, preserving their recorded status.
- [AGENTS.md](snapshot/AGENTS.md): project instructions, including JEV consultations.
- [EVALUATION.md](snapshot/EVALUATION.md): evaluation checklist, evidence rules and JEV design/mock-company roles.

The current documents can disagree or contain stale completion claims. They are preserved as evidence to evaluate, not reconciled by this capture. Requirements define product goals; design defines semantics; grammar defines syntax; disagreements remain explicit findings for the evaluation.

## App source and target index

| App file | Requirements | Source | Desired output |
| --- | --- | --- | --- |
| CanAffiliate | [Requirements](snapshot/draft/CanAffiliate.md) | [Can](snapshot/draft/CanAffiliate.can) | — |
| CanApprove | [Requirements](snapshot/draft/CanApprove.md) | [Can](snapshot/draft/CanApprove.can) | [JavaScript](snapshot/draft/CanApprove.mjs) |
| CanBoard | [Requirements](snapshot/draft/CanBoard.md) | [Can](snapshot/draft/CanBoard.can) | [JavaScript](snapshot/draft/CanBoard.mjs) |
| CanBook | [Requirements](snapshot/draft/CanBook.md) | [Can](snapshot/draft/CanBook.can) | — |
| CanCRM | [Requirements](snapshot/draft/CanCRM.md) | [Can](snapshot/draft/CanCRM.can) | [JavaScript](snapshot/draft/CanCRM.mjs) |
| CanCatch | [Requirements](snapshot/draft/CanCatch.md) | [Can](snapshot/draft/CanCatch.can) | — |
| CanCheck | [Requirements](snapshot/draft/CanCheck.md) | [Can](snapshot/draft/CanCheck.can) | [JavaScript](snapshot/draft/CanCheck.mjs) |
| CanContract | [Requirements](snapshot/draft/CanContract.md) | [Can](snapshot/draft/CanContract.can) | — |
| CanCustomer | [Requirements](snapshot/draft/CanCustomer.md) | [Can](snapshot/draft/CanCustomer.can) | — |
| CanDesk | [Requirements](snapshot/draft/CanDesk.md) | [Can](snapshot/draft/CanDesk.can) | — |
| CanDo | [Requirements](snapshot/draft/CanDo.md) | [Can](snapshot/draft/CanDo.can) | — |
| CanEvent | [Requirements](snapshot/draft/CanEvent.md) | [Can](snapshot/draft/CanEvent.can) | — |
| CanExpense | [Requirements](snapshot/draft/CanExpense.md) | [Can](snapshot/draft/CanExpense.can) | [JavaScript](snapshot/draft/CanExpense.mjs) |
| CanFeedback | [Requirements](snapshot/draft/CanFeedback.md) | [Can](snapshot/draft/CanFeedback.can) | [JavaScript](snapshot/draft/CanFeedback.mjs) |
| CanField | [Requirements](snapshot/draft/CanField.md) | [Can](snapshot/draft/CanField.can) | — |
| CanGrant | [Requirements](snapshot/draft/CanGrant.md) | [Can](snapshot/draft/CanGrant.can) | [JavaScript](snapshot/draft/CanGrant.mjs) |
| CanHire | [Requirements](snapshot/draft/CanHire.md) | [Can](snapshot/draft/CanHire.can) | [JavaScript](snapshot/draft/CanHire.mjs) |
| CanInvoice | [Requirements](snapshot/draft/CanInvoice.md) | [Can](snapshot/draft/CanInvoice.can) | — |
| CanLearn | [Requirements](snapshot/draft/CanLearn.md) | [Can](snapshot/draft/CanLearn.can) | — |
| CanLeave | [Requirements](snapshot/draft/CanLeave.md) | [Can](snapshot/draft/CanLeave.can) | [JavaScript](snapshot/draft/CanLeave.mjs) |
| CanLoyalty | [Requirements](snapshot/draft/CanLoyalty.md) | [Can](snapshot/draft/CanLoyalty.can) | [JavaScript](snapshot/draft/CanLoyalty.mjs) |
| CanMail | [Requirements](snapshot/draft/CanMail.md) | [Can](snapshot/draft/CanMail.can) | [JavaScript](snapshot/draft/CanMail.mjs) |
| CanMaintain | [Requirements](snapshot/draft/CanMaintain.md) | [Can](snapshot/draft/CanMaintain.can) | [JavaScript](snapshot/draft/CanMaintain.mjs) |
| CanMember | [Requirements](snapshot/draft/CanMember.md) | [Can](snapshot/draft/CanMember.can) | — |
| CanOnboard | [Requirements](snapshot/draft/CanOnboard.md) | [Can](snapshot/draft/CanOnboard.can) | [JavaScript](snapshot/draft/CanOnboard.mjs) |
| CanPropose | [Requirements](snapshot/draft/CanPropose.md) | [Can](snapshot/draft/CanPropose.can) | — |
| CanPurchase | [Requirements](snapshot/draft/CanPurchase.md) | [Can](snapshot/draft/CanPurchase.can) | [JavaScript](snapshot/draft/CanPurchase.mjs) |
| CanReception | [Requirements](snapshot/draft/CanReception.md) | [Can](snapshot/draft/CanReception.can) | — |
| CanRefer | [Requirements](snapshot/draft/CanRefer.md) | [Can](snapshot/draft/CanRefer.can) | [JavaScript](snapshot/draft/CanRefer.mjs) |
| CanRent | [Requirements](snapshot/draft/CanRent.md) | [Can](snapshot/draft/CanRent.can) | [JavaScript](snapshot/draft/CanRent.mjs) |
| CanReport | [Requirements](snapshot/draft/CanReport.md) | [Can](snapshot/draft/CanReport.can) | — |
| CanShift | [Requirements](snapshot/draft/CanShift.md) | [Can](snapshot/draft/CanShift.can) | [JavaScript](snapshot/draft/CanShift.mjs) |
| CanStats | [Requirements](snapshot/draft/CanStats.md) | [Can](snapshot/draft/CanStats.can) | — |
| CanStock | [Requirements](snapshot/draft/CanStock.md) | [Can](snapshot/draft/CanStock.can) | [JavaScript](snapshot/draft/CanStock.mjs) |
| CanSuccess | [Requirements](snapshot/draft/CanSuccess.md) | [Can](snapshot/draft/CanSuccess.can) | — |
| CanTable | [Requirements](snapshot/draft/CanTable.md) | [Can](snapshot/draft/CanTable.can) | [JavaScript](snapshot/draft/CanTable.mjs) |
| CanTime | [Requirements](snapshot/draft/CanTime.md) | [Can](snapshot/draft/CanTime.can) | [JavaScript](snapshot/draft/CanTime.mjs) |
| CanTrade | [Requirements](snapshot/draft/CanTrade.md) | [Can](snapshot/draft/CanTrade.can) | — |
| CanVolunteer | [Requirements](snapshot/draft/CanVolunteer.md) | [Can](snapshot/draft/CanVolunteer.can) | [JavaScript](snapshot/draft/CanVolunteer.mjs) |

## Shared and supporting material

- [draft/shared/Employees.can](snapshot/draft/shared/Employees.can)
- [draft/shared/Locations.can](snapshot/draft/shared/Locations.can)
- [draft/shared/Suppliers.can](snapshot/draft/shared/Suppliers.can)
- [examples/ExpenseFlow.can](snapshot/examples/ExpenseFlow.can)
- [examples/TeamTasks.can](snapshot/examples/TeamTasks.can)
- [draft/ADMIN_SURFACES.md](snapshot/draft/ADMIN_SURFACES.md)
- [draft/MIGRATION.md](snapshot/draft/MIGRATION.md)
- [draft/PORTFOLIO.md](snapshot/draft/PORTFOLIO.md)
- [draft/README.md](snapshot/draft/README.md)
- [draft/WORKSPACE_OPERATOR.md](snapshot/draft/WORKSPACE_OPERATOR.md)

## Evidence boundary

The `.mjs` files are handwritten desired-output drafts with proposed import contracts. This capture does not establish executable correctness, performance, complete workflow coverage or adoption. No syntax or behavior tests were run for the capture; verification checked inventory and byte identity only.

Compiler, parser and editor implementations, generated assets, caches, historical audit snapshots and historical JEV consultation files are outside this capture. References to those paths within preserved documents continue to identify their original project locations; obtain and version any such evidence separately when an evaluation item requires it. External provider services and proposed package modules are not materialized here.
