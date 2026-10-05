# B4 PROPOSAL construct inventory (read-only triage synthesis)

Sources: /tmp/b4-triage-{1,2,3,4}.md (P verdicts), /tmp/b4-coverage.md (NONE rows), /tmp/b4-witness.md. "Covers" = diagnostic the checker correctly emits today.

## P1. Deployment-less sibling imports — ~60 E2005 + ~2400 E2001/E3001 cascades, 47 drafts

Construct: bare `use <sibling-app> {…}` (rent_catalog, employee, customer, invoice, field, supplier, refer, sales_attribution, member_terms, crm, desk, creative, onboard, rent_reservations, std) and `uses=[sibling apps]` (CustomerSales ×4). Catalog holds only builtins/helpers, so all fail single-file; 531 shard-4 diags clear in workspace recheck (siblings resolve). Cascades: orphaned names (Location, can_work, test_*, owns/has_role, staff/hr/Task/Term) + bare status labels vs opaque types.
Covering code: E2005 (correct). Citations: GRAMMAR:78-80,160-162; DESIGN §8 imports; DESIGN:17,87 (bound `from=deployment.*` form passes — CanApprove:8, CanBook:10-11, CanAffiliate:8).
Affected: all drafts except CanShift/CanVolunteer (unchecked bodies).

## P2. Capability async event surface — ~60 E3010 + ~150 cascades, ~20 drafts

Construct: `on=<Cap>.<op>.completed|progressed|changed` (StaffSchedule, Rooms, Alerts, Sales, LLM, Images, Conversation, Billing, Payments, Stock, Membership, Mail.send, Post, Judge, Handbook.answer, CompanyAccessChanged, ReportSubmitted). Deployment catalog unresolvable in single-file check; local `on=WorkSources.work.completed` resolves (CanDo:87), proving the mechanism. Cascades: bare `succeeded/failed/confirmed/…` vs `event.*` (DESIGN:165 needs unique expected enum), opaque revision/args.
Covering code: E3010 (correct). Citations: GRAMMAR:365 (finite source registry); DESIGN:165.
Affected (E3010 counts): CanEvent 10, CanBook 9, CanMaintain 5, CanInvoice 5, CanRent 15(P↓), CanField/Hire/Inbox 4, CanLeave/Propose/Success/Time 3-4, CanMail/Reception/Purchase/Stock/Workbench 1-3, CanAffiliate/CanCheck/CanChat/CanCreative/CanKnowledge/CanLoyalty 1, CanRefer 1(P↓).

## P3. Capability receipt/signature opacity — ~250 E3001/E2013/E3015-opaque + E3013, ~25 drafts

Construct: delivery receipts (`Mail.send`, `Alerts.notify`), send `value=` shapes, `delivery(lookup)`, `DeliveryResult`/`OperationOutcome`/`Settlement`/`IncomingEmail.*` — operations resolve but receipts are silently opaque, orphaning bare status labels and poisoning comparisons/defaults (`delivery.*`, `derive …:DeliveryResult.status`, `delivery=attempt`, `schedule/cancel` keys). Proof elision works on typed values: `state=confirmed` (CanEvent:54), `state=unknown` (CanInbox:84), `status=planned` (CanFeedback:44); `pending` elides (CanDo:89) while `open/fresh` fail on opaque `event.result` same file.
Covering code: NONE — suggested E2013B/E3001R "opaque receipt member" (today only E2013/E3001/E3013 cascades). Citations: DESIGN:165 (expected-enum rule); L6 DeliveryStatus interim pick open.
Affected: CanDesk 18+5, CanDiscover 26, CanDo 3, CanEnrich 5+3+3, CanEvent 64+2+5, CanExpense 21+3+2, CanField 15, CanGallery 2, CanGrant 2, CanHire 19+5, CanInbox 25+3+10+5, CanRent 5(P↓), CanStock 10, CanSuccess 5(P↓)+2, CanTime 3, CanMaintain (part of 63), CanInvoice (part of 132).

## P4. `uses=[sibling apps]` — 4 sites, 1 draft family

Construct: app-level `uses=` dependency on sibling apps (CustomerSales ×4). Same root cause as P1, distinct syntax.
Covering code: E2005 (correct). Citations: GRAMMAR:78,160-162.

## P5. Plain-`std` value imports — 4 E2005 + DeliveryResult/OperationOutcome E2001 + E3013 knock-ons, 4 drafts

Construct: `use std {OperationOutcome, DeliveryResult}` with no `.can` provider (stdlib is TS-only); bound `from=deployment.*` form passes.
Covering code: E2005 (correct). Citations: DESIGN:87.
Affected: CanRent, CanStock, CanSuccess, CanWorkbench (1 each).

## P6. Trusted-scenario `each=` fan-out — 4 E1203, 2 drafts

Construct: `each=` on trusted scenarios. GRAMMAR trusted-scenario row lists only `on=`.
Covering code: E1203 (correct). Citations: GRAMMAR trusted-scenario row.
Affected: CanShift 2, CanVolunteer 2.

## P7. Dissolved containment — 3 not-contained + 21 E2013-`parent` cascade, 1 draft

Construct: `Expense in Employee` + unresolved `Employee` → containment dissolves, `parent` cascades.
Covering code: E2005 at import (correct); containment errors are cascade. Citations: DESIGN:99,133.
Affected: CanExpense.

## P8. Coverage-NONE syntax (no parser/BDD/runtime; drafts affected, zero diags — silently untestable)

| construct | drafts | covering code | citation |
|---|---|---|---|
| `delivery(...)` / `invocation(...)` types | 28 / 1-2 | NONE (parser rejects; suggested E1200-series accept rule) | GRAMMAR types |
| Sequence examples (`do`/`call`/`assert`) | CanChat, CanApprove + projections | NONE (no parser/BDD; suggested L1+L7 extension code) | L7 BDD |
| Table-example execution | 49 (all) | NONE (testkit accounts-only; runner pending L7) | L7 |
| `import=csv` / `review=` on forms | 5 | NONE (parser rejects) | GRAMMAR forms |
| `refresh=` on pages | 2 | NONE (parser rejects) | GRAMMAR pages |
| `expose=` allowlist | 0 uses, normative + witness #1 | NONE (parser rejects) | canonical-exposure-20261004, R12 |
| `corpus` grounding runtime | 1 | NONE (no impl L4) | GRAMMAR corpus |
| Migration/backfill execution | 0 uses, doc-only | NONE (orchestration NONE L3+L7) | MIGRATION.md (B3) |

## Volume ranking (proposals only)

1. P1 sibling imports: ~2500 (60 direct + ~2400 cascade).
2. P3 receipt opacity: ~250 opaque + label cascades.
3. P2 capability events: ~60 direct + ~150 cascade.
4. P8 table-exec/delivery-type: 49/28 drafts affected, 0 diags (untestable, highest risk-per-silence).
