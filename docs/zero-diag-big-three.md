# The big three: investigation notes

The earlier estimate of 107 diagnostics and roughly 50 attributed to these
three areas is historical, not a current diagnostic census. The original
descriptions were too categorical: current code supports some of the shapes
they called refused. Investigate each issue against the compiler and installed
runtime before choosing a design.

## 1. Searches inside rules (historically ~30 diagnostics)

**Observed on 2026-10-20:** the compiler accepts at least one leading
scenario `require` that calls a helper containing `any(...)`. With native
scenario receipts enabled, it emits `nativeScenarioRequire` and a receipt
disclosure. The remaining problem is not a blanket refusal to compile:
the installed runtime can evaluate the guard against the caller's visible
rows instead of the owning state.

The following source was compiled with `can compile --format=json
--native-scenario-receipts --catalog packages/cloudflare/dist/native-catalog.json`:

```can
app AuthorityProbe
Given
 Anchor {label:text}
 Secret {anchor:Anchor,blocked:bool,hidden:bool}
 policy Anchor read=members
 policy Secret read=members and not row.hidden
 derive has_block(anchor:Anchor,person:user):bool = any(Secret as secret,secret.anchor==anchor and secret.blocked and active_member(person,team))
When
 scenario enter(anchor:Anchor) -> bool by=members
  require not has_block(anchor,actor)
  do
   set anchor {label="entered"}
   return true
Then
```

A verified assembly ran through `buildInvoker(...).invokeMutation` with a
real member session and State memory storage. Each case started with a
readable `Anchor(id="anchor-1", label="Probe anchor")`; the invocation supplied
`{anchor:{id:"anchor-1",version:"1"}}`. The optional `Secret` row had
`anchor=anchor-1` and `blocked=true`. The caller's ordinary `Secret.read`
and an owner query checked the two views before invoking the scenario.

| Owner-state `Secret` | Caller `Secret.read` | Scenario result | Final `Anchor.label` |
| --- | ---: | --- | --- |
| No row | 0 rows | Committed | `entered` |
| `hidden=false` | 1 row | Rejected, `rule_failed` | `Probe anchor` |
| `hidden=true` | 0 rows | **Committed** | **`entered`** |

The hidden blocker was present in owner storage. In
[`scenario-receipt.ts`](../packages/state/src/invocation/scenario-receipt.ts),
`executeScenarioReceiptRequire` first projects the admitted anchor through its
read policy, then calls `evaluateInstalledReadPredicate`. The scan runs in a
`read-predicate` lifetime; [`read-policy-membership.ts`](../packages/state/src/receipt/read-policy-membership.ts)
sets its control projection only for `read-policy` lifetimes. Consequently,
[`source-policy.ts`](../packages/state/src/query/source-policy.ts) applies viewer read policies to
the `Secret` scan. The hidden row drops out, `any(...)` is false,
`require not has_block(...)` passes, and the label write commits. The final
check validates that same visible domain. This contradicts
[`DESIGN.md`](specification/DESIGN.md) §4: mutation decisions and their helpers inspect
bounded owner state without recursively applying viewer read policies; guard
data does not thereby become a result grant.

Two more boundaries were checked with the same write-bearing scenario:

- Changing `Anchor` read policy to `members and row.label=="Other"` made the
  admitted anchor unreadable. With **no Secret row**, invocation rejected with
  `forbidden` / `Source Require record is not readable.` and left the label
  unchanged. It wrote a rejected receipt. The source above has `by=members`
  and a passing guard in this case; [the specification](specification/DESIGN.md)
  says an ordinary viewer read grant is not an extra mutation prerequisite.
  This denial occurs before the search is evaluated.
- Removing the helper's `active_member` call still emitted
  `nativeScenarioRequire` and receipt disclosure, but omitted
  `canMembershipSources`. The installed runtime rejected each of the three
  Secret-row cases with validation error `Scenario Require lacks its complete
  independently checked original guard observer.` It made no receipt or
  business write. The membership call in the main probe lets the checked
  guard path execute; it does not explain the visible-versus-hidden result.
  The compiler's JS emitter publishes the two source inventories under
  different conditions, while Cloudflare's `nativeScenarioRequire` binding
  requires a matching entry in `canMembershipSources` before invoking State.

These are observed behavior boundaries, not fixes or proof that they share
one root cause.

