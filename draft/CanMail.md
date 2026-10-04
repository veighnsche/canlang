# CanMail requirements

Inherits [canlang requirements](../REQUIREMENTS.md), [workspace operator context](WORKSPACE_OPERATOR.md), and [portfolio composition](PORTFOLIO.md). The authored contract is [CanMail.can](CanMail.can); [CanMail.mjs](CanMail.mjs) is its handwritten desired JavaScript target, with proposed unimplemented imports.

## Purpose and Adoption Goal

Optionally help a workspace operator receive and deliver customer mail/parcels for on-site or virtual-office customers. Adoption depends on knowing what arrived, notifying the authorized recipient, and retaining collection or forwarding evidence.

## Users and Permissions

Authorized location mail staff record receipts and handling. Verified designated recipients see only items linked to their own service contact. A company administrator can manage the service and delegates without gaining recipient item, storage or photo reads. Organization administrators grant collection delegates explicitly. A booking, company email domain, or login alone does not authorize collection, opening, or forwarding.

## Data and Ownership

Mail service entitlement records customer, location, active period, permitted handling, and recorded recipient instructions/version. An item has stable receipt identity, recipient/service reference, receipt time, type, safe storage reference, optional bounded receipt photo, and received/notified/collection_ready/collected/forward_pending/forwarded/returned state. Retain collection delegate/actor/time or dispatch/carrier reference, fees/currency, and immutable handling history. Default identifiable item-history retention is 180 days after completion, with developer-maintained retention configuration outside the product UI.

## Workflows and Business Rules

Validate the active service and recipient before accepting an item into a customer queue; unmatched items enter restricted staff review. Notification is not collection. Staff record collection by an authorized recipient/delegate once with evidence. Forwarding uses snapshotted explicit instructions and destination; changing a contact address cannot redirect an already dispatched item. A failed or uncertain dispatch remains pending until evidenced.

Service expiry stops new handling entitlements but existing items remain available for an explicitly recorded collection/return resolution. Never discard or return an item merely because a timer or membership callback fired. Reversals/corrections append handling history. Initial scope is receive, notify, collect, forward, and return; opening/scanning mail content and call answering are deferred.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). When mail handling is offered, order navigation as My mail for verified permitted recipients, then Mail and parcels for location mail staff. Incoming, unmatched, uncollected and forwarding queues belong within the staff index; individual item/history views are contextual links. Delegate actions retain own-company authority.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My mail — recipient index | Item Cards with receipt/type/state Badge and authorized handling history; service location/period/instructions List | Read only linked own items; manage authorized recipient instructions; company administrators or individual owners nominate collection delegates through the owning workflow |
| Mail and parcels — location staff index | Location/status Select filters, queue Tabs and receipt Fieldset; Item Table with restricted physical-storage reference and incident Alert | Receive/match against current entitlement and recipient; record notification separately from physical collection |
| Collection detail — contextual permitted view | Recipient/delegate verification, instruction version, receipt/photo state and attributed collection evidence | Collect once only for the currently authorized recipient/delegate; expired service leaves existing items for explicit collection/return resolution |
| Forwarding/return — staff queue/detail | Snapshotted destination, carrier/evidence, recorded forwarding fee/currency and pending delivery Badge; handling history List | Forward, evidence dispatch, return or append corrections under current grants; invoice settlement cannot certify delivery |

On reception devices, place verification beside the intended action; stack mobile labels without exposing storage to recipients. Distinguish loading, no own items and filtered-empty queues. Preserve receipt/handling input after validation, stale dispatch or interrupted optional photo upload. Failed notices, lost-item incidents and uncertain forwarding remain visible for staff resolution. Retried collection, fees and dispatch retain their logical identity rather than duplicating handling. A changed contact cannot redirect a frozen dispatch, and expiry must not silently discard or return unresolved physical mail. Exclude technical retention/carrier/retry settings and opening/scanning contents.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Recipients may remember their own-item history/status view; staff may save an authorized location and queue filter. Clear/reset restores accessible defaults; discard revoked scopes. Personal settings cannot grant delegate rights, redirect forwarding, set service entitlement or change retention. Forwarding instructions and delegate nomination are explicit authorized business actions on the service/item views, rather than unchecked preference toggles.

