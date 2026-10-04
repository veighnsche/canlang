# CanDo requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanDo.can](CanDo.can).

## Purpose and Adoption Goal

Help workspace staff coordinate daily opening, closing, room preparation, and customer follow-up tasks. Adoption depends on a clear owner, due date, and list of unfinished work for each location.

## Users and Permissions

Require email/password authentication and team membership. Authorized members manage their team's tasks; assignees must belong to that team. Authorized members also create/edit/archive checklist templates within the same team/location scope as tasks.

## Data and Ownership

Todo belongs to a team and contains a trimmed, non-empty title, completion flag, optional assignee, and record version. Assignment requires active membership. Removing an assignee's membership clears the active assignment while preserving the task and its attribution.

Add location or operator-wide scope, description, due date/time, priority, and optional related-record reference. Keep a completion/reopening history and attributed staff comments.

Federated work-queue entries retain source app, source record/revision, location, permitted actor, due date, authorized summary and current action/status. They are read projections, not independent writable Todo copies. A source unavailable state is distinct from completion.

## Workflows and Business Rules

Use standard CRUD with server-enforced team scope. Completion and assignment are explicit updates, not commands inferred from page content. Reject conflicting stale edits so one user's title change cannot silently undo another user's completion.

Members work only on tasks in their granted scope. Reopening preserves prior completion evidence. Reusable opening/closing checklist templates create independent dated tasks with stable generation identity, so retrying generation cannot duplicate a location's checklist.

An independent Todo completes here. A domain queue action invokes the source's current permitted operation and returns its validation/decision evidence. Marking an onboarding step, inspection, board action or account follow-up complete must respect that source's required inputs and history. Refresh/remove stale projected actions after source reassignment or loss of access; aggregate queue visibility cannot grant a missing source permission.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar destinations are Tasks, My work and Checklist templates in that order, subject to current page grants. A task or source-record detail opens from its owning view and retains that sidebar context; it does not create another global menu item.

| Page | daisyUI layout and information | Actions and access |
| --- | --- | --- |
| Tasks | A page heading and supporting description above an inline form with Fieldset-placed title Input, priority Radio, location Select, description Textarea and due Input (assignee generated). Put location, assignee, priority and completion Select filters alongside All/Today/Overdue Tabs. Use a paginated Table on desktop and labeled List/Card rows on narrow screens, with title, assignee, due time, priority Badge and completion state; explicit Pagination; task detail uses a FAB of the canonical complete/reopen actions and Chat-bubble comments. Newest-first is the ordinary list; due views show their stated order. | Authorized members add, assign, inline-edit and delete through canonical operations. Empty work offers task entry; no matches offers filter clearing without changing scope. |
| Task detail | A split/detail Card with description, owner/due fields, attributed comments and a Collapse for completion/reopening history. Keep the title and current state visible while the detail scrolls; completion/reopening history stays in Collapse. | Complete and Reopen show their actual result; preserve prior attribution. A failed edit keeps input. Removing a task uses the existing deletion policy rather than silently deleting history. |
| My work | A filter toolbar for permitted location, due window and source, followed by scoped work rows. Show source, freshness, due date and Badge states for open, stale and unavailable. An Alert identifies incomplete sources independently of task completion; a captioned Divider precedes the projection; the items Table has explicit Pagination; Breadcrumbs orient the page. | Open authorized source detail or its canonical operation form with required evidence. Financial and HR summaries remain limited to source grants. Refresh clears invalid actions without inventing local completion. |
| Checklist templates | A Table of scoped templates beside the selected template's Card and ordered item Table, including offsets and priorities. The generation form previews the template's location and requested date before submission; template intake places name Input and location Select; template List has explicit Pagination; Breadcrumbs orient the page. | Template managers edit templates/items and generate independent dated tasks once. A repeated request or conflict shows the existing result; editing a template does not rewrite generated tasks. |

Use HTMX updates for the affected list/detail and visible counts, preserving filters, focus, unsaved comments and the current route. Show loading, request failure and conflict in context; a transport acknowledgment is not source completion. Source actions keep their protected binding and validation rather than becoming editable task fields. On reception devices, controls remain usable by touch and account changes clear the previous user's private work.

