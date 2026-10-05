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
3. [COMPLETE — see "Cascade/orphan intent (gate evidence)" below]
   Cascade/orphan intent: any draft example or policy pinning what parent
   delete/archive must do to imported children (absence CONFIRMED: 20/20
   sites NO across 11 owning workflows + 3 owner packages; zero pinning
   examples, 4 documented near-misses).
4. [QUALIFIED — see "Owner facet/export posture (gate evidence)" below]
   Owner-package stance for D: export/consent machinery SURVEYED (no
   facet mechanism exists; owner willingness is UNKNOWABLE from source
   alone and must be carried by JEV as a design choice, not an
   empirical finding).
5. [QUALIFIED — see "Storage atomicity (gate evidence)" below]
   Storage-engine input: can cross-package subtree archive be atomic in the
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

## Cascade/orphan intent (gate evidence)

Status: **PREP evidence — adopts NOTHING.** Closes checklist item 3
only. Alternatives A–D, fairness record, and remaining checklist items
4–6 are unchanged; JEV still not run.

Method: for each of the 20 sites' owning workflows (11 consumer `.can`
files), full-file keyword sweeps (`cascade|orphan|detach`, `delete`,
`archiv`, `deactivate|offboard|terminat`, `expir`, `retain`,
`revoke|retire|suspend|disable`, `remove`, `void|cancelled|withdrawn`)
plus targeted reads of every lifecycle hit; owner packages
(`draft/CanCustomer.can`, `draft/shared/Employees.can`,
`draft/shared/Locations.can`) swept the same way; the 11 `.md`
companions + `CanCustomer.md` swept for cascade/orphan/parent-delete
language. Read-only; no builds, no edits outside this file. Question
asked of each site: does any draft example, policy, or scenario pin
what parent delete/archive must do to the imported children (cascade
vs orphan vs forbid)? A YES requires an exact file:line quote; a NO
records the read ranges that establish absence.

Result: **20/20 sites NO — zero pinning examples.** Four near-misses
documented below; each fails to pin for a stated reason. Corroborating
corpus facts: the words cascade/orphan/detach appear nowhere in the 11
files; no `.can` file anywhere calls `Customer.delete`,
`Employee.delete`, or `Location.delete` (the sole `Customer.delete`
reference corpus-wide is `draft/CanCRM.mjs:806`, desired generated
output — out of scope for draft intent); every observed delete in the
corpus is archive-style, never physical removal.

### Per-site verdicts (grouped by owning workflow)

- Site 1 (Expense:11, `Expense in Employee`): **NO.** The three
  `deactivate` journeys deactivate non-parent employees only
  (reviewer at CanExpense.can:89-91 and :158-159, finance worker at
  :329-335); the claim's own parent is never deactivated, deleted, or
  archived. `archived=include` at :292 and :347 are readability
  queries, not lifecycle rules. `delete=none` at :70 governs the
  child CRUD, not the parent. Read: full sweep lines 1-503; targeted
  reads :70-199, :280-356.
- Sites 2-4 (Invoice:58,60,103): **NO.** `delete=none` on Invoice
  (:273) and `delete=remove` on local Line (:279) govern child CRUD
  only. The page comment "Keep own issued invoices ... reachable
  after membership expiry" (:883) concerns the invoiced membership
  *product* (see :1 domain list), not Customer-row deletion, and no
  example exercises it. CommercialHistory scenarios (:641-680) never
  delete or archive the customer. Read: full sweep 1-1045; targeted
  reads :641-680, :878-947.
- Sites 5-6 (Leave:22,25): **NO.** No `deactivate` import, no
  `archived`, no parent delete anywhere; withdraw/cancel
  (:142-159) are child-request state transitions. Read: full sweep
  1-341.
- Site 7 (Mail:25, `Service in Customer`): **NO** (near-miss NM-1,
  see below). No Customer delete/archive scenario; `retain ... until`
  (:57) and expiry journeys (:156-169) are child-side retention.
  Read: full sweep 1-423; targeted read :95-204.
- Sites 8-11 (Member:126,130,132,144): **NO.** `remove_company_role`
  (:656) revokes a role grant, not the parent; the "retain paid term"
  journey (:663-666) deactivates a *local* Seat row. `archived=include`
  reverse reads (:674, :704) enumerate archived *children* without
  pinning the parent-to-child direction. Read: full sweep 1-912;
  targeted read :620-711.
- Site 12 (Onboard:15, `Checklist in Employee`): **NO** (near-miss
  NM-2). The parent row itself is deactivated mid-journey (see
  below), but the owner code proves that transition is not
  delete/archive. Read: full sweep 1-240; targeted read :53-137.
