# CanCustomer requirements

Inherits [canlang requirements](../REQUIREMENTS.md), [workspace operator context](WORKSPACE_OPERATOR.md), and [portfolio composition](PORTFOLIO.md). Companion draft: [CanCustomer.can](CanCustomer.can).

## Purpose and Adoption Goal

Provide the workspace operator's customer identity and company-administration package. Adoption depends on a company being able to manage its people and billing contacts without duplicating its account across sales, membership, booking, and finance.

## Users and Permissions

Authorized customer administrators invite and remove people in their own customer organization and grant the explicitly defined administrator, booker, or billing-contact roles. Billing contacts read only the organization billing records granted by finance; a booker can book on behalf of permitted colleagues without reading invoices by default. Operator customer managers handle individual/company account maintenance under location and functional scope. Neither role is an operator employee invitation or a membership purchase.

## Data and Ownership

Own the canonical individual customer, customer organization, contact, verified account/contact link, organization role grant, expiring invitation, billing profile, and attributed merge/alias history. Separate contact information from an authenticated identity. Store active/archived state, applicable service locations, and externally referenced IDs. CanMember owns paid seats/benefits; CanInvoice snapshots the applicable billing profile at issuance. Historical snapshots are not overwritten when a company changes address.

## Workflows and Business Rules

A currently verified company administrator invites a person with explicit role and scope; accepting consumes the invitation once and cannot infer authority from a matching email domain. Freeze the inviter, addressed email, role, location scope and expiry. Acceptance rechecks that the inviter still holds administrator authority at every invited location and that those locations still belong to the customer; removal or scope revocation makes an outstanding invitation inadmissible without changing historical accepted grants. Prevent removal of the last active company administrator without an authorized operator recovery action and retained reason. Membership-seat assignment is a separate authorized operation at CanMember; inviting an administrator does not consume or grant a paid seat unless explicitly requested.

Removing an organization role immediately revokes its organization read/action permissions. Reconcile dependent seats, future organization bookings, and visitor-host permissions with visible pending/conflict outcomes; do not silently cancel a paid reservation or erase the person's independently owned account. A stale invitation or booking action after removal must fail current authorization. Resolve duplicate contacts/companies through authorized reviewed aliases, never automatic email-name matching; preserve financial and booking references and do not transfer roles during a merge.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Customers (`/customers`) for scoped operator managers and Invitations (`/company-invitations`) for authenticated invitees. Company people (`/companies/{Customer.id}`) opens for the selected own company; contact/duplicate/billing details stay contextual. Use daisyUI; protected company administration remains separate from own-user settings.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Customers and contacts | Search Input, individual/company and active/location filters, Table/List and identity Card; contact/account relationship and billing-profile Fieldsets. Intake forms keep `import=csv`/`review=` and gain `input` name/email/phone/external_id, `radio` kind and `textarea` address/reason controls; identity card shows `status` active and `badge` kind; alias/recover are explicit row-bound forms with `textarea` reason; contact rows show `status` verified, billing rows `status` on_account. | Scoped operator maintenance searches, edits, archives and exports authorized records; distinguish contact email from a verified account. Individual customers require no company account. |
| Company people | Own-company heading; role/location Table and invitation Fieldset; invitation status Badge and expiry text; separate owner-review explanation and membership-seat destinations. The invite form groups email/role in a `fieldset` captioned by the shared invitation message; grant rows show `badge` role, `status` active and a direct remove `button`; invitation rows show `badge` status; the reconciliation note is a `collapse` with its caption preserved. | Verified company administrators invite/remove and manage explicit administrator/booker/billing grants only within their company/scope. Existing operations enforce last-administrator protection. Paid seats call CanMember separately. |
| Invitations | Addressed invitation Cards with company, role, scope, expiry and accept Button; own contact/account claim summary. Claim/accept are direct `button action=` controls on arg-complete operations; contact rows show `status` verified. | Current verified invitees claim/accept only eligible addressed records once. Matching email domains never grant authority; stale invitations fail current checks. |
| Duplicate and billing context | Reviewed duplicate Table with proposed alias, affected references and reason Fieldset; authorized billing-contact/profile Card and historical-reference List. Finance approval rows show `status` on_account and an explicit `approve_account` form (`checkbox` approve + `textarea` reason, locations keep the generated control). | Canonical reviewed aliases preserve financial/booking references and never transfer roles. Billing visibility follows its own grants; operator recovery requires authority and a retained reason. |

Show invitation acceptance independently from seat/booking/reception reconciliation. Removal immediately removes local access while pending/conflict dependent outcomes remain visible; never imply that a paid reservation was cancelled. Empty states offer only authorized actions. Pending mutations prevent repetition; stale role or last-administrator conflicts retain the intended edit and explain the server outcome. Preserve unsaved fields after validation failures. On mobile stack people and invitation Cards, keeping role, scope and expiry visible; keep other-company records and ungranted billing content out of both views and downloads. No countdown is authored for invitation expiry (a datetime, not a remaining duration).

