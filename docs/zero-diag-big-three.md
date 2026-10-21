# The big three: investigation notes

The earlier estimate of 107 diagnostics and roughly 50 attributed to these
three areas is historical, not a current diagnostic census. The original
descriptions were too categorical: current code supports some of the shapes
they called refused. Investigate each issue against the compiler and installed
runtime before choosing a design.

The parent commit before the recovery pinned `draft` to
`fe2502ea4c57140ad3fccea3bd976119445440d4`, but that object is unavailable
from the draft remote. Canlang now pins the recovered draft main merge commit
`bbf29d178a43bca6dcce486d501c0b3d43fc9ebe`. The 2026-10-21
reproduction uses the earlier draft main `32cc63933a8310ea9b6f00f67dd6e2117e1f7324`;
its 24 source operands also generate two contribution sources. A prebuilt
compiler capture on that published revision completed with 106 diagnostics
(`complete:true`, `omitted:0`). It is a different compiler build and draft
revision from the earlier capture below, so count changes alone do not
establish the effect of a particular fix.

The October 20 Canlang gitlink update identifies `fe2502e` as a later draft
revision and describes four optional-navigation insertions in
`apps/CanLeave/CanLeave.can`. An October 21 migration archive preserved that
exact two-line source change; [its patch](recovery/canleave-fe2502e-source.patch)
is also kept in this repository so it does not depend on the missing submodule
object. Recovery commit `80e4f0829ecff14f6d19ea947f5137e97dd8d8dc`
reconstructs it on the earlier main and is now merged into draft main at
`bbf29d178a43bca6dcce486d501c0b3d43fc9ebe`; it is not the missing Git
object. A four-source compile with the same release compiler and catalog
reports 10 diagnostics on the earlier main versus 7 on the recovered source:
precisely the three `CanLeave` value
query order `E6008` diagnostics disappear. The recovered 24-source capture
completed with 88 diagnostics (`complete:true`, `omitted:0`). Compared with the
92-diagnostic capture below, it also lacks an unrelated `CanShift` external
`active_member` diagnostic, so that full-capture difference cannot all be
attributed to the recovered draft change. Canlang commit `0eb9162c` replaces
the unavailable `fe2502e` gitlink with the current draft main merge commit.

An earlier release build on published draft main completed the same
24-source capture with 92 diagnostics (`complete:true`, `omitted:0`). A build
before that had 98; the 92-diagnostic capture clears the original
`CanDesk.handoff` call, `CanPurchase.accept_invoice` created-result, and
`CanLeave.cancel`/`retry_release` guarded-SEND refusals, as well as nine
helper-contained source-`Require` and two viewer `CanLeave.preview` first-query
sites. At that earlier capture, `CanCustomer.accept` still lacked a multi-query
owner receipt, and `CanLeave.decide` still lacked a complete native owner
receipt. The sections below distinguish installed and full-draft clearances
from remaining gaps. The prebuilt compiler came from another commit, so its
106-to-92 count change is
an observed capture comparison rather than isolated per-change attribution.

The preceding release build over the recovered draft completed with 87
diagnostics (`complete:true`, `omitted:0`). Compared site-by-site with the
88-diagnostic recovered-draft capture before the event repair, exactly the
two original `CanContract.notice` and `CanContract.due` guarded-SEND refusals
cleared. One unrelated `CanShift` external `active_member` diagnostic appeared
in the new composition; the total 88-to-87 change therefore understates the
two event-site clearances and is not a general zero-diagnostic claim.

The preceding release build completes the same 24-source capture with 86
diagnostics (`complete:true`, `omitted:0`). A site-by-site comparison shows
exactly one cleared diagnostic and no new ones: the original
`CanCustomer.accept` first-query `E6008` at offset 14313. CanCustomer now has
zero diagnostics; the remaining 86 are separate sites.

