# CanFeedback requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanFeedback.can](CanFeedback.can).

## Purpose and Adoption Goal

Help workspace members suggest improvements to facilities, amenities, and booking services and see the operator's response. Adoption depends on an easy suggestion flow and a location-relevant roadmap.

## Users and Permissions

Public visitors see products, suggestions, roadmap status, and aggregate vote counts. Authenticated users control their own suggestion content and vote. Designated operator product owners create/manage location or service products, moderate suggestions and decide roadmap status, but cannot cast or edit other people's votes. Ordinary contribution rights do not grant product ownership or moderation.

## Data and Ownership

Product stores name and owner; suggestion stores title, description, owner, and roadmap status within that product. Votes are unique by suggestion and user. Public responses do not expose account emails or private voter records. Suggestions retain author, moderation state/reason, and roadmap-decision history; hiding a suggestion preserves authorized history.

Products represent a location's facilities or an operator-wide service such as booking. Add suggestion category, staff response, and optional duplicate-of reference while retaining original authorship and votes.

## Workflows and Business Rules

Vote and withdraw through the same retained owned Vote record; withdrawal clears its active flag, and a later cast restores that record. Duplicate casts never add a second vote. Casting has an account-wide ten-second cooldown; withdrawal does not reset it. Only product owners set planned/shipped/declined status. Moderation can hide abusive content without falsifying its vote count or transferring authorship.

Staff may link duplicate suggestions directly to a different root suggestion within the same product, without transferring or adding votes. A linked target cannot itself become a duplicate while inbound links remain, so chains and cycles are rejected. An urgent incident is directed to support/maintenance rather than waiting for a roadmap vote. Public suggestions must not contain private access instructions or other members' contact details. New submissions and contributor edits await product-owner review before public visibility; a moderation reason records publication or hiding. Authors may edit pending submissions, but cannot edit content hidden for an explicit abuse reason.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Suggestions (`/feedback`) for public/contributor use and Moderation and roadmap (`/feedback/moderation`) for designated owners. Suggestion/product details stay contextual. Use daisyUI; protected moderation/roadmap pages remain separate from own-user settings.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Suggestions | In-page Product selector with saved-preference defaults plus location/service/category/status Select filters, vote-ranked Table/List and suggestion Cards with aggregate vote Badge, roadmap status and staff response. A `hero` intro, saved-default status filter, paged vote-ranked roadmap table and per-collection empty states complete the page; urgent guidance is an alert notice. | Public visitors read published content without emails/private voter records. Counts derive from canonical votes rather than editable UI values. |
| Suggestion and contribution | Title/description Fieldset, own edit and vote/withdraw Buttons; response Card, operator-decision history Collapse and duplicate reference. Inline typed contribution controls; own submissions show published vs awaiting-review via a hidden-state `swap` (status badge in both); vote carries a cooldown tooltip; nested own-votes keep an empty state. | Authenticated contributors edit their own content and vote through the owned Vote record. Duplicate voting/withdrawal retries preserve counts; duplicate links do not transfer votes/authorship. |
| Moderation and roadmap | Protected queue Table filtered by hidden/status, content/history Card, moderation-reason Fieldset and roadmap decision controls with operator-decision/withdrawal history; product maintenance Fieldset. Title search on the split queue; roadmap/moderation open dialogs with `radio`/`select`/`toggle` controls; abuse reason stays visible to the author via history. | Designated owners maintain products, hide abusive content and set planned/shipped/declined through existing operations. They cannot impersonate authors or alter another user's vote. |
| Urgent service route | Clear Alert beside contribution fields with reception/support/maintenance destinations where declared. | Direct incidents to the existing service workflow; never publish private conversation, repair details, access instructions or other members' contacts as suggestions. |

Distinguish empty products, filtered results and own submissions. During asynchronous voting, retain the owned vote result and disable repeated action rather than incrementing an unconfirmed count. Moderation/stale-content conflicts refresh authorized state with an Alert and preserve unsaved staff reason or contributor draft where still permitted. Hidden content becomes unavailable to public record links as well as lists; authorized history remains. Preserve drafts after validation/rate-limit failure; confirm discard. On mobile stack suggestion Cards and filter controls, keeping vote state, roadmap authority and staff response visible; moderation controls never appear merely because a contributor opens the same record.

