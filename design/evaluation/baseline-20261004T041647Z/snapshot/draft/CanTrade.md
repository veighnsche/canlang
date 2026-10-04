# CanTrade requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanTrade.can](CanTrade.can).

## Purpose and Adoption Goal

Optionally help workspace members advertise their services, request suppliers, and offer surplus office equipment within the member community. Adoption depends on useful location/category browsing and deliberate contact sharing.

## Users and Permissions

Default browsing and publishing are for verified active customer members of the operator; staff moderators review reported content. The operator may additionally enable explicit public listings that anyone can browse. Authenticated eligible authors manage only their own posts and may publish both wanted and offered listings. Staff administration and customer membership remain separate.

## Data and Ownership

Post stores author, kind, title, description, optional amount/currency, contact details deliberately chosen for publication, and active/closed status. Account login email is never automatically published as contact information.

Record listing category, applicable location or operator community, and moderator reason/history. The author selects public versus verified-member visibility when the operator permits public listings; login identity and contact information remain separate.

## Workflows and Business Rules

One Post model covers wanted and offered listings. Authors can publish, edit, close, reopen, or delete their own listings; closed listings leave active search. Moderators can remove reported abuse but cannot impersonate the author. Do not allow ownership changes through CRUD.

Member-only publishing requires a current customer membership verified through a declared capability. Expiry or revocation hides member-only listings from discovery pending author renewal or staff moderation; historical authorship remains. Public directory publication is optional and explicit, never inferred from an employee team invitation.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar order is Community marketplace /marketplace, then Listing reports /marketplace/reports for moderators and the operator owner. The owner-only audience card grants no access to moderator reports or decisions. An owner-status view is a local filter. Public browsing exists only for explicitly enabled public listings; neither navigation nor staff team membership grants customer-member eligibility.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Marketplace /marketplace | Kind/category/location/status Select, title search Input and Post Cards/Table with amount/currency, escaped description and published contact. | Authorized read rechecks active audience membership; no private login email appears; removed listings stay unavailable through ordinary search/public links. |
| Publish and own listings | Typed Post Fieldset, explicit allowed audience/contact preview and own active/closed status List. | Post CRUD enforces eligible author ownership; status closes/reopens through the owning action, with no ownership edits. |
| Listing contact and reporting | Contextual Card with selected contact information and Report Fieldset; unavailable/access-denied Alert has no private account details. | Reporting uses the permitted canonical Report creation path and limits; participants arrange transactions directly, without checkout/payment claims. |
| Listing reports /marketplace/reports | Protected unresolved-report Table, Post/context Card, moderation reason Fieldset and authorship/history Collapse. | moderate removes reported abuse under moderator authority; it cannot impersonate authors or reveal private identity fields. |

This queue is the justified business administration surface, separate from personal preferences. Mobile Cards retain audience, publication contact, status and currency with accessible actions. Loading, empty search, unavailable eligibility and removed content are distinct. Preserve authored text/contact choices after validation or stale edits; refresh current audience access before publishing. Membership expiry hides member discovery, preserving authorship. No arbitrary rich HTML, automatic account-email sharing, technical settings or platform console is added.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Personal settings remember permitted location/category/kind filters and own-listings versus community browsing; persistent save/reset never changes the listing's audience or contact publication. Posting preferences cannot substitute for per-listing choices, grant active membership or confer moderation powers. Moderator decisions remain protected business operations rather than settings; public-listing enablement and technical configuration are not personal controls.

## Admin and Management Surfaces

End-user admin is required for marketplace moderation, only when the marketplace is offered. Authors control their own listings, while designated moderators must handle reports and remove abusive listings belonging to other authors.

Provide a restricted listing-report/moderation queue for designated moderators. Normal posting, closing and browsing stay in the ordinary marketplace. Moderation cannot change authorship or expose private account data; there is no technical-settings or generic platform-admin page. See [end-user administration scope](ADMIN_SURFACES.md).

## Interfaces and Integrations

Use D1 for posts and the shared authentication capability for publishing. Contact details let users arrange their transaction directly.

Declare active membership/audience eligibility where required; verify it on reads and contributions rather than trusting a copied member-area URL.

## Background Actions

No scheduled actions or notifications in the first version.

## Error Handling

Explain invalid fields and denied edits without exposing private account information. Rate-limit posting/reporting and render descriptions as escaped text. Removed listings cannot remain accessible through old search results or direct links.

## Scope and Completion

Complete when users can find active listings, publish chosen contact details, close a fulfilled post, and report abuse; ownership is enforced on direct API requests. Transactions remain arranged between participants.

Use this app if the operator offers a member marketplace. A member can advertise accounting services or surplus furniture, choose the allowed audience/contact details, and close the listing without publishing their account email by default.

Frontend acceptance journeys:

- An eligible member publishes an offered service with chosen contact/audience, finds it through filters and closes it when fulfilled. Their login email stays private unless explicitly entered for publication; direct edits by another author fail.
- A reported abusive listing is removed by a moderator with reason/history and disappears from search and old links. Expired membership cannot recover member-only access through saved filters/URLs, and contact edits survive correctable validation errors.

## Composition and Ownership

Recommended placement: Optional community marketplace. Own listings and reports; read active member/audience eligibility from CanMember and identity from CanCustomer. Listing ownership cannot grant staff or company administration. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Draft lifecycle and privacy decisions

Both public and member discovery require the author's current eligible membership; location-specific listings also require that location in a current paid term. Public grants expose only the published listing fields, never the author account or moderation reason. Authors retain a private management view when eligibility lapses and may close a listing; reopening or editing requires current eligibility and the currently permitted audience. Moderators retain their separate review authority. Disabling public publication hides existing public posts immediately without rewriting authors' chosen visibility.

The single operator-owned Audience record controls public publication. It is a business publication policy, not a personal setting. Posting admits fewer than twenty other posts by the author in the preceding day, including archived posts, so deletion cannot reset that bound. Reporting requires verified eligible membership, an active visible listing by someone else, at most one report per author/listing, and fewer than ten reports by that author in the preceding day. These are explicit first-draft abuse limits; ordinary transport throttling remains a shared service concern.

Removal resolves the listing's reports through their derived state, so moderation does not depend on an arbitrary bounded loop over all reports. An unfounded report can instead be dismissed with a reason. Original report text and authorship remain locked; automatic history preserves decisions. No account email is copied to published contact. Inline examples cover closure after membership expiry, rejected reopening, moderator-only removal and nonempty reasons; they are specified expectations, not executed behavior tests.