The current release build completes the same 24-source capture with 85
diagnostics (`complete:true`, `omitted:0`). The only site change is the cleared
`CanBook.remind` guarded-SEND `E6008` at offset 34178; no new diagnostics
appear. The checked handler ties the original header Require and SEND Rule to
its Appointment, recipient Contact email, Calendar instructions, and Notice
create. State promotes the Contact only through the observed Appointment
reference and fences both rows before commit. An installed test covers a
hidden Contact, stale and cancelled appointments, changes before dispatch,
and a Contact update at commit; two altered-source variants remain refused.

## 1. Searches inside rules (historically ~30 diagnostics)

**Implementation status, 2026-10-21:** The first owner-decision repair is now
implemented for independently checked source-`Require` guards and the confined
`any` plus decision-only `first` composition. Installed-runtime integration
checks show hidden blockers reject, a membership-free guard executes, an
unreadable anchor adds no viewer-read prerequisite, and ordinary `read=true`
queries remain viewer-filtered. Helper-contained `ChildOf` scans now admit
only exact original parent-parameter substitution; a copied or unproved
receiver still gets `E6008`. A checked void `first` null branch can select an
owner row for a create or an authorized update target, including a hidden
row, while copied selected fields and later unproved uses remain refused.
An order-only contained `first` target has a separate checked empty-predicate
receipt and State admission; an unscoped version remains refused. The tables
and failures below record the *pre-repair reproduction*.

A separate checked profile pairs one leading `any` guard with a contained
`first` null-branch update target over the same original parent and model.
`CanCustomer.accept` now composes that pair with its earlier `has_role` and
repeated per-location `has_location_role` source-`Require` observations. The
compiler admits the helpers' role formal only when it reuses the declared
`CompanyRole.role` enum field. It also verifies the original
`invitation.parent` reference in the final event payload and matches the
void create/SET/Emit effects to their source statements. State fences the
hidden owner observations and selected target at commit; the genuine owner
finalizer stages the emitted Work source, including when an unrelated Mail
binding exists. Installed checks cover hidden administrators, every required
location, an unrelated parent, a hidden inactive existing target, a commit
race, and exactly one correctly populated event on success. Copied parent
paths remain refused. The full recovered-draft capture confirms the original
`CanCustomer.accept` diagnostic is gone.

The nearest remaining void mutation is `CanMember.assign`: its
`first(term.Seat...)` drives a null-branch create or selected-row update,
but the leading decision also counts active `Seat` rows and evaluates
`has_role`, per-location `has_location_role`, and `eligible_account` helper
searches over other stored models. The admitted helper-observation plus
same-model pair does not yet cover its Seat count and `eligible_account`
cross-model observations. Admitting only the `first` would omit those guard
domains and their source order.

The other original mutation-body sites additionally copy selected fields
into effects, return an existing selected row, or select after earlier
effects and nested loops; they require corresponding value, result, and
stage proofs rather than a generic `first` allowance.

An exact leading helper `can_work(actor,ticket.location)` over a required
original Model field uses the source-`Require` observer, whose installed
predicate reads the hidden owner domain and fences it at the initial stage.
The `CanDesk.handoff` shape also has an unrelated `photo:file?=null` input.
Its source-`Require` admission now verifies that exact literal-null declaration
is unused by every Require guard; the fresh-IR serializer rejoins the null
default, and the Cloudflare loader accepts only an actual null for this
observer. A non-null File still needs separate owner-stage File provenance.
Installed probes with a created model result and with a child
call→set→returned Repair both commit for a hidden active Employee, reject
hidden inactive or unrelated rows, and leave ordinary `Employee.read`
viewer-filtered. They cover a compound null/model guard and null File
forwarding, but full imported `CanDesk.handoff` clearance still requires the
complete 24-source capture. That capture now clears the original
`CanDesk.handoff` call-effect `E6008` at offset 19160; two independent
CanDesk list-filter diagnostics remain.

