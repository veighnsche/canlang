# Preserved documentation context for later changes

Only the excerpts below were retrieved for this later-change attempt, in addition to inherited initial-task context. No other-variant artifacts or findings were supplied. The parent supplied this feedback: “B and C found no mandatory eight-outcome source/UI repair; exact error(validation) catalogue and fixture overrides of server fields are unresolved shared contract details, preserve those limits rather than invent semantics. No initial repair.”

## design/evaluation/evidence/adoption/experiments/changes-brief.md:1–11

```text
# Matched later changes — E016–E018

Pinned before either change attempt, 2026-10-04. Same Sol6.1 Medium subjects continue their own initial app; no cross-variant artifacts or evaluation findings. Both independent reviews requested no mandatory initial source repair under disclosed business assumptions. Preserve each variant's original privacy/limit choices except the changes explicitly below. Differences in inferred initial policy prevent an exact functional size-ratio claim; do not silently normalize or improve one baseline.

Save three successive draft versions under your variant directory: `change-1/`, `change-2/`, `change-3/`. Each builds on the preceding one. Preserve `initial` and all original metadata. Use relevant source/docs and normal efficient edits; no library/compiler/infrastructure implementation. Record actual read excerpts, commands, timing, touched files/declarations, source checks and assumptions in `changes-context.md`, `changes-metadata.json`, `changes-notes.md`. Hidden usage and missing measurements are null, not estimates.

1. **Ordinary rule/presentation:** caption the title input/output “Request”. Archive requires a trimmed nonempty reason, retained as immutable archive evidence. Preserve owner-only mutation, existing manager/read semantics and stale-version behavior. No second competing archive/delete path may bypass the reason. Show the authorized canonical action in browser/MCP and include expected blank-reason rejection and preserved evidence.
2. **Data change:** add optional cost_centre, maximum40; rename note to details preserving existing text/null/empty meaning; narrow title maximum to120 without truncation. Before activation, any existing title over120 must block until explicitly corrected using the old contract. Distinguish safe additive change, preserving rename and constrained narrowing. There is no real installed predecessor: produce an explicit draft migration/transition description tied to the prior artifact, without inventing a deployed hash, applied history or installed model population. Use exact language/framework notation where support exists; clearly identify evidence needed to pin activation. Keep browser/MCP/CSV/test bindings consistent.
3. **Permission change:** an owner/steward may grant a current member temporary read-only review access to department A until an explicit timestamp, with revocation. Effective scope is current, nonrevoked and now < expiry. Existing employee/manager grants remain; no grant adds write/archive authority. Preserve the original app's extra private-record restriction if present. One canonical read policy/query must control browser lists/search/details, export and MCP, with current rechecks for every new admission and retained grantor/revocation attribution. Include before-expiry, exact-expiry, revoked, other-department and denied-mutation expectations. Do not grant reviewers broad administrative authority or duplicate scope independently in interfaces.

This is one later-change attempt per variant, with ordinary self-checks recorded. Return reviewable artifacts and any precise unresolved contract; do not invent syntax to claim success. At most one independent-review repair is allowed, preserved separately and offered under identical criteria. Source syntax/checks are not executable application proof.
```

## design/evaluation/evidence/adoption/experiments/C/initial.can:1–80

```text
# Request departmental equipment privately, manage your unresolved requests, and review only departments you manage.
app EquipmentRequests
Given
 ## Department assignments are business data; canonical teams still owns authentication and team membership.
 Employee { user:user unique label="Employee", department:enum(A,B,C) label={text="Department",values={A="Department A",B="Department B",C="Department C"}}, manager:bool=false label="Department manager", enabled:bool=true } label="Department assignment"
 policy Employee read=members where=owner or row.user==actor
 lock Employee fields=user
 Request { title:text trim min=1 max=200, note:text? label="Note", submitted_by:user server=actor label="Request owner", department:Employee.department? server=first(Employee as employee where employee.user==actor and employee.enabled)?.department label="Department" } label="Equipment request"
 ## Nullable lookup representation permits an absent assignment to be rejected, never stored as a departmentless request.
 invariant Request: row.department!=null
 lock Request fields=submitted_by,department
 policy Request read=members where=row.submitted_by==actor or any(Employee as employee,employee.user==actor and employee.enabled and employee.manager and employee.department==row.department)
 preferences { view:enum(open,archived,all)=open label={text="Request state",values={open="Open",archived="Archived",all="All"}} }
 fixture current_employee=Employee {user=self,department=A}
 fixture other_employee=Employee {user=other,department=B}
 fixture mine=Request {title="Monitor",submitted_by=self,department=A}
 fixture colleague_a=Request {title="Keyboard",submitted_by=other,department=A}
 fixture colleague_b=Request {title="Dock",submitted_by=other,department=B}
When
 ## The owner maintains current department assignments through browser forms or the same MCP CRUD.
 crud Employee by=owner fields=department,manager,enabled create_fields=user,department,manager,enabled delete=none when=active_member(row.user,team)
 crud Request by=members fields=title,note when=row.submitted_by==actor and row.archived_at==null and any(Employee as employee,employee.user==actor and employee.enabled) label={delete="Archive"}
  examples create seed=[current_employee]
   as,title,note -> count(Request),first(Request)?.title,first(Request)?.submitted_by,first(Request)?.department
   members,"  Monitor  ",null -> 1,"Monitor",self,A
   members,"   ",null -> error(validation)
   public,"Monitor",null -> error(forbidden)
  examples update record=mine seed=[current_employee]
   as,changes.title,changes.note,request.record.version -> mine.title,mine.note,mine.version
   members,"  Wide monitor  ","For desk",1 -> "Wide monitor","For desk",2
   members,"Monitor",null,0 -> error(conflict)
   members,"   ",null,1 -> error(validation)
  examples update record=colleague_a seed=[current_employee]
   as,changes.title -> colleague_a.title
   members,"Changed claim" -> error(rule_failed)
  examples delete record=mine seed=[current_employee]
   as,request.record.version -> mine.archived_at!=null,mine.title,mine.version
   members,1 -> true,"Monitor",2
   members,0 -> error(conflict)
  examples delete record=colleague_a seed=[current_employee]
   as -> colleague_a.archived_at!=null
   members -> error(rule_failed)
 # Read authorized requests including preserved archives; this typed view also supplies scoped CSV export.
 scenario browse() by=members read=true -> Request[]
  do return Request archived=include
  examples seed=[current_employee,mine,colleague_a,colleague_b]
   as,current_employee.manager -> count(result),count(result as request where request.department==B)
   members,false -> 1,0
   members,true -> 2,0
   owner,false -> 1,0
   public,false -> error(forbidden)
 # Find readable exact-title candidates before explicitly choosing whether to create a new request.
 scenario duplicates(title:Request.title,note:Request.note) by=members read=true -> Request[]
  do return Request archived=include as request where request.title==title
  examples seed=[current_employee,mine,colleague_a,colleague_b]
   as,title,note -> count(result)
   members,"  Monitor  ",null -> 1
   members,"Dock",null -> 0
Then
 # Create a request or review a CSV intake; each confirmed row uses the same guarded create operation.
 page / title="Equipment requests"
  require members
  card "New equipment request"
   form Request.create import=csv review=duplicates display=inline
  card "Your requests and managed departments"
   tabs preferences.view
   table Request archived=include as request where preferences.view==all or (preferences.view==open and request.archived_at==null) or (preferences.view==archived and request.archived_at!=null) columns=title,note,department,submitted_by,archived_at order=-created search=title,note filter=department,archived_at display=split empty="No matching requests."
    details "Request evidence"
     text row.title,row.note,row.department,row.submitted_by,row.archived_at
     history
    card "Manage your open request"
     require row.submitted_by==actor and row.archived_at==null
     edit
     delete
 # Maintain current employee department and manager assignments. This grants no unrelated request access.
 page /assignments title="Department assignments"
  require owner
  form Employee.create
  table Employee columns=user,department,manager,enabled filter=department,manager,enabled
   edit
```