- Site 13 (Propose:40): **NO.** No Customer archive/delete/deactivate
  anywhere; only local Item `delete=remove` (:70) plus UI delete
  (:420). Read: full sweep 1-483.
- Sites 14-16 (Reception:37,40,42): **NO.** `archived_at==null` gates
  (:71, :85) gate creation/eligibility on parent state; no
  Location/Customer delete scenario exists. `visitor_days` /
  `credential_days` (:40) are child-side retention config. Read:
  full sweep 1-502.
- Site 17 (Refer:238): **NO.** No Customer lifecycle operations at
  all. Read: full sweep 1-268.
- Site 18 (Success:22): **NO.** `archived_at` appears only inside a
  policy field list (:28). Read: full sweep 1-223.
- Sites 19-20 (Time:19,20): **NO.** No Employee lifecycle operations
  at all. Read: full sweep 1-338.
- `.md` companions: **NO.** Zero cascade/orphan/parent-delete hits
  across all 11 companions plus CanCustomer.md.

### Owner packages (supplement — parent-side lifecycle surface)

- `draft/shared/Employees.can` (26 lines, fully covered): `crud
  Employee ... delete=none` (:16) — the Employee parent has no CRUD
  delete path at all; `deactivate` (:18-21) only sets
  `active=false,end=ended` (status flip, not archive/delete) and
  mentions no children. Employee-parented sites (1, 5-6, 12, 19-20)
  therefore have no parent delete/archive transition to pin.
- `draft/shared/Locations.can` (65 lines, swept): `crud Location ...
  delete=none` (:29); only create/update snapshot scenarios
  (:33-57), no delete/archive hooks. Location-parented site 15 has
  no parent delete/archive transition to pin.
- `draft/CanCustomer.can` (324 lines, swept + targeted read
  :150-225): `crud Customer` (:73) carries **no** `delete=` clause
  (default behavior, unpinned); `customer_deleted_access
  on=Customer.deleted` (:194-197) only emits `CompanyAccessChanged`
  and touches no children (local or imported); it has **no**
  examples block. Customer-parented sites (2-4, 7-11, 13-14, 16-18)
  have a delete event with zero observed child effects.

### Near-misses (each quoted; none pins)

- NM-1 — Mail:152-155 (reference survival, not containment):
  `call Contact.delete {record=delegate_contact}` then
  `history!=null -> true` with `history.contact.archived_at!=null`.
  Pins delete-means-archive plus referencing-row survival — but
  Contact is a *reference-field* target, not the containment parent
  (Customer). Says nothing about `Service in Customer` lifecycle.
- NM-2 — Onboard:111-112 (parent status flip, not delete/archive):
  `call deactivate {employee=test_worker,...}` — test_worker IS the
  Checklist's parent — then `call reopen {step=recovered,...} ->
  error(rule_failed)` via the `step.parent.parent.active` guard
  (:124). Children stay addressable after a parent lifecycle
  transition — but per Employees.can:18-21 that transition is a
  status flip, not delete/archive, and no child archived-flag is
  ever observed. Does not pin cascade vs orphan.
- NM-3 — Expense:159 (`claim.status -> ...submitted` after reviewer
  deactivation) and Member:663-666 ("retain paid term" after role
  removal): child rows survive *non-parent* lifecycle transitions.
  Discriminates nothing about the actual parent.
- NM-4 — Invoice:883 ("reachable after membership expiry") and
  Member:674,704 (`archived=include` child enumerations): readability
  of children across state changes, with no parent delete/archive in
  the causal path.

### Per-finding alternatives discrimination

- The uniform 20/20 absence **confirms** (no longer assumes) the
  Alternative B hedge that "no draft example currently pins
  cascade-vs-orphan for imported children." The cascade-vs-orphan
  choice between A (atomic subtree archive), B (orphan with an
  explicit rule), and D (faceted A) must therefore be carried
  entirely by JEV — no alternative gains draft support on this axis,
  and C's 20-site migration bill is unchanged.
- B's orphan-rule sub-variant "reject parent archive while imported
  children exist" has **zero draft support**: no draft anywhere
  shows a parent lifecycle transition rejected due to existing
  children, and NM-2 shows a parent transition succeeding with
  children present (conditional weight only — it is a status flip,
  not an archive).
- Hard cascade-delete (physical removal of children) has zero
  support corpus-wide: every observed delete is archive-style
  (NM-1; `Customer.deleted` read back via `archived=include` at
  CanCustomer.can:196). This forecloses only a reading none of A-D
  proposes.
- Owner CRUD silence is symmetric: Employee/Location `delete=none`
  plus Customer's missing `delete=` clause give D's facet-bounds
  question (item 4) no draft anchor — owner stance must come from
  the owners, not the corpus.

### Commands run (read-only)

1. `ls draft/` + `wc -l` on the 11 owning-workflow files (sizes
   recorded above; total 5278 lines).
2. `grep -rniE 'delete|archive|cascade|orphan|retain|destroy|purge|
   detach|remove|offboard|deactivat|terminat|until|expir'` over the
   11 files — hit census driving all targeted reads.
