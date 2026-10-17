# T12 — Standard and bound declaration inventory

- Task: T12 (L4). Base: branch `codex/challenge-audit-implementation` from `c681d86`; draft submodule `2d67312`.
- Method: read-only `rg` enumeration of every `use` line plus a per-package export check (`/tmp/check_bound.py`, kept out of tree); producer state read from `packages/contracts`, `packages/services`, `packages/work`, `packages/files`, `packages/values`, `packages/stdlib`, `compiler/src/analysis/{resolve,types,catalog}.rs`.
- Scope: every `use std {…}` member (bound and unbound) and every `from=deployment.…` member. Unbound non-`std` imports are T28/T29/T36 territory, not inventoried here.
- Rule: each entry names producer, version, accepted scope and availability — or a precise decision blocker. Nothing passes silently.

## Coverage

| Group | Distinct declarations | Import lines | Files |
| --- | --- | --- | --- |
| `std` members | 26 | 49 (`24` unbound + `25` bound) | 32 apps |
| Bound non-`std` members | 58 | 51 lines | 31 apps |
| **Total** | **84** | **100** | — |

Demand (scopes T13a vs T13b): 236 `send Head.op` occurrences (audit baseline 231; delta is regex scope), 45 `delivery(Head.op)` occurrences in `.can` (matches audit baseline), 40 fixture recipes over 17 distinct `Head.op` targets.

Checker cross-check (confirms the producer model, not new evidence): all 24 unbound-`std` lines fail today with E2005 (`std` is no known provider; audit counted exactly 24 E2005); all 58 bound non-`std` members resolve to declared+exported in-corpus symbols (0 undeclared, verified per package section); the 86 E3019 opaque-send/recipe failures decompose exactly into std-bound sends (Mail.send 40, Payments.\* 9, Images.\* 7, LLM.\* 5, Post.\* 3, Catch.report 1 = 65) plus std-bound fixture recipes (21). In-corpus-bound sends (Billing.\*, Membership.\*, Rooms.\*, StaffSchedule.\*, Judge.evaluate, …) already check against real declared signatures.

## A. `std` declarations — T13a scope (common operation / delivery / email contracts)

Producer versions: `@canlang/contracts 0.1.0` (`services.ts`, no separate contract version stamp — T13 must add one); `@canlang/services 0.0.0`, `SERVICES_CATALOG` version 1.

| `std` member | Imported as / from | Producer | Version | Accepted scope | Availability |
| --- | --- | --- | --- | --- | --- |
| `DeliveryResult` | plain, 20 unbound sites + bound `deployment.mail` (CanApprove:8, CanPropose:11) | `@canlang/contracts` `services.ts` (`DeliveryResult`/`DeliveryStatus`); observation via `@canlang/work` receipt kernel | contracts 0.1.0; work catalog 0.0.0 | closed `{id, status}` + 5 statuses | contract accepted; compiler/runtime consumption pending T13/T25 — no blocker on shape |
| `DeliveryError` | plain (CanInbox:10) | `@canlang/contracts` `services.ts` (`DeliveryError`) | contracts 0.1.0 | closed `{code, message}`, no details/retryable | contract accepted; consumption pending T13 — no blocker on shape |
| `OperationOutcome` | plain, 7 sites | `@canlang/contracts` `services.ts` (`OperationOutcome`) | contracts 0.1.0 | `{source, revision, state +6, reference?, detail?}` | contract accepted; also used as in-corpus event payload (`member_terms`, `stock` outcomes) — consumption pending T13 — no blocker on shape |
| `PaymentState` | plain (CanInvoice:13) | `@canlang/contracts` `services.ts` (`PaymentState`) | contracts 0.1.0 | reference/revision/amount/status/checkout/failure | contract accepted; consumption pending T13 — no blocker on shape |
| `EmailV1` | `Mail`, `deployment.mail`, 20 sites | `@canlang/services` `EmailV1Adapter` + `services.ts` (`EmailSendInput`/`EmailAccepted`); catalog `std.EmailV1` v1 | catalog v1 / cap v1 | `send` (catalog); adapter additionally implements `reconcile` (port, unadvertised) | **implemented** (adapter + controlled harness + scenario tables); T13a exports `send` schema first |
| `ErrorsV1` | `Catch`, `deployment.errors` (CanDo:8); 1 send `Catch.report` | `@canlang/contracts` `services.ts` (`ErrorReport`/`ErrorAccepted`) only — **no adapter** | contracts 0.1.0 | report shape accepted | contract accepted, adapter unimplemented → blocker B10 (contract-only T13a export vs adapter gate) |
| `PaymentsV1` | `Payments`, `deployment.payments` (CanInvoice:15); 9 sends (`collect`/`refund`/`cancel`/`reconcile`); `delivery(Payments.reconcile/cancel)`; 1 recipe | `@canlang/contracts` `services.ts` (`PaymentCollectInput`, `PaymentRefundInput`, `PaymentCancelInput`, `PaymentReconcileInput`) only — **no adapter** | contracts 0.1.0 | all four op input shapes accepted | contract accepted, adapter unimplemented → blocker B10 |