## design/evaluation/evidence/adoption/experiments/C/assumptions.md:1–44

```text
# Initial attempt — EquipmentRequests

This is app-specific proposed Can source against the frozen v1 contract, not an executable implementation. No compiler, shared library, runtime, infrastructure, target MJS, or deployment was added. One initial generation with ordinary documentation lookup and self-check; no review feedback or separate repair has been received.

## Business-policy assumptions

- The company provisions exactly one canonical team and its initial owner, admits the 25 users through standard email/password registration/invitations, and assigns their departments through the owner-only assignments page. No actual roster, team identity, or credentials were supplied. A/B/C are the three stable department codes; real names were not supplied.
- Each employee has one current department, and optionally manages that same department. The owner maintains `Employee` business assignments; canonical teams remains the only authentication/membership authority. These assignments add no second login or team-role mechanism. Multiple department management per person was not required and is not supported by this initial source.
- `enabled` marks an effective current department assignment; current canonical team membership is also mandatory for all employee operations and reads. The owner disables an assignment while the employee is still a team member; team removal itself immediately blocks new operations. An assignment cannot be reassigned to another user. A returned employee can reuse/update the retained assignment.
- Request department is a snapshot derived at creation from the authorized principal's current enabled assignment. A subsequent employee transfer changes manager scope through current manager assignments, but does not move old requests to another department. Request ownership survives transfer and remains readable by that owner while a current team member. Confirming transfer behavior would require a business decision; the brief does not specify it.
- Staff and managers see requests under the same read policy. Being team owner, finance, or an operations reviewer grants no extra request scope. A manager who owns a request has ordinary employee rights on that request; a manager cannot alter or archive anyone else's claim.
- Unresolved means not archived. No purchasing, fulfilment, approval, provider, or extra lifecycle was inferred. `archived_at == null` is open; nonnull is archived. This uses canonical archive metadata rather than a second writable status field. No expiry or permanent removal is declared; evidence and audit remain retained subject to the standard runtime contract.
- Title is Unicode-trimmed, 1–200 Unicode scalars. The 200 limit is an inferred practical bound. Note is optional and not trimmed. Duplicate title is a review hint, not a uniqueness prohibition: separate equipment needs may share a title, and users must explicitly confirm creation in the presence of a candidate. Exact repeated normalized CSV rows are additionally flagged by the pinned shared intake contract.
- An employee with no enabled assignment cannot create/update/archive a request. The server department lookup is nullable in representation because `first` may return null; `invariant Request: row.department!=null` rejects departmentless stored data. No client-supplied request owner/department fields are permitted. Department and ownership are locked after creation.

## Necessary wiring/settings notes

Select `EquipmentRequests` from this file in a v1 deployment. Use the pinned defaults (workerd/D1, email/password auth, canonical teams, daisyUI/HTMX, generated OAuth MCP server, English/system theme); no source setup repeats them. Provision the trusted application origin and first owner, create the company team, invite its staff, then establish their A/B/C assignments. No preceding schema/deployment is assumed, so no migration history was invented.

The actual assumed shared contracts are frozen DESIGN §§1–5 (default installation, types, permissions, CRUD/version/archive/receipts), §9 (accessible responsive controls, CSV export/intake and row outcomes), and §10 (one UI/MCP registry and authorization). `Employee` CRUD, `Request` CRUD, `browse`, and `duplicates` are the only app operations. Request create/update/delete use the same server operation identities in browser and MCP; delete means archive. CSV transport/review state is standard form machinery, not a different business mutation API. Request/create inputs contain only title and note. `Employee` administration is explicitly owner-only.

## Independently authored behavior expectations

The source contains inline draft expectations for create/trim/server attribution, own update, stale conflict, another employee's update/archive denial, invalid blank title, retained archive evidence, and ordinary/manager/owner read scope. They have not been executed. The following additionally review the shared interface outcomes for which no inline CSV/export test-invocation syntax is documented:

| Action and setup | Expected outcome |
| --- | --- |
| Employee self in A exports requests with self-owned A request, another employee's A request and another employee's B request present | Only the self-owned request is exported; readable safe identity/version fields are included. A caller-chosen B filter cannot reveal the other request. |
| Manager self in A exports the same setup | Self-owned A plus the other employee's A request; no B request. Finance/reviewer status by itself cannot widen this result. |
| Employee imports header `title,note` and rows `Monitor,desk`, blank title, and a second normalized `Monitor,desk` | Preview creates nothing. Blank title remains an invalid editable row; repeated normalized rows are flagged. Correcting or excluding those rows is explicit, with no automatic merge. |
| After review, employee selects two valid rows, the first succeeds, and their enabled assignment is revoked before the second submission | First request persists with owner and department determined on the server. Second fails safely. UI reports separate row outcomes and retains neither an all-success claim nor an implicit rollback of the first request. |
| A readable duplicate is created after review and before a later confirmed CSV row | Candidate review reruns, and changed candidates require renewed row confirmation. An unchanged duplicate still requires explicit create choice. |
| CSV attempts to map `submitted_by` or `department`, or supplies an unknown column as a request field | Mapping/input validation rejects the protected/unknown writable field. It cannot alter principal/team/department authority. |
| A confirmed row outcome is unknown and retried | Same row identity and frozen inputs reconcile the outcome without duplicate mutation; pending/unknown/succeeded/failed are separate statuses. |
| Narrow screen and invalid/conflict outcome | Standard responsive detail drawer and typed controls remain keyboard accessible, preserve authorized editable input, announce safe errors, and show authorized current values on conflict. |

## Observed limitations and unverified outcomes

- The only executed check was `python3 tools/can_parser.py design/evaluation/evidence/adoption/experiments/C/initial.can`. It failed at line 64, column 24: `unsupported attribute import`. Frozen GRAMMAR explicitly documents `form ... import=csv review=...` and states the syntax prototype does not yet accept these attributes. The initial source retains the normative contract, and is not claimed to parse successfully.
- No semantic checker, generated UI/MCP, fixture runner, CSV session test runner, app execution, deployment, security test, scale test, or performance test ran. All successful business expectations remain proposed.
- Parser stopping at CSV means it did not finish checking the whole file. A manual source self-check removed an enum-valued `search=department` from the assignments table; department remains a typed filter. This was part of the initial attempt before review, not a separate repair turn.
- Fixture overrides of server-initialized fields, nullable enum narrowing, lookup authority, inline example `result` shape, and exact rejection codes are intended according to the frozen design, but unverified by semantic execution. The source assumes CRUD `when` rejection uses the documented safe business-rule code `rule_failed`; the design explicitly defines that code for guards but does not separately name `when`'s code.
- `browse` examples test ordinary authorized read scope, not actual CSV bytes. Partial-import/export expectations above are independently authored prose because no canonical operation for an inline import-session/export-byte example is documented. Shared export/intake contracts are named, not implemented in this experiment.
- 500 records/25 users fit the documented UI paging and CSV row bounds. This is contract compatibility, not evidence of deployed throughput or D1 contention behavior.
```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:101–104

