# Permissions and business rules

Declare read access, operation authority and state constraints separately so every interface enforces the same business decisions.

## Grant reads explicitly

A `policy` belongs in `Given`. No matching policy means no read access. The following fragments assume Expense, Candidate and their role declarations exist:

```can
policy Expense read=members where=row.submitted_by==actor
policy Expense read=reviewer
policy Candidate read=interviewer fields=name,interview_at
```

The first policy lets members read their own expenses; the second gives reviewers a broader read grant. Matching policies combine their allowed fields for matching rows. Omitting `fields` grants ordinary fields and safe metadata, never secrets.

Team ownership is the default storage boundary, not an automatic permission grant. Cross-team relationships and access still require the language's explicit authority rules. A role declaration introduces a business role; it does not assign that role to everybody in a team.

## Authorize operations

An operation's `by` expression controls invocation:

```can
crud Todo by=members fields=title,done
```

This enables standard member operations on the allowlisted fields. A read policy does not authorize a write, and a write permission does not grant read access. Browser forms, external requests and MCP tools all reach the canonical operation.

A scenario can apply an additional state-dependent guard. This `When` fragment assumes an Expense model and reviewer role:

```can
# Approve a submitted expense from another teammate.
scenario approve(expense:Expense) by=reviewer
 require expense.status==submitted and expense.submitted_by!=actor
 do set expense {status=approved}
```

A member without the role fails admission. A reviewer attempting the wrong transition fails the business guard. A disabled or hidden control is presentation; retain both checks in source.

## Enforce cross-path rules

Use an invariant for a condition that must hold in the final state of every affected record. Use a lock to preserve values according to their pre-state:

```can
invariant Line: row.quantity>0
lock Invoice fields=customer,total when=row.status!=draft
```

An invariant applies across CRUD, scenarios and other mutation paths. A lock tests the original state: the transition that establishes the lock can set final values, and later operations cannot change them or remove the protected record. A lock without `when` is always active.

Put mandatory protections here rather than repeating them in a form and hoping every future caller remembers them. Use operation guards for rules specific to a particular business action.

## Preserve authority in reports and relationships

Normal user queries and read scenarios are filtered by the caller's reads. Internal decision expressions may inspect the authority state needed to enforce rules, but their access is not a grant to return those values to a caller. A deliberately privileged report uses the explicit authority-scoped read-scenario contract and needs an explicit authorized result design.

Review both the returned fields and failure text. A guard message must not reveal confidential values. A derived field needs permission for its actual dependencies, not merely a label that sounds harmless.

## Review and test the surface

```sh
can policy --format=json Tasks.can
```

Review roles, policies and operation gates together. Then [write examples](../03-Build-and-operate/02-testing.md) for permitted actors, denied actors, invalid transitions and stale versions. Exercise the same boundaries through the real browser and MCP interfaces before deployment.