## Personal Configuration

Inherit shared base settings through the own-user dialog. Remember product/location/category/status filters and history expansion. Status-filter memory is editable in context; product/location/category stay toolbar/dialog. Preferences cannot change votes, moderation visibility, ownership or operator commitments. Moderation remains protected business content; no general settings console is needed.

## Admin and Management Surfaces

End-user admin is required for moderation and operator roadmap authority. Contributors must not moderate other people's suggestions or claim that the operator has committed to a roadmap item. Designated moderators/product owners need that explicitly separate end-user authority.

Provide the required moderation queue and operator roadmap controls for designated staff, alongside public/contributor views. Limit this side to product ownership, moderation and roadmap decisions. It cannot impersonate authors, change other users' votes or expose private accounts, and needs no general settings console. See [end-user administration scope](ADMIN_SURFACES.md).

## Interfaces and Integrations

Use D1 for records and shared authentication for contributions and ownership.

## Background Actions

None in the first version.

## Error Handling

Rate-limit public contributions and voting, escape content, and preserve authorship. Reject direct writes to derived counts or roadmap fields from authors without product-owner authority. Removed/hidden content cannot remain publicly readable by ID.

## Scope and Completion

Complete when direct API requests cannot impersonate voters or override roadmap decisions, withdrawing/retrying a vote has a stable count, and moderation protects public views.

Members can suggest improved phone booths at a location, vote, and read the operator's planned/shipped response without publishing a private incident record.

Frontend completion additionally requires these journeys:

- A member submits a phone-booth suggestion, votes, withdraws and retries without inflating the count, then reads the operator's attributed planned/shipped response without seeing voter identities.
- A product owner hides abusive content with a retained reason; public lists and record access both stop exposing it while authorized history and original authorship remain. Urgent private incidents go to the declared support route.

## Composition and Ownership

Recommended placement: Community suggestion module. Own suggestion content, voter records and roadmap decisions. Link urgent issues to CanDesk/CanMaintain without publishing private conversation or repair details. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## October 4 draft completion contracts

The source caps canonical submission creation at five per author in a rolling hour, including archived submissions, through the precommit `Suggestion.create` hook. Submission text has explicit bounds (title 300, description 5000, category 100 Unicode scalars). Only the canonical CRUD operation creates suggestions in this draft; future creation paths must preserve that admission rule rather than bypass its hook.

`Vote` retains `account`, `active` and `cast_at`; its account is immutable and all generated Vote CRUD operations are disabled. `vote` creates or reactivates the caller's unique record and returns that owned record. `unvote` sets `active=false`, including on an already withdrawn vote. The account-wide cooldown scans retained votes, including contained archives, so withdrawal or suggestion archival cannot erase the last cast time. This is a casting-spacing limit, not a per-hour attempt ledger. The shared receipt/version rules cover replay and stale requests; ordinary later casts still observe the business cooldown.

The public authority report exposes only published visible cards, active vote totals, staff responses, and a duplicate reference whose target is still visible. It exposes no voter identities. Original votes are never combined or moved when suggestions are linked. Direct reads of hidden suggestions remain denied to the public; author and responsible-owner grants preserve authorized history. Contributor edits return reviewed content to the moderation queue; history retains the previous reason even when the current pending reason is cleared.

The urgent-issue form invokes the actual exported `desk.open_request` contract with `priority=urgent`. Location and private incident details remain canonical form inputs, since an operator-wide product can have no location. The imported operation supplies its own verified-email, active-location, optional customer-authority and daily-intake guards. No published suggestion content, voter data, conversation, or repair information is copied into the handoff.

Location and category filters join the existing status preference, the public table orders by vote total, and the protected moderation list selects only products owned by its current staff actor. Product search uses its actual name. Generic draft preservation, conflict handling, labels, history disclosure and asynchronous submission state remain shared presentation contracts.

