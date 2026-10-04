# Status-only receipt disclosure — 2026-10-04

This focused contract is applied to the shared draft specifications and the Grant/Mail witnesses. Its imports remain proposed; no implementation or executed permission-test result is claimed. Delivery business outcomes and recipient authority remain owned by their existing declarations.

## Verified problem

Mail's `Item.notification:delivery(Mail.send)?` holds the current notice attempt. Its `Item.notice_state:DeliveryResult.status? = row.notification?.status` derive preserves the existing Notification column and localized case captions. The pre-correction recipient policy granted `service,recipient,kind,state,notice_state,completed,created`, not `notification`.

DESIGN §4 requires readable dependencies and viewer-mode derives. §8.1 additionally requires the containing delivery field grant. Therefore the current recipient cannot read this derive. Granting the whole association would expose more than the original status-only grant. Presentation that defaults to status does not repair that authorization difference.

Actual `recipient(person,service)` requires `service.parent.active`, null customer/contact archive times, a verified service contact, nonnull contact account, and account equality. It does not require the mail service to remain live for custody/status access. The separate staff grant is `mail_staff and can_work(actor,row.location)`. The consultation briefs' shorthand “active customer/contact” means precisely these predicates; Contact has no additional `active` field. A verified but archived contact fails. No login-email directory is involved.

GRAMMAR already defines `selector = path`, but DESIGN does not assign leaf-grant semantics to an embedded value path. The existing `delivery(c,handle)` proposal does not establish which containing field authorized a read. Neither syntax acceptance nor possession of an opaque ID supplies that missing rule.

## Advice and disagreement

Three independently rewritten, facts-only choice briefs and full responses are retained under [design/jev/delivery-leaf-grants-20261004](jev/delivery-leaf-grants-20261004). No source files or credentials were attached. The first sandboxed connection failed without an HTTP result; the same caller and request succeeded after ordinary reviewed network escalation under standing human authorization.

| Request | Leaf grants | Authority read | Stored mirror | Selected | Confidence |
| --- | ---: | ---: | ---: | --- | ---: |
| 1 | .65 | .10 | .25 | Leaf grants | .47 |
| 2 | .46 | .44 | .10 | Leaf grants | .18 |
| 3 | .38 | .54 | .08 | Authority read | .32 |

This is substantive disagreement, not consensus or an approval threshold. Responses contain probabilities and confidence but no explanatory rationale. Do not invent one.

I investigated the alternatives by tracing complete source and target boundaries:

- An existing `scope=authority` read can safely return a nullable status after explicit current recipient-or-staff/workplace checks. It adds no field-permission semantics. It needs its own declared result, guarded operation and read-form presentation. The existing automatic table column cannot obtain that operation's result without an explicit invocation/composition change; ordinary derives cannot call it as a privileged shortcut. This route is valid when an explicit read interaction is acceptable.
- A stored status mirror preserves today's independent field grant and existing table. Enqueue sets pending; callbacks match the current association before copying status. It needs no new disclosure rule. Receipt progress then causes domain version/history changes and follows callback processing, even when no domain transition occurs. It is coherent if those writes and repeated transport copying are desired.
- An explicit value-leaf grant preserves the automatic column while keeping transport progress outside domain writes. It is coherent only if nullable presence, dependency checking, serialization and record-field provenance are specified together. Merely appending a selector or returning an unrestricted receipt object is insufficient.

**Applied decision: explicit narrow leaf grants**, with the complete rules below. The deciding application requirement is preserving the status-only field experience while adopting runtime-owned transport observations. This is a design judgment under the recorded uncertainty, not a claim that JEV settled it. The authority-read interaction remains a coherent alternative; adopting leaf grants requires all the disclosure rules below rather than silently publishing the ungranted derive.

## Exact shared draft contract

`policy ... fields=` may name a leaf path through a singular embedded value, including an associated delivery's declared observation schema. Each interior component must be a typed value component, not a model/user/member reference, array, arbitrary JSON, secret, action or file. A path cannot follow a record relationship and grant fields on that other record. Existing containing-record/team/lifetime checks remain necessary. Reject unknown paths and paths through unsupported shapes; do not infer a directory or cross-record authority.