An ordinary viewer `read=true` body can now apply a source-checked model
`first` to the canonical viewer `records` result. The installed regression
checks hidden rows, an authored `where` clause, ordering, and membership
revocation. In a four-source dependent compile, the two original
`CanLeave.preview` first-query refusals cleared; its two mutation `request`
first-query refusals did not. This viewer path grants no owner decision query.

An earlier 24-source compile finished with 103 diagnostics (`complete:true`,
`omitted:0`), compared with 91 in the 2026-10-20 capture. Fourteen newly
explicit `E6008` refusals are helper-contained `ChildOf` source-`Require`
shapes that still lacked exact parent substitution; two former send-guard
diagnostics cleared. All 21 original `first` correspondence diagnostics
remained in that earlier capture. It predates the exact helper and viewer
repairs above.

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

The [owner-state rule-search design](design/rule-search-owner-authority.md)
specifies the authority, source proof, stage, commit and disclosure boundaries.

Additional compiled-runtime probes expose further boundaries. Keeping the
original root helper query but granting `Secret.read` only `anchor` makes a
visible blocking row reject with `forbidden` / `Record field is not readable.`
The row remains in storage, and no business write occurs. Omitting
`Secret.read` entirely makes the same compiled guard commit past a blocking
row. A root `Secret` query that reads `secret.parent` for a declared
`Secret in Anchor` child still rejects a visible blocker and commits past a
hidden one.

A direct leading `require not any(anchor.Secret as secret,...)` has a native
receipt and shows the same hidden-child commit. The emitted function uses
`nativeScenarioRequire`, the same source-`Require` observer as the root helper.
With no child row and an `Anchor.read` rule that rejects its label, this
direct guard also returns `forbidden` / `Source Require record is not
readable.` before its business test, confirming the extra viewer prerequisite
on the same path.
A helper containing the same `anchor.Secret` collection has **no** native
receipt disclosure: the source checker admits declared array fields through
helpers but not this implicit `ChildOf` collection. With `active_member`, the artifact fails installation
(`Membership owner lacks its original checked disclosure source.`); without
it, the generic scenario refuses the ruled child model at invocation. The
direct and helper-contained cases need distinct compiler admission proofs;
admitted guards should inherit the same decision authority.

A separate admitted composition was exercised from
[`any-first-composition.can`](../compiler/tests/fixtures/any-first-composition.can).
Its leading `require not any(invitation.parent.C as grant,...)` tests
`grant.account==actor and grant.role==invitation.role and grant.active`;
the body selects `first(...)` by account and role, requires a nonnull row,
then creates `D`. The runtime probe added `C.hidden:bool=false` and
`policy C read=members and not row.hidden` to the fixture. It seeded valid
parent `P` and invitation `I` rows plus these `C` rows, compiled with native
receipts, and invoked `accept` with a real member session:

| Owner-state `C` rows | Caller-visible `C` | Outcome | `D` rows |
| --- | ---: | --- | ---: |
| Visible inactive | 1 | Committed | 1 |
| Visible active | 1 | Rejected, `rule_failed` | 0 |
| Visible inactive + hidden active | 1 | **Committed** | **1** |
| Hidden inactive only | 0 | **Rejected, `rule_failed`** | **0** |

The third case should reject: the hidden active row matches the leading
guard, and the visible inactive row keeps the later `first` query satisfiable
so it cannot mask the guard defect. The emitted function uses
`executeScenarioReceiptAny` plus `executeScenarioReceiptQuery`, without
`nativeScenarioRequire`. State's `executeScenarioReceiptQueryMode` captures
the bounded owner domain, then calls viewer-only `queryRecordsObserved` with
the source read policies; the hidden candidate drops out before the guard's
predicate. This is a second observed authority seam. In the fourth row, the
hidden inactive child does not match `any`, but should satisfy `first` and
its sole consumer, `require c!=null`. The runtime treats it as absent. The
third row isolates the leading `any` defect because its visible inactive
child keeps that later `first` satisfied.