## Personal Configuration

Inherit the shared own-user dialog and base settings. Remember authorized directory filters and people-list density. Roles, colleagues' contacts, billing profiles, seats and reconciliation are business-page content; none belongs in personal configuration. No general settings console is required.

## Admin and Management Surfaces

End-user admin is required for company access administration. A verified company administrator must invite/remove colleagues and assign company booker/billing roles without granting operator staff access. Ordinary customers cannot manage someone else's organization authority.

Provide an own-company people/invitation/role view for the verified company administrator. Operator customer maintenance remains ordinary customer-management work. Seat controls call CanMember's permitted operation; this role cannot change prices, paid evidence, or another company. See [end-user administration scope](ADMIN_SURFACES.md).

## Interfaces and Integrations

Use D1 and shared verified authentication. The composed customer/sales app owns these records once; CRM, account follow-up, proposals, booking, and invoicing reference them rather than creating another customer directory. Standalone apps use a configured scoped reference/role lookup capability. Organization-role reads identify operator, organization, user, action, and revision and return allowed/denied/unavailable with no implicit staff privilege.

## Background Actions

Expire invitations and persist organization-role changes before notices or downstream reconciliation. Retry seat/reception/booking reconciliation with the same removal or assignment identity. A notice accepted by email delivery is not proof of invitation acceptance.

## Error Handling

Reject cross-organization role edits, unverified account impersonation, stale invitations, unauthorized merges, and references outside the caller's scope. A downstream failure leaves local revocation effective and dependent actions visibly pending; it cannot silently restore access. Conflicting contact/source identities require staff review.

## Scope and Completion

A company administrator can invite two colleagues, give one billing access, assign available paid seats through CanMember, and remove a colleague without exposing another company or losing historical invoices. Retried invitations/removals preserve one result. Individual customers can book without a company account. Operator employee identities remain owned by the people context.

Frontend completion additionally requires these journeys:

- A verified company administrator invites colleagues with distinct billing/booker scope, sees invitation acceptance separately from CanMember seat assignment, and cannot grant operator staff access or inspect another company.
- Removing a colleague revokes local access immediately while visible reconciliation remains pending/conflicted; a stale action fails, historical invoices remain, and removing the last active administrator requires the documented recovery boundary.

## Composition and Ownership

This is the canonical customer package in the customer/sales composition, alongside CanCRM, CanBook, CanPropose, and CanSuccess. It can supply a small standalone customer-administration interface where necessary, but adding this requirement does not mandate a new directory deployment for every app.


The directory exports Alias, CompanyRole and Invitation and its existing claim/invite/accept/remove/recover/alias operations so CRM can present canonical customer resolution and account controls. Their original customer-manager, verified-email, company-administrator, location and last-administrator guards remain intact. A CRM salesperson grant confers no customer-management or company-administrator authority. Alias evidence keeps both old and canonical identities without rewriting documents, contacts or company roles; inline examples cover authorized review, self-alias and blank-reason rejection, unauthorized callers and repeated mappings. The duplicate-company fixture represents a distinct directory identity required by this review operation. Exported visibility is not an additional read/write grant or an implementation.

Finance eligibility is owned by BillingProfile and changed only through exported `approve_account`, guarded by the actual exported invoice.finance role and active employee location scope. Approval freezes an explicit nonempty location set; later customer-location additions do not expand it. Replacing or revoking a grant also requires authority over its previous locations. Customer managers cannot edit the approval through ordinary CRUD. Decision reason/account/time remain attributable; approval does not mean payment or membership. The Billing approvals page is derived navigation under its own finance guard. New fulfillment must check active customer, current approval and the specific approved location; revocation does not rewrite already accepted debts.

Customer/contact CSV intake is authored on existing forms with schema-derived `import=csv` and exported `duplicate_customers`/`duplicate_contacts` reads. Matching is review evidence, never automatic aliasing or merging. New candidates discovered after a prior imported row commits return the later row for explicit review. Owner operations retain customer_manager/location guards. The form attributes still exceed this syntax prototype: full-file parsing currently rejects `import=csv`, while the supported business declarations and isolated table examples can be parsed as a projection. Neither check establishes semantic validation or operation execution.

### Access invalidation coverage

`CompanyAccessChanged.account=null` invalidates all live access watches for the named customer. Committed customer/contact/company-role create, update and archive changes trigger a current-state recomputation, including recovery, scope edits and identity changes. The event revision identifies its source observation; it is not a single counter across unrelated models. Consumers re-read current authority and publish their own ordered eligibility evidence. Entitlement consumers additionally reject inactive or archived customers; identity-role predicates retain their existing meanings so billing/history access is not silently removed. Record history and billing evidence remain subject to their separate read grants.

### Invitation authority correspondence