## Interfaces and Integrations

Use D1, R2 for bounded receipt photos, and EmailService. CanMember or a configured service record owns the paid mail entitlement; CanCustomer owns customer/delegate identity. Declare unique same-currency fee charges to CanInvoice if enabled; a forwarded state requires dispatch evidence, not invoice settlement. A carrier adapter is optional; manual carrier evidence remains usable.

Retention, delivery retry defaults and carrier/provider wiring are developer maintenance. Staff/recipients manage actual item handling and their authorized forwarding instructions in ordinary pages, with no technical policy editor.

## Background Actions

Notify verified recipients after durable receipt and send bounded uncollected-item reminders under the configured policy. Re-check delegate/service state before new handling and retry delivery or forwarding work with stable identities. Expire permitted personal history without deleting unresolved physical-item records.

## Error Handling

Reject unauthorized delegate collection, conflicting receipt identities, mismatched recipient/location, invalid destinations, and stale dispatch actions. Retrying collection or fee creation cannot duplicate either. Show failed notification, lost-item incidents, and uncertain forwarding for staff resolution without pretending the item reached its destination.

## Scope and Completion

Enable only when the operator offers mail handling or virtual-office service. A customer can see an arrived parcel, nominate a permitted collector, and retrieve collection evidence; staff can forward another item once to its authorized snapshotted destination. No room booking is implied by a mail-service entitlement.

Frontend journey: the designated recipient opens an arrived parcel, the company administrator or individual owner nominates a permitted collector, and the recipient later reads collection evidence; staff verifies the current delegate before collection, and repeating the action does not create another receipt or fee.

Frontend journey: staff records forwarding to the frozen destination and sees uncertain delivery as pending even after billing settlement. A later contact edit leaves that destination intact; an expired service still offers explicit authorized resolution for existing items.

## Composition and Ownership

Optional distinct mail-handling app/package. Reuse customer identities, service entitlements, and billing rather than duplicating them. It is not required to deploy the short-rental booking flow.

## Authored draft completion

The source now declares staff service setup and availability review, current paid-service admission, recipient instruction updates with revision checks, verified delegate nomination, durable receipt/matching, actual EmailV1 acceptance outcomes, collection, frozen forwarding attempts, uncertain dispatch, evidenced dispatch/return, appended corrections, and same-source fee invoice recovery. My mail includes permitted handling evidence; the staff index retains private storage and photo fields. Instruction and dispatch forms bind the current business revision explicitly.

A membership-backed service references the actual exported `member_terms.Term`. New receipt, matching and forwarding require the purchased `Term.mail` benefit, its location and currency, and `eligible_term` at admission. This uses the provider's live paid, pause/revocation, current customer role and assigned-seat checks. No mail entitlement feed or automatic subscription is assumed. A configured standalone service instead requires staff-recorded paid evidence and an active period; a denied linked term cannot fall back to that evidence. Held items still support current verified recipient/delegate collection or staff-evidenced return after service expiry. Organization delegate grants require its administrator; an individual owner may grant delegates. Current verified customer identity is checked again at collection. The nominated Contact and account are explicit immutable Delegate identity fields; changing either requires a new delegation. Only active can be edited. The owning customer/contact containment remains invariant history even when verification, account linkage or archived status changes. New delegations default active and require a current unarchived verified Contact whose account matches the nomination, under an active unarchived customer. Reactivation uses the same eligibility check, while an authorized administrator/owner can deactivate a revoked nomination. Uniqueness is the historical Contact/account pair, permitting a replacement Contact nomination without editing the old relationship. Collection checks the exact saved contact/account, active delegation and current customer state, rather than accepting an unrelated later Contact with the same account. Receipt/matching/forwarding retain their existing active-location and paid-service gates; collection retains the explicit after-expiry custody-resolution policy.

`Dispatch` is an Item child with locked source, instruction version, destination, fee and complete optional `invoice.Charge`. Staff verifies the postal destination explicitly before preparing it. Manual carrier evidence is the supported initial transport path; no carrier lookup, automatic dispatch or postal-address validation API is claimed. Dispatch and uncertain-result forms act on the exact current attempt and revision. Successful dispatch appends immutable Handling with that snapshot; uncertainty leaves the physical state pending. Invoice completion/reconciliation correlates to the latest delivery and the same frozen billing source; fee results never change physical handling state. Billing recovery discards the preceding delivery correlation before requesting reconciliation, and a missing invoice reuses the identical Charge. Returning a pending attempt requires explicit no-dispatch evidence; commercial adjustments remain with the invoice owner.

