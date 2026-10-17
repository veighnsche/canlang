# CRM appointment replacement consultation and verification

<a id="source-README"></a>

## Source: README.md

### Appointment replacement consultation

Three fresh semantically equivalent requests retain exact current CanBook book/cancel, ScheduleV1 reserve/release declarations and handlers, and RoomsV1 declarations. Full explanatory prose and criteria were rewritten and checked before sending. The first attempt lacked network access and returned no response; elevated calls used the user’s standing authorization. Responses are preserved in full.

| Run | Choice | Confidence | Staged | Disjoint | Coordinator | Current-guarantee NOUL |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | staged | 0.83 | 0.89 | 0.11 | 0.00 | 0.08 |
| 2 | staged | 0.98 | 0.99 | 0.01 | 0.00 | 0.10 |
| 3 | staged | 0.93 | 0.96 | 0.04 | 0.00 | 0.18 |

The chosen alternative agrees across calls; certainty does not. The distributions are advice, not proof or approval thresholds. Source inspection independently shows that reserve_connected updates the previous same-source interval before a room authority can settle. A new unlinked source conflicts with its original overlapping appointment. Staging must preserve the existing compatible-duty exception: the predecessor is the only additional appointment/visit overlap exemption. It must not reject otherwise compatible same-location duty coverage, and must not exempt other appointments or visits.

The agreed staff shape is ScheduleV1.stage(value:CommitmentRequest,previous_source:text,previous_revision:int)->OperationOutcome. A fresh candidate keeps its predecessor allocated; existing release retires candidate or predecessor with retained cancellation tombstones. Room/venue staging is coordinated at the owning capacity authority separately. Cross-provider atomicity is not claimed. Runtime/provider implementations remain unimplemented.

<a id="source-verification"></a>

## Source: verification.md

### CRM connections workflow verification

Owned workflow edits: `draft/CanBook.can`, `draft/CanBook.md`, `draft/CanPropose.can`, `draft/CanPropose.md`. Earlier CRM/provider export work is recorded separately in `/tmp/crm-connections-verification.txt`; this follow-up does not claim ownership of other agents' shared owner changes.

Final focused command: `python3 tools/can_parser.py draft/CanBook.can draft/CanPropose.can`. Result: `Parsed 2 .can files (syntax only).` No compiler, typechecker, renderer, adapter, runtime or inline-scenario execution was performed. CanBook/CanPropose have no generated JavaScript target here.

Source inspection matched consumer fields and calls against the actual owning declarations in CanShift, CanRent, CanInvoice and shared Locations. Required counterparts are authored: employee staged predecessors with cancellation tombstones; noncommercial venue hold/stage/confirm/release in the canonical capacity authority; explicit resource routing before creation; released outcomes for absent/already released venues; structured location `is_open`; quote hold/accepted offer DTO imports; itemized frozen invoice Charge fields.

Three specific asynchronous races were corrected during the source review:

- A delayed venue stage must reject an earlier same-source VenueFence; replayed release must return an authoritative released outcome even after the row is already nonbusy.
- Quote expiry deactivates a temporary hold without fencing a timely accepted decision; withdrawal/decline uses the explicit resource release fence.
- Hold and booking share a quote source/commercial number, so ReservationOfferOutcome now carries required `kind` and owner `version`. Consumers store separate hold/booking versions, ignore older results, and cannot mistake QuoteHold confirmation for a Booking.

Book examples author expectations for holiday exclusion, verified booking, failed staged movement retaining the predecessor, adoption after both resources, cancellation and discarding uncertainty while preserving the original. Propose examples author expectations for held deadlines, exact snapshot handoff, sold-out alternatives, permissions, hold-vs-booking discrimination and stale owner-version rejection. These expectations are not executable evidence.

No source-level contract dependency remains for this batch after the owning edits above. Deployable behavior still depends on unimplemented compiler/runtime/UI and installed capability adapters, including authenticated producer/namespace/causation mapping, committed authoritative outcomes, replay and file finalization. The authored workflows do not claim cross-provider atomicity or working scheduling/payment/PDF delivery.
