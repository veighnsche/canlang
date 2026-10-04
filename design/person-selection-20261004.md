# Authorized person selection — 2026-10-04

## Decision and verified boundary

Use the existing Employee work identity, an explicitly authored readable work name, and an ordinary canonical read for the demonstrated Expense candidate choice. Keep `Expense.reviewer:user` and historical Decision user attribution. Do not introduce a universal auth directory, new selection syntax, an implicit search across all user-bearing records, or automatic extraction of arbitrary scenario guards.

Verified sources: DESIGN §4 gives other users only stable IDs; only actor has email/verification facts. Subject role predicates test active team membership but grant neither enumeration nor record access. DESIGN §11 requires bounded authorized picker results and permits opaque input without a directory grant. `employee.Employee` has unique user and work attributes but no name. Its staff read policy permits user/home/locations/operator_wide/active/role/skills; HR alone has broader access. `can_work(person:user,location:Location)` requires active Employee, active membership and a matching work location. Expense CRUD is by members and permits only the caller's active draft at an authorized location. Submit additionally requires a distinct account with the current expense reviewer role and work eligibility. The selected reviewer currently is a user, including in frozen Decision evidence.

R6/C-I02 identifies missing person recognition and directory provenance, not proved unusability. Neither an opaque ID nor a generic account lookup is enough to invent an authorized name. No Employee display name currently exists to reuse; adding one is an explicit owner schema/fixture/migration change, not an inference from auth email. No app files are changed by this note.

## Exact proposed shared-contract text

Person-reference selection uses a declared, currently authorized source of candidate identities. A readable model field of type `user` can supply that user value to an existing operation; the model's other fields remain subject to their own grants. An owning pure read may explicitly select eligible candidates using ordinary queries and current authorization predicates. Its result is bounded and viewer-filtered unless the source explicitly declares a different authority/disclosure contract. Browser controls and MCP use that same canonical read and input identity; they do not maintain separate eligibility schemas or enumerate the authentication provider. Merely importing a user-valued field, knowing an ID, or testing a subject role does not grant directory access. Without an authorized candidate source, retain opaque-reference entry and safe unavailable/empty states rather than guessing another person's account.

A person choice may display only the fields granted by that candidate source. For a work identity, an explicitly authored Employee `name` can supply its ordinary readable reference caption; it is a maintained work display name, not a verified legal name or a newly exposed authentication profile. The selected value remains the canonical user ID when the operation expects `user`. Names are not unique keys. Show safe authorized disambiguators such as work role/home location only when those values and nested reference captions are readable, and expose the full identity for precise confirmation and MCP use; a shortened ID alone must never silently merge equal labels. Never fall back to another user's email, private HR notes, personnel dates, manager or HR document. A name change changes presentation, not stored account attribution; historical user fields do not automatically acquire Employee/name disclosure and retain an opaque fallback when no current authorized source supplies a label.

Candidate eligibility is current guidance for its declared selection purpose, not a promise that every later business guard passes. Re-evaluate the candidate query when its bound location/context changes and validate the actual owning operation at invocation/commit under its existing revocation fence. A stale choice is not silently replaced by a namesake. Denial or loss of eligibility produces the existing safe operation error and a refreshed authorized choice flow. Historical reviewer/decision references remain intact after role or employment removal. Authenticated external users obtain no employee roster merely by holding a user input; only their actually granted candidate sources are available. Empty results mean no eligible readable choices, while unavailable lookup/budget failures remain distinct failures. Do not infer an extra role grant, expose hidden candidate counts, or treat visibility as permission to mutate.

## Concrete owner changes for later application

1. In `employee.Employee`, author `name:text? trim min=1`, include `name` in the existing staff work-field read grant, and add it to the existing HR create/update field lists. HR supplies/maintains the value. Omitted names remain null with the existing safe identity fallback, so old fixtures and stored records need no filler names. Populate real work names or distinct test names only where recognition is needed; do not populate them from undisclosed auth profiles. No second person model is needed.
2. In Expense, author one ordinary read using current primitives, and invoke it from the selection UI. Its canonical identity is `expense.reviewer_choices`; explicit UI usage exposes this same read to MCP under existing rules. Retain the existing Expense.create/Expense.update/submit signatures and guards. The lookup is a new genuine read operation, not a wrapper for an existing mutation.
3. Keep this lookup's eligibility purpose explicit: an active, distinct reviewer for the supplied work location. It does not guarantee money, receipt, claimant-state or full submission validity. An existing draft can use the same candidates to bind `changes.reviewer` through its canonical edit/update control; no second candidate read is authored for editing.

## Source witness using existing syntax

The Employee name/read/CRUD additions above precede this illustration. Imports retain the existing canonical Employee, Location and can_work declarations. This is a proposed bounded insertion, not a second Expense source or copied mutation signature.

