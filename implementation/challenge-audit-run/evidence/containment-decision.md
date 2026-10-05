# T28 prep: imported-containment semantics — alternatives for the JEV gate

Status: **PROPOSED / PREP — adopts NOTHING.** Decision requires the
coordinator-run JEV protocol (three fresh, equivalent, independently worded
requests with saved advice/uncertainty) plus full-scope evidence. Every
alternative below carries explicit **JEV-PENDING** markers. No T29
implementation may begin before the gate accepts one rule.

Scope note (T28 brief): distinguish declaring identity, local/remote
dependency, parent/storage/authority, reverse relationships, and migration.
Done when an accepted rule preserves workflows and handles cycles/lifecycle.

## Settled context (read-only inputs, not decisions)

- R14 ([root-causes.md](root-causes.md)): E2008 x20 — `containment target is
  imported; containment needs a package-local parent`. Bucket **b** with a
  JEV-gated decision; confidence medium; flip needs demonstrated unenforceable
  unsafety plus a comparably concise alternative preserving the workflow.
- Named R14 sites (6 + 14 further unattributed — see gate needs):
  Expense:11 `Expense in Employee`, Invoice:58 `CommercialHistory/CommercialSale
  in Customer`, Reception:40 `GuestPolicy in Location` (plus `Visit`,
  `HostPresence in Customer`), Leave:22 `Calendar/Allowance in Employee`,
  Onboard:15 `Checklist in Employee`, Propose:40 `Proposal in Customer`.
- All named parents arrive via **plain** (non-bound) imports — `use employee
  {Employee,...}`, `use customer {Customer,...}`, `use rent_catalog
  {Location,...}` — with no `from=` binding. Per DESIGN, a plain import
  includes the whole owning executable package internally. **No R14 site uses
  a bound (`from=deployment...`) remote parent.** Local-vs-remote is therefore
  a live design axis with zero draft evidence on the remote side.
- Adopted local-containment semantics (DESIGN, read-only here): `Model in
  Parent` creates an implicit required immutable `parent:Parent`; the child
  inherits the parent's team and storage owner; `parentRecord.Child` is a
  typed collection; changing containment is not an ordinary update; delete
  archives the subtree atomically; a child write does not advance the parent
  version; uniqueness scopes within the containing parent; `parent` is a
  protected contextual binding; creation defaults may read `parent`.
- Adjacent settled rules: dependency cycles between stored model references
  are allowed, but containment cycles are errors (DESIGN import section); a
  model, its policies, invariants, and canonical CRUD belong to one package —
  other packages may `call` imported operations but cannot directly mutate the
  model or extend its policy. OPEN #60 (DECISIONS): parent traversal still
  needs precise semantics. R07 parent selectors (`row.parent...` in policy/UI)
  are accepted via T08; R30 (Leave:131) shows `parent` converging with
  unrelated opacity roots on one line.
- App-intent dispositions: Expense, Invoice, Leave, Onboard, Propose,
  Reception are all ACCEPTED-WORKFLOW-INTENT with R14 as a T28-gated blocker;
  all runtime negatives retained.

## Workflows each alternative must preserve (acceptance bar)

1. Expense claims, Leave calendars/allowances, Onboard checklists rooted at
   the canonical imported `Employee` (no copied identity).
2. Invoice commercial history/sales and Propose proposals/revisions rooted at
   the canonical imported `Customer`, including policies reading
   `row.parent.locations` (Invoice) and `row.parent.location` (Propose).
3. Reception `GuestPolicy in Location` with `unique ... fields=parent`.
4. Multi-level nesting with an imported root: `Step in Checklist in Employee`
   (Onboard, incl. `parent.parent.user` default), `Item in Revision in
   Proposal in Customer` (Propose), `Portion in Request in Calendar in
   Employee` (Leave).
5. Negatives (R14): wrong parent, cross-team parent, missing/archive-state
   parent, and cycles fail in checking and applicable storage; an import
   supplies no parent-mutation authority.

## Alternative A — Full containment across plain imports

Rule: `Child in ImportedParent` has exactly the local-containment semantics
(team/storage inheritance, immutable `parent` binding, atomic subtree
archive/delete, parent-scoped uniqueness, `parentRecord.Child` typed
collection) whenever the parent arrives via a plain import whose owning
package is included in the selected app. Bound (`from=`) parents are rejected
as containment targets with a diagnostic.