T13a input-shape note (→ blocker B9): `EmailSendInput.attachments` is required in contract, but all 40 corpus `Mail.send` sends and all 13 recipes supply only `{to, subject, body}`. T14a must rule default-empty vs required.

## B. `std` declarations — T13b scope (generation / image / judgment / mailbox / knowledge)

| `std` member | Imported as / from | Producer | Availability / blocker |
| --- | --- | --- | --- |
| `TextGenerationV1` | `LLM`, `deployment.llm` (CanChat:6); sends `generate`/`cancel`×3/`reconcile`; 3 delivery forms; 2 recipes | candidate `ai.ChatV1` (`ModelChatInput`/`ModelChatReply`/`ModelRunSnapshot`, `OllamaChatAdapter`, catalog cap v1 op `generate`) | name/shape reconciliation required → B2; `cancel` has no port op (stream-handle only) → B3 |
| `TextMessage`, `TextRequest`, `TextRun` | plain (CanChat:5; `TextRun` also CanKnowledge:7) | none under these names | no contract → B2 (reconcile vs `ai.ChatV1` shapes or new contract) |
| `ImagesV1` | `Images`, `deployment.images` (CanCreative:9); sends `inspect`/`validate`/`submit`/`cancel`×3/`reconcile`; 5 delivery forms | partial `ai.ImagesV1` (`ImageGenerateInput`/`ImageAccepted`, `ComfyUINativeAdapter` `submit`/`reconcile`/`cancel`, catalog cap v1 op `submit`) | `submit`/`cancel`/`reconcile` mappable → B3 (signature form `{source,revision}` vs port `(job)`); `inspect`/`validate` have no producer → B4 |
| `ImageRun`, `GeneratedImage` | plain (CanCreative:8, CanGallery:8) | `@canlang/contracts` `services.ts` (`ImageRun`/`GeneratedImage`) | **contract accepted**; consumption pending T13b — no blocker on shape |
| `ImageRequest`, `WorkflowInput`, `WorkflowDefinition`, `WorkflowInspection`, `WorkflowValidation` | plain (CanCreative:8) | none (`WorkflowNodeMapping`/`ApiGraph` are adapter-owned config, not language types) | no contract → B5 |
| `MailboxV1`, `IncomingEmail`, `MailReply`, `MailReplyOutcome` | `Post`+types, `deployment.inbox` (CanInbox:9); sends `Post.reply`×2/`Post.reconcile`; 2 delivery forms; 2 recipes | **none** (no contract, adapter, or catalog entry anywhere in `packages/`) | no producer → B6 (new L4 contract or explicit scope-out) |
| `JudgmentSpec` | plain (CanDecide:5, CanInbox:10); fields `specification:JudgmentSpec` | none under this name; related: `ai.SystemOneV1` (`JudgmentQuestion`/`JudgmentBatchInput`, `SystemOneAdapter`, catalog cap v1 op `evaluate`) and in-corpus `export judgment` decls (`decide.ChangeReview` v1, `inbox.Triage` v1) | triangle reconciliation required → B7 |
| `KnowledgeRequest`, `IndexState` | plain (CanKnowledge:7); `IndexState` also a derive target | none | no contract → B8; `Handbook.*` sends bind to the local `corpus Handbook … from=deployment.knowledge` decl (CanKnowledge:25), also T13b corpus-interface scope |

## C. Bound non-`std` members (58, all resolve in corpus)

Producer for every row: the owning draft package at submodule `2d67312` (source-declared, statically resolvable today — no E2004/E2005; sends against capability ops already signature-check). Versions: `capability`/`judgment` decls carry `version=1`; `contract`/`scenario` decls are unversioned. Deployment-binding semantics (local executable closure vs bound remote schema) are gated on the T28 decision for all rows (→ B12).