A leaf selector grants that leaf and only the null/presence observations necessary to traverse its nullable prefixes. It does not grant the containing value as a first-class value, its identity, siblings, other projections or serialization of the whole value. Selecting `notification.status` explicitly permits distinguishing no associated request from an associated transport status; it grants neither `notification.id`, `notification.result`, `notification.error` nor the frozen request. A whole-field selector retains its existing meaning and additional result/error/file/lifetime restrictions. Matching grants union authorized paths; granting a parent subsumes its descendants. Partial paths never expand into an implicit parent grant.

The dependency of `row.notification?.status` is the selected leaf and its required nullable traversal, not an arbitrary whole-value extraction. A derive still needs an explicit grant for the derived field **and** readable dependencies under its caller's mode. Thus `fields=notice_state` alone is insufficient; `fields=notice_state,notification.status` is sufficient for this exact derive. A later change that reads result/error/ID requires the corresponding authority; it cannot inherit permission from the old derive caption or result type. This is explicit field authorization, not automatic derived declassification or an authority derive.

Viewer filtering, comparisons, ordering, aggregates, history and response serialization use those same resolved leaf grants. Unreadable leaves remain withheld, never null, an empty string, or fabricated status. A nullable prefix may be serialized as null only when the caller has the selected path's grant. Otherwise the entire denied path is omitted/withheld under the existing projection contract. For an authorized nonnull association with only its status leaf readable, a projected object may contain `notification: {status: ...}`; it is a read projection, not a first-class delivery handle and cannot be assigned, submitted or used for receipt lookup. The derived `notice_state` remains available independently. No ID or receipt locator is placed in that projection.

For deliveries, leaf permission does not replace operation-result, safe-error, file or retention checks. The existing authorized `result`/`error` observation may still be null when its separate retention/content-disclosure contract requires that; missing field-path permission itself is never represented as a successful null observation. A status-only reader sees the retained status after sensitive result/error content expires; it never learns whether those hidden values exist. An authorized status lookup enrolls the receipt revision in the owner read fence. Lack of authority denies/withholds before reading a private value; null means an actually null association, not denied access. Receipt progress still performs no domain write, hook or version increment.

## Exact Mail source change

Keep the authored derive, its nullable type and structured labels. Add one explicit path to the existing recipient policy:

```can
policy Item read=authenticated where=row.service!=null and recipient(actor,row.service) fields=service,recipient,kind,state,notice_state,notification.status,completed,created
```

The full staff policy is unchanged. No status mirror, new business operation, result/error grant or source helper is needed in Mail. The explicit successful current-attempt completion reaction remains unchanged.

## Canonical desired JavaScript correction

Replace the proposed handle-only observation lookup for stored associations with a provenance-bearing lookup:

```js
const observed = await delivery(
  c,
  {record: row, field: "notification"},
  ["status"],
);
return observed === null ? null : observed.status;
```

The second argument identifies a current record and one declared delivery field; it is not a user-supplied model name, ID or arbitrary traversal string. The generated field selector and requested property list are statically resolved against that record's canonical schema. The runtime resolves the actual association internally, verifies current owner/team/record and exact leaf grants before dereference, then applies content/lifetime checks and returns one immutable **selected** observation. It does not trust caller-supplied values for handle, grants, status or field contents. The return is null only for an authorized null association; absent field/leaf authorization uses the existing denied/withheld path, not a null observation. Every requested leaf must be field-authorized before the helper succeeds; it never returns a successful object silently missing a requested property. A viewer projection omits denied source fields rather than evaluating and publishing their private values.

This is the sole proposed observation helper shape for an associated delivery. There is no alternate handle-only or raw-ID lookup that can skip record-field checks. A local fresh `send ... as attempt` remains a protected effect result that may be assigned to a compatible same-owner field; its immutable ID can be used within that originating mutation under the existing effect authority. Observing its mutable transport properties requires association with an owning field first, then the same record-field lookup. A previously read whole handle or a detached alias cannot become an alternate observation locator. A status projection is not a handle at all. This pins the previously unspecified unassociated-mutable-observation boundary rather than inventing a second authorization route.