```text
Every record has `id`, `version`, `created`, `updated`, `created_by`, `updated_by`, and nullable `archived_at`. These names are reserved. IDs are opaque strings; attribution names stable accounts or trusted sources and survives membership removal. A model name denotes a type/collection, **never a current record**.

A created row has version 1 throughout its creating transaction, including create-hook adjustments. Ordinary references to an existing row expose its admitted version `v` throughout the owner transaction while field reads observe ordered provisional changes. An accepted `set`, CRUD update or archive reserves `v+1`, even for a normalized same-value write. Further writes/calls/hooks to that row do not advance it again. Update-hook `event.before.version` is `v` and `event.after.version` is the reserved `v+1`; create-after is 1. Permanent removal has no after record; its deleted event carries `v+1`. A child write does not advance an unwritten parent. Failed operations advance nothing; receipt replay reapplies nothing. This write-intent rule intentionally produces history/version changes for accepted no-op writes. Locks compare stored values, not modification metadata.

```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:280–299

```text
A declared role also accepts one explicit subject: `salesperson(person)` returns bool for `person:user` in the current verified team. This is a role predicate application using ordinary call syntax, not a first-class callable/value type. Resolve the callee by normal lexical/import rules; its declaration must be a visible declared team role. The existing bare `salesperson` is the canonical literal-actor spelling; `salesperson(actor)` is redundant and diagnosed, while another expression may evaluate to the same account. Built-in `owner`, `members`, `authenticated` and `public` do not gain a call form; `active_member(person,team)` remains the existing explicit membership test. No-team contexts cannot evaluate a declared team role.

The subject must be an active member of that team with the explicit package-qualified assignment; a team owner does not automatically hold every declared role. Missing, inactive or foreign-team membership yields false. Use current admission authorization state and the same commit fence as caller-role checks. The predicate provides neither account enumeration nor record access, never switches actor, and never narrows actor to nonnull merely because another subject holds a role. It can restrict prospective assignments but must not be a stored historical invariant that invalidates old records on later revocation. No role-name strings, dynamic role values or second role storage are introduced.

For the authenticated caller only, `actor.email:email` and `actor.email_verified:bool` are read-only admission facts supplied by canonical auth. They permit explicit addressed-invitation acceptance without a parallel identity service. Other user references do not expose those properties or a global email directory; request inputs cannot override them.

```can
policy Candidate read=recruiter
policy Candidate read=interviewer where=row.interviewer!=null and row.interviewer.user==actor fields=name,interview_at
invariant Line: row.quantity>0
lock Invoice fields=customer,total when=row.status!=draft
```

Policies grant **reads**, including files. No policy means deny. Matching grants union their fields for matching rows; omitted `fields` grants ordinary fields and safe record metadata, never secrets. Identity/team/parent boundaries always apply. Public and external-user grants are explicit exceptions to membership requirements, evaluated in the resolved record/team scope. New cross-team record relationships are rejected.

User queries apply row/field permissions before filters, searches, ordering, counts, aggregates, relationship expansion, and serialization. A derived value is readable only if its data dependencies are readable. A confidential aggregate needs a specifically authorized read scenario with `scope=authority`, described below. No separate `projection` primitive duplicates policy field grants.

Pure queries inherit their declaration's evaluation authority. Read-policy decisions, invariants, pre-state locks, CRUD `when` and mutation/trusted-handler decision expressions inspect bounded authority state at the resolved storage owner; they do not recursively apply read policies to their decision scans. Derives inherit the caller's mode. Team/parent/storage boundaries, expiry and work bounds still apply. A policy may inspect its own grant-table model without recursively evaluating that model's read policy. Pure derive/call cycles are invalid. Ordinary viewer queries and `read=true` bodies remain permission-filtered; authority decision data does not become a result grant. The existing explicit `scope=authority` report boundary remains required for confidential outputs.

`invariant Model: predicate` is a pure invariant in `row` scope, checked for every affected row in the proposed final state. Dependency analysis rechecks relevant rows when referenced data changes; oversized dependency work fails with a bounded-work error. Deleting a referenced row fails unless references have been removed in the same operation. Invariants do not emit events or perform effects. `invariant` is the sole Given introducer; the former Given `require Model: predicate` spelling is invalid. Execution guards, presentation gates and migration/backfill checks retain `require`. Both words remain contextual names outside their syntax slots.
```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:299–350