A keyed reminder checks the still-uncollected item and current verified recipient, sends at most two reminders seven days apart by default, and does not require extending an expired service merely to collect held property. Duplicate/stale reminder numbers do no new work. Collection, forwarding preparation and return cancel further collection reminders. Notice enqueue state is pending; only a correlated successful EmailV1 completion marks a received item notified. Provider acceptance does not establish reading or physical collection, and failed/unknown notices remain visible.

Developer-maintained Item defaults set the reminder policy and `history_days=180`; no product operation edits these settings. Explicit collection, evidenced forwarding or return stores `retention_until=now+history_days*1d`, and `retain Item` applies that deadline to its contained Handling/Dispatch records, history and photo visibility. Unresolved items have a null deadline. Runtime retention must still implement expiry, reference-blocked disposal, replay metadata, outbox/content copies and attachment cleanup as specified in DESIGN §7.1; the declaration is not an erasure implementation.

Inline BDD tables, the shared-state sequence and their deferred JavaScript recipes cover instruction conflicts, delegate authorization, revocation without invalidating history, archived/unlinked contacts and verified identity, denied paid mail benefit, linked-term payment failure without standalone fallback, collection after expiry, repeated collection, invalid/unreviewed forwarding destinations, stale dispatch revisions, frozen destinations after edits, fee settlement while dispatch remains unknown, bounded/stale reminders, notice failures/correlation and explicit return retention. JavaScript syntax and table-only source parsing were checked; the initial parser does not yet accept the newly specified `examples`/`do` sequence. The full sequence was traced against DESIGN §5.1/§13 and GRAMMAR. No examples or application workflows execute because the compiler, semantic checker, stdlib, owner modules, UI, transports and example runner remain unimplemented.

The declared `deployment.mail` and `deployment.billing` bindings must be configured under the current integration contract. `Service.billing=false` suppresses fee sends; it does not invent an optional-binding or conditional-linkage facility. Receipt photos inherit the shared bounded file policy, and ordinary canonical forms/queries retain their shared upload, permission, loading, error and retry contracts.

The three freshly worded JEV consultations are retained in [mail-completion evidence](../design/jev/mail-completion-20261004/). They agree on live Term checks and a separate Dispatch model, with the original confidence/probabilities preserved. Their agreement is design advice, not proof of correctness.


## Authority correction evidence

The Delegate invariant now checks only `contact.parent==service.parent`. It does not depend on verification or current account linkage, so an unverified, archived or unlinked historical nominee is a valid stored setup. The current `delegate_eligible` decision is evaluated by CRUD admission and collection at the storage owner, without granting the caller new reads. The target carries the same Contact field/label, locked identity fields, historical uniqueness pair, create/update allowlists, current eligibility derive, bound parent query, protected UI parent binding and displayed nomination identity. The target remains handwritten desired output.

`nominee` and `unrelated` use the existing test-only user recipes and provision distinct ordinary accounts. The nominee Contact and Delegate share that real fixture identity. `members` still invokes self: the positive nomination row is authorized by the real seeded CanCustomer administrator grant, and the positive instruction row by the designated verified recipient. A revoked administrator grant, unverified nominee or unrelated signed-in account fails the appropriate owning guard with `rule_failed`; only public admission or a caller lacking `mail_staff` fails `by` with `forbidden`. No row uses `as=authenticated`, and ordinary membership is never treated as the absence of customer authority.

The collection rejection rows preserve valid historical Delegate state while changing domain verification, account linkage or customer activity. Archival is exercised through canonical Contact.delete in the sequence, rather than a forbidden reserved-metadata fixture selector. Deactivation of an already unverified nominee succeeds and retains one delegation record; attempted reactivation rejects. Separate tables avoid overlapping reference/field fixture selectors. The tables remain single-operation expectations. The sequence below specifies earlier authorized commits and their effect on later admission in one shared state; neither form has executed or proved runtime custody/privacy results. The frontend journey remains a completion requirement.

