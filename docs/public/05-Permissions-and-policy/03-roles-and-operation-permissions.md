# Declare roles and authorize expense operations

Use the expense-review app to separate caller admission, another person's role eligibility and record-specific guards. Understand why role assignment, read access and permission to approve are distinct.

## Declare roles without granting access

Use the complete [ExpenseReview source](01-authentication-and-teams.md#use-one-complete-business-example). Its `Given` section declares:

```can
role reviewer
role finance
```

These declarations name owner-assigned team roles. They do not assign an account, make a row readable or grant an operation. Roles have package-qualified identities: identically named roles in different packages do not merge. A team owner does not automatically hold every declared role.

`members`, `owner`, `authenticated` and `public` are built-in actor predicates. A declared role such as `reviewer` is also an actor predicate. `authenticated` means signed in, not membership in this team; `public` admits without requiring sign-in and may have a null actor. This app uses team membership and explicit roles for its operations.

## Check a different person's role

The app's `assign` operation uses a subject predicate:

```can
scenario assign(expense:Expense,person:user) by=members
 require expense.submitted_by==actor and expense.status==draft
 require reviewer(person) and person!=actor
 do set expense {assigned_reviewer=person}
```

This is a `When` excerpt requiring the app's `Expense` model and `reviewer` role. Ava may assign Ben only while editing her own draft, and only if Ben is an active member with that explicit reviewer assignment in the current team. She cannot assign herself through this operation.

`reviewer` tests the caller; `reviewer(person)` tests the supplied account. The latter does not impersonate that person, change `actor`, grant directory access or make that person's records readable. An inactive, missing or foreign-team membership returns false. There is no `members(person)` call form; explicit membership checks use `active_member(person,team)` where permitted. `reviewer(actor)` is redundant and diagnosed; use the bare role for the literal caller.

Use subject predicates to check prospective assignments, not as a stored historical invariant that makes old expenses invalid when a reviewer later loses a role. The app checks eligibility again on submission. Approval also requires the caller's current reviewer role. This sample freezes assignment after submission; automatic reassignment or an owner override is not implied.

## Separate admission from business guards

The approval scenario is admitted with `by=reviewer`. Its guard then requires a submitted expense, this caller's assignment and a different submitter:

```can
require expense.status==submitted and expense.assigned_reviewer==actor and expense.submitted_by!=actor
```

This line belongs inside that scenario, before its `do` body. Admission is evaluated before parameter defaults, record-dependent business guards and effects. A member without the reviewer role is refused at admission; a reviewer assigned to another record cannot satisfy this record's guard.

| Request | Rule that decides it |
| --- | --- |
| Ava edits her draft's purpose | Member admission, CRUD allowlist and own-draft `when` |
| Ava changes status through CRUD | Refused: `status` is not in the mutation input allowlist |
| Ben approves his assigned submitted expense from Ava | Reviewer admission and all approval guards pass |
| Another reviewer approves Ava's expense assigned to Ben | Assignment guard fails |
| Ben approves his own expense | No-self-approval guard fails, even if stored assignment names him |
| Ordinary member calls `approve` | Admission fails with `forbidden` |
| Caller supplies a stale record version | Concurrency rules refuse the stale mutation |

Read permission is not a universal extra prerequisite for every write. Record inputs still resolve their type, owner/team, lifetime and expected version, and the owning operation's guards decide whether the mutation is permitted. An opaque ID confers no authority. Missing, expired or foreign-owner references remain unavailable; generic refusals must not disclose confidential values.

## Keep CRUD, exposure and presentation separate

The app's CRUD declaration permits only purpose and amount changes on the caller's own draft. It disables deletion with `delete=none`; hiding a delete button would not disable that operation. Authored scenarios may write their explicitly declared business fields independently of the CRUD input allowlist, while still enforcing locks, invariants, versions and ownership.

CRUD `expose=` controls public selection of enabled canonical operations; omitting it permits enabled CRUD. An exposure restriction does not disable internal canonical calls or weaken their checks. A hidden button, disabled control or omitted tool is not an authorization rule. See [CRUD lifecycle](../06-Business-workflows/01-crud-and-record-lifecycle.md) and [actions and invocations](../06-Business-workflows/05-actions-and-invocations.md).

Continue with the [read-policy and report boundaries](02-read-policies-and-field-access.md).
