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

1. Full enumeration of all 20 E2008 sites (only 6 named in R14; 14
   unattributed) with per-site parent import provenance (plain vs bound).
2. Confirmation that zero R14 sites use bound (`from=`) parents — currently
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