3. `grep -rniE 'cascade|orphan|detach'` over the 11 files — exit 1,
   zero hits.
4. `grep -rn 'delete'` over the 11 files — child-CRUD clauses plus
   Contact.delete / Step.delete / TemplateStep.delete-hook only.
5. `grep -rnE 'archiv|deactivate|offboard|terminat|expir|cancelled|
   withdrawn|void'` (two batches) — child-state enums plus the
   Expense/Onboard deactivate journeys and Reception/Mail gates.
6. Targeted `read_file` ranges listed per verdict above
   (Expense :70-199 + :280-356; Invoice :641-680 + :878-947; Mail
   :95-204; Member :620-711; Onboard :53-137; CanCustomer :150-225).
7. `grep -rnE '\.delete|archive'` over the 11 files minus
   `archived_at==null|archived=include` gates — residual 4 lines
   (Mail:152,155; Onboard:50,93; Success:28), all classified.
8. Owner sweeps: `grep -nE 'scenario|delete|archive|...'`
   on CanCustomer.can, shared/Employees.can, shared/Locations.can.
9. `grep -rnE '(Customer|Employee|Location)\.delete' draft/` —
   only CanCustomer.can:194 (hook, no examples) and CanCRM.mjs:806
   (desired output, out of scope).
10. `grep -rnE 'revoke|retire|suspend|disable'` over the 11 files —
    child-side/access-grant only.
11. `grep -rniE 'cascade|orphan|detach|parent.{0,20}(delet|archiv)|
    ...'` over the 12 `.md` companions — exit 1, zero hits.

- Writer: L3 T28-cascade-orphan slice. Appended this section and
  marked checklist item 3 complete above; no other text altered. No
  JEV run; no Git; no other files touched.
- Release: `implementation/challenge-audit-run/evidence/containment-decision.md`
  is RELEASED to the coordinator for JEV-gate scheduling.

## Owner facet/export posture (gate evidence)

Status: **PREP evidence — adopts NOTHING.** QUALIFIES checklist item 4
(see mark above): the export/consent machinery survey is complete, but
owner willingness to export a facet is UNKNOWABLE from source alone —
no owner has been asked and no draft marker answers for them. JEV must
carry the stance as a design choice. Alternatives A–D, fairness
record, and remaining checklist items 5–6 are unchanged; JEV still
not run.

Method: full reads of the three owner package sources
(`draft/shared/Employees.can` 26 lines, `draft/shared/Locations.can`
65 lines, `draft/CanCustomer.can` 324 lines); keyword sweeps for
facet/consent/opt-in/contain machinery across owner files, the full
`draft/` corpus, and DESIGN.md/GRAMMAR.md/DECISIONS.md (read-only);
`export`/`policy`/`use` censuses for export kinds, policy-extension
attempts, and cross-package grants. Read-only; no builds, no edits
outside this file.

Headline: **no facet/consent/opt-in machinery exists anywhere.** The
word scan `facet|consent|opt-in|export contain` returns zero hits in
all three owner files and zero hits in DESIGN.md/GRAMMAR.md/DECISIONS.md
(the only corpus hits for D-facet language are this file's own
Alternative D text). GRAMMAR.md:164 enumerates the exportable kinds —
stored models, contracts, events, roles, derived functions,
capabilities, judgments, fixtures, user scenarios, named messages —
and a containment facet is not among them. Alternative D therefore
requires a genuinely new declaration form, confirming (not reducing)
its stated cost line. Policy-extension prohibition is confirmed at all
three layers: grammar (export "unavailable on ... CRUD,
policies/rules ..." — GRAMMAR.md:164), design ("cannot directly
mutate it or extend its policy" — DESIGN.md:85), and corpus (zero
`policy Employee|Customer|Location` lines outside the owner files;
zero `export policy` lines anywhere).

### Owner 1: employee (`draft/shared/Employees.can`, parents 6/20 sites)