- Declaring identity: child model keeps its declaring package identity
  (`expense.Expense`); only the *parent type* is imported.
- Local/remote: plain import = same deployment, owner transaction rules
  apply; bound import = remote, containment forbidden (reference field
  instead).
- Parent/storage/authority: storage owner = parent's owner (already the same
  included store); child CRUD owned by the declaring package; parent package
  policy still governs parent rows; consumer cannot mutate parent or extend
  its policy (existing package rule, unchanged).
- Reverse relationships: `employeeRecord.Expense` typed collection resolved
  through the whole-app index; readable only where child read policies grant.
- Migration: zero draft edits at R14 sites; checker rule change only.
- Workflows preserved: all five bar items hold verbatim, including
  `parent.parent` chains and `row.parent.*` policies.
- Cycle/lifecycle: containment-cycle detection runs over the whole-app
  package index (cross-package cycles are errors, same as local); subtree
  archive/delete spans the shared store atomically; `retain until` containing
  deadlines compose as local.
- Costs: cycle detection and subtree operations must be index-wide, not
  per-package; error messages must attribute across package boundaries;
  storage engine must prove same-store atomicity for cross-package subtrees.
- Strongest opposing case: cross-package subtree coupling lets a consumer's
  delete/archive cascade touch owner-package rows' children and lets a
  consumer's `unique ... fields=parent` constrain owner-adjacent state; a
  future split of the packages into separate deployments silently breaks
  atomicity promises; foreign-policy extension risk if reverse collections
  leak readability. **JEV-PENDING**: whether same-deployment inclusion is a
  sufficient atomicity boundary, and what diagnostic fires if deployment
  splits later.

## Alternative B — Reference-plus-scoping (no lifecycle coupling)

Rule: `Child in ImportedParent` desugars to a required immutable
`parent:Parent` reference plus team/storage inheritance, but WITHOUT subtree
lifecycle coupling: deleting/archiving the parent does not cascade to
imported children; uniqueness still scopes by parent; `parentRecord.Child`
resolves as a query over the reference rather than a stored reverse edge.

- Declaring identity / local-remote: as A (plain import only; bound rejected).
- Parent/storage/authority: storage owner inherited as A; authority identical
  to A for reads/writes; lifecycle authority stays per-package (each package
  archives only its own rows).
- Reverse relationships: derived query, not a stored edge; same readability
  grants as A.
- Migration: zero draft edits; observable behavior differs from A only on
  parent delete/archive and on orphan handling (explicit orphan rule needed:
  reject parent archive while imported children exist, or leave detached
  children readable — **JEV-PENDING** which).
- Workflows preserved: bar items 1–4 hold for create/read/query/policy paths;
  item 5 holds. Parent-deletion journeys would observe non-cascading behavior
  — no draft example currently pins cascade-vs-orphan for imported children
  (see gate needs).
- Cycle/lifecycle: no cross-package containment cycles possible by
  construction (references already allow cycles); lifecycle stays local, so no
  cross-store atomicity promise is ever made.
- Costs: two meanings of `in` (local vs imported) must be taught, diagnosed,
  and kept apart in every future `in` feature; orphan rule is new surface;
  if any workflow later needs cascade, it must be hand-built per app.
- Strongest opposing case: silent semantic split — identical syntax with
  different deletion behavior depending on import provenance is exactly the
  kind of spooky action the audit penalizes elsewhere; authors will assume
  local cascade and lose data-integrity expectations. **JEV-PENDING**:
  whether the cascade difference is acceptable drift or a workflow-breaking
  change, and which orphan rule (reject-archive vs detach) the drafts intend.

## Alternative C — Keep local-only containment; remodel imports as references

Rule: the checker keeps rejecting imported containment targets. Each R14 site
is remodeled under T36/draft-owner adjudication to an explicit reference
field (`employee:Employee` + policies/invariants/uniqueness spelled out);
`in` remains strictly package-local.

- Declaring identity: no imported parent types in `in` position; references
  use ordinary imported-type fields.
- Local/remote: moot — no cross-package containment exists in either form.
- Parent/storage/authority: child is team-scoped in its own package; team
  equality with the referenced row enforced by invariant/policy, not by
  construction; storage owner is the child's own package binding.
- Reverse relationships: explicit queries only; no `parentRecord.Child` sugar
  across packages.