## Personal Configuration

Use the shared settings facility. CanDo can retain the current user's preferred task view and permitted default location/due window as presentation preferences. Validate saved choices against current scope and fall back visibly when a location grant disappears. These choices neither assign tasks nor change their due dates, source permissions or business timezone. Checklist authoring and source configuration remain their existing business/developer workflows, not extra settings tabs.

## Shared Shell and Personal Configuration

The canonical [standard shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration) now lives in the root language requirements, with [source semantics](../DESIGN.md#9-browser-presentation) in DESIGN. CanDo has no special shell service or runtime dependency. Its companion source declares its task pages and useful personal view choices; sidebar/base account settings are implicit. This replaces the earlier staged requirements-only contract.

## Interfaces and Integrations

Use D1 for records. Bind error reporting to an explicitly configured CanCatch project and its declared ingestion capability; resolve endpoint and credentials through deployment configuration. The compiler must not assume that a matching app name provisions a project or grants access.

Declare narrow authorized action-list and invoke-result contracts per connected source. A standalone source or independent Todo remains usable when an optional queue source is unavailable; a dependent action cannot be silently completed locally.

## Background Actions

No scheduled independent-task business action is required. Refresh bounded federated work projections on source changes or configured polling, preserving source authorization and freshness. Captured errors are forwarded as they occur.

## Error Handling

Show task failures inline and preserve unsaved input. Forward instrumented browser/workerd errors with event identity, environment, and release context. Reporting uses bounded buffering and must not block task actions when CanCatch is unavailable.

## Scope and Completion

Complete when two team members can independently edit tasks with conflicts explained, another team cannot access them, membership removal handles assignments, and CanDo errors reach the configured CanCatch project.

Reception can generate today's opening checklist, assign tasks, spot overdue room preparation, and reopen an incorrectly completed task while retaining attribution.

A manager sees an inspection and account follow-up in one queue; completing either updates its source evidence, while a forbidden review remains inaccessible through the task interface.

Front-end acceptance also requires a member to find Tasks/My work/Templates through authorized sidebar links, enter a task on a narrow screen, and return from its detail with filters intact. A stale edit preserves the attempted input; an unavailable source cannot appear completed. Changing language/appearance in personal settings retains an unsaved comment and survives the appropriate preference save/reload. A user without template grants neither sees that destination nor accesses it directly.

## Composition and Ownership

Recommended placement: Shared work queue and task module. Own independent tasks/templates. Aggregate authorized source actions from onboarding, account follow-up, facilities, governance and volunteering through explicit references. Domain completion uses the owning workflow, not editable task mirrors. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft contract

The authored My work page uses the bounded active-session `refresh=refresh` contract with `poll=5s`. It begins only after an explicit accepted refresh input submission; ordinary page polls remain GETs. Source mutations immediately withhold affected old action handles, including pending/unknown outcomes, until a fresh owner projection reauthorizes them. Refresh POSTs keep current admission and no secrets, stop on hidden/session loss, coalesce timer ticks and hold one full refresh delivery chain in flight with bounded retry/backoff. Verified source invalidation is available only through an explicitly installed adapter mapping; no source event channel is inferred.

WorkView has one current projection per account. Pending projection retention is 25 hours, covering the default 24-hour external-delivery retry horizon; a completed result expires after one minute. A new accepted refresh clears its previous projection, and only the current pending delivery may update it. Imports name all five owners' actual work/work_detail reads and canonical mutations; WorkSourcesV1 remains a deployment-installed mapping with current delegation, remote seals and permissions, not a fabricated source adapter. No runtime freshness guarantee is claimed.

The canonical `todo.complete` operation is exported for typed Workbench proposals. Import visibility does not change its member, staff, location, not-done or current-version checks. Workbench never writes Task directly or impersonates its saved requester; an approved full invocation reaches the same owning operation under the current real caller. This is an interface visibility change, not a second completion workflow.