Exports used (all within DESIGN.md:83/GRAMMAR.md:164 kinds): role
`hr` (:5); model `Employee` (:6); event `EmployeeChanged` (:7);
derives `staff`, `can_work` (:8–9); fixture `test_worker` (:14);
user scenario `deactivate` by=hr (:18). Never exported: policies
(:10–12), invariant (:13), crud (:16), hook scenario `changed`
(:22–25).

Cross-package posture: generous exporter. Consumers import the model
plus authority-adjacent symbols — e.g. Expense:7 and Onboard:7 import
`{Employee,...,hr,deactivate}`; Leave:6, Time:6, Shift:9 import the
model with `can_work`/fixtures. Consumers invoke owner authority
only through the imported `deactivate` operation, never by direct
mutation. Grants received: `use rent_catalog {Location,test_site}`
(:3) — a type plus fixture import; no admission delegation.

Bounds the owner COULD want (grounded in its own rules, not its
wishes): HR-gated mutation with `delete=none` (:16 — no delete path
exists, so any facet cascade choice has no owner-side anchor);
tiered reads — full for `hr` (:10), field-limited for
members+staff (:11, `private_notes`/`document` withheld), self-row
for the subject (:12). A facet could plausibly bound which children
may attach, the cascade-vs-status-flip behavior (deactivation is a
status flip per :18–21, not archive/delete), and reverse-collection
readability given the field-limited member grant. Which bounds, if
any: **UNKNOWABLE** — no marker exists; do not infer willingness
from export generosity.

### Owner 2: customer (`draft/CanCustomer.can`, `package customer` at :8; parents 13/20 sites)

Exports used: models `Customer`, `Contact`/`BillingProfile`/
`CompanyRole`/`Invitation in Customer` (:17–21), `Alias` (:22);
event `CompanyAccessChanged` (:23); derives `has_role`,
`has_location_role`, `owns` (:25–27); fixtures `test_*` (:53–59);
scenarios `duplicate_customers`, `duplicate_contacts`,
`approve_account`, `claim`, `invite`, `accept`, `remove`, `recover`,
`alias` (:82–172). Deliberately NOT exported (contrast with
employee's exported `hr`): roles `customer_manager`,
`customer_reader`, `billing_reader` (:14–16); derive
`customer_staff` (:28); event `InvitationExpiry` (:24); fixtures
`billing_profile`, `company_invitation`, `duplicate_company`,
`reviewed_alias` (:60–63); access-hook scenarios (:186–225);
policies/invariants/unique/lock/crud/messages/preferences.

Cross-package posture: richest grant surface of the three, and the
corpus's clearest owner-to-owner grant: `use invoice {finance}`
(:11) imports the invoice package's exported role (declared at
CanInvoice.can:74), which the owner then grants `read` on
Customer/Contact/BillingProfile (:40–42) and `by=finance` admission
to `approve_account` (:96). Outbound, consumers import models,
derives used directly in consumer policies (`owns`/`has_role` at
CanMember.can:169,183), events, and scenarios (`remove` imported as
`remove_company_role` at CanMember.can:72; CRM:6 imports eight
scenarios/operations). The owner already constrains its OWN
locally-contained children — company-kind invariant (:48),
contact-parent invariant (:47), `unique CompanyRole
fields=account,role` (:50), Invitation `lock` (:51) — giving any
facet-bounds syntax draft-shaped precedent, though exact facet
expressiveness stays JEV-PENDING. `crud Customer` (:73) carries no
`delete=` clause and `Customer.deleted` (:194–197) has zero observed
child effects, so the cascade-vs-orphan bound is genuinely open.

Willingness to export a facet and desired bounds: **UNKNOWABLE**.
The non-exported roles show this owner withholds more than employee
does — but that is about roles, not containment, and must not be
over-read as facet reluctance. Stakes note: at 13/20 sites, a
withholding customer owner strands most of D's consumers.

### Owner 3: rent_catalog (`draft/shared/Locations.can`, parents 1/20 sites)

Exports used: role `catalog_owner` (:5); `Location` (:6); local
children `WeeklyHours`/`ClosedDate`/`DateHours`/`LocationPolicy in
Location` (:7–9, :12); contracts `OpeningWeek`/`OpeningDate`
(:10–11); derives `policy_open`, `is_open` (:15, :23); fixtures
(:24–27). Never exported: derive `dated_open` (:22); policies
(:13, :16–19); `lock LocationPolicy` (:14); invariants (:20–21);
crud (:29–32); snapshot scenarios (:33–64).

