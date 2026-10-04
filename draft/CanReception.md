# CanReception requirements

Inherits [canlang requirements](../REQUIREMENTS.md), [workspace operator context](WORKSPACE_OPERATOR.md), and [portfolio composition](PORTFOLIO.md). Companion draft: [CanReception.can](CanReception.can).

## Purpose and Adoption Goal

Help workspace reception register expected visitors, check arrivals/departures, and track physical keys/cards. Adoption depends on knowing who may enter, whom they are visiting, and which issued credentials remain outstanding.

## Users and Permissions

Authorized reception staff manage visits and credential records for their granted locations. Eligible verified customer hosts invite their own guests within booking/member permissions. Guests see only their own invitation and arrival instructions through verified access. Authorized access staff issue/revoke device access where configured; ordinary hosts cannot provision door rights or browse the full visitor list.

Credential issue/revocation is ordinary access-staff work under its specific grants. Provider/device keys and connection configuration remain developer maintenance and have no receptionist technical settings console. Shared own-user presentation preferences do not grant device or visitor authority.

## Data and Ownership

Visit stores location, guest contact, verified host and customer organization, purpose, booking/event reference when applicable, permitted arrival/departure window, invited/expected/arrived/departed/cancelled/refused state, and actor/time history. Credential stores an opaque identifier, location/device reference, active issue to one holder, issue/return/loss/revocation evidence, and provisioning outcome. Store no reusable door secret in visitor pages or exports. Retention for identifiable departed/refused visits is configurable, initially 90 days; credential audit records follow their configured retention.

## Workflows and Business Rules

An invitation checks current host eligibility, party/guest limit, and location hours and does not reserve a room. Reception checks the current invitation, eligible underlying booking/term, configured host-presence rule, and recorded identity-check result before admission. Record only the configured identity-check evidence; copying ID documents is not a default requirement. A guest name is not authority to alter another guest's visit.

Arrival consumes its logical admission once; repeated arrival/departure returns the prior result. Guest departure does not clear CanRent's room occupancy or mark an entire event complete. Cancelled bookings, expired memberships, removed company hosts, or revoked invitations disable future admission. If a guest has arrived, reception must resolve departure and any outstanding credential explicitly.

Reserve one active issue per physical key/card and record issue/return once. Lost keys/cards remain outstanding with reason and require a tracked revoke/replacement decision; reusing a credential cannot leave the old holder active. Without hardware integration staff record evidenced physical handling and manual revocation. With hardware integration retain desired versus device-confirmed rights and show pending/failed/uncertain provisioning. Expiry queues revocation; the UI must not claim a device is disabled before confirmation.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar order is Reception, Keys and cards, My visitors, filtered by receptionist/access-staff/verified-host access. Invitation details are contextual verified guest destinations, not unbound global links; a reception device still requires its operator's authenticated session.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Reception /reception | Tabs for expected/today/on-site/overdue; location Select, purpose Input and Visit Table with host, entitlement, window, arrival/departure and freshness Badge. | Authorized host lookup; arrive, depart, refuse and cancel require current location/eligibility and recorded evidence or reason. |
| Keys and cards /reception/credentials | Credential List and nested issue Table; separate desired, confirmed, pending/failed/unknown, return/loss and overdue states; Collapse exposes history. | Credential CRUD and issue, return_key, lost, manual_revoke use access-staff grants and one-active-holder rules. |
| My visitors /reception/mine | Invitation Cards, typed invite Fieldset, location/window/state and arrival instructions; delivery failures use Alert. | Verified hosts invite/cancel only permitted guests; resend preserves existing invitation identity and is a staged owning-operation requirement. |
| Verified guest invitation | Contextual Card of that guest's instructions, current eligibility and visit window, without other guests or reusable door secrets. | Verified record access rechecks underlying authority; guest reading never admits anyone or provisions hardware. |

On narrow screens, preserve guest, interval and desired/device-confirmed status in stacked Cards; drawers return focus to the triggering row. Loading and unavailable eligibility block admission; empty queues differ from stale data. Preserve entered identity evidence during validation/conflict resolution. Recorded on-site counts carry freshness and evidence limits. Expiry/cancellation shows pending revocation until device confirmation; departure cannot clear room/event occupancy.

## Personal Configuration

