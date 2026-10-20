# Context and default declarations

Look up app context overrides, named resources and contextual values such as actor, team, row and event. Distinguish inherited defaults from explicit configuration and bindings available only in their owning scope.

## App context and inherited defaults

An app may have one `context` block immediately after its app declaration. It sets only supported overrides and named resources; defaults omitted from source are inherited. Do not repeat defaults such as the standard runtime, D1 database, email/password authentication, team support, R2 file service, or base theme. Context does not create arbitrary provider configuration.

## Declare named resources

```can
# Coordinate calendar work.
app CalendarDemo
context
 binding Schedule DurableObject key=CalendarDemo.Calendar
 queue Reconcile type=ReconcileWork
 cache KV ttl=10m
 analytics Usage { event:text, occurred:datetime }
Given
 Calendar at=Schedule { name:text }
 contract ReconcileWork { calendar:Calendar }
When
Then
```

This complete declaration example owns the calendar model, queue payload type, and telemetry schema. It declares resources but no business operations or user page. A Durable Object binding names a key path that routes a root and its contained group to one authoritative SQLite owner. Queue declarations bind a name to an exact payload type; consumers are declared as trusted handlers. KV caching is positive-TTL and only for reconstructible public data; it cannot become business authority or cache private policy results. Analytics carries bounded telemetry, never transactional state.

The only additional context forms are `theme` with supported mode/accent/density values, `files` with an allowed type list and/or positive maximum size, and `locale default="..."` using a canonical BCP 47 tag. Repeated, unchanged defaults and arbitrary resource attributes are invalid. Provisioning and credentials belong to [environments and secrets](../12-Deploy-and-operate/01-environments-and-secrets.md); exact syntax is indexed in [syntax reference](../13-Language-reference/01-syntax-reference.md).


## Context override lookup

| Form | Meaning | Boundary |
| --- | --- | --- |
| `theme density=compact` | Change a shared theme setting | Modes system/light/dark; accents blue/green/purple; density comfortable/compact; omit unchanged defaults |
| `locale default="nl"` | App default/fallback language | Does not change a package's authored source language |
| `files types="image/png,image/jpeg" max=5MiB` | Override the app file policy | Uses the closed file-policy syntax; does not finalize or authorize an upload |
| `binding Schedule DurableObject key=CalendarDemo.Calendar` | Named authoritative root binding | Model placement explicitly references it |
| `queue Reconcile type=ReconcileWork` | Named typed queue | Verified ingress supplies handler context |
| `cache KV ttl=10m` | Positive-TTL cache | Reconstructible public data only, never business authority |
| `analytics Usage {event:text,occurred:datetime}` | Bounded telemetry schema | Not transactional business storage |

Default runtime/storage/auth/team/file/UI settings are inherited. Composed app contexts merge explicit settings first, rejecting conflicts, then apply defaults. Imports do not silently import another app's context. See the [complete composition example](04-apps-and-packages.md).

## Contextual name lookup

These names are supplied by the evaluation site, not fields to accept from an untrusted request. They are not universally available in every expression.

| Binding | Available context | Worked use and restriction |
| --- | --- | --- |
| `actor` | Authenticated request context; null in trusted handlers | `requester:user server=actor` requires admission that guarantees a user; trusted handlers cannot supply a nonnull actor |
| `team` | Verified team context | `active_member(person,team)` or `team.timezone`; never use a payload to invent a team grant |
| `now` | Operation admission clock | `set task {completed_at=now}` when that field exists; fixed across internal retries |
| `operation` | Supplied operation context | `operation.id`, `operation.source`; read-only identity/context |
| `row` | Model policy/invariant/derive/lock; collection child | `row.title`; scenario bodies instead use named record parameters |
| `parent` | Actual containment chain | Refers to the enclosing parent, not any arbitrary reference field |
| `event` | Handler's declared trusted source | `event.expense`; CRUD hooks expose `event.before`, `event.after`, `event.input` |
| `result` | Read-form descendants or page data binding | `list result`; read-form siblings have no result scope |
| `preferences` | Then and preference validation | `preferences.view`; cannot enter mutation/authority logic through a helper |
| Query alias | Following query clauses; alias-scoped aggregate predicate/key | `Todo as task where not task.done`; not visible backward into its domain |
| `let`/loop binding | Its executable lexical scope inside do | `let due=now+1d`; no file-level executable initialization |
| `before`, `row` | Migration mapper | Frozen predecessor and partially initialized destination; mapper restrictions still apply |
| `self`, `other`, `outsider` | Behavioral example setup/caller selectors | Test identities, not production authentication variables |
| `request` | Behavioral example request overrides/observations | For example `request.record.version`; not an author-controlled production principal |

Active contextual facts cannot be shadowed. Named helper parameters do not capture a caller's locals. Defaults can refer to earlier parameters, not later ones or do-body bindings. UI attribute selectors such as `columns=title,done` resolve schema fields, while expressions use an explicit record binding. See [expressions and scope](03-expressions-and-derives.md#contextual-variables-and-lexical-scope).
