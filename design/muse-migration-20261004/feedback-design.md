# C4 handoff — Feedback publication history and Product selector

Status: **READY for coordinator acceptance and Muse application.** Design only; no app file has been changed by this handoff. Baseline: `99a53f93d2e3cccd392a6f328b5347e7d96b3128`, specifically `draft/CanFeedback.can`, `.mjs`, `.md`, DESIGN §§2, 4, 5.1, 9 and 13. Apply against current files without reverting concurrent routine corrections. The handoff owns no shared-language change.

## Decision and requirements text

Retain private generic Suggestion history in the two existing author/owner sites. Public history is an explicit report of **staff decision publications**, never a view of raw revisions. Add a private contained `Decision` for each successful `roadmap` call, and a private `Suggestion.current_decision` reference. Freeze its status and response. Its nullable `published_at` records explicit release, rather than inferring publication later from current visibility.

`roadmap` retains its present authority, input guards, current status/response/duplicate effects and ability to work while a suggestion is hidden. It additionally creates and selects the new Decision. If the suggestion is already approved (`hidden=false`), release that Decision in the same transaction. While hidden, keep it private; `moderate(hidden=false)` releases only the selected current Decision. Earlier private staff drafts are never released by later approval. Contributor edits still hide the suggestion and clear the current moderation reason; they do not alter any Decision or its release evidence. Reapproving a contributor edit restores eligible earlier released decisions without manufacturing a new staff decision.

A Product's `published` state separately gates public access. A staff decision made on an approved suggestion while its Product is unpublished is intentionally prepared for later Product publication; `published_at` is its **release authorization time**, not proof that somebody saw it. Hiding/unpublishing/archiving suppresses the complete public history immediately on subsequent authorized reads. Explicitly approving/publishing again restores released, nonwithdrawn entries. No report exposes contributor title/description revisions, moderation/withdrawal reasons, individual votes, author/staff accounts, raw Decision references, audit metadata or unpublished decisions. Public attribution is “Operator decision history”; personal staff attribution stays in private audit metadata.

An owner can permanently withdraw an unsafe Decision through `withdraw_decision(decision,reason)`, preserving its body and private reason. A noncurrent withdrawal removes only that entry from future public results. Withdrawing the current Decision atomically hides its Suggestion, sets the reason, resets status to `proposed`, and clears response, duplicate and current_decision. This prevents the withdrawn current response from remaining readable through existing Suggestion/Card routes. The owner can then author a replacement while hidden and explicitly approve it. Withdrawal has no undo operation; a new intentional decision is a new record. Already delivered public copies cannot be recalled.

Use `ProductChoice`, a nonstored presentation value with an authorized Product reference, name and location, and `product_choices()`, an ordinary viewer-scoped derive. Both pages render its existing typed Product/location filters with preference defaults. Delete the old hard Product-preference `where` clauses: a saved preference is an initial filter, and an in-page change/clear must override it for that view. Toolbar changes do not save preferences automatically. Reuse the canonical own-user settings save when users change their defaults. Product choice, search and location are intersecting ordinary filters; location-less service Products remain available when location is clear. No model-self filter, extra setting primitive, business selection operation or custom JavaScript widget is introduced.

**Requirements edits:** in `draft/CanFeedback.md`, replace the two remaining-gap paragraphs with the behavior above, update the page table to name the actual Product filter and operator-decision Collapse, and state that public history begins with explicit Decision records. Existing installations have no automatic historical backfill: never reconstruct approval from old audit/current fields. An existing visible suggestion with no Decision still displays its current response and an empty public history; the next explicit roadmap call starts its history. No “history complete since creation” claim is allowed.

## Exact affected files

1. `draft/CanFeedback.can`: declarations, two existing scenario bodies, two new scenarios, fixtures/examples, and the two page collection roots/explicit bindings/public history/private withdrawal controls below.
2. `draft/CanFeedback.mjs`: corresponding schemas, rule maps, pure registry/function, operation metadata/handlers, page sections and example descriptors below. All imports already exist; no new runtime/UI helper is required.
3. `draft/CanFeedback.md`: accepted policy/presentation text and updated verification/limits, replacing the obsolete gap statements.
4. `draft/MIGRATION.md`: coordinator/Muse evidence disposition only after actual application/checks. No changes to DESIGN, GRAMMAR, REQUIREMENTS, compiler or library are required for this app design.