```text
`invariant Model: predicate` is a pure invariant in `row` scope, checked for every affected row in the proposed final state. Dependency analysis rechecks relevant rows when referenced data changes; oversized dependency work fails with a bounded-work error. Deleting a referenced row fails unless references have been removed in the same operation. Invariants do not emit events or perform effects. `invariant` is the sole Given introducer; the former Given `require Model: predicate` spelling is invalid. Execution guards, presentation gates and migration/backfill checks retain `require`. Both words remain contextual names outside their syntax slots.

`lock Model fields=... [when=predicate]` evaluates on the **pre-state**. An omitted predicate means true: the fields are always locked, so do not repeat `when=true`. If the predicate is true, those field values cannot change and the row cannot be removed, including through scenarios or hooks. The sole lifetime exception is whole-record disposal after declared expiry (§7.1), not early deletion or field editing. The transition establishing a conditional lock may set final values. A child rule may inspect `row.parent`. Archival preserves locked values. No separate freeze/immutable/snapshot variants: copy selected values into typed snapshot fields with `set`/`create`, then lock them. Audit history is automatic.

Operation `by` governs its writes independently of generic CRUD input fields. All paths still enforce ownership, invariants, locks, versions, and reference validity. Scenarios may inspect authority data needed for their rules; this does not grant callers access to that data. Guard failures default to a generic business-rule error; diagnostic messages must not disclose confidential values, including arguments omitted by the selected translation.

## 5. Canonical operations

```can
crud Todo by=members fields=title,done,assignee
# Complete an open task.
scenario complete(todo:Todo) by=members
 require not todo.done
 do set todo {done=true}
