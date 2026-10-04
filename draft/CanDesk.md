# CanDesk requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanDesk.can](CanDesk.can).

## Purpose and Adoption Goal

Help reception and support teams handle booking changes, billing questions, Wi-Fi problems, and member service requests across workspace locations. Adoption depends on one readable customer conversation and a clear responsible queue.

## Users and Permissions

Support staff manage tickets only at locations where `can_work` permits them. Assignees must be active staff authorized for that location. Verified authenticated customers can open and respond to their own private conversation; this does not grant staff routing, private-note or related-record access.

## Data and Ownership

Ticket stores team, subject, customer email, assignee, status, and an opaque reply-thread token. Messages store staff/customer authorship, immutable body/address snapshots, receipt time, external message identity, and the outbound-delivery association; the displayed delivery state is a read-only receipt observation, never a stored copy. Customer messages cannot be modeled solely as member-authored replies.

Record location, request category, priority, assigned queue/member, and optional customer, booking, membership, or invoice references. Private staff notes are separate from customer-visible replies. Support bounded authorized attachments whose versions and send recipients remain recorded.

Reference canonical CanCustomer contact/organization identities and role grants for authenticated customer views. Customer email snapshots identify the conversation recipient but do not grant company billing or booking administration.

## Workflows and Business Rules

Accept a new support email or staff-created ticket. Correlate incoming replies to the ticket's thread token and deduplicate external message IDs. Staff responses append to the same conversation and send email. A customer reply reopens a resolved ticket. Mail content cannot change permissions, assignee, or administrative state.

Staff triage unassigned tickets, record escalation, and distinguish waiting_on_customer from resolved. An optional response deadline is a fixed instant; an unresolved ticket becomes overdue strictly after it, including while waiting on the customer. Resolving removes it from the overdue queue without clearing the deadline. Explicit escalation requires an unresolved ticket, nonempty responsible queue and reason, records the staff actor/time and sets urgent priority. It does not extend the deadline or close the conversation. Linking a customer record requires authorized access and cannot expose it through email. A ticket request does not itself cancel a booking, refund money, or grant building access.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Support (`/support`) for authorized staff and My support requests (`/support/mine`) for authenticated customers. Conversations, unmatched-mail triage and related-work details stay contextual. Use daisyUI; distinguish customer messages from private notes.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Support queue | Search Input and status/assignee/unassigned/overdue/priority/category/location Select filters; Table/List with subject, customer, queue, priority and state Badges; ticket Fieldset. Rows show `badge` state/priority and `status` overdue/unassigned; the request card is structured by uncaptioned `divider`s and a gated escalation `alert`; edit/intake/triage/escalate/handoff forms carry `input`/`textarea`/`radio`/`file_input` controls (due keeps its generated datetime control). | Create/edit permitted tickets, assign/escalate, and distinguish waiting_on_customer from resolved through existing record operations. |
| Conversation | Chronological `chat_bubble` messages (header: kind badge + sender/recipient/time; content: paragraph body + attachment links; footer: delivery-state badge + author); reply Fieldset and separately marked internal-note Card. | Existing reply/note operations preserve message identity and recipients. Attachment downloads follow authorization; private notes never appear in customer mail or own-ticket views. |
| Unmatched mail and related work | Unmatched sender/subject/receipt Table with focused triage Fieldset; permitted customer/booking/membership/invoice reference Cards and repair handoff link. The triage group is a `collapse`; the triage form places `input` category/queue/subject. | Authorized staff resolve unknown threads; sender-supplied ticket IDs confer no access. Declared maintenance handoff retains ticket and returned repair reference. |
| My support requests | Own-ticket List and conversation `chat_bubble` messages (same header/content composition with a badge-only footer; policy excludes notes and the author, so no kind predicate is authored) with customer-visible messages, attachments, status and authorized reply entry. | Verified/scoped customer access reads only permitted conversations; email identity alone grants no organization billing/booking authority. A customer reply reopens a resolved ticket. |

Show queued, sent, failed, uncertain and skipped delivery beside each message rather than as one ticket-wide success label; a message with no associated delivery shows the standard not-requested state. During asynchronous send, retain composed text and pending message identity; timeout must not invite a new duplicate send. Incoming repeated delivery updates one conversation entry. Distinguish empty filtered, unassigned and own-request queues. Preserve unsaved reply/note text after errors and confirm discard, always keeping its audience visible. On mobile stack queue rows and message metadata, with attachment and delivery controls reachable. Related records remain separate operations: a service request or email cannot implicitly refund money, cancel a booking or grant access. No countdown is authored for the response deadline (a datetime, not a remaining duration). File-array inputs keep generated controls; only the single nullable handoff photo uses `file_input`.

## Personal Configuration

Inherit shared base settings in the own-user dialog. Remember authorized queue filters and a compact/comfortable conversation presentation. Preferences never change recipients, note privacy, assignment, routing or permissions. No support admin/technical mail-configuration tab is required.

## Interfaces and Integrations

Use D1 for tickets/messages and the bound `std.EmailV1` contract for outbound mail and a configured incoming support address. Route managed inbound email to a declared intake handler; validate payload limits and treat sender content as untrusted. Reply routing identifies a ticket without granting access to other tickets.

Declare maintenance handoff and booking/billing lookup capabilities where installed. A handoff retains the original ticket and returned repair reference.

## Background Actions