Cross-package posture: public-read owner (Location/children
`read=public`, Location field-limited at :16–19) with `delete=none`
on all four crud decls (:29–32). Second owner-to-owner grant
pattern: `use employee {can_work}` (:3) delegates crud admission to
another package's predicate via `when=can_work(actor,row[.parent])`
(:29–32). Consumers import broadly (Reception:6
`{Location,DateHours,is_open,test_site}`; Rent:71 the near-full set
including `catalog_owner` and `LocationPolicy`). Lifecycle note: the
owner runs snapshot automation over its OWN children on every
Location/child create/update (:33–64); an imported child
(`GuestPolicy`, site 15) would sit outside that machinery — a facet
would need to say whether imported children participate, which is
new semantics, JEV-PENDING.

Willingness and bounds: **UNKNOWABLE**. Smallest blast radius (1
site), but the only non-identity parent — discriminates whether a
facet rule is identity-specific or general over plain imports.

### How the findings constrain D vs A/B/C

- D vs A: where facets exist, D's semantics ARE A's, so the full
  site enumeration and per-site discrimination transfer to D
  conditionally. D's only delta over A — the owner-consent
  precondition plus facet-bounds check — is confirmed novel: zero
  existing syntax, semantics, or markers to extend. D's "three owner
  packages must be edited and versioned" cost stands unreduced.
- D vs B: a facet could carry the cascade-vs-orphan choice per
  owner, resolving B's orphan-rule question without B's
  two-meanings-of-`in` split. But checklist item 3 proved zero draft
  anchor for ANY choice (all three owners: `delete=none` or silent
  crud), so the facet's lifecycle bound would be JEV-supplied, not
  source-derived.
- D vs C: without owner cooperation D's fallback IS C's 20-site
  remodel — and partial consent (some owners consent, others do
  not) yields a mixed A/C corpus, a complexity none of A/B/C has.
  Non-response/stranding risk is real and unquantifiable from
  source; JEV must weigh it.
- Gate impact: item 4 cannot become COMPLETE without owner
  testimony. The qualified record above is the most source honesty
  allows; the JEV gate must either adopt D's consent rule as a pure
  design choice or set D aside for lack of an ascertainable owner
  stance.

### Commands run (read-only)

1. `ls draft/ draft/shared/` + `grep -rn "^package
   (employee|customer|rent_catalog)" draft/` — owner sources:
   shared/Employees.can, shared/Locations.can, CanCustomer.can:8
   (`rent_catalog_ui` at CanRent.can:8 is a different package).
2. Full `read_file` of all three owner sources (26/65/324 lines).
3. `grep -rniE "facet|consent|opt.?in|contain "` over the three
   owner files — exit 1, zero hits.
4. `grep -rniE "facet|opt.?in|export contain" draft/
   implementation/ DESIGN.md DECISIONS.md` — only this file's own
   Alternative D text (plus unrelated prose hits).
5. `grep -n "export"` + non-export decl census on CanCustomer.can
   (roles :14–16, `customer_staff` :28, `InvitationExpiry` :24,
   fixtures :60–63, access scenarios :186–225 all unexported).
6. `grep -rnE "policy (Employee|Customer|Location)[ .]" draft/`
   minus owner files — exit 1, zero foreign-policy attempts;
   `grep -rn "export policy" draft/` — exit 1, zero hits.
7. `grep -rnE "use (employee|customer|rent_catalog) {" draft/` —
   consumer import census (incl. Member:72, Rent:71–73, CRM:6,
   Expense:7, Onboard:7, Reception:6–7 role/scenario/derive
   imports).
8. `grep -rn "role finance" draft/` + `grep -n "^package|^app"
   CanInvoice.can` + `grep -rn "use invoice" draft/` — finance
   role exported at CanInvoice.can:74 (`package invoice` :8),
   plain-imported by customer (:11) and CanRent.can:74.
9. DESIGN.md:83–91 + GRAMMAR.md:164 read-only extraction of export
   kinds, no-policy-extension rule, and import-grants-visibility
   semantics.

- Writer: L3 T28-facet-stance slice. Appended this section and
  marked checklist item 4 qualified above; no other text altered. No
  JEV run; no Git; no other files touched.
- Release: `implementation/challenge-audit-run/evidence/containment-decision.md`
  is RELEASED to the coordinator for JEV-gate scheduling.

## Storage atomicity (gate evidence)

Status: **PREP evidence — adopts NOTHING.** QUALIFIES checklist item 5
(see mark above): the included-store atomicity question is answered YES
at the spec/contract level but UNPROVEN at the engine level (subtree
cascade unimplemented, generated path interim), and the deployment-split
failure is specified (fail before commit, no cross-store transaction)
while the split-time diagnostic is ABSENT. Alternatives A–D, fairness
record, and remaining checklist item 6 are unchanged; JEV still not run.