```

There is at most one `crud` declaration per model. It generates create, update, and delete operations. `fields` is the update allowlist and, unless a different `create_fields` is supplied, the create allowlist. Do not copy an identical list into `create_fields`. `create=none`, `update=none`, or `delete=none` disables that operation. `when=predicate` applies to each normalized proposed create/update row and the existing delete row. Prepare defaults and server-owned fields without staging this write, evaluate the predicate, then stage only on acceptance. Field reads through `row` observe the candidate; model scans observe the provisional owner store immediately before this write, including earlier effects but not this candidate write. Updates still leave the old stored row visible to scans during admission. Delete admission runs before removal. Final invariants inspect the completed provisional state. Mandatory cross-path business rules belong in invariants/locks. All required create fields must be supplied, defaulted, or server-owned. A child create takes its protected parent binding. Create defaults do not run again on update; omitted update fields are unchanged, and explicit null clears a nullable field.

Omitted deletion mode means archive: delete archives the row and its contained subtree, atomically. Do not repeat `delete=archive`. It does not create a second archive API. `delete=remove` permanently removes an unreferenced row/subtree and is explicit; `delete=none` preserves an intentional prohibition. Existing references to archived rows remain valid for authorized history; new references cannot target them. Archived rows cannot be edited; restoration is outside v1. Audit/receipt retention is independent of deletion.

A scenario declares every parameter's type. `p:T` is required; `p:T?` defaults to null; `p:T=expr` has a default. `Model.field` inherits value constraints, not its storage default/server ownership. There is no inference from parameter spelling or later prose. Parameter defaults are pure and evaluated at invocation. A mutation's record parameters carry expected versions; read parameters need only IDs.

External mutation admission authenticates the caller/resolves the authorized team and checks `by` before the body. Record inputs resolve their declared type, owner/team, lifetime and expected version within that boundary. The operation’s authored guards govern permission to mutate that record; an ordinary viewer read grant is not an extra universal write prerequisite. This retains §4’s separate read/write permissions rather than silently granting reads to make a write possible. An unreadable record supplied by opaque ID confers no authority: the same owning guards still run and may reject with the generic `rule_failed` without exposing confidential values. Missing, expired or foreign-owner references remain `not_found`; ordinary read/look-up interfaces hide unreadable rows, and page pickers remain viewer-filtered. Return values and changed-record projections still obey their existing disclosure rules, and file attachment authority is checked independently. A caller with only broad operation membership cannot bypass a missing per-record business guard; such a missing guard is an application defect, not inferred permission from an ID. Trusted handlers retain their verified source authority and local calls retain their unchanged caller.

The effect vocabulary is finite:

| Statement | Meaning |
| --- | --- |
| `let name=expr` | Immutable local binding |
| `require expr [message=expr]` | Reject without committing if false; message is literal text or a message descriptor |
| `create Model {fields} as name` | Insert and bind a record; child inputs include `parent` |
| `set record {fields}` | Assign named fields; no implied copies or model-name rebinding |
| `delete record` | Apply the model's declared deletion mode; allowed only if deletion is enabled |
| `call operation {arguments} [as name]` | Invoke a canonical operation in the same transaction/context; recheck its `by`, rules and ownership |
| `if expr` / `else` | Indented conditional branches |
| `for item in query limit=N` | Bounded loop; fail the entire operation if more than N items would be processed |
| `emit Event {fields}` | Persist one typed domain event for post-commit handling |
| `send Target.operation {arguments} [when=predicate] as delivery` | Persist a typed external delivery intent; returns a receipt, not provider success |
| `schedule key at=instant event=Event {fields}` | Replace one named pending occurrence at this owner; key is a text expression |
| `cancel key` | Cancel the named pending occurrence if not dispatched |
| `return expr` | Return one statically typed result and end evaluation |

Each scenario has one lowercase `do` execution body. An inline `do` may contain simple statements separated by `;`; a block `do` contains any statements. It replaces the earlier lowercase `then` spelling, which is no longer a body introducer. Leading `require` checks and the body execute in written order; further `require` checks may occur inside the body, including between effects. A failed check rejects the whole provisional mutation. `do` also introduces pure read bodies and trusted-handler bodies; it creates no additional transaction or authority. Attached `examples` stays outside the execution body and is test-only. Uppercase package `Then` still declares presentation. No nested `atomic`: a mutation is already one atomic unit at its inferred owner. No `clear`, `insert`, `upsert`, `append`, `snapshot`, `freeze`, arbitrary SQL/JS, or free-form effects. Collections stored by value are replaced through `set`; large mutable child collections are models.

Cross-package `call` is the only way to mutate another package's model. It participates in the caller's operation identity, invokes no network request, and cannot recurse. Direct parameter assignment is never storage mutation. A scenario cannot synthesize user privilege or trusted source status.

Every authored `require` has the same rejection semantics, including leading checks in trusted handlers. False means the safe business error, default `rule_failed`, and rollback of all provisional domain changes, events, deliveries and attachment links. A trusted business rejection is a terminal failed occurrence; transient runtime failures retry the same occurrence. Lifecycle `skipped` describes superseded/cancelled/ineligible work or a false dispatch `send when`, not a false authored `require`. Inline examples observe the ordinary business error, without committing rejected domain effects.

Mutation results default to a receipt plus authorized changed-record projections. Explicit mutation returns may contain literals, input values, generated receipts, and readable record values. Private authority-derived scalars cannot leak through return values; the compiler tracks these dependencies. A deliberate privileged report uses `scenario ... read=true scope=authority -> Contract by=...`: its typed result is an explicit information grant to `by`. Ordinary `read=true` uses viewer queries, allows only pure statements, and has a required result type and return on every path. Source-scoped reports must have a description identifying the information exposed. Mutation success/failure can inherently reveal the stated operation's permitted business outcome, such as availability; it never returns hidden rows or SQL diagnostics.

### 5.1. Inline behavior examples

```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:743–773