```can
# Find readable current reviewer work identities for this location.
scenario reviewer_choices(location:Location) read=true -> Employee[] by=members
 require can_work(actor,location)
 do return Employee as candidate where candidate.user!=actor and reviewer(candidate.user) and can_work(candidate.user,location)
```

A standard read form retains the explicit claimant and selected location bindings; it never asks the user to paste a hidden HR record:

```can
list Employee as claimant where claimant.user==actor and claimant.active
 list Location as site where can_work(actor,site)
  form reviewer_choices arguments={location=site}
   list result as candidate columns=name,user,role,home
    form Expense.create arguments={parent=claimant,location=site,reviewer=candidate.user}
```

The extra compatible Employee in scope is why `parent=claimant` is explicit. The lookup form/result supplies the candidate; the existing Expense operation supplies all remaining receipt/amount/purpose inputs. It is an illustrative selection composition, not a requirement to add unrelated employee browsing to every app. The initial Expense intake should be replaced or adapted, not duplicated beside another independent reviewer control.

For MCP, invoke the same canonical `expense.reviewer_choices` with the selected Location reference, inspect permitted Employee name/work fields and its readable `user`, then pass that exact user reference to existing `expense.Expense.create` or update. The protected record/version schemas and actual operation admission remain unchanged. If the caller cannot read Employee.user, the candidate cannot supply an identity through this read.

## Desired JS witness

Normal metadata declares the existing Location input and Employee[] result once. UI and MCP refer to its operation identity. The executable handler uses the standard helpers and current viewer context; this is desired output, not an available module implementation.

```js
async reviewer_choices(c, { location }) {
  check(hasRole(c, "members"), "forbidden");
  check(await can_work(c, c.actor, location));
  return collect(records(c, "employee.Employee", {
    where: async (candidate) =>
      !same(candidate.user, c.actor) &&
      hasRole(c, "expense.reviewer", candidate.user) &&
      await can_work(c, candidate.user, location),
  }));
}
```

The existing form `arguments` contract carries `{parent: claimant, location: site, reviewer: candidate.user}` to `expense.Expense.create`. Result rendering reads name/role/home under normal field grants. No `getAllUsers`, email lookup, custom picker service or duplicate operation schemas are introduced.

## Consultation and uncertainty

Three independently reworded equivalent requests and full responses are saved in `design/jev/person-selection-20261004/`. All facts, questions and alternative prose were rewritten; stable alternative IDs remained fixed. The alternatives were (a) add an explicitly permitted Employee work name while retaining reviewer:user and ordinary queries, (b) define a scoped auth-directory grant/lookup, and (c) change reviewer to Employee and map back to user evidence. Each was assessed against recognizable eligible choice, collisions, revocation, private HR/email boundaries, external callers and UI/MCP parity.

| Request | Employee work label | Auth directory | Employee reviewer reference | Confidence |
| --- | ---: | ---: | ---: | ---: |
| 1 | .98 | .00 | .02 | .97 |
| 2 | .95 | .00 | .05 | .92 |
| 3 | .73 | .22 | .05 | .60 |

No winner disagreement occurred. The third response's directory probability is material uncertainty, not rounded away: a centrally maintained auth name might reduce duplicate name maintenance, but the verified source has no profile-disclosure grant or usable label schema to reuse. The existing Employee approach makes its cost explicit through owner-maintained data and a field grant, avoids changing historical account identity, and uses current query/form primitives. These reasons settle the choice; no probability threshold approves it. Responses contain no explanatory rationale beyond distributions, so none is attributed to JEV. Initial sandbox network connection failed; the identical first request succeeded through the approved normal network escalation. No credentials were attached to evidence.

Still unverified: real staff recognition/selection success, duplicate-name usability, runtime field projection, live grant races, MCP reference serialization, and source/JS execution. This note proposes a concrete draft correction; it does not claim an implemented picker, compiler, fixture runner or measured token/performance benefit.

Verification: the initial source-witness check rejected an unnecessary query-order suffix; the final witness removes it and uses the existing collection syntax. No parser or language change was made.
The corrected source witness parses in a standalone syntax wrapper. The Employee name is optional after coordinator review: the selection contract supports unnamed identities without bulk fixture filler, while named records provide the improved recognition path. This does not change the consulted alternative or introduce a directory grant.


## Applied witness handoff

The authorized follow-up applies optional work name/read/CRUD changes to `draft/shared/Employees.can` (the actual filename), plus the canonical reviewer lookup and explicit intake composition in CanExpense.can/.mjs. Candidate columns include the exact user identity alongside name/role/home, so collisions have a visible discriminator. Existing business mutations, recovery and historical user evidence remain unchanged. Expense adds eight lookup rows and a real Employee.deactivate selection sequence; private-field protection is a policy/projection check, not a fake test-inspection visibility assertion. Root still needs to apply the three exact shared-contract paragraphs above to DESIGN/REQUIREMENTS as appropriate; no new grammar form is required.
