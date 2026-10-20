# Roles and operation permissions

A role names an application concept; it does not by itself grant capabilities. A user operation's `by` clause is its call eligibility rule and is evaluated before parameter defaults, record-dependent business guards, or effects. Current membership and role facts come from the authenticated context. A denied operation must not disclose records or internal diagnostics.

```can
When
 # Approve a pending request.
 scenario approve(request:Request) by=members
  require request.status==pending message="Request cannot be approved"
  do
   set request {status=approved}
```

This is a fragment requiring a declared `Request` schema and authorized read/write context. Membership permits reaching the operation, while the business guard determines whether this request is approvable. Operation exposure is separately controlled by CRUD exposure and selected UI/tool declarations; hiding a control is not a permission rule. An omitted CRUD exposure allows enabled generated CRUD; an explicit exposure allowlist constrains public interfaces without disabling internal canonical calls.

See [authentication and teams](01-authentication-and-teams.md), [field access](03-read-policies-and-field-access.md), and [actions and invocations](../05-Workflows/08-actions-and-invocations.md).