[CanFeedback.mjs](CanFeedback.mjs) is the handwritten desired target using the proposed `@canlang/stdlib`, `@canlang/ui` and owning-package contracts. It mirrors the declaration permissions, field grants, hooks, ordering, duplicate invariant and inline example recipes. Its `canApp()` returns callable handlers/rule maps only. The source and target include independent success/rejection examples for submission quotas, own edits, review, retained voting/withdrawal, unauthorized withdrawal, duplicate cycles, public counts and hidden duplicate targets. Fixture callbacks resolve real identities only after dependencies are provisioned.

Three freshly worded JEV consultations are saved in [the completion evidence](../design/jev/feedback-completion-20261004/analysis.md); their agreement is design advice. The initial parser accepts the declarations and table examples when the later shared-state sequence is excluded, and `node --check` accepts the complete target syntax. The sequence uses the settled DESIGN §5.1/GRAMMAR draft contract beyond the initial parser. Those checks do not resolve imports or types, execute policies/hooks/examples, provision fixtures, render pages, or prove runtime behavior. No compiler, standard library, provider adapter, infrastructure or example runner is implemented by this draft.


The public Suggestions page keeps personal Vote reads inside a nested authenticated detail. Anonymous viewers can still browse public products, suggestion content, the published aggregate roadmap and the released operator-decision history; the page does not gain a membership or voter-record admission test. Authenticated users see only votes permitted by the existing own-account policy. Canonical contribution/vote/unvote/moderation authority stays with its owner operation. The desired target shares one static owner/page descriptor between discovery and rendering, with only resolved team context at public admission and the product-owner gate at moderation admission. Non-sequence source syntax and complete target JavaScript syntax are checked; no descriptor dispatcher or runtime is implemented.

## Requirement/source/desired-target closure

The ranked roadmap now carries category and offers category/status filters with their saved defaults. Product name and location remain visible above contextual content. The in-page Product selector lists authorized product choices with the nullable saved Product preference as its default; an in-page change or clear overrides that default for the current view without saving. Product choice, search and location are intersecting ordinary filters, and location-less service products stay available while location is clear. Toolbar changes never auto-save preferences; the canonical own-user settings save remains the only defaults writer. This does not add a business-operation input, a setting primitive or a read grant.

The authenticated own-submission section distinguishes pending/hidden review state and reason, displays title/category/response/duplicate, and exposes the existing own edit/archive controls and authorized history. The general suggestion detail now includes its title/category; moderation includes those fields and the original author. Shared Appearance owns history expansion. Private generic history stays confined to authors and responsible owners in the two existing sites. Public history begins with explicit Decision records: each successful roadmap call records a staff decision that releases when its suggestion is visible, and the public operator-decision history reports released, non-withdrawn entries only, attributed to "Operator decision history" without revisions, reasons, votes, accounts or unpublished rows. Existing installations have no automatic historical backfill: never reconstruct approval from old audit/current fields. An existing visible suggestion with no Decision still displays its current response and an empty public history; the next explicit roadmap call starts its history. No "history complete since creation" claim is allowed.

One shared-state inline example follows genuine canonical creation, owner review, planned response, voting, withdrawal/repeated withdrawal, immediate cooldown rejection, contributor editing back into review, abuse hiding/edit rejection, owner republication/shipped response, and own archival. It rebinds updated suggestion records before later writes, preserves original authorship and the one withdrawn vote, and checks the public roadmap after pending, publication, editing and archival. Its named moderator has a real product-owner fixture assignment. The fixed clock cannot demonstrate a later successful recast; existing isolated old-cast-time tables retain that case. The desired JavaScript mirrors the sequence through the existing canonical sequence descriptors; no runner is added.

Focused checks cover complete JavaScript syntax, the initial parser's non-sequence subset, source/target sequence step correspondence for the journey additions and the decision-history sequence, the withdrawal rejection table, the absence of any public Decision read grant, the explicit Product bindings, and the presence of the two protected private-history sites with no generic history under the public suggestion detail. They do not execute transactions, policies, hooks or examples, prove direct-ID denial or cache invalidation, verify rendered filters/mobile layout/draft retention, or run the public/private UI. Those remain runtime or explicitly stated design/presentation boundaries.
