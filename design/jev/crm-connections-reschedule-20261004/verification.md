# CRM connections workflow verification

Owned workflow edits: `draft/CanBook.can`, `draft/CanBook.md`, `draft/CanPropose.can`, `draft/CanPropose.md`. Earlier CRM/provider export work is recorded separately in `/tmp/crm-connections-verification.txt`; this follow-up does not claim ownership of other agents' shared owner changes.

Final focused command: `python3 tools/can_parser.py draft/CanBook.can draft/CanPropose.can`. Result: `Parsed 2 .can files (syntax only).` No compiler, typechecker, renderer, adapter, runtime or inline-scenario execution was performed. CanBook/CanPropose have no generated JavaScript target here.

Source inspection matched consumer fields and calls against the actual owning declarations in CanShift, CanRent, CanInvoice and shared Locations. Required counterparts are authored: employee staged predecessors with cancellation tombstones; noncommercial venue hold/stage/confirm/release in the canonical capacity authority; explicit resource routing before creation; released outcomes for absent/already released venues; structured location `is_open`; quote hold/accepted offer DTO imports; itemized frozen invoice Charge fields.

Three specific asynchronous races were corrected during the source review:

- A delayed venue stage must reject an earlier same-source VenueFence; replayed release must return an authoritative released outcome even after the row is already nonbusy.
- Quote expiry deactivates a temporary hold without fencing a timely accepted decision; withdrawal/decline uses the explicit resource release fence.
- Hold and booking share a quote source/commercial number, so ReservationOfferOutcome now carries required `kind` and owner `version`. Consumers store separate hold/booking versions, ignore older results, and cannot mistake QuoteHold confirmation for a Booking.

Book examples author expectations for holiday exclusion, verified booking, failed staged movement retaining the predecessor, adoption after both resources, cancellation and discarding uncertainty while preserving the original. Propose examples author expectations for held deadlines, exact snapshot handoff, sold-out alternatives, permissions, hold-vs-booking discrimination and stale owner-version rejection. These expectations are not executable evidence.

No source-level contract dependency remains for this batch after the owning edits above. Deployable behavior still depends on unimplemented compiler/runtime/UI and installed capability adapters, including authenticated producer/namespace/causation mapping, committed authoritative outcomes, replay and file finalization. The authored workflows do not claim cross-provider atomicity or working scheduling/payment/PDF delivery.