- Migration: touches all 20 E2008 sites across 6+ files (draft-owner edits,
  each needing demonstrated evidence per T36); `parent.parent` chains
  (Onboard default, Leave derives, Invoice/Propose policies) must be rewritten
  per site; nested chains like `Item in Revision in Proposal in Customer`
  keep local links but gain a reference seam at the imported root.
- Workflows preserved: achievable in principle, but preservation must be
  re-proven site by site — alias/order/composition parity, policy equivalence
  (`row.parent.locations` → `row.customer.locations`), and default equivalence
  (`parent.parent.user`) each need a witness. Highest proof burden.
- Cycle/lifecycle: containment cycles stay per-package and checkable as
  today; no cross-package lifecycle promises; team-scoping invariants are
  author-written and author-auditable.
- Costs: largest authoring and review cost; verbose reference+policy idiom
  replaces a one-word relation; future imported-containment needs repeat the
  cost; risks T36 mass-edit pressure against the no-blanket-rewrite rule.
- Strongest opposing case: it discards the drafts' clearest relational
  intent (R14 intent: "retain canonical Employee/Customer identities as
  parents instead of copying them") and pays the maximum migration price to
  preserve a checker limitation rather than a semantic necessity — the flip
  side must show concrete unsafety, not just implementation convenience.
  **JEV-PENDING**: whether any R14 workflow is inexpressible or
  unsafety-prone as references, and whether the migration volume violates
  minimal-intervention.

## Alternative D — Owner-consented containment facet (opt-in per parent)

Rule: imported containment is allowed only where the parent's owning package
explicitly exports a containment facet (e.g. `export contain Employee` or an
equivalent owner-authored marker — exact syntax **JEV-PENDING**). Plain
import + facet = full Alternative-A semantics; missing facet = E2008 retained
with a diagnostic pointing at the facet; bound parents rejected regardless.

- Declaring identity / local-remote: as A, plus an owner-consent precondition.
- Parent/storage/authority: as A once consent exists; the facet may carry
  bounds (max depth, cascade-vs-orphan choice, exposed reverse collections) —
  facet expressiveness **JEV-PENDING**.
- Reverse relationships: only the facet-listed collections resolve (default
  none vs default all **JEV-PENDING**).
- Migration: zero draft edits at consumer sites IF owner packages add facets
  (employee, customer, rent_catalog owners each add one line); without owner
  cooperation, consumers fall back to B/C remodeling.
- Workflows preserved: as A wherever facets exist; partial if any owner
  withholds consent (no draft owner has yet been asked — see gate needs).
- Cycle/lifecycle: as A, with facet bounds as an additional static check.
- Costs: new declaration form + export/import visibility rules + facet
  compatibility across versions; three owner packages must be edited and
  versioned; consumers blocked on owner release cadence.
- Strongest opposing case: consent theater — in this corpus all parents are
  same-project packages, so the facet is a speed bump, not a trust boundary,
  and it strands consumers behind owner edits for zero runtime gain; for
  genuinely remote parents it still cannot promise atomicity, so it solves
  neither the simple case (A already does) nor the hard case. **JEV-PENDING**:
  whether any real trust boundary exists between these packages, and what the
  facet buys over A's plain-import rule.

## Fairness record (preserved opposing cases)

- A's risk: cross-package cascade/coupling and future deployment-split
  breakage (R14 opposing, this file).
- B's risk: silent two-meanings-of-`in` deletion drift (strongest against B).
- C's risk: maximum migration cost to preserve a checker limitation; intent
  loss (R14 flip burden).
- D's risk: consent theater with release-coupling cost and no atomicity gain.
- No alternative is ranked or adopted here. Ranking is the JEV gate's job.

## What the gate still needs (evidence checklist)

1. [COMPLETE — see "Site enumeration (gate evidence)" below] Full
   enumeration of all 20 E2008 sites (only 6 named in R14; 14
   unattributed) with per-site parent import provenance (plain vs bound).
2. [COMPLETE — see "Site enumeration (gate evidence)" below] Confirmation
   that zero R14 sites use bound (`from=`) parents — currently
   true for named sites only.
3. Cascade/orphan intent: any draft example or policy pinning what parent
   delete/archive must do to imported children (none found yet; absence must
   be confirmed, not assumed).
4. Owner-package stance for D: whether employee/customer/rent_catalog owners
   would export a facet, and what bounds they would want.
5. Storage-engine input: can cross-package subtree archive be atomic in the
   included-store case (A/D), and what fails if deployments split?
6. Coordinator-run JEV protocol: three fresh equivalent independently worded
   formulations, saved responses + uncertainty, disagreement investigated.
   **No JEV was run for this prep file; tools/jev.py untouched.**

## Handoff

- Writer: L3 T28-prep. Single new file; DESIGN.md/GRAMMAR.md/DECISIONS.md
  untouched (read-only); tasks.md/monitor.md/inbox untouched
  (coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## Site enumeration (gate evidence)

Status: **PREP evidence — adopts NOTHING.** Closes checklist items 1–2
only. Alternatives A–D, fairness record, and remaining checklist items
3–6 are unchanged; JEV still not run.

Method: `can check --catalog=packages/values/dist/catalog.json
--format=json` over all 52 `draft/**/*.can` sources (49 top-level + 3
shared), byte-offset spans decoded to file:line via the envelope's
`sources` table; parent provenance read from each file's `use` lines;
bound-import census via `grep "use .*from=deployment"`. Read-only; no
builds, no source edits. Repro commands are listed at the end.

Result: **20/20 E2008 sites**, exit 10, `complete=true`, `omitted=0`,
2500 total diagnostics. The 6 R14-named sites are all present at their
R14 lines (Expense:11, Invoice:58, Leave:22, Onboard:15, Propose:40,
Reception:40); the other 14 were unattributed in R14 so line-identity
against the T01 run cannot be checked for them — the count still matches
exactly (20). Checker binary
`compiler/target/debug/can` sha256
`e90664d2e25bf89cab8eb1d2324bcad77b8733cf33adffe8f7ea788652706b61`
(post-T01 checker slices; E2008 family untouched by them). Caution for
reproducers: omitting the 3 `draft/shared/*.can` files drops the count
to 13, because `employee` and `rent_catalog` resolve from
`draft/shared/Employees.can` and `draft/shared/Locations.can`.

### All 20 sites with parent provenance

Every parent arrives via a **plain** `use` line (no `from=`). Package
context is noted where the file holds several packages.

| # | Site (child `in` parent) | Parent import (plain, no `from=`) |
| --- | --- | --- |
| 1 | `draft/CanExpense.can:11` `Expense in Employee` | `use employee {Employee,...}` at CanExpense.can:7 |
| 2 | `draft/CanInvoice.can:58` `CommercialHistory in Customer` | `use customer {Customer,...}` at CanInvoice.can:9 |
| 3 | `draft/CanInvoice.can:60` `CommercialSale in Customer` | same line 9 |
| 4 | `draft/CanInvoice.can:103` `export Invoice in Customer` | same line 9 |
| 5 | `draft/CanLeave.can:22` `Calendar in Employee` | `use employee {Employee,...}` at CanLeave.can:6 |
| 6 | `draft/CanLeave.can:25` `Allowance in Employee` | same line 6 |
| 7 | `draft/CanMail.can:25` `Service in Customer` | `use customer {Customer,...}` at CanMail.can:6 |
| 8 | `draft/CanMember.can:126` `export Membership in Customer` (`package member_terms`) | `use customer {Customer,...}` at CanMember.can:72 |
| 9 | `draft/CanMember.can:130` `BenefitRequest in Customer` (same package) | same line 72 |
| 10 | `draft/CanMember.can:132` `BenefitFence in Customer` (same package) | same line 72 |
| 11 | `draft/CanMember.can:144` `AccessWatch in Customer` (same package) | same line 72 |
| 12 | `draft/CanOnboard.can:15` `Checklist in Employee` | `use employee {Employee,...}` at CanOnboard.can:7 |
| 13 | `draft/CanPropose.can:40` `export Proposal in Customer` | `use customer {Customer,...}` at CanPropose.can:6 |
| 14 | `draft/CanReception.can:37` `Visit in Customer` | `use customer {Customer,...}` at CanReception.can:7 |
| 15 | `draft/CanReception.can:40` `GuestPolicy in Location` | `use rent_catalog {Location,...}` at CanReception.can:6 |
| 16 | `draft/CanReception.can:42` `HostPresence in Customer` | same line 7 |
| 17 | `draft/CanRefer.can:238` `export Capture in Customer` (`package sales_attribution`) | `use customer {Customer,...}` at CanRefer.can:233 (the line-13 `use customer {test_company}` in `package refer` does not name `Customer`) |
| 18 | `draft/CanSuccess.can:22` `Account in Customer` | `use customer {Customer,...}` at CanSuccess.can:6 |
| 19 | `draft/CanTime.can:19` `Entry in Employee` | `use employee {Employee,...}` at CanTime.can:6 |
| 20 | `draft/CanTime.can:20` `PeriodReview in Employee` | same line 6 |

Parents: `Customer` x13, `Employee` x6, `Location` x1. Forms: 16 plain
(`Child in Parent`), 4 `export`-form (sites 4, 8, 13, 17) — the checker
fires E2008 on both forms. Sibling control: `CommercialSale in Term` at
CanMember.can:140 (package-local parent) fires no E2008, confirming the
rule keys on import provenance, not on the child name.

### Bound-parent verdict: zero bound parents, corpus-wide

**Confirmed: no E2008 site uses a bound parent, and no bound parent
exists anywhere in the corpus.** Census: 76 `use ... from=deployment...`
lines across the corpus; every one binds versioned capability interfaces
or value types (`EmailV1 as Mail`, `ScheduleV1 as StaffSchedule`,
`RoomsV1 as Rooms`, `BillingV1 as Billing`, `MembershipV1 as Membership`
(member_terms), `Qualification`, `Settlement`, `SaleMilestone`,
`DocumentLine`, `Charge`, `ReportsV1`, `DimensionsV1`, etc.) — **none
binds `Employee`, `Customer`, or `Location`**, and the `employee`,
`customer`, and `rent_catalog` packages are never imported with `from=`
in any file. Two near-misses checked and excluded: `Membership` is bound
from `member_terms`/`deployment.membership` at CanReception.can:11 and
CanRent.can:76, but no containment targets `Membership`; CanLeave.can:8,
CanInvoice.can:14-18, CanMail.can:8, CanMember.can:75-76, and
CanTime.can:10 carry bound imports in E2008 files, yet each file's E2008
parent still arrives only through its plain `use` line above.

Consequence for the gate: the "bound parents rejected" clause shared by
alternatives A, B, and D is **untested by draft evidence in both
directions** — there is neither a bound-parent positive to preserve nor
a bound-parent negative proving rejection is intended. The local-vs-remote
axis noted in the prep remains live with zero draft evidence on the
remote side; this enumeration extends that from "named sites only" to
all 20 sites.

### Per-site alternatives discrimination

Shared by all 20: plain-import parents keep A/B/D-plain on the table and
give C its full 20-site migration bill. The notes below name what each
site (or group) adds beyond that.

- Site 1 (Expense:11): reverse-collection read through the imported
  parent at CanExpense.can:137 (`claim.parent.Expense ... where
  row.corrects==claim`) plus the parent-scoped invariant at :32
  (`row.corrects.parent==row.parent`) — discriminates A (typed
  cross-package reverse edge) vs B (derived query must support the same
  filter) vs C (both must be rewritten; the reverse sugar has no
  reference-form equivalent). Nested local children (Decision,
  Reimbursement, ReceiptExtract in Expense, :12-14) with
  `row.parent.parent.user` policies (:26-28) make the lifecycle seam of B
  observable mid-chain.
- Sites 2-3 (Invoice:58,60): commercial *history/evidence* rows with
  `row.parent.locations` policies (:64-65) and parent-scoped uniqueness
  (`unique CommercialHistory fields=parent`, :59). Audit-retention
  semantics make these the sharpest A-vs-B lifecycle witnesses: A's
  atomic subtree archive would take audit history with the customer,
  while B's orphan rule could retain it.
- Site 4 (Invoice:103, `export`): exported child of an imported parent
  with deep `row.parent.parent` policies on its own local children
  (:137-153, `owns(actor,row.parent.parent)`). Discriminates D (must the
  facet cover re-export?) and raises C's bar (export shape preserved
  through remodeling).
- Sites 5-6 (Leave:22,25): three-level nesting (`Portion in Request in
  Calendar in Employee`, :26-27) with `parent.parent`/`parent.parent.parent`
  policies, invariants, and example projections (:32-46, :112-118), plus
  a same-parent sibling reference (`Portion.allowance:Allowance?`, :27).
  Stresses A's index-wide cycle detection and B's mixed-chain deletion
  behavior; C must rewrite the deepest chains in the corpus.
- Site 7 (Mail:25): `Service in Customer` with its own lifecycle-ish
  state (`term`, `billing`, `active`). Deleting a customer while a mail
  service persists is the plainest A-cascade-vs-B-orphan question; no
  draft journey pins it (feeds checklist item 3).
- Sites 8-11 (Member:126,130,132,144): `export Membership` plus three
  fence/request rows under one imported parent; policies use
  `owns/has_role(actor,row.parent,...)` (:169, :183) and reverse
  collections (`row.Term`, :170). Fences (BenefitFence, AccessWatch)
  arguably should never cascade, so they discriminate B's orphan rule
  from A's uniform cascade; the `export` on site 8 repeats site 4's D
  question.
- Site 12 (Onboard:15): `parent.parent.user` creation default
  (`assignee=user=parent.parent.user`, :16) and derive/policy/crud reads
  through the chain (:17, :24, :37). Under C the default must be
  re-expressible without `parent`; under A/B it is the canonical
  cross-package default read.
- Site 13 (Propose:40, `export`): deepest export chain (`Item in Revision
  in Proposal in Customer`, :41-42), parent-identity invariant
  (`row.recipient.parent==row.parent`, :51), and cross-package
  parent comparison at :155-156
  (`capture.parent==revision.parent.parent`, where `capture` is Refer's
  site-17 child). The cross-package comparison is meaningful only if
  parent identity survives the import boundary — direct evidence for
  A/B/D-plain over reference remodeling.
- Site 14 (Reception:37): `Visit in Customer` holds a local `policy`
  field pointing at site 15's child (`policy:GuestPolicy`), coupling two
  E2008 subtrees (one rooted at Customer, one at Location) inside one
  file. Any alternative must keep both roots coherent simultaneously.
- Site 15 (Reception:40): the only non-identity parent (`GuestPolicy in
  Location`) with `unique GuestPolicy fields=parent` (:41). Discriminates
  whether the rule is identity-specific (a D facet could plausibly cover
  only Employee/Customer) or general over plain imports (A/B as written).
- Site 16 (Reception:42): `HostPresence in Customer` — presence evidence
  with its own retention shape (`until`, `ended`). Same A-vs-B retention
  tension as sites 2-3 in miniature.
- Site 17 (Refer:238, `export`): attribution capture under Customer in a
  second package block (`sales_attribution`), consumed cross-package by
  Propose:155-156. Joins sites 4/8/13 on the export-facet question and is
  the only E2008 child read from another file's logic.
- Site 18 (Success:22): `Account in Customer` dossier with local children
  (Milestone, Notice in Account, :23-25). Ordinary two-level nesting;
  adds no new axis beyond shared provenance, but counts toward C's bill
  and A's index-wide subtree scope.
- Sites 19-20 (Time:19-20): two children sharing one imported parent with
  a sibling collection link (`PeriodReview.entries:Entry[]!`, :20),
  conditional parent-scoped uniqueness (`unique Entry fields=parent
  where=row.until==null`, :36), and a sibling-quantified policy
  (`all(row.entries as entry,...)`, :30). Tests whether sibling
  composition under an imported parent behaves as one subtree (A) or as
  reference-linked rows (B/C).

### Commands run (read-only)

1. `compiler/target/debug/can check
   --catalog=packages/values/dist/catalog.json --format=json
   $(ls draft/*.can | sort)` — 49-file trial; E2008=13 (incomplete:
   missing shared packages; discarded for the count, kept as the
   repro caution above).
2. `find draft -name '*.can' | sort` — 52 sources (49 + 3 shared).
3. `compiler/target/debug/can check ... $(cat sources)` — 52-source run;
   exit 10, complete=true, omitted=0, 2500 diagnostics, **E2008=20**;
   spans decoded via the envelope `sources` table (script kept in
   `/tmp`, not committed).
4. `grep -n "use \\(employee\\|customer\\|rent_catalog\\)"` over the 11
   E2008 files — per-site provenance table.
5. `grep -rn "use .*from=deployment" draft/*.can draft/shared/*.can` —
   76 bound-import lines (39 files) census for the zero-bound-parents verdict.
6. Verifying greps (all read-only): nested `in` links, `parent.parent`,
   `row.parent`, `unique .*fields=parent`, `^package`/`^app` blocks,
   per-child policies, `claim.parent.Expense`, `corrects` invariant.

- Writer: L3 T28-enumeration slice. Appended this section and marked
  checklist items 1-2 complete above; no other text altered. No JEV run;
  no Git; no other files touched.
- Release: `implementation/challenge-audit-run/evidence/containment-decision.md`
  is RELEASED to the coordinator for JEV-gate scheduling.