The earlier capture's 21 `first query: original native query correspondence`
diagnostics are heterogeneous: six occur in derive declarations (including
two used by an explicit `read=true scope=authority` report), two in
`CanLeave.preview` (`read=true` without that scope, so viewer authority), and thirteen in
mutation scenario bodies. The latter include idempotent create/update
branches, effect-target or field selection, guarded evidence, and returned
existing rows. They cannot all acquire owner authority from the spelling
`first`; the original consumer and any result/effect flow must be checked.

The six derive-declaration sites were checked separately against the current
source and runtime. None has a safe local `first` exception. The native
first-query receipt currently binds a source-backed **scenario-body** `let`
and its original consumer; a derive has no such admission or frozen query
stage. The new pure-first exception belongs only to an ordinary viewer
`read=true` body, not a helper whose authority varies by caller. In
particular:

| Derive `first` sites | Missing correspondence |
| --- | --- |
| `CanInvoice.first_paid_invoice` | `received` and the `first_receipt(invoice)` order key depend on payment child domains. Its callers both decide and create/update `CommercialHistory`; the first row, all candidate/order dependencies, and the effect consumer need one owner-fenced proof. |
| `CanRefer.latest_capture` | The exported nullable `Capture` selection follows advocate/partner references, reads their collection memberships and `now`, and is called from other apps' mutation guards. A helper-local grant would cross both owner and module boundaries. |
| Two nested `CanRent.saved_rows` selections | Each point chooses a `ResourcePolicy` and `LocationPolicy` by dynamic `left`, inside nested `flatten` projections returned by `resource_report`. That report has explicit `scope=authority`, but its current State decision query accepts only bounded data-only selections; the Cloudflare host rejects callback predicates and contained-parent filters. The source needs a per-point owner snapshot and a result grant for the complete `Contribution[]`. |
| `CanShift.previous_work` and `next_work` | `travel_entered` calls both helpers repeatedly from mutation and trusted-event decisions, then reads nullable selected-row fields. The predicates use dynamic employee/skip/time values and order by time, so each call needs the inherited owner stage, whole candidate order, selected fields, and commit-fence correspondence. |

Among mutation-body sites, `CanInvoice.issue` takes the order-only first row
of unscoped global `Defaults`, reads its retry fields in a Require, and copies
three fields into the Invoice SET. The same owner also has a `Line` count,
an Invoice `any` guard, a `can_work` helper, a Line sum, settlement and EMIT,
guarded SEND, and SCHEDULE. The current first receipt has no selected-Defaults
field dependencies and State's decision grant accepts one query; the existing
order-only target profile requires a contained parent. A correct extension
must fence those original guard domains and selected Defaults fields together
with the mutation value lineage, rather than admitting that `first` alone.

The underlying refusal in [`js.rs`](../compiler/src/codegen/js.rs) therefore
remains appropriate for the six derive sites; allowing `first` over an unfenced model
array would change the query authority or expose a stale selected row. A
future implementation should issue a checked derive-call-site recipe under
the caller's actual viewer or owner mode and test hidden candidates, ties,
parent changes, and concurrent row/domain changes through the installed
runtime.

The existing bounded owner query was checked with nonblocking rows: 200
`Secret` rows allowed the mutation, while 201 produced `validation` /
`Owner mutation query exceeds its row bound.` with no business write. The
storage implementation still labels content expiry as a later slice, so no
current runtime expiry result is claimed for these probes.

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

The original `CanContract.notice` and `CanContract.due` handlers now have an
exact declared-event SEND profile. The compiler matches their complete
IF→Mail SEND→NoticeDelivery CREATE shapes, the declared `Notice` or
`ObligationDue` model field and revision, original source and IR occurrences,
and the guarded Rule's typed inputs. The private Work due path supplies the
retained event payload; State binds it to the current owner row and fences
that row and its navigated Term/Agreement parents before commit. An installed
notice probe sends and creates once for a current Term, and a due probe does
the same for a current Obligation. The notice probe also checks the nullable
executed-party snapshot and localized subject against the verified app locale.
Stale revisions, a null snapshot, terminated or done rows, inactive parents,
and changes after scheduling produce no Mail intent or NoticeDelivery. Forged
occurrences, changed retained schedule payloads, tampered terminal status,
and undeclared event fields are refused. New File inventories retain only the
void result type rather than duplicating the large checked disclosure; an
unchanged older full-void inventory reopens, while an altered plan is refused.
The two original CanContract SEND `E6008` sites clear in the complete recovered
24-source capture.