The revision fence was exercised separately. Each run began with no `Secret`
row; an external writer inserted a blocking row after the first guard scan,
either just before final revalidation or immediately before the first commit.
The original attempt did not commit its label write. State re-admitted the
same invocation at the new revision and scanned `Secret` again. A newly
visible blocker then produced `rule_failed` with the label unchanged; a
newly hidden blocker was still filtered out and the retried invocation
committed `label="entered"`. The late insertion also defeated the first
commit's expected-revision check. This shows that the tested revision race
is detected and retried, while the authority mismatch persists on the fresh
attempt. It does not establish every concurrency boundary.

The language already specifies empty `any=false`, empty `all=true`, nullable
`first`, sequential short-circuit, propagated predicate failures, and rollback
of domain effects after a false `require`. Those semantics need to survive
the eventual owner-state implementation, along with authored guard order,
bounded queries, and commit-time revalidation. These probes have not exercised
`all`, `count`, or null handling.

## 2. Event handlers that send or create (historically ~17 diagnostics)

The original note described a narrow receipt-aware event-handler shape and
said every failing handler was declined. Current code has additional ordinary
handler paths, so that statement is not a reliable current classification.
The exact remaining failures and the authority for outside event data need
their own source and runtime investigation.

## 3. Data flowing across two models (historically ~20 diagnostics)

The original note called cross-model search/create/return scenarios a blanket
compiler refusal. Current code supports some cross-model flows, so the
remaining failing shapes need to be identified individually. Their proof and
result-disclosure boundaries have not been reproduced in this investigation.

## Other historical claim

The old note also called `!=` inherently unsealable. That claim was not
investigated here and should not be treated as a current design conclusion.

## Small-list execution (2026-10-20): what changed and what was refused

A separate pass worked the ~50 diagnostics outside the big three, from 107
down to 91 (`complete:true, omitted:0`; span-insensitive diff per shipped
fix, zero new diagnostics). Two fixes shipped; everything else was recorded
as a fail-closed refusal. The sealed-evidence reasoning matters for the big
three because several refusals below are load-bearing for receipt
transitivity.

Shipped:

- UI display lists/tables over result bindings (8 diags). Result and
  row-bound collections carry the element model in the type
  (`Array Record stored:true`); binding a row reuses the same authorized
  rows, no new fetch. Contract rows admitted with `stored:false` (no
  read-grant path).
- Membership observations (7 diags). Root cause was scale, not soundness:
  one shared `SemanticJoin` accumulated its 16384-node budget across every
  predicate page, dying at an arbitrary page and taking the whole membership
  bridge down with it. The budget now bounds one pairwise page join instead
  of the whole cohort. One `E6007` relocated honestly to a still-refused
  direct `active_member` reference in a send guard.

Refused (fail-closed; each would weaken sealed evidence or bless a
tainted sink):

- Localized `format()` in business statements (8 diags). 6 are masked by
  send-guard declines; 1 is dynamic-template injection-shaped; 2 would bake
  build-locale text into sealed-eligible audit rows. Locale-null rendering
  is deterministic per build but the fields are cross-locale audit evidence.
- Cross-operation call effects (7 diags, heterogeneous, no single fix):
  4 pass bare params but their callees contain `format()` (downstream of the
  format refusal, proven by repro); 1 passes a foreign-key hop the
  disclosure provenance gate declines (only literal `.parent` on ChildOf is
  admitted — widening was rejected because callers guard only non-null
  linkage, so the sealed receipt would attest admission that was never
  checked); 1 binds a model the callee did not create; 1 unresolved.
- Hook context (12) plus invoice `on=` triggers (5): legacy hook handlers
  lower without ambient context by design (Rule A). Queries, derive calls,
  staged field reads, and `now` in hooks need the handler skeleton.
- Money-header `stat` blocks (3): the stat factory renders text only and raw
  money throws at runtime; rendering money as text is localized
  presentation (see format refusal).
- Remainder, by design or app-side: bare `history` in a row-less action
  form (1); list filters naming non-enum computed flags (2); an empty
  placeholder `collapse`/`skeleton` pair (2); one collection call over a
  multi-collection predicate (big-three item 2 downstream, 1).

Current census (91): send-dispatch-guard 27 and first-query correspondence
21 are the big-three core; the rest is the refused surface above. Anything
that clears the big three must preserve the refusals listed here — they
are the same seal, not separate limitations.