## Can changed-section witness

In Given, add `current_decision:Decision? label="Current operator decision"@{nl="Huidig exploitantbesluit"}` to Suggestion. Its public field grant remains exactly `title,description,category,status,response`. Add these declarations; keep existing declarations/policies/locks/fixtures:

```can
  Decision in Suggestion { status:Suggestion.status, response:text label=label_Suggestion_response, published_at:datetime? label="Released at"@{nl="Vrijgegeven op"}, withdrawn:bool=false label="Withdrawn"@{nl="Ingetrokken"}, withdrawal_reason:text? label="Withdrawal reason"@{nl="Reden van intrekking"} } label="Operator decision"@{nl="Exploitantbesluit"}
  contract DecisionCard { status:Suggestion.status, response:text label=label_Suggestion_response, published_at:datetime label="Released at"@{nl="Vrijgegeven op"} }
  contract DecisionHistory { items:DecisionCard[]! label="Released decisions"@{nl="Vrijgegeven besluiten"} }
  contract ProductChoice { product:Product label="Product"@{nl="Product"}, name:text, location:Location? }
  policy Decision read=product_owner where=row.parent.parent.owner==actor
  invariant Suggestion: row.current_decision==null or (row.current_decision.parent==row and row.current_decision.status==row.status and row.current_decision.response==row.response and not row.current_decision.withdrawn)
  lock Decision fields=status,response
  lock Decision fields=published_at when=row.published_at!=null
  lock Decision fields=withdrawn,withdrawal_reason when=row.withdrawn
  derive product_choices():ProductChoice[] = Product as product select ProductChoice {product,name=product.name,location=product.location}
```

Decision has **only** the owner read policy. Do not add public/author grants: the public report is the disclosure boundary, and authors already retain their Suggestion history. Parent containment is immutable. Public results use required `DecisionCard.published_at`; the query's nonnull predicate narrows the copied field. The ordinary query order is release time with the existing record-ID tie-breaker; equal-time entries do not promise causal order.

In When, disable generated Decision CRUD and replace the complete `roadmap`/`moderate` bodies with these. Retain their current isolated examples and add the new examples described below. The existing scenario captions/descriptions can stay; add their publication meaning to attached `#` descriptions in both languages.

```can
  crud Decision by=product_owner fields=status,response create=none update=none delete=none
  scenario roadmap(suggestion:Suggestion,status:Suggestion.status label=label_Suggestion_status,response:text label=label_Suggestion_response,duplicate:Suggestion? label=label_Suggestion_duplicate) by=product_owner label="Record roadmap decision"@{nl="Roadmapbesluit vastleggen"}
   require suggestion.parent.owner==actor and trim(response)!=""
   do
    create Decision {parent=suggestion,status,response} as decision
    if not suggestion.hidden
     set decision {published_at=now}
    set suggestion {status,response,duplicate,current_decision=decision}
  scenario moderate(suggestion:Suggestion,hidden:bool label=label_Suggestion_hidden,reason:text) by=product_owner label="Moderate suggestion"@{nl="Suggestie modereren"}
   require suggestion.parent.owner==actor and trim(reason)!=""
   do
    if not hidden and suggestion.current_decision!=null and suggestion.current_decision.published_at==null
     set suggestion.current_decision {published_at=now}
    set suggestion {hidden,moderation_reason=reason}
  # Withdraw released or private staff text while retaining owner evidence. @{nl="Trek vrijgegeven of private medewerkerstekst in en behoud het bewijs voor de verantwoordelijke."}
  scenario withdraw_decision(decision:Decision,reason:text) by=product_owner label="Withdraw operator decision"@{nl="Exploitantbesluit intrekken"}
   require decision.parent.parent.owner==actor and trim(reason)!="" and not decision.withdrawn
   do
    if decision.parent.current_decision==decision
     set decision.parent {hidden=true,moderation_reason=reason,status=proposed,response=null,duplicate=null,current_decision=null}
    set decision {withdrawn=true,withdrawal_reason=reason}
  # Read released operator decisions without private revisions or account identities. @{nl="Lees vrijgegeven exploitantbesluiten zonder private revisies of accountidentiteiten."}
  scenario decision_history(suggestion:Suggestion) read=true scope=authority -> DecisionHistory by=public label="Read operator decision history"@{nl="Geschiedenis exploitantbesluiten lezen"}
   require suggestion.archived_at==null and suggestion.parent.archived_at==null and suggestion.parent.published and not suggestion.hidden
   do return DecisionHistory {items=suggestion.Decision as decision where decision.published_at!=null and not decision.withdrawn order=decision.published_at select DecisionCard {status=decision.status,response=decision.response,published_at=decision.published_at}}
```