Durably record messages and pending delivery before dispatch. Bounded retries preserve message identity and the original recipient. Incoming replies update the conversation without duplicating messages; delivery outcomes are observed from the retained receipt without rewriting the message.

## Error Handling

Show queued/sent/failed/uncertain/skipped delivery per message. A timeout is uncertain delivery, not permission to repeatedly send a new message. Unknown reply threads enter a staff review queue; they cannot be attached to arbitrary ticket IDs supplied by the sender.

## Scope and Completion

Complete when a customer can initiate and reply to a support conversation, staff can respond, duplicate email delivery adds no duplicate message, and a customer reply reopens a resolved ticket.

Reception can handle a member's Wi-Fi report, record a private staff note, route a repair, and send a customer reply without leaking that note or changing the booking implicitly.

Frontend completion additionally requires these journeys:

- Reception opens a Wi-Fi request, records a clearly private note, performs the declared repair handoff and sends a customer reply with visible delivery state; the customer sees no private note.
- A customer's reply reopens a resolved ticket once despite duplicate inbound delivery; an uncertain outbound send retains its original message identity and an unknown thread reaches staff review.

## Composition and Ownership

Recommended placement: Distinct support module. Own customer conversations and private internal notes, referencing CanCustomer accounts. Link facilities jobs without exposing notes or granting repair/booking/billing mutations through mail content. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Private browser intake and reply draft

The exported canonical `open_request` creates a real private ticket and its first customer message. It requires a verified account, an active location, nonempty content/category and a bounded contribution count. Optional `client` association checks current ownership/company authority and location membership; merely supplying a Customer ID grants no rights. It snapshots the submitting account's verified email, uses the Reception queue and records an opaque thread identity. CanFeedback can display this operation's generated form instead of posting urgent/private details to its public suggestion board.

`respond` appends only to the verified account's own conversation and reopens it. It cannot change assignee, queue, priority, private notes or related business records. Browser-origin messages have no email recipient until an actual email is sent; their nullable recipient records that fact instead of inventing an inbox address. File attachments still pass normal finalization and attachment authorization. Source intake/reply effects are authored, not executed.

### Completed authored workflow draft

Replies send `Message.attachments` through the same bound mail operation that freezes the recipient and immutable finalized file versions in its outbox, and associate the resulting typed delivery with the reply. Files are never silently omitted to meet a transport limit; the provider rejects an oversized aggregate. The reply's displayed state derives from that receipt, so definitely failed, uncertain, skipped and sent remain distinct outcomes without a receipt-copy callback, and receipt progress never rewrites the message. The shared bounded transport retry keeps the original delivery, and no app retry operation creates another message after uncertainty. Authorized staff and customer views keep their existing message fields; customers gain only the status leaf the derived state needs, never receipt identity, result or error.

Inbound replay checks retained Message and Unmatched identities in the same owner transaction and succeeds without repeating effects. Matching requires both the opaque thread and sender address; a new customer message reopens once. An unknown or mismatching sender remains in staff review with its original thread, addresses, content, files and receipt time. Inbox ingestion must use the existing verified-source receiving-app finalization contract for incoming files; no untrusted file ID or sender-supplied ticket identity grants attachment or conversation authority. Triage creates a new location-scoped ticket and its first message, copies those attachments, records the resolved ticket/staff/time, and removes that retained row from pending review. Blank email subjects can be corrected in the canonical triage form. Already represented external mail cannot be triaged into another conversation.

Ticket has optional typed Customer, Booking, Membership and Invoice references. Canonical authorized reference inputs and owning read grants apply; importing a model never grants support staff billing, company or booking access. The support page displays the permitted reference identity. Target details remain withheld unless the viewer has that owner's current read grants, and own-customer conversation fields exclude all these references. Links never invoke cancellations, refunds or access changes.

Maintenance handoff requires an unresolved, unlinked ticket, support location authority and an asset at the same location. It calls the exported canonical `maintain.report` with the current actor, ticket subject and an explicit description/photo, then stores its returned Repair without deleting or closing the Ticket. The provider retains its exact authenticated, verified-email, active-asset and nonempty-content checks. The support caller becomes that repair's reporter and receives the existing limited own-report grant; the ticket customer acquires no repair access. Private notes are not automatically forwarded. Manager assignment, downtime and verification remain Maintenance operations with their original roles.

Inline examples author intake, own-reply reopening, attachment retention/rejection, private-note rejection, sender mismatch, repeated matched/unmatched mail, triage retention/rejection, handoff, deadline boundaries, escalation and associated delivery observations: a new reply observes pending, while a seeded association observes pending/succeeded/failed/uncertain/skipped or a truthful null without affecting the reply. The prototype parser rejects the settled `delivery(Mail.send)?` field type and the structured per-value caption on the derived state; a disclosed temporary projection substituting only that type with `text?` and that caption with its scalar form accepts the surrounding declarations, leaf selectors and all fourteen tables, which checks syntax only. These examples, typed permissions, mail adapters, file finalization and UI rendering have not been executed. CanDesk has no handwritten JavaScript target in the current 21-target corpus. The provider's narrow Asset/report export and Repair-return change is mirrored in CanMaintain's proposed target.

Assignment eligibility is checked by Ticket CRUD admission and the escalation operation when routing is written. It is not a historical invariant on every later reply: deactivating an assignee cannot make an existing customer conversation impossible to reopen. Current support scope and any new assignee still require their own current workplace authority.