The original `CanBook.remind` handler now has a separate exact profile for its
header Require followed by Mail SEND and Notice CREATE. Its recipient crosses
the required `Appointment.contact` reference into `customer.Contact.email`;
the generated receipt pairs those original observations before the protected
target is read. The installed hidden-Contact and race checks pass, and the
complete 24-source capture clears precisely that SEND site.

The [exact event-row SEND carrier design](design/event-send-owner-row.md)
specifies the remaining compiler, Cloudflare, and State proof for
`CanInvoice.overdue`. Its guard reads derived `Invoice.balance`, whose Credit,
Attempt, and ExternalPayment dependencies still lack a bounded frozen
source-owner snapshot and commit fence. That handler remains refused.

A bounded ordinary mutation SEND repair now carries a checked field narrowed
from its nullable declaration after a successful source `require`; the
original declaration remains part of the transport proof. SEND guard
preparation stages each owning scenario atomically and checks its fresh IR
diagnostics, while the whole-IR and checked-type correspondence seals remain
fatal. A missing native guard emits `E6008` and a runtime throw instead of
falling back to a callback. The installed test commits exactly one Mail intent
for a current nonnull recipient and none for a null recipient or a failed
state guard. A mixed-source negative fixture reports `E6008` only in the
unproved event handler, leaving its separate valid mutation owner clear.
`event` remains refused as a free SEND guard name outside the two exact
CanContract private profiles. The five
additional original Invoice standard-trigger failures are classified there.

The preceding recovered-draft release capture finished with 87 diagnostics
(`complete:true`, `omitted:0`), including 21 guarded-SEND refusals: 14 at
unprepared guard sites and seven at owners whose native receipt still lacks
complete correspondence. The compiler now indexes only original guarded-SEND
scenario subtrees, so the corpus no longer trips the 200,000-node global CST
census before owner preparation. The original `CanLeave.cancel` and
`CanLeave.retry_release` SEND refusals cleared in the complete corpus; its
`decide` SEND guard is prepared, but the owner still reports a native receipt
refusal. Its first checked disclosure decline is the contained
`all(request.Portion as portion,...)` guard: the present source-`Require`
observer only admits a stored reference-array `all`, and this one also reads
derived allowance `remaining`. It needs a bounded owner child-domain and
derived-dependency receipt before the SEND stage can be admitted. A scratch
closure with only that guard removed then declines `request.timezone` inside
the SEND payload's `local_instant(...)`: the stored timezone field lacks an
exact receipt value transport. The branch's SET→SEND→SET effects still need
their own complete owner-stage match. The two
original `CanMaintain` ordinary guarded SEND sites at offsets
20318 and 21253, and the `CanEvent` site at 60773, also cleared. The guarded
`CanInvoice.overdue` event SEND still reports `E6008` at its predicate (offset
73254), as do other unproved event/source shapes. Clearing an owner's
SEND Rule does not by itself admit its whole scenario receipt.

## 3. Data flowing across two models (historically ~20 diagnostics)

**Implementation status, 2026-10-21:** Cross-model search/create/return is
not a blanket refusal. The original `CanCRM.promote_research` compiles with
zero diagnostics; an installed-runtime regression now checks its `first`
selection, Deal and ResearchIntake creates, returned Deal, replay, and changed
evidence. That run exposed a use-before-initialization in Cloudflare's File
staging census, now fixed in [`invoke.ts`](../packages/cloudflare/src/runtime/invoke.ts).

