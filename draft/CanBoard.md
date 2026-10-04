# CanBoard requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanBoard.can](CanBoard.can).

## Purpose and Adoption Goal

Help the workspace operator's leadership or advisory board prepare meetings about locations, investment, and operating performance, then retain their decisions. Adoption depends on ordered papers and an attributable final meeting record.

## Users and Permissions

Authorized board members read their board's papers. Meeting coordinators edit preparation; the secretary or designated recorder finalizes recorded decisions. Ordinary readers cannot rewrite finalized minutes or resolutions.

## Data and Ownership

Meeting stores title, time, and location; agenda items store title, position, and optional paper. Meetings retain timezone, draft/final state, agenda positions, and paper versions. Resolution decisions record actor/time and supporting recorded notes. Finalized content references the paper versions presented at that meeting.

Record meeting attendance, agenda-item discussion/minute text, location or expansion project references, and resolution outcome. Decisions can create manually assigned action records with owner, due date, and completion history.

## Workflows and Business Rules

Prepare and reorder a draft agenda, then finalize the meeting record. Later corrections create attributed amendments rather than overwriting the approved record or replacing its papers. Decisions are entered manually with their evidence; the app does not infer votes or quorum.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Board records (`/board`) for authorized readers/coordinators/recorders, then Board actions (`/board/actions`) for permitted members. Meeting, paper and resolution details open contextually. Use daisyUI in the normal governance workspace.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Board records | Date-ordered Table/List with title, local meeting time, location and draft/final state text; search Input and draft/final Select; scheduling Fieldset; explicit Pagination in the meeting List; finalized rows show an immutability Alert. | Authorized coordinators create/edit preparation; readers open only their board's records; finalization stays a canonical row action beside the meeting summary. |
| Draft meeting | Meeting Card with attendance Fieldset; position-ordered agenda Table showing papers and discussion; resolution Cards with typed Input/Textarea/Calendar/File-input controls inside Fieldsets (title, position, evidence, due date, papers, discussion); decisions use a confirming Modal with an inline decide form (Accept Checkbox, evidence Textarea). | Add/reorder agenda items and upload papers using existing operations; propose resolutions and record outcomes manually with supporting notes, without inferred votes/quorum. |
| Finalized minutes and amendments | Readable minutes Card, presented paper-version download Buttons, resolution List and attributed amendments as a Timeline inside the existing preference-gated Collapse; print/download controls. | Only authorized recorders finalize. Finalized papers, minutes and decisions remain immutable; later corrections use amendments. Archived records retain authorized retrieval. |
| Board actions | Outstanding-action Table with source resolution, owner, due date and completion state; completed/outstanding filters and focused action Card; explicit Pagination; Breadcrumbs orient the queue; completion uses a tooltip-annotated action Button. | Manually assign actions and mark completion under existing permissions. Where the declared CanDo export is installed, show its returned task reference without rewriting minutes. |

Keep meeting date/timezone and draft/final state visible while scrolling through a long agenda. Show an empty agenda and no-outstanding-actions message with only permitted next actions. Failed paper uploads preserve the previous version and leave other draft fields recoverable. Confirm finalization with the current meeting/paper summary; a concurrent finalization or immutable-record conflict produces an Alert and refresh path, preserving unsaved amendment text. On mobile render agenda rows as ordered Cards and stack attendance/minutes fields; preserve paper access and action provenance. Print/download includes amendments and the finalized version references.

## Personal Configuration

Inherit shared base settings through the own-user dialog. A personal presentation preference may open Board records in draft/final view and expand or collapse paper/amendment history. Meeting timezone, attendance, finalization authority and action ownership remain business records, never personal settings. No added governance administration tab is needed.

## Interfaces and Integrations

Use D1 for meeting records and R2 for meeting papers.

A declared task export can send board actions to CanDo while preserving the originating resolution reference; it cannot rewrite finalized minutes.

## Background Actions

None in the first version.

## Error Handling

Reject unauthorized document access and direct updates to finalized records. Failed uploads leave the previous paper version intact. Archived meetings retain authorized access to their finalized papers and amendments.

## Scope and Completion

Complete when readers can access the actual meeting papers, only authorized recorders finalize decisions, and later amendments cannot erase the original record.

Leadership can finalize a location-opening decision, retrieve its papers and minutes, and follow its assigned actions through completion.

Frontend completion additionally requires these journeys:

- A coordinator prepares ordered location-opening papers; a recorder finalizes the evidenced decision; a reader retrieves the same paper versions and prints minutes with a later attributed amendment.
- A member completes an assigned board action, sees its originating resolution and any declared CanDo reference, and finds the finalized decision unchanged.

## Composition and Ownership

Recommended placement: Governance module. Own finalized minutes, resolution evidence and amendments. Assigned actions may appear in CanDo through source operations; changing a task cannot amend a finalized decision. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft contract

The draft now uses a canonical Location reference. Exported work/work_detail reads project only eligible actions under the unchanged members/secretary completion authority. A separate bounded ActionOrigin read shows assigned members only source resolution/meeting titles, including completed actions; it grants no board papers, minutes or decision evidence. File references remain immutable presented versions under finalization locks. A finalized_record read returns the same authorized Meeting. Its read-form composition includes minutes, attendance, ordered papers, decisions and attributed amendments for the shared Print control, including native save-to-PDF. The shared bounded read checkpoint, pagination traversal, field/file grants and explicit incomplete/failure behavior govern printing; no app formatter, new stored PDF, or broader approval permission is introduced. Meeting.location supplies the required location-or-expansion reference.

Inline examples now cover draft edits versus finalized rejection, immutable presented file retention, manual accepted/rejected decisions and blank evidence, unresolved-decision finalization rejection, attributed amendment creation without original-record changes, finalized read access, assigned/recorder completion and narrow source-title retrieval after completion. These tables and desired JavaScript are review contracts: parsing and JavaScript syntax checks do not execute permissions, attachment finalization, transactions, print traversal or BDD.
