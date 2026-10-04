# End-user administration scope

This refines the [workspace operator requirements](WORKSPACE_OPERATOR.md) and [portfolio composition](PORTFOLIO.md). Administration means a concrete business end-user responsibility, not developer setup or a label for every privileged operation. Each requirement was assessed independently from its purpose and audience; no example app is a comparison baseline.

## Only the justified end-user admin sides

End-user administration is required in the following six modules. The view belongs to the existing app/composition and can be a page, tab or focused queue; no paired admin application or mandatory full admin console is required. Loyalty and marketplace administration exist only when those optional products are offered.

| Module | End-user responsibility | Independent business justification |
| --- | --- | --- |
| [CanCustomer](CanCustomer.md) | Company access administration | A verified company administrator must invite/remove colleagues and assign company booker/billing roles without granting operator staff access. Ordinary customers cannot manage someone else's organization authority. |
| [CanMember](CanMember.md) | Membership plans and entitlement administration | An operator membership administrator must maintain shared sellable plans, paid-seat limits and included benefits that apply to member accounts. Members and content editors cannot change the rules of their own paid entitlement. |
| [CanRent](CanRent.md) | Published workspace catalog and booking-policy administration | The operator must control the prices, capacities, hours and booking policies offered to all customers. A customer or reception booker cannot grant themselves cheaper prices, extra capacity or broader access. |
| [CanLoyalty](CanLoyalty.md) | Published reward-program administration, only when loyalty is offered | The operator's program owner must set the shared rewards, tier thresholds and earning/redemption terms offered to customers. A participant cannot set the cost or rules of their own reward. |
| [CanFeedback](CanFeedback.md) | Moderation and operator roadmap authority | Contributors must not moderate other people's suggestions or claim that the operator has committed to a roadmap item. Designated moderators/product owners need that explicitly separate end-user authority. |
| [CanTrade](CanTrade.md) | Marketplace moderation, only when the marketplace is offered | Authors control their own listings, while designated moderators must handle reports and remove abusive listings belonging to other authors. |

## Ordinary workflows needing no added admin side

The following 33 modules have no app-specific admin side in this scope. Their existing actor/record permissions still apply. A dispatcher, reviewer, instructor, event organizer or finance user performing the core job does not need an additional administration area. Staff and customer views may differ without either being an admin console.

| Module | Why the normal product interface is sufficient |
| --- | --- |
| [CanAffiliate](CanAffiliate.md) | Partner agreements, commissions and settlement review are the partner/finance users' core work. |
| [CanApprove](CanApprove.md) | Assignment and document decisions are coordinator/reviewer workflows. |
| [CanBoard](CanBoard.md) | Agenda preparation, recording and amendments are the meeting users' core work. |
| [CanBook](CanBook.md) | Host availability and appointments are ordinary calendar work. |
| [CanCRM](CanCRM.md) | Sales records, assignments and follow-ups are the sales users' core work. |
| [CanCatch](CanCatch.md) | Issue triage is the product UI; project provisioning, keys, quotas and retention are developer-maintained. |
| [CanCheck](CanCheck.md) | Health/history and pause/resume are normal monitoring operations; provisioning and technical settings are developer-maintained. |
| [CanContract](CanContract.md) | Agreement terms, obligations and amendments are ordinary contract records. |
| [CanDesk](CanDesk.md) | Ticket triage, replies and assignment are support work. |
| [CanDo](CanDo.md) | Task and checklist work uses existing member scope. |
| [CanEvent](CanEvent.md) | Event creation/publication, registration and admission are organizer/reception workflows. |
| [CanExpense](CanExpense.md) | Claim review and reimbursement are employee/reviewer/finance workflows. |
| [CanField](CanField.md) | Dispatch and visit reports are dispatcher/technician workflows. |
| [CanGrant](CanGrant.md) | Program intake, award review and budgets are coordinator/reviewer work. |
| [CanHire](CanHire.md) | Vacancy publishing, interviews and hiring decisions are recruiter work. |
| [CanInvoice](CanInvoice.md) | Invoice issuance, credits and collection review are finance work; technical retry/provider policy is developer-maintained. |
| [CanLearn](CanLearn.md) | Course creation/publication and enrollment are instructor work; learning is the learner workflow. |
| [CanLeave](CanLeave.md) | Allowances and requests are HR/approver/employee work. |
| [CanMail](CanMail.md) | Receipt, collection delegates and forwarding are ordinary mail-service work. |
| [CanMaintain](CanMaintain.md) | Assets, inspections, repairs and verification are facilities work. |
| [CanOnboard](CanOnboard.md) | Employee records and readiness checklists are HR/employee work. |
| [CanPropose](CanPropose.md) | Offer creation and acceptance are sales/recipient workflows. |
| [CanPurchase](CanPurchase.md) | Suppliers, budgets, orders and receipts are procurement/approver work. |
| [CanReception](CanReception.md) | Guest admission and physical key/card handling are reception/access-staff workflows. |
| [CanRefer](CanRefer.md) | Referral-program terms and manual settlement are marketing/finance users' core work. |
| [CanReport](CanReport.md) | Reports and exports are scoped reads; definitions and sources are developer-maintained. |
| [CanShift](CanShift.md) | Coverage, roster publication and swaps are scheduling/employee work. |
| [CanStats](CanStats.md) | Traffic/goal reports are the product UI; tracker provisioning, keys and quotas are developer-maintained. |
| [CanStock](CanStock.md) | SKU/reorder thresholds, receipts and transfers are ordinary stock work. |
| [CanSuccess](CanSuccess.md) | Account milestones and renewal follow-ups are account-manager work. |
| [CanTable](CanTable.md) | Table definitions, reservations and seating are café work. |
| [CanTime](CanTime.md) | Project rates, time review and corrections are project-manager/employee work. |
| [CanVolunteer](CanVolunteer.md) | Opportunity publication, confirmation and attendance are organizer/volunteer work. |