No special “publish history” helper is hidden here. State changes use the existing atomic owner transaction, input/parent/version admission, final invariant checks, locks and receipt replay. A rejected duplicate invariant, stale request, lost role, invalid reason or bounded-work failure leaves no Decision, pointer or partial publication. Failed history reads return failure, not an empty success. Release does not call canonical Suggestion.update, so it does not trigger the contributor-edit hook. The snapshot creation/set and parent update are ordinary scenario effects.

Replace both complete page roots with the following, retaining the existing supporting `#` descriptions. This is the complete Can presentation witness (no omitted child bindings):

```can
  page /feedback title="Suggestions"@{nl="Suggesties"}
   list product_choices() as choice filter=product,location defaults={product=preferences.product,location=preferences.location} search=name
    text row.name,row.location
    card "Urgent private issue"@{nl="Dringend privéprobleem"}
     text "Use private support for incidents. Never put access instructions or anyone’s contact details in a suggestion. New suggestions await owner review."@{nl="Gebruik privésupport voor incidenten. Zet nooit toegangsinstructies of contactgegevens van anderen in een suggestie. Nieuwe suggesties wachten op beoordeling door de verantwoordelijke."}
     form open_request arguments={priority=urgent}
    card "Contribution intake"@{nl="Bijdrage aanmaken"}
     form Suggestion.create arguments={parent=choice.product}
    card "Published roadmap and aggregate votes"@{nl="Gepubliceerde roadmap en stemtotalen"}
     form published arguments={product=choice.product}
      table result.items columns=title,category,status,response,duplicate,votes filter=category,status defaults={category=preferences.category,status=preferences.status} order=-votes
    details "Your submissions and review state"@{nl="Je bijdragen en beoordelingsstatus"}
     require authenticated
     list choice.product.Suggestion as suggestion where suggestion.author==actor filter=category,status defaults={category=preferences.category,status=preferences.status}
      title row.title
      content row.description
      text row.category,row.status,row.response,row.hidden,row.moderation_reason,row.duplicate
      edit
      delete
      history
    details "Suggestions and your votes"@{nl="Suggesties en je eigen stemmen"}
     list choice.product.Suggestion filter=category,status defaults={category=preferences.category,status=preferences.status}
      title row.title
      content row.description
      text row.category,row.status,row.response
      edit
      action vote
      details "Operator decision history"@{nl="Geschiedenis exploitantbesluiten"}
       form decision_history
        table result.items columns=published_at,status,response
      details "Your votes"@{nl="Je eigen stemmen"}
       require authenticated
       list row.Vote
        text row.active
        action unvote
  page /feedback/moderation title="Moderation and roadmap"@{nl="Moderatie en roadmap"}
   require product_owner
   card "Product intake"@{nl="Product aanmaken"}
    form Product.create
   list product_choices() as choice where choice.product.owner==actor filter=product,location defaults={product=preferences.product,location=preferences.location} search=name
    text row.name,row.location
    form Product.update arguments={record=choice.product}
    list choice.product.Suggestion filter=hidden,status defaults={status=preferences.status} display=split
     card "Suggestion and roadmap outcome"@{nl="Suggestie en roadmapuitkomst"}
      title row.title
      content row.description
      text row.category,row.author,row.status,row.response,row.hidden,row.moderation_reason,row.duplicate
      actions roadmap,moderate
     history
     details "Operator decisions and withdrawals"@{nl="Exploitantbesluiten en intrekkingen"}
      list row.Decision order=created
       text row.status,row.response,row.published_at,row.withdrawn,row.withdrawal_reason
       action withdraw_decision
```