Focused verification is JavaScript syntax checking, table-only source parsing, sequence grammar tracing and manual source/target correspondence for these identity fields, invariants, locks, CRUD inputs/guards, collection predicates, UI bindings and test recipes. The same-source billing, physical forwarding evidence and paid-service decisions remain as authored. No new runtime, authentication surface, delivery recovery layer or optional-import mechanism is supplied by this correction.


## Shared-state custody journey

The `examples`/`do` sequence attached to receive admits each call separately with fixed real caller identities. A named mail operator has the declared mail_staff role and an Employee record granting work at test_site. The customer owner's existing test_admin grants self nomination/deactivation authority. The exported directory manager and employee fixtures supply the actual customer_manager and location authority for Contact.update/delete. No call changes caller roles, patches fixture state or directly invokes an email/queue handler.

The journey configures a reviewed standalone purchased service through the existing configure action, then records a new physical receipt against that live service. This is necessary because the shared paid_term snapshot deliberately has mail=false; the sequence cannot silently patch it into a paid-mail purchase. The independent membership-backed receipt/forwarding tables retain their paid, mail-benefit, location and currency denials without a manual-evidence fallback. The new Service/Item/Delegate are queried after their canonical creates instead of invented return values or copied fixture variants.

After nomination, the directory manager changes the nominated contact's email through canonical Contact.update. Its owning hook clears account and verification. The formerly eligible nominee's collection then returns the exact rule_failed guard outcome, leaving the received item, zero Handling records and null retention deadline intact. Self deactivates the nomination, and the directory manager archives its Contact through canonical deletion. A fresh Delegate query observes the same saved contact/account, inactive state and archived contact; the relationship remains valid history and confers no current eligibility.

Staff then ends the service through service_status. Fresh current-state checks establish inactive service, live=false and the original recipient still eligible for custody resolution. That recipient collects the held item through the same staff collect action, which appends one attributed Handling and the ordinary completion retention deadline. A newly queried repeated collection fails rule_failed without adding another Handling. Final observations retain the historical nomination and distinguish the original recipient from the revoked nominee. Fresh queries precede later mutations when earlier commits changed those records, preserving ordinary version admission.

This is an authored whole journey with desired target sequence metadata under the shared contract, not execution evidence. Email acceptance, timer delivery and UI serialization are outside these calls: notice remains pending and immutable privacy policies remain the authority for recipient-only item/history reads and staff-only storage/photo fields. The sequence supplies no new read grant. Carrier forwarding and notice-retry behavior are not expanded by this custody/authority correction.


The notice transport association is `delivery(Mail.send)?`; its read-only `notice_state` projection preserves the existing recipient status-only grant and Notification caption without exposing the receipt, result or safe error. Null means no notice request. Status updates do not write the Item or change its version. The only completion reaction retained is received→notified after a successful, non-null completion whose ID matches the current association; late attempts and already collected items retain custody state. Result/error retention may expire without erasing the associated receipt's status or manufacturing a retry.

Two typed isolated notice recipes replace five repeated request declarations: `attempt` varies its initial envelope, and a distinct default-pending `pending_notice` retains the different current identity needed for superseded-completion correlation. They preserve complete frozen requests and every pending/succeeded/failed/unknown/skipped observation. Completion tables cover current success, a different pending current attempt, no association, uncertain/failed/skipped delivery and already collected custody. These are setup snapshots plus explicit handler calls, not proof that a provider sent mail. The actual custody sequence observes its newly enqueued pending receipt through the canonical lookup in the desired JavaScript. The new delivery type and provisioning remain proposed compiler/runtime behavior.

The recipient grant explicitly permits only notification.status as the readable dependency of notice_state, leaving receipt identity/result/error private. The single desired delivery observation uses the owning record, declared field and static selected properties; denial is withheld rather than null. Enum-derived status captions reuse the field label contract. These small contract additions preserve the previous status-only recipient experience and cannot be inferred from test-inspection reads.


Initial whole status/result/error selectors are validated together before receipt provisioning; no ID, principal, target or request is editable. The seven completion rows retain independent expectations and typed verified event envelopes. Their event and initial-recipe status/result/error cells still repeat the same envelope explicitly; this reduction adds no structural fixture constructor or event derivation syntax. Current success, different current pending ID, null association, failed/unknown/skipped delivery and collected custody remain distinct.