Method: read-only survey of DESIGN.md §§1/5/7–8/11 storage and
ownership rules, DECISIONS.md persistence entries, the
`@canlang/state` engine (`storage/`, `mutation/`, `invocation/`,
`ports/`, `migration/`), the `StoragePort`/`CommitBatch` contracts,
the compiler effects pass, the Cloudflare worker assembly seam, the
B1 interim runtime headers, and all `draft/**/*.can` store/binding
declarations (`at=`, `binding`, `context`). Read-only; no builds, no
edits outside this file. Question asked: in the included-store case
(A/D plain imports), can a cross-package subtree archive be atomic —
and what exactly fails if the deployments split?

Headline: **spec YES, engine UNPROVEN, split behavior specified but
unenforced.** The atomic unit is one owner commit on one store, and
plain-import inclusion plus storage-owner inheritance put a
cross-package parent and child in that same unit — so A/D atomicity
follows from the design. But no engine code expands a delete to its
subtree today, generated operations still commit through the B1
interim path, and nothing fires a diagnostic at deployment-split
time. Item 5 therefore cannot become COMPLETE without engine proof
(T29/T16/T17 scope), which this prep must not claim.

### CONFIRMED: one owner, one store, one atomic commit

- The atomic unit is a single owner commit. DESIGN.md:532: "Every
  mutation has one authoritative storage owner. D1 is the default."
  DESIGN.md:362: "a mutation is already one atomic unit at its
  inferred owner." DESIGN.md:338: "delete archives the row and its
  contained subtree, atomically." The D1 protocol (DESIGN.md:551–556)
  is one revision-fenced batch: assert revision, apply
  writes/constraints/history/receipt/outbox, increment; mismatch
  rolls back the entire batch.
- The contract repeats the unit and the boundary.
  `packages/contracts/src/state.ts:276-279`: "One atomic owner
  commit. The store asserts `expectedRevision`, applies all
  writes ... Any failure ... rolls back the entire batch."
  `packages/contracts/src/state.ts:359-362`: "there is no
  cross-store transaction. Raw adapter writes around the fence are
  forbidden."