All generated reads of stored delivery properties use this checked locator, including immutable `.id`. An id-only lookup need not enroll mutable receipt revision; mutable selected properties do. Trusted completion matching has its existing trusted invocation authority and requests `["id"]`, preserving current association correlation without exporting IDs. The selector list is a projection request, never an authority request. Staff can request additional declared properties only under their existing grants and independent checks. No default “return every property” exists.

The Mail metadata delta is only:

```js
fields: [
  "service", "recipient", "kind", "state", "notice_state",
  "notification.status", "completed", "created",
]
```

Its derive handler uses the lookup above. Schema stays `{type:"delivery",operation:"mailroom.Mail.send",nullable:true}`; the derive stays `{type:"std.DeliveryResult.status",nullable:true,...}`. Source dependency resolution supplies path provenance, not a copied permission schema in application code. Existing sequence inspections must use `{record: b.arrived, field: "notification"}` and `["status"]`; inspection privilege cannot become the production caller's authority.

## BDD witness and boundaries

The existing Mail receipt recipes already freeze complete `Mail.send` inputs and contain valid typed status/result/error values. They may be reused; do not provision arbitrary receipt IDs or override their protected internals. The accepted fixture has a nonnull provider result, which makes hidden-result serialization assertions meaningful. `parcel` references `service` and `test_contact`; changing the contact's verified flag is a valid stored snapshot and does not claim a real revocation call occurred.

Current inline syntax attaches examples to scenarios/CRUD, not model-read declarations. A test-inspection observation of `s.parcel.notice_state` has inspection authority and **cannot** prove recipient privacy. For a small standalone language-contract witness, an ordinary viewer read can exercise the dependency grant without authority scope:

```can
## Contract witness only; adding this operation to Mail is not required.
scenario visible_notice(item:Item) read=true -> DeliveryResult.status? by=authenticated
 do
  let visible=first(Item as candidate where candidate==item)
  require visible!=null
  return visible.notice_state
 examples seed=[parcel] item=parcel
  as,parcel.notification,test_contact.verified -> result
  self,pending_notice,true -> pending
  self,accepted_notice,true -> succeeded
  self,failed_notice,true -> failed
  self,null,true -> null
  unrelated,pending_notice,true -> error(rule_failed)
  self,pending_notice,false -> error(rule_failed)
```

The `require` is inside the ordinary read body: the query is viewer-filtered. The last two rows have no readable Item and fail this explicit assertion rather than returning a null status. The witness uses the existing caller and recipe contracts, never an authority read. Desired target body:

```js
async visible_notice(c, {item}) {
  const visible = await first(records(c, "mailroom.Item", {
    where: candidate => same(candidate, item),
  }));
  check(visible !== null, "rule_failed");
  const observed = await delivery(c, {record: visible, field: "notification"}, ["status"]);
  return observed === null ? null : observed.status;
}
```

The table lowers to ordinary `inputs`, `selectors`, row dependencies and expected scalar results. Each receipt recipe is a row dependency; the common Item dependency supplies the imported service/contact closure. The `unrelated` account is explicit and has no staff grant. The scalar observation type is `std.DeliveryResult.status?`. No extra helper or authority flag is passed to `records` or `delivery`.

Separate required runtime/compiler contract checks cannot be faked by inspection examples:

1. With only `notice_state` granted, its dependency remains withheld. Add `notification.status` and the scalar becomes readable. A request for id/result/error or the whole handle still fails/withholds. A malformed leaf path or traversal through `service` to another model is rejected.
2. Serialize the recipient's authorized Item projection containing an accepted receipt: only the granted status leaf and derived status appear; attempt ID, result.reference, error, request body and protected locator are absent. Even a hidden null property is omitted, not emitted as null. The projection cannot be submitted as a delivery value.
3. Reread under current caller after canonical contact revocation/archive or changed recipient account: both status representations disappear with the Item grant. Staff behavior remains governed by its independent role/workplace grant. A previously returned projection or locator cannot bypass revocation.
4. Null association produces the shared no-request presentation. Retained succeeded/failed status remains available after sensitive content expires. Receipt revision changes fence a concurrent observation without incrementing Item.version; selected status does not confer mutation/retry permission.

These are specified checks, not executed results. Exact generated model-read input/result-envelope and privacy-assertion harness details remain outside this note; it does not invent a new app test DSL or claim a source snapshot proves serialization. These remain explicit runtime acceptance requirements for the applied draft contract.
