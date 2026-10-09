# Office Supplies evaluator witness

**Status:** frozen Task 1 outcomes; `OfficeSupplies.can` is a desired-stage evaluator source, not an agent template or a qualified app. Keep this directory out of every novice agent's blank starting workspace. Give that agent only the [tiny introduction and Task 1 prompt](../../../design/can-dev-agent-tasks.md#agent-setup), its ordinary file tools, and the selected `can dev` control surface. The evaluator may revise source spelling as Can capabilities land; the observable outcomes below stay fixed. Record each spelling change and its reason before a trial.

The source owns one implicit app/package, one team-scoped `Supply` model, member read/CRUD policy, one page, and two authored update examples. Its `create_fields=name,quantity` narrows the create operation so callers cannot override the `available=true` default; update may change availability. It relies on the pinned defaults for D1, Identity, teams and business `/mcp`; there is no imported app, handwritten Worker, replacement page or test-only business handler. The `count` list child is a **proposed smallest expression** of the current-view count. Its required meaning is one list-level summary of authorized records matching the active tab and name search, before any pagination; it must not repeat per row. This syntax is not an approved/implemented Can construct; the owning UI/compiler producer may use a different source-level spelling while retaining that meaning.

## Actors and data

Use fresh local D1 and Identity data for each independent check. Create team **Cedar** with active members **Ava** and **Ben**; create team **Oak** with active member **Cal**. **Dee** is signed in but belongs to neither team; **Public** has no session. Start with selected team Cedar and no supplies. Cal's Oak membership never grants Cedar authority. Browser and business `/mcp` must use ordinary app credentials and the same canonical operations. Record the exact source, artifact, installed package and profile revisions used for every run.

| Actor with Cedar selected | Read/list Cedar supplies | Create/edit/status/delete Cedar supply | Expected observation |
| --- | --- | --- | --- |
| Ava, Cedar member | Allow | Allow | Own writes survive reload. |
| Ben, second Cedar member | Allow | Allow | Sees and can change Ava's row. |
| Cal, Oak member only | Deny | Deny | No Cedar row, domain change or effect intent. |
| Dee, signed in without membership | Deny | Deny | No Cedar row, domain change or effect intent. |
| Public, no session | Deny | Deny | Login/admission refusal, no domain change or effect intent. |

An engine-owned rejection receipt is permitted for a denied mutation. It is classified separately from a domain write or effect intent. After each refusal, compare the Cedar record, its version/history and all resources admitted by this profile to the pre-call state; do not infer safety solely from an HTTP status or an example's expected error.

## Independent observable checks

| Check | Action and oracle |
| --- | --- |
| O01 Required, optional and default fields | As Ava, reject missing/blank `name`; create `Paper` without `quantity`. Read it back: `name=Paper`, quantity absent/null, `available=true`. Submit a direct canonical/MCP create with `available=false`; the closed create schema rejects that undeclared input and creates no row. The failed creates add no supply. |
| O02 Details and shared authority | As Ava, create `Pens` with quantity 4. As Ben, list/read it, edit to `Blue pens` and quantity 8, reload and read the changed values. |
| O03 Availability | As Ben, mark that item needing restock and then available again; each state persists after reload and changes the corresponding view. Both changes use the canonical operation path. |
| O04 Remove | As Ava, delete the item. It disappears from ordinary authorized reads and all page views; a fresh list count drops by one. |
| O05 Search, tabs and count | Seed `Paper` available, `Pens` needing restock, `Tape` available through authorized operations. All shows 3; Available shows 2; Needs restock shows 1. Searching `pa` in All shows only Paper and count 1; searching `ens` in Available shows none and count 0; searching `ens` in Needs restock shows only Pens and count 1. The empty state is useful and visible for the zero-result case. Clear search and change tabs to prove count and rows change together. |
| O06 Denied paths | Attempt read/list, create, edit, status change and delete against Cedar as Cal, Dee and Public. Every path refuses without Cedar-domain or effect-intent change. Cal can still use his own Oak team normally; this must not leak Cedar rows. |
| O07 Browser and MCP join | In headless Chrome, Ava signs in and selects Cedar, creates from the source-generated form, changes details/status, reloads and removes. Ben sees the same data. Repeat representative create/read/edit/refusal through business `/mcp`; UI and MCP use the same operation IDs, validation and policy. Preview bootstrap access never substitutes for app login. |
| O08 Authored examples | Compile the source's two example rows. Row 1 invokes update as `other` and independently expects the edited name/quantity. Row 2 invokes as the `outsider` test selector and expects `forbidden` with no domain/effect change. Inspect the runner's actual actor/team facts; do not treat this selector as proof that the literal Cal/Oak account was used. O06 separately tests that real cross-team member. Executed count is exactly selected authored count and greater than zero; setup failure, unsupported, skipped or zero-row reports fail. Re-run from a fresh row scope and prove no prior-row/preview data carried over. |

The checks observe the app rather than its source spelling or generated JavaScript. A checked source alone, a handwritten fixture result, an anonymous page, or a count that ignores the search term does not pass. Whole-app qualification still requires [A1–A6](../../../design/can-dev-first-slice.md#acceptance-criteria-one-complete-supported-app); unfamiliar-agent support additionally requires A7 and a separate clean trial. This file is evaluator material and must not be exposed through construct help, CLI diagnostics or the agent's starting checkout.

**Recorded initial direct check (2026-10-09):** `can check --format=json OfficeSupplies.can` reported a complete analysis with zero diagnostics. At that checkpoint, `can compile --format=json OfficeSupplies.can` exited 10 with five `E6008` lowering gaps: bound tabs/preferences, authored list ordering, list search, the proposed list-level count, and bound edit controls. It emitted no artifact, so that result claimed no runtime or example success. This is historical witness evidence, not the current compiler status. `create_fields` is the declared Can narrowing of the generated create allowlist; the direct override refusal remains an independent G2 observation. Current producer and whole-app progress belongs in the dev-server plan.