The public history form auto-binds its sole Suggestion parameter to the current Suggestion row. The owner withdrawal action auto-binds its Decision; reason remains an input. The Product projection is a structural row, so create/read/update bindings are explicit. Keep those bindings in the JS too. Owner-only decisions include unreleased/withdrawn evidence; public `DecisionHistory.items` does not. Anonymous page admission remains team-only; the nested own-vote and own-submission `require authenticated` gates stay local.

## Desired JavaScript changed-section witness

This section supplies every new metadata/effect boundary. Merge entries into existing objects; preserve existing maps/handlers. No spread of appDefinition into canApp, app-specific runtime helpers, raw Can evaluation or duplicate operation registry is introduced.

```js
// Add to feedback.Suggestion.fields:
current_decision: {
  type: "feedback.Decision", nullable: true,
  label: message("Current operator decision", { nl: "Huidig exploitantbesluit" }),
},
// Append "Suggestion.require.2" to feedback.Suggestion.invariants.

// Add to appDefinition.models:
"feedback.Decision": {
  parent: "feedback.Suggestion",
  label: message("Operator decision", { nl: "Exploitantbesluit" }),
  readGrants: [{ rule: "Decision.read.1" }],
  locks: ["Decision.lock.1", "Decision.lock.2", "Decision.lock.3"],
  fields: {
    status: { type: "feedback.Suggestion.status" },
    response: { type: "text", label: responseCaption },
    published_at: { type: "datetime", nullable: true, label: message("Released at", { nl: "Vrijgegeven op" }) },
    withdrawn: { type: "bool", default: false, label: message("Withdrawn", { nl: "Ingetrokken" }) },
    withdrawal_reason: { type: "text", nullable: true, label: message("Withdrawal reason", { nl: "Reden van intrekking" }) },
  },
},
// Add to appDefinition.contracts:
"feedback.DecisionCard": { fields: {
  status: { type: "feedback.Suggestion.status" },
  response: { type: "text", label: responseCaption },
  published_at: { type: "datetime", label: message("Released at", { nl: "Vrijgegeven op" }) },
} },
"feedback.DecisionHistory": { fields: {
  items: { type: "feedback.DecisionCard", array: true, requiredArray: true,
    label: message("Released decisions", { nl: "Vrijgegeven besluiten" }) },
} },
"feedback.ProductChoice": { fields: {
  product: { type: "feedback.Product", label: message("Product", { nl: "Product" }) },
  name: { type: "text" },
  location: { type: Location, nullable: true },
} },
// Add appDefinition.pure:
pure: {
  "feedback.product_choices": {
    handler: "product_choices", inputs: {},
    result: { type: "feedback.ProductChoice", array: true },
  },
},
// Add to appDefinition.operations:
"feedback.withdraw_decision": {
  handler: "withdraw_decision", by: "feedback.product_owner", read: false,
  label: message("Withdraw operator decision", { nl: "Exploitantbesluit intrekken" }),
  description: message("Withdraw released or private staff text while retaining owner evidence.", {
    nl: "Trek vrijgegeven of private medewerkerstekst in en behoud het bewijs voor de verantwoordelijke.",
  }),
  inputs: { decision: { type: "feedback.Decision" }, reason: { type: "text" } },
},
"feedback.decision_history": {
  handler: "decision_history", by: "public", read: true, scope: "authority",
  result: "feedback.DecisionHistory",
  label: message("Read operator decision history", { nl: "Geschiedenis exploitantbesluiten lezen" }),
  description: message("Read released operator decisions without private revisions or account identities.", {
    nl: "Lees vrijgegeven exploitantbesluiten zonder private revisies of accountidentiteiten.",
  }),
  inputs: { suggestion: { type: "feedback.Suggestion" } },
},
// Append to appDefinition.disabled:
"feedback.Decision.create", "feedback.Decision.update", "feedback.Decision.delete"
```

Use the existing actual disabled-CRUD property's name (`disabled` at the baseline); do not add a second one. New no-parameter derive implementation and complete handler/map additions/replacements:

