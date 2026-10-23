# Implementation ownership and dependencies

The [ordered task checklist](tasks.md) owns current status and priority after the implementation ending at `eb8a8544`. These notes coordinate shared writers; they do not duplicate the backlog or launch an automation. The original [reviews](reviews/index.md) remain source rationale at their recorded audit baseline.

| Workstream | Remaining packets | Coordination and dependencies |
| --- | --- | --- |
| Generation | GEN-REQUEST-C1, GEN-C1 | One controls/lifecycle writer; CLI only forwards outcomes. Durable request admission must precede external launch. |
| Development and editor | DEV-C1, DEV-C2, AUTHOR-C1 | Coordinate owner publication and preview resource custody; the editor framing fix is independently actionable. |
| Values and provider validation | V-LOOKUP-C1, V-ORDER-C1, V-BOUNDS-C1, PROVIDER-C1 | One writer per shared Values file; Rust/binding handoffs preserve public order and errors. Provider result validation is independent. |
| Receipt/profile simplification | RT-C1, P-CODEC | The maximum-copy defect is resolved. Select the next complete receipt workflow; decide persisted accepted domains and fault order before decoder substitution. Coordinate compiler collector, State receipt and host adapter writers. |
| Delivery/setup/guidance | DELIVERY-C1, SETUP-C1, REPO-DOC-C | Independently scoped owners. SETUP-C1 supplies the updated test recipient where SETUP-V1 needs it. |
| Feature and support joins | MIG-CONTRACT, MIG-C1, BROWSER-C3, AUTH-DELIVERY-C, PRODUCER-JOINS | Migration contract precedes installed migration cutover. Refresh, auth and each provider consumer have their own source/permission/custody dependencies; they need not wait for unrelated joins. |
| Remaining verification | SETUP-V1, HOST-V1 | Existing real recovery/retained-state consumers. Verify the actual changed contract rather than fixture metadata or unrelated successful tests. |

First measure the current complete native diagnostic list as described in the checklist. That measurement can identify a shared repair deserving earlier priority; it is not a prerequisite for an independently demonstrated fix.

Use one operator for shared compiler/catalog/dist outputs and native fixtures. Preserve other workers' in-progress changes. Reuse applicable passing evidence, keep original/current permission decisions distinct, and commit coherent tested batches. No new unit tests, diagnostic suppression, blanket cap/timeout increases or app exceptions.