The remaining original `CanDesk.handoff` call effect had two independent
source-proof gaps: its leading `ticket.repair==null` guard selected a nullable
reference, and `set ticket {repair}` consumed the immediately preceding
`CallAs` result. The compiler now admits those exact shapes while retaining
their original source and result lineage. In a 15-source imported CanDesk
closure copied from published draft main, the handoff's `E6008` call-effect
diagnostic cleared; that closure still had 32 other diagnostics. A separate
installed-runtime regression creates one child Repair, stores its returned
reference on Ticket atomically, and rejects a repeated handoff without a
duplicate. A further exact source and owner-stage carrier now forwards a
nonnull optional `photo:file?` through the same-owner child call. The
installed integration checks a real finalized File, omission, invalid File
reference refusal, child retention, and replay; the earlier null-input case
still checks that no File access occurs. The tested sources and runtime
assertions are
[`native-cross-model-promotion.can`](../packages/cloudflare/test/fixtures/native-cross-model-promotion.can),
[`native-cross-model-handoff.can`](../packages/cloudflare/test/fixtures/native-cross-model-handoff.can),
and [`native-cross-model-promotion.integration.test.ts`](../packages/cloudflare/src/runtime/native-cross-model-promotion.integration.test.ts).
The complete published 24-source capture now clears the original
`CanDesk.handoff` call-effect refusal. Its leading
`can_work(actor,ticket.location)` helper guard passes through the checked
source-`Require` owner observation, including the unrelated literal-null
`photo:file?` parameter. An installed combined regression checks the helper
decision over hidden Employee rows and the child create/set/return path.
Two unrelated list-filter diagnostics in CanDesk remain.

The original `CanPurchase.accept_invoice` create-result diagnostic exposed a
different exact-source mismatch. After creating Payable, the scenario sets
the required `invoice_document:InvoiceDocument` input to reference it and
returns the new Payable. Created-result receipts now reuse the existing
source-matched required-parameter SET proof, which checks the original
parameter, authored receiver, type, and source span. The untouched original
five-source CanPurchase subset clears that created-result `E6008` while its
independent first-query/stat diagnostics remain. The installed regression in
[`native-created-result-required-set.can`](../packages/cloudflare/test/fixtures/native-created-result-required-set.can)
checks the create, SET, and returned-row identity plus the repeated-call
guard. The complete published 24-source capture also clears the original
`CanPurchase.accept_invoice` created-result refusal.

The next original call-effect candidate, `CanPropose.offer_alternative`,
remains outside this profile. A focused compiler trace located the first
failure in its child `propose.revise`: the `can_work` helper's
`any(Employee...)` query in the shared Employees source has no complete
query closure there. Its first effect is also a filtered
`proposal.Revision` loop with a conditional second SET. Source loop closure
admits only an unfiltered original array or contained-member domain and a
body of direct SETs; the `ForMember` receipt likewise requires an unfiltered
contained collection. The parent therefore has no complete model-result
child to call. Independently, it SETs a field on the returned replacement
and copies `revision.Item` with a CREATE inside another loop, while the
current per-element loop proof admits only SET. A call allowance alone would
bypass filtered-query authority, branch decisions, and per-element creates.
The four CanRent fulfillment wrappers reach children with branch, SEND,
schedule, cancel, and evidence creates; CanField's conditional inspection
call reaches a child with cancel and conditional Repair creation. Their
remaining `E6008` call sites require complete child receipts for those
effects rather than a generic call allowance. The required loop/query,
per-row mutation, and item-copy interfaces are specified in the
[contained mutation loop design](design/cross-model-contained-loop.md).

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

The 2026-10-20 census (91): send-dispatch-guard 27 and first-query correspondence
21 are prominent big-three-related diagnostic groups, but the latter spans
different evaluation sites as classified above. The rest is the refused
surface above. Anything
that clears the big three must preserve the refusals listed here — they
are the same seal, not separate limitations.