```js
async function product_choices(c) {
  const rows = [];
  for await (const product of records(c, "feedback.Product")) {
    rows.push({ product, name: product.name, location: product.location });
  }
  return rows;
}

// Add product_choices to the callable canApp() return object.
// Add to its read map:
"Decision.read.1": (c, row) =>
  hasRole(c, "feedback.product_owner") && same(row.parent.parent.owner, c.actor),
// Add to its invariants map:
"Suggestion.require.2": (c, row) => row.current_decision === null || (
  same(row.current_decision.parent, row) &&
  row.current_decision.status === row.status &&
  row.current_decision.response === row.response &&
  !row.current_decision.withdrawn
),
// Add to its locks map:
"Decision.lock.1": { fields: ["status", "response"] },
"Decision.lock.2": { fields: ["published_at"], when: (c, row) => row.published_at !== null },
"Decision.lock.3": { fields: ["withdrawn", "withdrawal_reason"], when: (c, row) => row.withdrawn },

// Replace/add these complete canApp() methods:
async roadmap(c, { suggestion, status, response, duplicate = null }) {
  check(hasRole(c, "feedback.product_owner"), "forbidden");
  check(same(suggestion.parent.owner, c.actor) && response.trim() !== "");
  const decision = await create(c, "feedback.Decision", { parent: suggestion, status, response });
  if (!suggestion.hidden) await set(c, decision, { published_at: c.now });
  await set(c, suggestion, { status, response, duplicate, current_decision: decision });
},
async moderate(c, { suggestion, hidden, reason }) {
  check(hasRole(c, "feedback.product_owner"), "forbidden");
  check(same(suggestion.parent.owner, c.actor) && reason.trim() !== "");
  if (!hidden && suggestion.current_decision !== null && suggestion.current_decision.published_at === null) {
    await set(c, suggestion.current_decision, { published_at: c.now });
  }
  await set(c, suggestion, { hidden, moderation_reason: reason });
},
async withdraw_decision(c, { decision, reason }) {
  check(hasRole(c, "feedback.product_owner"), "forbidden");
  check(same(decision.parent.parent.owner, c.actor) && reason.trim() !== "" && !decision.withdrawn);
  if (same(decision.parent.current_decision, decision)) {
    await set(c, decision.parent, {
      hidden: true, moderation_reason: reason, status: "proposed",
      response: null, duplicate: null, current_decision: null,
    });
  }
  await set(c, decision, { withdrawn: true, withdrawal_reason: reason });
},
async decision_history(c, { suggestion }) {
  check(hasRole(c, "public"), "forbidden");
  check(suggestion.archived_at === null && suggestion.parent.archived_at === null &&
    suggestion.parent.published && !suggestion.hidden);
  const items = [];
  for await (const decision of records(c, "feedback.Decision", {
    parent: suggestion,
    where: (decision) => decision.published_at !== null && !decision.withdrawn,
    order: ["published_at"],
  })) {
    items.push({ status: decision.status, response: decision.response, published_at: decision.published_at });
  }
  return { items };
},
```

The direct field ordering lowers to `order:["published_at"]`, following the existing static field-path `records` witnesses in CanRent; these are checked selectors, not a string-expression interpreter. The ordinary ID tie-breaker still applies. UI selector ordering stays `order:["created"]`.

For **both existing page functions**, fetch the viewer derive after descriptor admission and before `renderPage`:

```js
const choices = await product_choices(c);
```

Replace the outer Product list's complete query/selector properties; retain its children using these exact bindings. For `/feedback`, use:

```js
context: c,
rows: choices,
contract: "feedback.ProductChoice",
filter: ["product", "location"],
defaults: { product: c.preferences.feedback.product, location: c.preferences.feedback.location },
search: ["name"],
renderRow: (choice, view) => [ /* existing children, with replacements in the table below */ ],
```

For `/feedback/moderation`, use the same properties except `rows: choices.filter((choice) => same(choice.product.owner, c.actor))`. Its page-level owner admission is retained. No Product-preference `where` remains. The pure derive and `list.rows` reuse existing typed-array collection behavior (`CanRent.mjs` already passes an array result to `list.rows`); they may fail the ordinary query/page bounds rather than silently truncate Product scope. This does not introduce unbounded runtime enumeration.