```text
Compilation parses and type-checks, resolves names/ownership/permissions/effects, and emits one workerd application, generated interfaces, Cloudflare binding requirements, versioned schema/index migrations, and the inline-example test artifact. These are compiler phases, not app framework layers. Diagnostics identify file/declaration/field and one concrete error; unknown syntax is an error, not an AI interpretation opportunity.

Application source has no executable general-purpose escape hatch. Pure derivations compose expressions; scenarios compose canonical effects; integrations implement declared external contracts. The compiler does not invent business decisions, provider mappings, field names, or functions to make a source file appear complete.

Schema evolution uses the explicit maintenance declarations below. Automatic changes are conditional, not a blanket exemption for optional/defaulted fields or indexes. Never infer a rename from similar spelling or erase data to satisfy a compile. Generated Cloudflare deployment configuration tracks its supported provider version; application data migrations are distinct from Durable Object class lifecycle configuration.

The language version pins builtin signatures, wire schemas, currency scales, timezone data, runtime defaults, and component behavior. App deployments record that version without repeating a version on every declaration. Compiler/runtime versions cannot silently reinterpret a running app. Component download/tree-shaking, SQL planning, password-hash implementation, and bundler choice are implementation work; their absence is not permission to invent alternative source syntax.

### 11.1. Schema evolution boundary and versions

`migration Owner from="snapshot-id"` is a top-level maintenance declaration alongside actual business source. `Owner` references a logical named package or small app's implicit package; it creates no additional owner, package wrapper or namespace. It is outside Given/When/Then and has no `by`, `on`, `export`, business parameters or UI/MCP operation. File placement supplies no execution order. A composed app has no aggregate schema owner: its included local packages contribute their own transitions, including dependency-only packages. Bound providers are never migrated by a consumer.

`from` must identify the exact compiler-produced installed owner snapshot: canonical stored schema, constraints, locks/lifetimes, effective language version, resolved physical bindings/routing and persisted declaration contracts. The deployment also retains release artifacts and inventories the actual contracts of queued work; equal table shapes cannot establish equal handler meaning. Current declarations determine the desired snapshot. Migration bodies are excluded from that snapshot's fingerprint; their canonical content has a separate digest. Diff diagnostics expose the actual predecessor ID and changes requiring explicit disposition. Authors do not repeat old schemas, write version counters or maintain a migration manifest. Missing or mismatched predecessor evidence blocks an upgrade.

The compiler selects transitions relevant to the desired local closure or exact installed local owners being removed. Unrelated declarations remain inert. For `rename owner`, the header names the desired owner and `from` supplies the differently named predecessor. For `drop owner`, the header instead names the removed installed owner, resolved through that exact snapshot and installed inventory despite its absence from current declarations. Each old logical owner is retained, explicitly renamed once, or explicitly dropped; a target consumes at most one predecessor. There may be alternative `from` declarations for different installed snapshots, but at most one exact matching transition for each owner/source is selected. Reject duplicate consumption, merges, collisions and competing mappings. Matching contributions from different owners form one derived deployment plan rather than competing plans. A newly included owner starts empty, without importing another deployment's data.

The generated transition records its predecessor, desired snapshot, body digest and application/progress status. Applied artifacts are immutable: changing their transformation or target is not a replay. Source can replace completed transitions with current upgrade alternatives; generated deployment history retains the applied artifacts. When current declarations change the target of a retained source transition, it is a new candidate artifact requiring validation against that predecessor, never a replacement for the applied artifact. An older deployment requires a matching authored path to the current target, not an inferred jump or a replay retargeted to newer declarations. Fresh installs create the current schema without applying old transitions or requiring their snapshots. They check current syntax/targets and do not claim inactive `before` paths have been typechecked.

| Change | Treatment |
| --- | --- |
| New empty model, nullable/context-free constant field, nonunique query index | Candidate automatic change only if ownership, references, locks/history and the complete stored state remain valid. |
| Actor/clock/random default or historical business snapshot | No inferred backfill. Supply an explicit transition and defensible historical values. |
| Rename/removal, required backfill, narrower enum/type/invariant, new/changed uniqueness, stored-to-derived change or semantic data conversion | Explicit transition; validate the complete desired state, including archived rows and retained key/reference constraints. |
| Creation-default edit | Changes future creation only; does not rewrite existing values. |
| Logical package/implicit-app rename | Explicit one-to-one identity mapping, with physical scope/routing unchanged. |
| Team/parent/physical storage transfer, record split/merge or population of a new model from old rows | Outside this v1 migration subset; block rather than invent a mapping. |

Storage compatibility and UI/MCP, bound-interface, record-version and pending-work compatibility are separate. Automatic candidates must pass both applicable boundaries. In particular, an optional field with a new invariant or a unique index is not automatically safe. Unknown historical membership anchors/intervals cannot be recovered from a current default or mutable plan.

### 11.2. Typed transition directives

```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:774–805

```text
Outside a mapper, `before` names the pinned predecessor's declaration namespace; unqualified target names resolve in the header's desired logical owner. Structural directives describe a mapping, not an imperative rename sequence. Establish all mappings before mapper guards or bodies; their written order does not change name resolution. Each old model/field is retained, renamed or dropped once, and each target has at most one mapped source. A drop cannot also map the same source, and competing destinations/sources are errors. Value initialization is a separate phase: one `backfill` per target model may transform retained or renamed fields. Thus model rename plus backfill, or field rename followed by an explicit `set row`, is valid subject to old locks; `before` remains unchanged throughout.

| Directive | Meaning |
| --- | --- |
| `rename owner` | Map the predecessor's canonical package prefix to the header owner; required when those identities differ. |
| `drop owner` | Remove the predecessor's complete logical owner; the header owner must be absent from the desired schema. |
| `rename before.Model to Model` | Preserve rows/IDs through an explicit one-to-one model-name mapping. |
| `rename before.Model.field to Model.field` | Preserve the value through an explicit stored-field mapping; source and destination belong to the corresponding old/desired model. |
| `drop before.Model` or `drop before.Model.field` | Explicitly acknowledge removal of a stored model/field. |
| `backfill Model` | Transform each corresponding old row into its desired stored shape using the body below. |
| `invalidate before.handler` | Dispose eligible undispatched work of an inventoried old asynchronous trusted handler, as specified in §11.3. |

An owner rename preserves physical authority, protected scope/containment, IDs and immutable file objects. Stored model references and schedule namespaces follow the explicit canonical mapping; historical receipt identities remain historical. Carry role grants only to valid surviving mapped roles; removed or incompatible assignments must first be explicitly reconciled, and new roles gain no assignments. The directive supplies no public wire alias, Cloudflare class transfer or remote reauthorization. Bound clients/interfaces need their own compatible installation. Owner/model/field drops remain subject to locks, incoming references, expiry, file accounting and replay rules; `drop owner` is not a namespace-deletion bypass. A transition with no row directives can acknowledge a constraint-only change, but still cannot authorize an undeclared removal or infer a rename.

`backfill Model` binds a read-only `before` old row and a partially initialized desired `row`. After structural mapping, same-representation values may be copied without coercion or normalization; they initialize desired fields only when valid under the desired field definition. Initialize new fields only with proven compatible null/context-free constant defaults. Changed representation types, including incompatible enum/reference types, require explicit assignment; `before.field` retains its old type for conversion. Mapper dataflow must prove a field initialized before reading it or completing the row; if a copied value's validity is not provable, explicitly assign it instead. Leading `require` and one `do` body reuse `let`, `require`, `if`/`else` and `set row {fields}`. Assign every uninitialized stored field on all successful paths. A nullable field is not a license to silently replace incompatible old data with null. Desired derived fields are read-only. Representation-preserving constraint-only transitions may validate unchanged values without a mapper and fail if any violate the desired definition. Final field constraints, invariants, uniqueness, references and lifetimes must hold for the complete target dataset.

The mapper reads frozen stored value components and opaque reference identities of its old row. A reference assignment requires a known retained/renamed target model with the same protected scope/authority. It cannot dereference another record, run collection queries, use actor/clock/random, invoke operations/hooks/providers, or `create`, `delete`, `emit`, `send`, `schedule` or `return`. The runtime supplies complete bounded iteration and checkpoints; ordinary `for ... limit` is not a migration loop. Staged output cannot become another row's input. This is maintenance initialization, not a second user CRUD route.

Old locks are evaluated on original pre-state. Renaming protected data preserves its value; changing/removing still-locked evidence fails. While an old lock protects retained predecessor rows, preserve its mapped predicate and at least its field coverage; this subset permits identifier renames and added protection, not arbitrary lock rewrites or removal. Each originally protected retained row must still satisfy that mapped predicate after backfill, so editing a different predicate input cannot silently unlock it. No general predicate-equivalence prover or historical per-row policy layer is implied. New locked fields can be established during initialization, then their desired locks apply. Include archived rows without unarchiving or changing protected identity/creation metadata. Expired content cannot be read, backfilled or resurrected; affected incompatible physical expiry backlog must finish disposal under its old lifecycle before activation. Retained references and uniqueness still block where applicable. Name-only changes preserve row versions. Actual stored-value initialization/conversion, including default/null materialization, advances each affected row once with trusted migration attribution; pending version bindings must be assessed. File references retain their real object identity; release relationships before retryable collection. Dropping schema does not promise erasure of historical audit/receipt/provider copies beyond the canonical retention contract.

Illustration only: suppose a compiler-recorded predecessor contained `Todo {label:text trim max=200,done:bool=false,legacy:text?}`. The following desired source explicitly renames `label`, initializes a required priority and removes `legacy`. This is not the history of the reference app. Replace the placeholder with its real compiler-issued snapshot ID; an upgrade using the placeholder must fail.

```can
# Track team work.
app TeamTasks
Given
 Todo {title:text trim max=200,done:bool=false,priority:enum(low,normal)}
 policy Todo read=members