## Developer maintenance stays outside the product UI

Developers perform technical setup and maintenance through deployment configuration and controlled maintenance under the [canonical writer fence and old-work rules](../DESIGN.md#113-maintenance-application-and-old-work). A privileged database credential is not an unfenced write path: ordinary data changes use the owning operations; schema/data maintenance closes affected admissions, fences all writers and preserves the installed predecessor before staging changes. Do not build end-user forms, settings drawers, admin roles or MCP business tools for provisioning projects/sites/checks, rotating ingestion/API keys, changing quotas or technical retention/retry defaults, configuring providers/bindings/endpoints, defining report sources, or making code/schema/release changes. Existing configured values may still drive the runtime and scoped read views.

End-users retain the ordinary actions they need: a host changes availability, finance issues an invoice or requests a permitted retry, HR maintains allowances, a receptionist issues a physical key, and an organizer publishes an event. Those are business record operations under existing permissions. A physical key assigned to a visitor is not a developer API key. Customer payment/renewal consent and recipient forwarding instructions remain customer actions, not developer configuration.

## Maintenance, provider changes and recovery

The same old-work gate applies when a release changes only provider configuration: endpoint, adapter account, binding, key namespace or a capability's installed implementation can change a pending request's meaning even when no row schema changes. Inventory affected schedules, outbox intents, in-flight/accepted/unknown deliveries and retained replay receipts before activation. Drain or reconcile them, or retain a compatible old binding/account and its original identity namespace until that work finishes. Never resend an uncertain charge or message through a new account and call it a retry. Unchanged business identities and verified account/source correlation remain required. A key rotation that preserves the account and request semantics may retain compatibility; it does not prove compatibility for an account switch. If the required old implementation, account access or evidence is unavailable, keep the affected workflow closed and require reconciliation rather than invent a successful cancellation.

Recovery is scoped to the composed company's required workflow, not one package's database alone. Preserve a compatible release/configuration and database checkpoint together with immutable file references/objects, relevant authoritative owner inventories, retained work contracts, receipt identities and provider-account associations. Validate referenced files and cross-package records before reopening affected access. D1, Durable Objects, R2 and external providers do not share one rollback transaction. Partial restoration stays closed while the maintainer resumes or reconciles it; a missing retained file or owner cannot be represented as complete recovery.

A restored local record cannot reverse an external payment, issued credential or delivered email. Reconcile provider observations and work accepted after the restored checkpoint before enabling dispatch; retain stable original idempotency identities, and expose pending/unknown or an explicit business exception until resolved. These are draft maintenance obligations, not an implemented backup service, a second app-authored manifest or an end-user administration screen. Future execution must demonstrate writer exclusion, interrupted activation/recovery and unknown-provider outcomes under these contracts.

## Permission and composition boundaries

Use canonical authentication/team controls once for account membership and role management. They do not imply a bespoke admin side in every app. Verified company administrators manage only their own company; operator plan/catalog/program administrators and moderators have only their named functional/location grants. Do not introduce a global super-admin role or an extra settings landing page for the other modules.

For the six named responsibilities, ordinary pages, the end-user admin view, direct requests, downloads, HTMX and MCP call the same owning operations with the same server policies. Navigation is not authorization. Administrative price/plan/program changes preserve committed snapshots; moderation preserves authorship/history; role changes cannot fabricate payment, bypass capacity or grant another company's records. Any future admin feature requires a specific business action and audience that cannot be served by the existing workflow, not merely a larger record count or more complex application.

## Completion

Only the six named modules contain a dedicated Admin and Management Surfaces requirement section. The other modules retain their normal roles/pages without invented admin requirements. Check the actual business boundary: for example an ordinary company user cannot invite billing administrators, a member cannot edit plan benefits, and a marketplace author cannot moderate another author. Technical setup is absent from product UI/tool requirements. Optional products add their admin work only when enabled.