| Existing inner target site | Complete replacement |
| --- | --- |
| Product heading on either page | `text({context:view,values:[choice.name,choice.location]})` |
| Suggestion intake | `form({context:view,operation:"feedback.Suggestion.create",arguments:{parent:choice.product}})` |
| Published report arguments | `arguments:{product:choice.product}` |
| Both public Suggestion lists and owner Suggestion list | `parent:choice.product` (all other existing predicates/filters/children retained) |
| Product edit control on moderation page | `form({context:view,operation:"feedback.Product.update",arguments:{record:choice.product}})` |

Add this complete child in the general Suggestion `renderRow:(suggestion,rowView)=>[...]`, after vote actions and before the authenticated own-vote detail. It is **not** generic `history`:

```js
details({
  context: rowView,
  caption: message("Operator decision history", { nl: "Geschiedenis exploitantbesluiten" }),
  children: [form({
    context: rowView, operation: "feedback.decision_history", arguments: { suggestion },
    renderResult: (result, resultView) => [table({
      context: resultView, rows: result.items, contract: "feedback.DecisionCard",
      columns: ["published_at", "status", "response"],
    })],
  })],
}),
```

Add this complete child after the moderation Suggestion's existing generic history:

```js
details({
  context: rowView,
  caption: message("Operator decisions and withdrawals", { nl: "Exploitantbesluiten en intrekkingen" }),
  children: [list({
    context: rowView, model: "feedback.Decision", parent: suggestion, order: ["created"],
    renderRow: (decision, decisionView) => [
      text({ context: decisionView, values: [decision.status, decision.response,
        decision.published_at, decision.withdrawn, decision.withdrawal_reason] }),
      actions({ context: decisionView, operations: ["feedback.withdraw_decision"], boundArgs: { decision } }),
    ],
  })],
}),
```

## Disclosure and failure witnesses

Retain the existing causal journey and its isolated tables. Add observations to that journey: first approved planned call yields one released entry; contributor editing makes `decision_history` fail; final shipped call yields two released entries; archival makes history unavailable. Add an isolated withdrawal fixture/table for wrong role, other owner's Product, empty reason and already withdrawn record. Do not turn denied/unavailable reads into success with zero entries.

The following additional complete shared-state example belongs on `decision_history`. It uses the existing `moderator` and `journey_product` recipes, rebinds records after writes and explicitly proves that an abandoned hidden staff response never enters public history. Fixed clock means both releases can share one instant; assertions use membership/count rather than an invented temporal order.

```can
   examples seed=[journey_product]
    do
     call Suggestion.create {parent=journey_product,title="Quiet spaces",description="More booths",category="Amenity"} by=self
     let submitted=first(journey_product.Suggestion as item where item.author==self)
     submitted!=null -> true
     call roadmap {suggestion=submitted,status=planned,response="Private draft containing a phone number",duplicate=null} by=moderator
     let drafted=first(journey_product.Suggestion as item where item.id==submitted.id)
     drafted!=null -> true
     call roadmap {suggestion=drafted,status=planned,response="Two booths this quarter",duplicate=null} by=moderator
     let ready=first(journey_product.Suggestion as item where item.id==submitted.id)
     ready!=null -> true
     call decision_history {suggestion=ready} by=public -> error(rule_failed)
     call moderate {suggestion=ready,hidden=false,reason="Reviewed current text and response"} by=moderator
     let visible=first(journey_product.Suggestion as item where item.id==submitted.id)
     visible!=null -> true
     call decision_history {suggestion=visible} by=public as released
     count(released.items),first(released.items)?.response -> 1,"Two booths this quarter"
     call roadmap {suggestion=visible,status=shipped,response="Two booths installed",duplicate=null} by=moderator
     let shipped=first(journey_product.Suggestion as item where item.id==submitted.id)
     shipped!=null -> true
     call decision_history {suggestion=shipped} by=public as history_before
     count(history_before.items),any(history_before.items as item,item.response=="Private draft containing a phone number") -> 2,false
     shipped.current_decision!=null -> true
     call withdraw_decision {decision=shipped.current_decision,reason="Response needs correction"} by=moderator
     let withdrawn=first(journey_product.Suggestion as item where item.id==submitted.id)
     withdrawn!=null -> true
     withdrawn.hidden,withdrawn.status,withdrawn.response,withdrawn.current_decision -> true,proposed,null,null
     call decision_history {suggestion=withdrawn} by=public -> error(rule_failed)
     call roadmap {suggestion=withdrawn,status=planned,response="Installation postponed",duplicate=null} by=moderator
     let corrected=first(journey_product.Suggestion as item where item.id==submitted.id)
     corrected!=null -> true
     call moderate {suggestion=corrected,hidden=false,reason="Reviewed replacement"} by=moderator
     let republished=first(journey_product.Suggestion as item where item.id==submitted.id)
     republished!=null -> true
     call decision_history {suggestion=republished} by=public as history_after
     count(history_after.items),any(history_after.items as item,item.response=="Two booths installed"),any(history_after.items as item,item.response=="Installation postponed") -> 2,false,true
```