- All three adapters implement single-store atomic commit.
  `packages/state/src/storage/d1.ts:4-15`: every commit is ONE
  `db.batch()` whose leading `fence_log` INSERT "fails atomically
  and nothing is applied" on a stale revision.
  `packages/state/src/storage/durable-object.ts:4-13` + `:80-85`:
  same fence semantics through `transactionSync`, which is required
  ("an untestable BEGIN/COMMIT fallback must not silently carry
  atomicity"); environments without it are rejected loudly.
  `packages/state/src/storage/memory.ts:538` provides the matching
  fenced `commit`.
- Invocation and assembly take exactly one store.
  `packages/state/src/invocation/invoke.ts:89` (`store:
  StoragePort`), `packages/state/src/ports/transact.ts:36-37`
  ("the single-shot transaction port over one store"),
  `packages/cloudflare/src/worker/assembly.ts:332,366` (single
  `store: StoragePort` per assembled worker). The engine cannot
  express a two-store commit, so multi-owner atomicity is not
  merely unimplemented — it is inexpressible at this layer.
  `packages/state/src/migration/index.ts:37-42` states the loud
  assumption: "one store instance serves exactly one owner ... A
  shared multi-owner store would mix layouts under one fence."

### CONFIRMED: included-store co-location (the A/D case)

- Plain imports include the owner package in the same deployment.
  DESIGN.md:81: "A plain import of a production business symbol
  includes the whole owning executable package internally."
  DESIGN.md:19: "Every included package's resource references
  resolve through these defaults or the selected app's merged
  explicit context" (and dependency imports do not import another
  app's context). DESIGN.md:599: "Whole-package dependencies
  containing file fields use this same store, even when their
  pages are unselected."
- Containment inherits placement. DESIGN.md:95: a `Model in Parent`
  child "inherits the parent's team and storage owner."
  DESIGN.md:97: `Model at=Binding` moves team-scoped placement
  while "explicit children retain inherited placement."
- Consequence: under A/D, an imported parent and its cross-package
  children sit at the same storage owner in the same store, so the
  subtree archive of DESIGN.md:338 falls inside one atomic owner
  commit. This is a spec-level entailment, not an engine
  observation — see the qualification below.
- The corpus exercises only this case. Zero `binding X
  DurableObject` / `Model at=Binding` declarations exist in any
  `draft/*.can` or `draft/shared/*.can` (grep exit 1, zero hits).
  The only six `context` blocks (CanCatch.can:3, CanCreative.can:3,
  CanGallery.can:3, CanInbox.can:3, CanKnowledge.can:3,
  CanStats.can:3) declare files/queue/analytics only — no storage
  bindings. All 20 R14 sites are therefore default-D1 team-scoped;
  the `at=`-split topology is unexercised by every draft.
- Subtree enumeration primitives exist in-store. All three
  adapters filter by parent linkage: d1.ts:640-644,
  durable-object.ts:1153 (`AND parent_model = ? AND parent_id =
  ?`), memory.ts:512-516; the `records` table carries
  `parent_model`/`parent_id` columns (schema.ts:41). A future
  cascade can enumerate children without leaving the store.

### CONFIRMED: the checker already rejects two cross-scope atomic shapes

- E4040 (`compiler/src/analysis/effects.rs:29-33`, impl at :2815):
  "`call` stays in one owner transaction, so its target must not
  be a bound-imported (remote) operation; remote targets use
  `send`." E4051 (effects.rs:41-43): an `on=every(...)` handler
  spanning app- and team-scoped models is rejected (DESIGN.md:526:
  "Mixed incompatible scope families or cross-owner atomic bodies
  fail checking"). The pass is wired (`compiler/src/analysis/
  mod.rs:30,123`) and tested (`compiler/tests/effects.rs`).
- Weight: this proves the architecture enforces atomicity
  boundaries at check time in principle — but neither rule keys on
  package/deployment topology, so neither fires for a
  deployment-split import. They are precedent, not coverage.

### QUALIFIED: the cascade itself is unimplemented

- Engine delete archives one row, not a subtree.
  `packages/state/src/mutation/crud.ts:153-155`: delete "maps the
  admitted call onto a single pipeline write" (`op: 'remove'` at
  :298). `packages/state/src/mutation/pipeline.ts:691-705` sets
  `archivedAt` on that row only; the remove path contains no
  children query or expansion (the disposal scan at :408-412
  rejects hard-remove targets with live referrers — a guard, not
  a cascade).
- `grep -rniE "cascad" packages/state/src packages/contracts/src`
  returns exit 1, zero hits: no containment-cascade code exists in
  the state engine or its contracts. (Corpus-wide, `cascad*`
  appears only for identity membership recovery and interface
  tests — unrelated to containment lifecycle.)
- The generated path is not on the engine yet.
  `packages/cloudflare/src/runtime/stdlib.ts:1-14` is the B1
  interim data plane: direct fenced `StoragePort` commits with
  `history: []`, `receipt: null`, full-row reads, and seven stubs
  — its header requires L3 to "route create/set/deleteRecord
  ... through the state engine." `packages/cloudflare/src/runtime/
  invoke.ts:1-11` calls emitted handlers directly; canonical-invoke
  parity "is a follow-up, not done here." So even single-package
  subtree atomicity is unexercised through generated operations;
  T16/T17 own that join and T24 owns atomic dispatch staging
  (`implementation/CHALLENGE-AUDIT-PLAN.md:504`), all pending.
- Net: Alternative A's stated cost — "storage engine must prove
  same-store atomicity for cross-package subtrees"
  (containment-decision.md:92-94) — stands CONFIRMED as open work.
  The plan's standing caution applies verbatim: "Do not infer
  cross-store atomicity" (`implementation/CHALLENGE-AUDIT-
  PLAN.md:572`; likewise "respect D1/DO boundaries" at :304).

### SPLIT: failure specified (CONFIRMED), split-time diagnostic ABSENT

- What the spec says fails, in order of authority:
  1. DESIGN.md:549: "A call targeting more than one owner
     instance fails before commit" and business rules imply no
     "cross-D1/DO transaction."
  2. DESIGN.md:547: "Cross-owner joins/aggregates are forbidden
     in business mutations", "A reference can identify another
     owner but cannot imply an atomic read or write there",
     "Invariants must live entirely within one owner",
     "Cross-owner workflows use durable events and explicit
     pending business state."
  3. DESIGN.md:89: "An imported external interface does not
     create local records, grant service authority or make remote
     mutations atomic."
  4. DESIGN.md:927-931: a composed app has "no aggregate schema
     owner"; bound providers "are never migrated by a consumer";
     "A newly included owner starts empty, without importing
     another deployment's data."
- So if A/D packages split into separate deployments, the atomic
  subtree archive degrades to: parent archive commits alone while
  children stay live elsewhere (orphans-by-topology), or the
  multi-owner call is rejected before commit — with no durable
  event bridge unless the app authors one. Which of the two
  occurs at which call site is not pinned by any source read.
- ABSENT: no check, diagnostic, or deployment-plan rule keys on
  "these two packages used to share a store." E2008 rejects
  imported containment wholesale today; E4040/E4051 key on
  bound-vs-local and app-vs-team scope, not on deployment
  topology; the migration plan matches logical owners to
  snapshots (DESIGN.md:931) with no store-sharing assertion. The
  "what diagnostic fires if deployment splits later" question
  (containment-decision.md:100-102) therefore has no answer in
  the sources — JEV must supply it or explicitly leave it open.

### Per-finding alternatives discrimination

- A (full containment): storage facts SUPPORT the included-store
  core — same owner, same store, one atomic commit is the
  designed unit, and the whole corpus sits in that topology by
  default. They CONFIRM A's cost line (engine proof still owed)
  and A's strongest opposing case: a future split silently
  breaks the atomicity promise with no split-time diagnostic in
  evidence. Fairness preserved: the opposing case is not
  hypothetical — DESIGN.md:549/547/89 specify exactly the
  failure (reject-before-commit or orphan-by-topology), while
  nothing in the checker or deploy plan detects the split.
- D (owner-consented facet): the A analysis transfers
  conditionally wherever facets exist, exactly as the item-4
  section transfers the site enumeration. Storage adds no new
  facet machinery and no per-owner atomicity scope beyond what A
  already has; a facet COULD carry a cascade-vs-orphan or
  store-sharing bound, but no source gives that bound a syntax,
  a check, or a default. D's "no atomicity gain" opposing case
  stands undiminished by storage evidence.
- B (reference-plus-scoping): storage facts SUPPORT B's
  immunity — B never promises cross-package atomicity, so the
  unimplemented cascade, the interim generated path, and the
  split hazard all pass it by. This support is defensive only:
  storage says nothing for or against B's orphan-rule choice
  (item 3 already proved zero draft anchor for any orphan
  variant), and nothing that softens B's strongest opposing
  case — the silent two-meanings-of-`in` deletion drift, which
  is a semantics objection no storage layer can answer.
- C (remodel as references): storage facts are NEUTRAL on C —
  with no cross-package containment there is no cross-package
  atomicity question, so C avoids every risk above at its full
  20-site migration price. Fairness preserved in the other
  direction: the storage survey confirms C would discard a
  spec-guaranteed atomicity semantic (DESIGN.md:338 over the
  inherited owner of DESIGN.md:95) that the drafts' `in`
  spelling claims and that references cannot reconstruct —
  `send`/durable-event bridges (DESIGN.md:547) are explicit
  pending-state workflows, not atomic commits. C's "checker
  limitation, not semantic necessity" opposing case survives
  the storage survey intact.

### Commands run (read-only)

1. `grep -n` line pins for every citation above (state.ts:276,
   :359-362; d1.ts:5, :640-644; durable-object.ts:82, :1153;
   memory.ts:512-516, :538; schema.ts:41; migration/index.ts:37;
   invoke.ts:89; transact.ts:36; assembly.ts:332,366;
   crud.ts:154, :298; pipeline.ts:691; effects.rs:29,41,2815;
   mod.rs:30,123) — all exit 0 with the quoted text.
2. `grep -rniE "cascad" packages/state/src
   packages/contracts/src` — exit 1, zero hits (no engine
   containment cascade).
3. `grep -rnE "binding [A-Za-z0-9_]+ DurableObject|
   at=[A-Z][A-Za-z0-9_]* \{" draft/*.can draft/shared/*.can`
   — exit 1, zero hits (no draft storage bindings).
4. `grep -rn "^context$" draft/*.can` — exit 0, six hits
   (Catch/Creative/Gallery/Inbox/Knowledge/Stats :3); bodies
   read in full — files/queue/analytics only.
5. `sed` reads of stdlib.ts:1-14, invoke.ts:1-11, crud.ts:150-175,
   migration/index.ts:28-43, DESIGN.md:530-559, and the six
   draft context blocks — interim/generated-path and
   co-location quotes verified verbatim.
6. `grep -rn "E4040\|E4051" compiler/tests/ compiler/src
   --include="*.rs" -l` — exit 0: effects.rs, types.rs,
   explain.rs, tests/effects.rs (checks wired and tested).

- Writer: L3 T28-storage-atomicity slice. Appended this section and
  marked checklist item 5 qualified above; no other text altered. No
  JEV run; no Git; no other files touched.
- Release: `implementation/challenge-audit-run/evidence/containment-decision.md`
  is RELEASED to the coordinator for JEV-gate scheduling.