Inherit account/security, language, appearance and validated persistent save/reset from [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Optional personal controls remember an authorized location and visitor queue or credential-status filter; removed grants invalidate those selections. They change presentation only, never host limits, admission policy, retention or device rights. No receptionist business/technical configuration console is added; shared personal preferences remain available. Provider/device keys stay developer-maintained.

## Interfaces and Integrations

Use D1, EmailService, and authorized booking/member/customer-role capabilities. CanRent owns space reservations and room occupancy; CanReception owns visits and credential lifecycle. A configured device adapter accepts scoped credential/holder/location rights and expiry with stable operation identity and returns pending/active/revoked/failed/unknown outcomes. Device reads/reconciliation are optional; no hardware vendor or protocol is implied.

## Background Actions

Send invitation/change notices and revision-bound arrival reminders if enabled. Process explicit expiry/cancellation/removal revocation work, retry uncertain device operations with stable identities, flag overdue departures/unreturned credentials, and remove visitor personal data when retention expires without erasing required credential evidence.

## Error Handling

Reject guests exceeding a host's authorized limit, revoked hosts, wrong-location admissions, concurrent credential issues, and stale check-in decisions. If eligibility cannot be verified, show unavailable and require resolution rather than treating it as granted. Uncertain device changes remain action-required for reception; a software cancellation cannot prove physical exit or device revocation.

## Scope and Completion

A host can invite a guest for a meeting; reception can verify entitlement, record arrival, issue and reclaim a key, and record departure. Concurrent issue attempts cannot assign one card twice. Membership expiry or host removal prevents new admission and creates visible revocation work for an already issued credential. This records ordinary reception operations; unattended building automation is optional.

Frontend acceptance journeys:

- A verified host invites an eligible guest; reception checks fresh entitlement, records arrival and issues a card. A second issue fails visibly; return and departure retain attributed evidence without clearing a room booking.
- Membership expiry with a card outstanding creates visible revocation work. A failed/unknown device response never renders revoked; stale admission evidence requires refresh and keeps entered evidence available for correction.

## Composition and Ownership

A distinct reception app/package connects to the workspace app and company administration. Booking check-in remains in CanRent; guest arrival and physical credential handling remain here. Café seating and event admission retain their own authorities.

### Authored eligibility, recovery and retention boundary

Invitations use their own record identity for membership watches while retaining the caller's business reference separately. Membership checks the entire remaining visit interval and returns the frozen paid plan's concurrent guest allowance, requested interval, checked time and watch revision. Reception admits only evidence at most one minute old, rechecks current customer/host/location rights and current open hours, and serializes its overlapping guest count locally. Refresh and changed events preserve source identity and monotone observations; a revoked host cannot revive a cancelled visit. Periodic reconciliation covers visits near arrival and on site. This is bounded freshness with fail-closed admission, not cross-service atomic physical access.

One location-owned GuestPolicy governs required evidenced host presence, visitor retention (initially 90 days), credential evidence retention (initially 365 days), and optional reminder lead time. These are ordinary protected business rules under access staff, separate from personal settings and device wiring. Reminder replacement uses the same keyed schedule; delayed dispatch rechecks current invitation eligibility. The invitation notice is now a typed `delivery(Mail.send)?` association on Visit; nullable derived `notice_state` observes only receipt status, replacing the stored none default and transport-status copy, and the pure receipt-copy callback is removed with no business transition lost. Invitation dispatch, reminder replacement and explicit resend keep their guards and associate the fresh attempt; null renders the standard not-requested state. Host/guest readers keep their existing limited fields plus only the `notice_delivery.status` leaf the derived state needs, never receipt identity, result or error. Eligibility, device and reconciliation correlation still use raw delivery IDs under their existing source/revision fences.

Credential issues freeze device/identifier, holder, expiry and their audit policy. Desired revisions and provider observation revisions are distinct: adapters must monotonically number observations within a desired revision, replay matching apply input idempotently and reject changed payload for the same identity. Completion events and verified changed events converge through the same owning DeviceObserved handler. Reconcile/retry operations never claim revocation before verified evidence. Loss, physical return and manual revocation remain separate. Departure and return are allowed after entitlement expires.

Visit/host-presence content uses canonical retention; credential evidence has its separate configured deadline. Expired visit content becomes unavailable to history/UI even while a retained credential reference blocks physical disposal. Credential return/revocation uses its frozen fields and does not require reading expired visitor data; physical removal follows the language's reference-safe retention rules. This cannot recall provider-accepted email or erase source customer directories.

Eligibility refresh and credential expiry/revocation run as keyed per-record scheduled occurrences, not a periodically truncated global scan. Each occurrence rechecks current state and schedules its next relevant check; ended visits stop refresh. This retains progress when a team has more records than a single transaction's loop bound. Hardware uncertainty remains visible for explicit reconciliation rather than a claim that a queued revoke physically succeeded.


### Company host removal and actual credential outcomes

Current host admission now independently requires an active/unarchived customer and requested location, that location still in the customer, a current verified contact for the exact host account, and current customer ownership or booker/administrator authority at that location. Invite, host-presence admission and `current_access` share this check. Fresh paid-member evidence alone cannot authorize a host whose contact or location scope was revoked. Historical Visit/Issue/HostPresence records do not acquire dynamic eligibility invariants, so revocation does not invalidate custody evidence or manufacture a departure.

Customer invalidation uses CustomerVisitStep and CustomerCredentialStep, each selecting one next stable record ID. The former marks an invalid live host's admission for review and returns expected to invited, preserving arrived state. It can request fresh membership evidence for restored current hosts still under review. The latter reaches actual retained Issue records, including credentials attached to ended visits, and queues the existing CredentialCheck. Issue freezes its originating customer at handover, allowing customer-scoped retained revocation work without dereferencing expired visitor content. Existing expiry short-circuit and frozen credential fields retain the independent custody/retention boundary.

`access_review(customer,location)` explicitly grants only safe counts to a current administrator at that customer location or a scoped receptionist/access operator. Discoverable Reception access review and a company-record page expose that report and `recheck_access`; actual raw Visit/HostPresence/Issue policies stay unchanged. The report separately shows current host admission conflicts, pending evidence/review, on-site review, active credentials still needing a revoke intent, and desired-revoked credentials whose confirmation is pending, failed, unknown, still-active conflict or revoked. Reports never expose guests, purposes, identity evidence, key identifiers, holder details or provider references to administrators. Staff using Customer pickers/routes still need existing directory read authority.

A rerun queues both current-state cursors at the requested location; its receipt is not physical revocation. The existing credential handler changes desired intent once, increments its provider revision, and keeps hardware uncertainty explicit. A provider still confirming active under the revoked intent is a visible conflict and permits a same-intent retry. Device retry/reconcile and manual physical revocation/return remain access-staff actions in Keys and cards. Membership/reception failure does not erase actual arrival or release Rent's room occupancy. Current admission is fail-closed even before cursor work completes; departure and credential recovery remain usable under their historical ownership and staff guards.

Meaningful authored examples use the existing arrival/key fixtures: current host contact loss appears immediately as conflict and revoke work; reports distinguish pending/failed/unknown/confirmed revocation; visit invalidation preserves arrived state; a no-device revoke remains unknown until real physical evidence; replaying an already revoked intent preserves its provider revision/outcome. The user sequence performs an actual authorized Contact email update, inspects the current safe report and queues owner recovery while retaining physical arrival/departure facts. It uses no direct fixture mutation or synthetic handler calls.

Manual progress proof: 99, 100, 101 and 1000 matching visits/issues each advance through N one-record continuations plus an empty terminal selection. There is no former `limit=100` customer fanout transaction that could reject an entire invalidation. Replays reread current authority, and old source revisions are not treated as a global customer clock. Existing keyed visitor and credential occurrences continue independently; authorized rerun covers old unfinished owner backlog. Current reports identify unresolved work before/after it is queued; read-budget failure is unavailable evidence, not a successful zero-work result. This is source reasoning, not executed scheduling/device evidence.

Full Can parsing rejects the unsupported `delivery(Mail.send)?` field type at line 37, the structured enum caption on the model derive at line 39, and the pre-existing attached sequence example; a disclosed temporary projection replacing only that type with `text?` and that caption with its scalar form while omitting only that sequence passed `tools/can_parser.py`. This checks surrounding syntax only, not receipt typing, label rendering or runtime behavior; no runner implements that settled contract. No existing matching generated MJS target exists, and none is added for symmetry. Combined Customer/Member/Reception navigation requires explicit actual owner selection; CustomerSales and Workspace are not silently broadened to import the device/reception deployment.