Desired JS for the complete added sequence descriptor (append it to the existing flat `examples` array returned by the Feedback fixture factory, following DESIGN §13):

```js
{
  operation: "feedback.decision_history", dependencies: [journey_product],
  sequence: [
    { operation: "feedback.Suggestion.create", by: async (c,s,b)=>s.self, inputs: async (c,s,b)=>({parent:s.journey_product,title:"Quiet spaces",description:"More booths",category:"Amenity"}) },
    { let: "submitted", value: async (c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>same(item.author,s.self)})) },
    { observations: async (c,s,b)=>[b.submitted!==null], expected: async (c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.roadmap", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({suggestion:b.submitted,status:"planned",response:"Private draft containing a phone number",duplicate:null}) },
    { let:"drafted", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.drafted!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.roadmap", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({suggestion:b.drafted,status:"planned",response:"Two booths this quarter",duplicate:null}) },
    { let:"ready", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.ready!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.decision_history", by:async(c,s,b)=>"public", inputs:async(c,s,b)=>({suggestion:b.ready}), error:"rule_failed" },
    { operation:"feedback.moderate", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({suggestion:b.ready,hidden:false,reason:"Reviewed current text and response"}) },
    { let:"visible", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.visible!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.decision_history", by:async(c,s,b)=>"public", inputs:async(c,s,b)=>({suggestion:b.visible}), bind:"released" },
    { observations:async(c,s,b)=>[await count(b.released.items),(await first(b.released.items))?.response??null], expected:async(c,s,b)=>[1n,"Two booths this quarter"], types:["int","text?"] },
    { operation:"feedback.roadmap", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({suggestion:b.visible,status:"shipped",response:"Two booths installed",duplicate:null}) },
    { let:"shipped", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.shipped!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.decision_history", by:async(c,s,b)=>"public", inputs:async(c,s,b)=>({suggestion:b.shipped}), bind:"history_before" },
    { observations:async(c,s,b)=>[await count(b.history_before.items),await any(b.history_before.items,item=>item.response==="Private draft containing a phone number")], expected:async(c,s,b)=>[2n,false], types:["int","bool"] },
    { observations:async(c,s,b)=>[b.shipped.current_decision!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.withdraw_decision", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({decision:b.shipped.current_decision,reason:"Response needs correction"}) },
    { let:"withdrawn", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.withdrawn!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { observations:async(c,s,b)=>[b.withdrawn.hidden,b.withdrawn.status,b.withdrawn.response,b.withdrawn.current_decision], expected:async(c,s,b)=>[true,"proposed",null,null], types:["bool","feedback.Suggestion.status","text?","feedback.Decision?"] },
    { operation:"feedback.decision_history", by:async(c,s,b)=>"public", inputs:async(c,s,b)=>({suggestion:b.withdrawn}), error:"rule_failed" },
    { operation:"feedback.roadmap", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({suggestion:b.withdrawn,status:"planned",response:"Installation postponed",duplicate:null}) },
    { let:"corrected", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.corrected!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.moderate", by:async(c,s,b)=>s.moderator, inputs:async(c,s,b)=>({suggestion:b.corrected,hidden:false,reason:"Reviewed replacement"}) },
    { let:"republished", value:async(c,s,b)=>await first(records(c,"feedback.Suggestion",{parent:s.journey_product,where:item=>item.id===b.submitted.id})) },
    { observations:async(c,s,b)=>[b.republished!==null], expected:async(c,s,b)=>[true], types:["bool"] },
    { operation:"feedback.decision_history", by:async(c,s,b)=>"public", inputs:async(c,s,b)=>({suggestion:b.republished}), bind:"history_after" },
    { observations:async(c,s,b)=>[await count(b.history_after.items),await any(b.history_after.items,item=>item.response==="Two booths installed"),await any(b.history_after.items,item=>item.response==="Installation postponed")], expected:async(c,s,b)=>[2n,false,true], types:["int","bool","bool"] },
  ],
}
```