Normalization alone changes Can source from 38,700 to 38,382 UTF-8 bytes (318 bytes fewer). All 47 table expectations and the actual custody sequence remain unchanged, with production Can/JavaScript byte-preservation and source/target table correspondence checks. Node syntax and descriptor dependency/direct-selector closure checks pass. The structural parser projection substitutes the settled delivery type, omits the sequence and reduces only the unsupported derived enum-label record to its scalar caption; it does not validate those proposed semantics. No provider, fixture planner, custody runner or privacy enforcement executed.

## C3 dependency application (A05)

Mail imports the invoice interface as one grouped bound import (`CanMail.can:8`): `use invoice {BillingV1 as Billing,Charge} from=deployment.billing`. Under DESIGN §1 this resolves only the versioned `invoice.BillingV1` interface and its reachable value types through `deployment.billing`; Mail's direct executable edge to the invoice package is gone. Customer's plain production import (`use invoice {finance}`) still includes the invoice executable package, so this application makes no deployment-key reduction. `deployment.mail` and `deployment.billing` stay required bindings. `Service.billing=false` and `Service.term=null` do not alter deployment requirements. The desired-JS counterpart imports `Charge` from `./deployment.billing.mjs` (`CanMail.mjs:42`, CanRent convention); the `mailroom.Billing` binding descriptor is unchanged.

Import:

- Given the Customer package imports `invoice {finance}` as a plain production import, when deployment resolves Customer, then the invoice executable package is included and `finance` keeps its actual role, employee/location checks and attributed decisions.
- Given Mail uses the grouped bound import, when deployment resolves Mail, then only the versioned `invoice.BillingV1` interface and its reachable value types resolve through `deployment.billing`.

Visibility (existing grants only):

- Given a prepared `Dispatch` with any `charge_state`, when mail staff opens the staff index, then the frozen destination, fee, `charge_state` and invoice reference remain visible (`CanMail.can:45,333`); custody, notice outcome and fee-invoice outcome stay separate.
- Given the same dispatch, when the verified recipient opens My mail, then no fee, charge or provider payload is exposed (`CanMail.can:42`); the recipient sees only its existing safe notice-state projection.

Entitlement (manual versus automatic fees; `derive fee_charge`, `CanMail.can:34`):

| service.billing | fee | frozen Charge | Billing.charge send |
| --- | --- | --- | --- |
| false | money(5,"EUR") | none | none |
| true | money(5,"EUR") | frozen, source `mail-forward-{item}` | one send, `charge_state=pending` |
| true | money(0,"EUR") | none | none |
| true | null | none | none |

- Given `billing=false`, when staff prepares forwarding with a positive fee, then a manual handling fee is recorded without an invoice request and `charge_state` stays `none`; `deployment.billing` remains a required binding.
- Given `billing=true` with `term=null` and reviewed nonblank paid evidence, when staff prepares forwarding with a positive same-currency fee, then the identical frozen Charge is created; a denied linked term still cannot fall back to manual paid evidence.

Deactivation preserving pending/unknown fee and physical state:

- Given a `forward_pending` dispatch with `charge_state` in {pending, unknown, failed}, when staff runs `service_status` with `active=false`, then the service becomes inactive and `live=false`, while the dispatch keeps its state, frozen fee/charge and `charge_state`; held items stay available for explicit collection/return resolution.
- Given the same deactivated service, when staff runs `retry_fee` on a dispatch with `charge_state` in {failed, unknown}, then reconciliation reuses the original frozen source (`CanMail.can:250-254`); provider failure never mints a fresh logical charge.

Confirmation of a prepared dispatch after deactivation:

- Given a `forward_pending` dispatch on a deactivated service, when staff runs `dispatched` with the current revision, carrier and evidence, then the item becomes `forwarded` with immutable Handling carrying the frozen snapshot (`CanMail.can:210-215` requires no `live(service)` check); the outcome is independent of `charge_state`.
- Given `charge_state=failed` on that dispatch, when staff records dispatch evidence, then physical dispatch is still recorded: billing failed/unknown/pending never prevents recording actual dispatch evidence, and billing settlement cannot prove physical dispatch.