When
 crud Todo by=members fields=title,done,priority
Then

```

## design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md:165–192

```text
enum_type        = "enum" "(" separated(NAME) [","] ")" ;
action_type      = "action" "(" separated(path) [","] ")" ;
field_type       = type ["!"] ;
schema           = "{" bracketed(field) "}" ;
field            = NAME ":" field_type [initializer] {field_modifier} [field_label_attribute] ;
initializer      = "=" expr | "server" "=" expr ;
field_modifier   = "trim" | "unique" | "min" "=" expr | "max" "=" expr ;
parameters       = "(" bracketed(parameter) ")" ;
parameter        = NAME ":" type ["=" expr] [field_label_attribute] ;
```

`enum(...)` and `action(...)` are recognized by their exact call-shaped type production. A bare type path component named `enum` or `action` is not globally banned. Their atom forms are not union arms. Union `|` combines all named paths before array/container suffixes: `A|B[]?` means a nullable array of union values. There are no grouped types, repeated array suffixes or nullable-element spelling `T?[]`. A scalar may have `?` without an array. Enumerator/allowed-action lists are syntactically nonempty, and enum entries are unqualified names. Checking requires distinct values and valid canonical action targets. Union arms must resolve to the supported tagged named value types; primitive unions are not authorized by their syntactic path shape.

The trailing field `!` is creation metadata, not a value-type operator. `text!`, `text?!`, `text[]?!` and repeated `!` are invalid; an explicitly written nonnullable array can use `text[]!`. A qualified field path whose representation is unresolved can be parsed with `!`, as in `items:Contract.rows!`; later checking must prove that the reused field is a nonnullable array. A required-array-input field cannot also have a default or server initializer. A syntax-only parser must not claim it knows an unresolved path's representation.

Suffixes act on the resolved value, including inherited field types. Applying `[]` to an already nullable value or array is forbidden. Applying `?` to an already nullable value is redundant and invalid. A reused nonnullable array may acquire container nullability or the field-only required marker, but not both. These rules prevent qualified field reuse from smuggling nested arrays or nullable elements into the subset. Reuse retains representation/nullability and normalization/value bounds, but never the old initializer, required-array-input marker, server ownership, uniqueness, scope or policy.

Fields may have one initializer and one occurrence of each modifier; initializers precede modifiers. A field default or bound is delimited by the next field modifier at current depth or the schema comma/closer. Bare `trim`/`unique` terminate the preceding complete value just as `min=`/`max=` do. Type checking determines compatible modifiers, default values, nullability and initialization obligations. Schema fields use colons and require commas, including between fields on joined physical lines. An optional `label=` follows its initializer/modifiers and delimits a preceding complete expression. A field description does not replace its comma.

Parameters have no field-only `!`, server initializer or field modifier list; their optional trailing `label=` follows any default. Their required/defaulted/nullable input behavior comes from their signature and DESIGN. Capability operation signatures use `NAME parameters "->" type`, pure functions parse `derive path parameters ":" type "=" expr`, and scenario signatures use the table's header attributes/result annotation. Checking must establish a valid owning function name for a parsed derive path; a path is not an automatic cross-package extension. Parameters and defaults must resolve and type-check; parameter spelling never infers a type.

## Expressions and values

The following productions are syntactic. Their apparent function/type paths require later resolution; constructors, functions and operation identities are not inferred from an attractive name.

```ebnf
expr           = ordinary [query_tail] ;
ordinary       = fallback ;
```

## design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md:410–450

```text
                | "rename" before_path "to" path
                | "drop" before_path | "invalidate" before_path ;
