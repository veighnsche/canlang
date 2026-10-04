# CanGallery

CanGallery completes the Chat → Creative → review → shared collection journey. It selects `[chat,creative,gallery]`, uses the existing creative output contract, and owns only collection access and review/publication. Requirements, Can source and handwritten desired JavaScript remain drafts; no runtime, rendering or BDD execution is claimed.

## Submit a deliberate disclosure

A member chooses one readable finalized output from a successful owned creative run, an active collection, title, intended-use statement and rights/consent evidence. Pending, failed and unknown jobs cannot be submitted, even if they retained a finalized partial output. The selected image and statements become an immutable submission. A pending or approved submission of the same output in that collection prevents accidental duplication; rejected or withdrawn versions stay historical and may be followed by a fresh submission.

Submission copies only the selected authorized image attachment and business evidence. Reviewers do not acquire the original output relationship, private prompt, workflow graph, run receipts or conversation. The file has its own new owning submission field under existing attachment rules; no raw URL, preview or forged file ID can substitute. Later chat revocation does not erase a deliberately shared submission or its review history. The creator can explicitly withdraw the submission when its sharing consent changes.

## Independent review

A reviewer needs both the current reviewer role and current collection access, and cannot approve their own submission. Review applies only to a pending immutable snapshot and requires a reason. Approval or rejection records the reviewer, reason and decision time exactly once. An intervening withdrawal or other version change causes ordinary conflict/current-state rejection, never approval of stale evidence.

Creators retain access to their submitted evidence and decisions. Reviewers see only submitted material in collections they may review. Rejected assets remain outside approved collections. Correcting the description or rights evidence means creating a new submission; an old decision is never reused for edited content.

A creator, currently authorized reviewer, or owning curator can withdraw a submission with a reason. It disappears from approved views, while original approval/rejection and attribution remain immutable. Withdrawal records its own actor/time/reason and is terminal for that submission.

## Collection sharing and revocation

A curator owns a named collection and grants individual current team accounts access. The curator can deactivate a grant or the collection. Restoring a grant requires current membership; revoking an already-removed account remains possible. Collection access does not grant reviewer status, and reviewer status alone does not grant collection access. Administrators never obtain chat content from either role.

The ordinary pure `approved` read returns only approved submissions under current access and field/file grants. Generated thumbnail, enlarged preview and original-file requests use those same grants on every request. Removing access, team membership, approval or collection activation prevents future shared reads, including old file links. A creator's independent private submission access can remain; a viewer cannot use that rule to read another creator's file. The system cannot recall bytes a previously authorized person already downloaded.

## Shared UI

Approved collections show authorized thumbnail galleries with attribution, rights and approval date. My images/submissions provides success-only candidate images, canonical submit forms and personal status/withdrawal controls. Review presents the exact image, intended use and rights evidence beside the canonical independent-review form. Collection access manages collection activation and member grants.

The shared `gallery` component supplies the image layout, loading/error states, keyboard preview and safe original access. Every page carries breadcrumbs, every collection an explicit empty state and pagination, and submission states render as badges. Parameterized review and withdrawal open catalog modals with typed checkbox/textarea controls, while single-field creates and the submit form keep bare typed forms. Existing pages, lists, forms and actions provide all business UI with inline English/Dutch captions. One-second authorized page polling updates review and revocation state; it performs no mutation or provider dispatch.

## Behavioral evidence

The source and target include isolated positive/negative cases for successful-output eligibility, another account’s output, inactive collections, independent review, removed reviewer access and self-approval. A sequential example performs a real pending read, approval, authorized shared read, access revocation, denied read, creator withdrawal and final empty approved collection while retaining the original decision.

Required runtime acceptance checks include unauthorized thumbnails/originals, stale review versions, duplicate submit/replay, rejection followed by a new immutable corrected submission, member removal during a preview, collection deactivation, and proof that reviewer responses omit the private `output` relationship. These remain requirements until the shared engine executes them. The JSON graph fixture used transitively by Creative is an accepted upload-policy test artifact, not proof of provider execution.

The module deliberately has no provider binding, token stream, retry loop or copied image-generation operation. It consumes finalized creative output and ordinary owner transactions. See [shared lifecycle design and JEV evidence](../design/complex-apps/chat-media.md).