The frozen Invitation now retains `invited_by`; `invite` requires the caller's verified-email fact and existing scoped company-administrator grant. `accept` rechecks the original inviter's current company/location authority before creating/reactivating the addressed grant. Five authored cases cover accepted once, removed issuer, already consumed, exact expiry and revoked scope. Stored historical invitations do not acquire a dynamic role invariant, so later revocation cannot invalidate their evidence. Syntax parsing alone does not execute those cases. Owner-local seat/allowance and visitor/credential review below carries the subsequent cross-owner outcomes; invitation admission remains separate from those outcomes.

### Contact-email identity correspondence

Changing a contact email through canonical Contact.update clears the previous account and verified flag in its pre-commit hook. Editing a name or phone preserves identity; the new email requires a fresh claim by its own verified account. Existing historical delegation records retain their nominated contact/account identity and their use checks current verification. The attached claim sequence first edits name/phone without clearing proof, then uses the actual directory-operator email update, observes revoked proof and rejects the previous account at the addressed-email business guard (`rule_failed`); ordinary viewer reads separately hide that unclaimed contact; it never edits test state between calls. The exported named directory-operator fixtures are test-only and confer no production access.

The authored sequence uses the settled examples/do extension; the initial parser and runtime runner do not implement it. The existing CSV form attributes also remain outside prototype parsing. Source/contract correspondence is inspected, not executed.


### Current company access review and owner recovery

The access requirement is immediate revocation of the company grant plus visible, recoverable downstream business outcomes, with paid commitments and independent accounts preserved. The draft's former `Reconciliation(pending)` record had no business writer or completion path. It is removed: receipt of `CompanyAccessChanged` cannot truthfully establish seat reconciliation, physical revocation, or booking cancellation.

Customer's company page explains the independent Membership access review and Reception access review destinations. Those actual owners declare their own discoverable pages and customer-record pages; no copied accounts, private visitor/key tables, global applied flag, or central coordinator is introduced. Their explicit authority reports disclose only current counts at one customer/location. A current administrator must still hold that location grant; a scoped owner operator retains the owner's functional and location guards. Customer alone does not report an absent owner's status. CustomerSales remains unchanged; existing Workspace selects Member but not Reception. A product requiring the combined journey must explicitly select the actual `customer`, `member_terms` and `reception` packages/apps and their configured interfaces. Conditional optional imports or foreign-route mounting are a separate composition boundary, not implemented by this correction.

Membership distinguishes active seats needing an explicit decision, current future allowance requests requiring review, pending differences between current eligibility and recorded review evidence, and recorded conflicts. Reception distinguishes current host admission conflicts, pending admission evidence, on-site review, revoke work not yet applied, and actual pending/failed/unknown/still-active conflict/confirmed revocations. Report unavailability or a bounded-read failure cannot become zero work or successful reconciliation. Individual seat release, device retry/reconcile/manual revocation and physical departure retain their canonical owner operations and grants. Customer administrators receive the safe reports, not raw visitor, identity-check, credential or device data.

Removal replay retains the original operation identity and current-state events. An authorized owner `recheck_access(customer,location)` starts the existing cursor work again without reactivating or repeating the removed grant. Its receipt means work was queued. Membership's durable request review evidence and Reception's durable visit/device outcomes establish what actually remains unresolved; no event-delivery acknowledgement marks them complete. Later restored identity/scope can clear a stale membership review reason only after rechecking all allocations of that finite request. Paid terms, invoices, reservation money/units and arrived/departed history remain evidence.

Manual correspondence: `customer.remove` deactivates the exact grant; the committed owner event and explicit invalidation reach `member_terms.company_changed` and `reception.customer_changed`. Both read current authority. Membership walks memberships, future allocations and access watches; Reception walks active visits and retained issues. Current admission guards reject revoked identity/location rights before any asynchronous scan completes. Rent's existing confirmed-arrival operation separately rechecks scoped reception, fulfilled payment/consumed allowance, current customer/resource and credit/financial coverage. A removed booker grant does not silently cancel an independently paid reservation or rewrite consumed financial commitments; affected future membership allowance use receives explicit owner review.

Syntax verification parses the supported declarations and all table examples after omitting attached sequence bodies and existing CSV form attributes. Full parsing still rejects the settled examples/do extension; Customer's CSV form attributes also exceed the initial parser. These are source contracts and manual owner traces, not executed reconciliation. There are no existing matching generated MJS files for these three owners; none are added.

Invitation expiry scheduling belongs to `invite` beside its sole Invitation creation, committing with the invitation and its outbound intent. It does not depend on an unavailable Invitation CRUD hook; acceptance still rechecks expiry and current inviter authority.

### C3 dependency witness (A05)

Customer keeps its plain production import `use invoice {finance}` (`CanCustomer.can:11`): under DESIGN §1 the invoice executable package is included and `finance` keeps its actual role, employee/location checks and attributed decisions. The finance-guarded Billing approvals page (`CanCustomer.can:248-252`) is untouched; the canonical `invoice.finance` role is not copied, relocated or renamed. No deployment-key reduction follows from Mail's grouped bound import while this import stands.