before_path    = "before" "." NAME ["." NAME] ;
backfill       = "backfill" NAME suite(mapper_body) ;
mapper_body    = {guard_line} mapper_do ;
mapper_do      = "do" (line(mapper_leaves) | suite(mapper_effects)) ;
mapper_effects = {line(mapper_leaves) | mapper_conditional} ;
mapper_leaves  = mapper_leaf {";" mapper_leaf} ;
mapper_leaf    = let | guard | "set" "row" values ;
mapper_conditional = "if" expr suite(mapper_effects)
                     ["else" suite(mapper_effects)] ;
```

Each migration is top-level, outside package sections, with a required string predecessor snapshot. `rename before.Model to Model` uses model paths, and field rename/drop uses exactly an old model/field pair; target path shape must match the directive kind. `invalidate` accepts exactly `before.handler`, not a field path. Owner rename/drop has no additional target token. Backfill names a desired model; logical-owner names, directive targets and predecessor identities require resolution. Structural directives describe mappings independent of their textual placement; the full mapping is established before executing any mapper. A standalone migration header can acknowledge a constraint-only transition without inventing a no-op directive. Its body, when present, is nonempty; omitting row directives never authorizes undeclared removals or inferred renames.

Mapper `before` is the pinned old row and `row` the partially initialized desired row. The mapper reuses expressions, leading guards, one do body, lets, conditional suites and `set row`. It has no for/create/delete/call/emit/send/schedule/cancel/return production. Pure expression parsing alone does not authorize queries, record dereferencing, actor/clock/random access or provider calls in a mapper; a checker must reject those dependencies. Complete initialization, old locks, identity/field mapping, desired constraints, installed snapshot matching, queued-work compatibility and actual migration application remain semantic/runtime work.

## Verification boundary

This grammar establishes source structure and rejects unsupported spelling. A syntax AST parser must retain physical start locations and parse every accepted token into structure, including examples and fields, and report the file, physical line, column and expectation for failures. Complete AST end spans are additional implementation work, not implied by a start location. Testing the current source corpus alone cannot exercise absent features such as semicolon sequences, unions, field descriptions, richer contexts and maintenance declarations. Syntax coverage neither supplies a type checker/runtime nor proves the design's business requirements. Compiler-derived schemas, interfaces, indexes and deployment plans do not require authored manifests or additional source primitives.

## Personal configuration and presentation boundaries

Given `preferences {fields}` is selected before the same-shaped model production. It is the sole unnamed extension declaration; `preferences Name {fields}` and exports are errors. A field called preferences remains legal. Empty and duplicate owner schemas are rejected syntactically; allowed field types, constant defaults, preference invariants and presentation-only dependency checks are semantic, as defined in DESIGN §9.

Then accepts only pages. Authored nav/link trees are removed; navigation derives from eligible pages with page-local exceptions. Grouping retains scope. Collection defaults use the existing values-object production, never a new query or permission grammar. Typed filter matching and display values require semantic checks. The parser rejects details with both display and open, since open is only for default Collapse.

`tabs [expr]` may have `tab expr` child suites; only direct tab children are allowed. A selector-free tabs header requires suites. Each tab requires a nonempty normal presentation body. A selector-backed leaf is allowed. Semantic resolution requires an owned enum preference selector and, in its block form, every exact distinct case once. Unbound tab captions must resolve to text/messages. Types do not choose the syntactic production.

Declaration-local `label=` and inline `@{...}` descriptors follow the closed forms above. Parsing their shape does not validate captions, inherited assets, source-language ownership or locale coverage.

## Semantic refinement boundary

DESIGN §3 defines lexical binding before enum-case expectation, protected active contextual facts, permitted nested authored shadowing, left-to-right signature defaults, and the finite numeric/builtin signatures. These are checking rules, not parser guesses. Defaults may reference earlier inputs, never later inputs or body locals. §5.1 rejects overlapping example selector paths and fixture aliases, resolves cells against untouched seeded state, and keeps common bindings as the override baseline. Trusted leading and body `require` share rejection semantics. §6 infers independent D1 team/app recurring scopes; root-bound ticks are unsupported in v1. §8 specifies receiver-finalized typed file results without additional source syntax. §9 defines datetime inputs, finite filters and safe instance labels as shared behavior. A parsed tree alone cannot establish any of these semantic contracts.

Declared team-role subject checks reuse `call_expr`: a resolved role callee accepts exactly one nonnull user expression and returns bool in the verified team context. Normal lexical/import resolution applies. A bare role remains the literal-actor predicate; an explicit `role(actor)` is redundant. This semantic call form creates no first-class function or role-value type, and does not authenticate or impersonate its subject. See DESIGN §4.

CSV form import uses existing attribute grammar with `import=csv` and optional `review=path`. The target must be a canonical mutation and the review a pure model-array read with compatible named input bindings. No new effect, batch scenario or form-input expression scope is added. `app_url` is a closed typed builtin using ordinary call syntax. The unchanged syntax prototype does not yet accept the new form attributes; this is a recorded prototype boundary, not alternate source spelling.

A page refresh attribute names a canonical operation, not an arbitrary expression, callback or source URL. Semantic checks require an existing same-page form, no record parameters, and the active-session invocation contract in DESIGN §9. Representation polling stays GET-only. The syntax prototype has not yet implemented this page attribute.

```

## Commands actually used

- UTC clock observations via clock__curr_time.
- cat changes-brief.md, own initial.can and assumptions.md.
- sed targeted DESIGN/GRAMMAR ranges listed above.
- python3 /tmp/can_changes_subject.py: local app-specific snapshot text edits; initial preserved.
- python3 tools/can_parser.py followed by change-1/app.can, change-2/app.can, change-3/app.can: one structural invocation, exit1, unsupported CSV attributes at 78:24, 83:24, 116:24.
- Python pathlib/hashlib/difflib/json wrote evidence records and byte hashes. No runtime/business tests or live application edits.