| Provider (file) | Members (export kind) | Deployment binding(s) |
| --- | --- | --- |
| `affiliate` (CanAffiliate) | `CommissionV1` (capability) | deployment.commissions |
| `board` (CanBoard) | `complete`, `work`, `work_detail` (scenarios) | deployment.board |
| `catch` (CanCatch) | `AlertsV1`, `IntakeV1` (capabilities) | deployment.alerts, deployment.error_intake |
| `check` (CanCheck) | `PingV1` (capability) | deployment.pings |
| `decide` (CanDecide) | `SynthesizerV1` (capability), `ChangeReview` (judgment) | deployment.decision_writer, deployment.decision_judgment |
| `desk` (CanDesk) | `InboxV1` (capability) | deployment.support_inbox |
| `discover` (CanDiscover) | `DiscoverySourceV1`, `DiscoveryAnalysisV1` (capabilities) | deployment.discovery_sources, deployment.discovery_analysis |
| `enrich` (CanEnrich) | `SourcesV1` (capability) | deployment.company_sources |
| `inbox` (CanInbox) | `Triage` (judgment) | deployment.judgment |
| `invoice` (CanInvoice) | `BillingV1`, `DocumentsV1`, `SalesV1`, `BillingIngressV1`, `SalesIngressV1` (capabilities); `Charge`, `DocumentLine`, `Settlement`, `SaleMilestone`, `Qualification` (contracts) | deployment.billing, deployment.documents, deployment.qualified_sales, deployment.billing_ingress, deployment.sales_ingress |
| `maintain` (CanMaintain) | `inspect`, `work`, `work_detail` (scenarios) | deployment.maintenance |
| `member_terms` (CanMember) | `MembershipV1`, `MembershipIngressV1` (capabilities); `AccessEvidence`, `Entitlement`, `BenefitInterval`, `AllowanceOutcome` (contracts) | deployment.membership, deployment.membership_ingress |
| `onboard` (CanOnboard) | `complete`, `work`, `work_detail` (scenarios) | deployment.onboarding |
| `propose` (CanPropose) | `DocumentsV1` (capability) | deployment.documents |
| `purchase` (CanPurchase) | `PayableEvidenceV1` (capability) | deployment.accounting |
| `reception` (CanReception) | `DeviceV1` (capability) | deployment.devices |
| `rent_reservations` (CanRent) | `RoomsV1` (capability); `AffectedBookings` (contract) | deployment.rooms |
| `report` (CanReport) | `ReportsV1` (capability) | deployment.reports |
| `shift` (CanShift) | `ScheduleV1`, `ScheduleIngressV1` (capabilities) | deployment.staff_schedule, deployment.schedule_ingress |
| `stats` (CanStats) | `DimensionsV1`, `TrackerV1` (capabilities) | deployment.dimensions, deployment.tracker |
| `stock` (CanStock) | `StockV1`, `StockIngressV1` (capabilities); `StockReceipt` (contract) | deployment.stock, deployment.stock_receipts |
| `success` (CanSuccess) | `complete`, `work`, `work_detail` (scenarios) | deployment.accounts |
| `sync` (CanSync) | `AccountsV1` (capability) | deployment.accounts |
| `todo` (CanDo) | `WorkSourcesV1` (capability) | deployment.work_sources |
| `volunteer` (CanVolunteer) | `complete`, `work`, `work_detail` (scenarios) | deployment.volunteering |
| `workbench` (CanWorkbench) | `WorkbenchPlannerV1` (capability) | deployment.workbench_planner |

## D. Producer availability backing the inventory

- `@canlang/services 0.0.0`: 4 adapters (`EmailV1Adapter`, `OllamaChatAdapter`, `SystemOneAdapter`, `ComfyUINativeAdapter`), 4 ports, controlled harnesses + checked scenario tables for all four; no payments/errors/mailbox adapters. `SERVICES_CATALOG` v1 advertises exactly the 4 adapter-backed capabilities with one op each (`send`/`generate`/`evaluate`/`submit`).
- `@canlang/work 0.0.0` (`WORK_CATALOG_VERSION 0.0.0`, 14 kernel entries: intent/outbox/event/schedule/dispatch-guard/receipt/recovery): backs receipt observation (`ReceiptObservation`, fenced selected leaves) and durable dispatch behind `DeliveryResult`. No draft imports it directly.
- `@canlang/files 0.0.0` (`FILES_CATALOG_VERSION 0.0.0`, 17 entries: upload/finalize/provenance/retention/bridge/storage): backs attachment refs (`EmailSendInput.attachments`) and T27 image finalization. No draft imports it directly.
- `@canlang/values 0.1.0` + `@canlang/stdlib 0.1.0` façade (`STDLIB_CONTRACT_VERSION 1`): pure builtins, delivery/action/invocation value shapes (`DeliveryRef`, `delivery(op)` types). Capability binding is via deployment bindings + T13 schemas, not via this façade — no stdlib change implied.
- L1 read-only state: `resolve.rs` treats bound-unknown providers as opaque externals (never an error), unbound-unknown providers as E2005, external sends/recipes as E3019; `catalog.rs` consumes only the values `catalog.json` (no capability-schema consumption yet — that is T13).
- L3 read-only state: `packages/state/src` carries effects staging/outbox/intent ports the T24 join will use; no T12 claim on them beyond existence.

## E. Decision blockers (each unresolved interface has one; none passes silently)

