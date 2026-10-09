# Can dev: unfamiliar-agent app tasks

**Status:** Proposed pre-planning benchmark, 2026-10-09. These are real business requests for an AI coding agent new to Can. They define desired behavior, not a claim that the current compiler, test CLI or local runtime can execute every workflow end to end. Confirm the supported runtime profile before scoring a live run. The [dev-server design](can-dev-server.md#before-an-implementation-plan) records the surrounding questions.

## Agent setup

Give the agent only this introduction, one task prompt below, a blank project, its normal file tools, and the selected development control surface:

> Can builds business apps from `.can` source. **Given** declares data and rules. **When** declares permitted actions. **Then** declares pages. Write your best draft, check it with the development tool, and use its construct help to revise.

Do not preload the grammar, source examples, solution code or acceptance checks. The agent may follow specific help links returned by the development tool. Use the same agent model/settings, tool access, time budget and clean project state for each help condition. Existing [TeamTasks](../examples/TeamTasks.can) and [ExpenseFlow](../examples/ExpenseFlow.can) are useful feasibility witnesses for evaluators, not agent-visible templates.

## Task 1 — Office supplies

### Agent-visible request

> Build an office supplies tracker for one team. Each supply has a required name, an optional quantity, and starts marked available. Team members can add supplies, edit their details, mark an item as needing restock or available again, and remove it. Only members of that team can see or change its supplies. Give them one page with a create form, a supply list, a count of items in the current view, search by name, and views for all, available, and needing restock. Show a useful empty state. Include behavior examples for a successful edit and for a nonmember being denied.

### Observable checks

- A new item has the requested default and optional quantity; a member can create, edit and remove it.
- Switching views and searching changes the visible items and count as requested; the empty state appears when appropriate.
- Another member of the same team can see the item; an outsider cannot read or mutate it.
- The authored examples assert the requested success and denial independently of the implementation.

This tests the smallest complete record, permission, CRUD, page and example loop. The specific field and page spelling are the agent's choice.

## Task 2 — Staff shifts

### Agent-visible request

> Build a staff shift board for one team. Members can post an open shift with a title and day, edit or remove it while it is open, and browse shifts ordered by day. A shift may have an assigned teammate. Only someone with the scheduler role can assign an active teammate to an open shift and mark it filled, or reopen a filled shift and clear its assignee. A filled shift cannot have its title or day edited and cannot be removed. Team members can search by title and switch between open and filled views; outsiders cannot see or change shifts. Include behavior examples for a valid fill, a non-scheduler denial, and a forbidden edit to a filled shift.

### Observable checks

- Member create/edit/delete works for open shifts; outsiders cannot read or mutate team shifts.
- Only a scheduler can make the stated open/filled transitions; filling sets an active assignee and reopening clears it.
- A filled shift's title and day stay fixed, and delete is refused, including attempts through a generic edit path.
- The page orders and filters shifts as requested; examples cover the stated success and refusals.

This adds a role, typed member reference, guarded operation, state transition and cross-path immutability. It does not require calendar integrations or notifications.

## Task 3 — Expense review

### Agent-visible request

> Build an expense reimbursement app for one team. A member can create a draft expense with a purpose and a positive money amount, edit their own draft, and submit it for review. Submitting freezes its purpose and amount. A reviewer can approve or reject a submitted expense from someone else; rejection requires a nonblank explanation. Record who made a decision and when. Once approved or rejected, an expense cannot be decided again. Submitters can see their own expenses; reviewers can see all team expenses. Provide a page for drafting, viewing status, and taking permitted review actions, plus a count and total of visible expenses filtered by chosen status and currency. Include behavior examples for submission, approval, unauthorized review, invalid amount, and an invalid repeat decision.

### Observable checks

- Nonpositive amounts are refused; a member can edit only their own draft and submit it once.
- Purpose and amount cannot change after submission through any mutation path.
- Reviewer authorization, no self-review, required rejection explanation, decision actor/time and terminal-state rules hold.
- Read visibility and the status/currency summary respect the viewer's access; the page exposes the requested actions and outcomes.
- Examples state the requested allowed and refused outcomes without deriving expected values from the operation body.

This exercises multi-actor permissions, invariants/locks, guarded transitions, reporting and examples. [The existing design witness](../examples/ExpenseFlow.can) includes a proposed shared-state example sequence that the initial parser/runner does not implement; score independently checkable operations separately until an actual supported runner can verify a full claimant-to-reviewer journey.

## Evaluation rules

Score the finished app against each prompt's observable checks, not similarity to the existing examples or a preferred Can spelling. No business requirement is hidden in the evaluator's checks. Record source validity, which requested behaviors ran in the selected runtime profile, the results of authored examples, edit/check turns, total input/output tokens, elapsed time, keyword hints followed, wrong-intent suggestions and unavailable capabilities. A checked source file alone is not a completed app.

For a help comparison, run each task from an equivalent fresh state under three conditions: no contextual construct help, deterministic grammar-position help, and the same help candidates ranked by Jev. Keep everything else equal and vary task/condition order across agents. Count naturally occurring guesses; use a separate, clearly labeled diagnostic corpus to test specific invented keywords. If a requested behavior is not yet executable in the chosen profile, mark that observation unqualified and narrow the scored profile before drawing an agent-performance conclusion.