Additional required cases, with policy fixed here so Muse need not invent it:

| Case | Expected outcome |
| --- | --- |
| Public/direct lookup of a Decision, including a known released ID | No public model grant; deny. Only the authority report discloses its three declared fields. |
| Pending suggestion / Product unpublished | History operation's guard fails; no successful empty report. |
| Archived suggestion or ancestor / expired input | Admission or explicit guard denies; no retained public history or current Card. Do not fix an unknown admission error code by inventing one. |
| Private roadmap draft A then B, approve B | Only B is released; A stays private even through later reapproval. |
| Contributor edit, then owner reapproval without another roadmap decision | History unavailable while hidden; same released entries return, no duplicate record/release timestamp. |
| Two new successful identical roadmap calls | Two actual decision records; replay of the same operation identity creates only one. This follows existing accepted-write/replay semantics. |
| Withdraw an older released Decision | That entry disappears, current status/response/duplicate/pointer and visibility remain unchanged. |
| Withdraw current or unreleased current Decision | Atomic reset/hide defined above. Old nonwithdrawn released history returns only after explicit reapproval. No retracted row resurfaces. |
| Wrong role, other Product's owner, blank reason, already-withdrawn row | Reject with existing forbidden/rule_failed ordering; retain all rows, current state and versions. |
| Roadmap duplicate invariant fails after Decision create | Entire owner transaction rolls back, including new Decision and pointer. |
| Product default A, local selection B, then clear | B overrides A; clear shows all authorized choices subject to other filters. No preference auto-save. |
| Revoked/inaccessible saved Product, switch team, changed Product publication | Existing safe fallback/revalidation and clear prior-context data; no stale Product label/content disclosure. |
| Product or history query exceeds work/response budget | Explicit failure; no completeness claim for a partial result. |

## Advice, checks and remaining limits

Three independently worded equivalent JEV requests completed with no approval rejection. Full requests, results and uncertainty are in [the C4 evidence directory](../jev/muse-feedback-20261004/). All prefer explicit snapshots and the ordinary typed Product projection. History A probabilities: 1.00, 0.99, 0.98; selector A: 0.99, 1.00, 0.99. This is advice, not evidence that policies, transactions, rendering or examples execute.

Handoff verification: the initial parser accepted an in-memory application of the changed Can blocks with the pre-existing shared-state sequence excluded; `node --input-type=module --check` accepted the wrapped new derive, handlers, public/private UI blocks and full added sequence descriptor. [Saved results](../jev/muse-feedback-20261004/syntax-checks.json) state the exact limits. These are snippet checks, not whole-target application.

Application checks: parse the non-sequence Can subset; `node --check` the entire desired target; compare new Can/JS declaration schemas, guards/effects, selected result fields, explicit Product bindings and every added sequence step. Preserve the two existing private generic-history sites. Confirm no public Decision read grant and no generic history under the general public suggestion detail. Report full runtime/privacy/UI checks as unexecuted. No broad corpus audit is requested.

One [bounded independent Astra review](../jev/muse-feedback-20261004/bounded-review.md) found no concrete application or disclosure blocker; it did not run the design.

There is no unresolved business-policy question in this bounded handoff. Coordinator acceptance remains required before Muse applies this proposed design. The compiler, type checker, transaction engine, query budgets, actual reference-filter rendering, public-cache invalidation, direct-ID enforcement and BDD execution remain existing implementation gaps; this handoff does not close them.