| ID | Question | Scope | Owner |
| --- | --- | --- | --- |
| B1 | How does `std` become resolvable — compiler-known module fed by T13 schemas, or another mechanism? (Unblocks all 24 E2005 lines.) | T13/T14 | L4 schemas + L1 consume |
| B2 | Is corpus `TextGenerationV1` + `TextMessage`/`TextRequest`/`TextRun` the same contract as producer `ai.ChatV1` (`ModelChatInput`/`ModelChatReply`/`ModelRunSnapshot`), renamed — or a new contract? | T13b | L4 with draft evidence |
| B3 | `cancel`/`reconcile` surface: corpus `{source, revision}` form vs ports (`MediaPort.cancel(job)`, stream-handle cancel, `reconcile(deliveryId)`); chat port has no `cancel` op. Adopted per-capability op set? | T13b/T24 | L4 |
| B4 | `Images.inspect`/`Images.validate` have no producer. New contract + adapter/harness, or explicit scope-out (blocks CanCreative template/validation flow)? | T13b | L4 decision |
| B5 | `ImageRequest`/`Workflow*` have no language contract (only adapter-owned `WorkflowNodeMapping`/`ApiGraph`). New contract or scope-out? | T13b | L4 decision |
| B6 | `MailboxV1` + `IncomingEmail`/`MailReply`/`MailReplyOutcome` have no producer at all. New L4 contract (+ adapter) or explicit scope-out (blocks CanInbox `Post.*` flow)? | T13b | L4 decision |
| B7 | Reconcile `JudgmentSpec` (std) ↔ in-corpus `export judgment` surface (`specification`/`revision`/`options`/`pick`/`choice`/`route`/`urgency` leaves) ↔ `ai.SystemOneV1` wire (`JudgmentQuestion` kinds). One contract or two joined layers? | T13b | L4 with L1 |
| B8 | `KnowledgeRequest`/`IndexState` have no producer; `corpus Handbook` decl kind also needs a T13b interface rule. New contract or scope-out (blocks CanKnowledge)? | T13b | L4 decision |
| B9 | `EmailSendInput.attachments` required vs corpus never supplying it: default-empty in T14a checking, or required (would make all 40 corpus sends invalid)? | T14a | L1 with L4 |
| B10 | `ErrorsV1`/`PaymentsV1` are contract-accepted but adapter-less: is contract-only schema export enough for T13a/T14a checking (runtime via controlled fixtures, adapters later), or do adapters gate T13a? | T13a/T24 | L4 |
| B11 | `DeliveryResult` imported bound (`deployment.mail`, 2 sites) and unbound (20 sites): does `from=` on a value type carry binding meaning, or must the bound form be normalized? | T13/T28 | L4 with L1 |
| B12 | For all 58 in-corpus bound members: local executable closure vs deployment-bound remote schema semantics (ownership, authority, storage). | T28 | L3 decision |

## F. Catalog / index changes

None. Rationale, checked against the mapping above:

- `packages/services/src/catalog.ts`: all four entries truthfully advertise adapter-backed capabilities/ops; unadvertised port ops (`reconcile`, stream `cancel`) and contract-only capabilities (`ErrorsV1`, `PaymentsV1`) are recorded here as T13 input, not added — adding them now would be new provider semantics and would weaken strict validation (E3019 must keep firing until real schemas land per T13/T14).
- `packages/work/src/catalog.ts`, `packages/files/src/catalog.ts`: kernel/file entries are unchanged and complete for T12; drafts import neither directly.
- `packages/stdlib/src/index.ts`: values-only façade already documents its scope and gaps; capability binding does not flow through it.
- Completed producers preserved: no entry removed, no version bumped, no op renamed.

## G. Commands run (all read-only; no heavy lock needed)

- `rg -n "use std" draft/ | sort` + counts — 49 lines, 32 apps.
- `rg -n "^\s*use " draft/ | rg -v "use std"` + bound/non-std splits — 51 bound non-std lines.
- `rg -o "send [A-Za-z_]+\.[A-Za-z_]+" … | sort | uniq -c` — 236 occurrences, 69 distinct `Head.op`.
- `rg -on "delivery\([A-Za-z_]+\.[A-Za-z_]+\)" draft/*.can` — 45 occurrences; fixture-recipe aggregation — 40 recipes, 17 targets.
- `python3 /tmp/check_bound.py` — 58/58 bound non-std members declared+exported in owning package sections, 0 undeclared.
- Reads: `packages/{contracts,services,work,files,values,stdlib}/src/…`, `compiler/src/analysis/{resolve,types,catalog}.rs` (import/E2005/E3019 rules, catalog consumption).
- No `tsc`/`npm`/`cargo` run (zero code edits); no lock acquired.
