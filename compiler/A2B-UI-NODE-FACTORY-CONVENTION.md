# A2b: UI-node/factory convention — evidence + proposal (for F review)

Compiler-side draft (A2b scope, rev2 vs `9c1d35c`, base `d93fc4b`).
No checker/emitter edits. Implementation follows a later grant.

## 1. Corpus evidence (9 diags + 2 latent)

B8 rows 41–55 (`CanDo.can`); every message is `X is not a §13
server factory`, gated at `js.rs:3038-3047` against
`is_ui_factory` (`js.rs:1008-1039`):

| Node | Sites | Draft `CanDo.mjs` shape (rev2-corrected) |
|---|---|---|
| `require` | :119, :158, :185 (`require members` / `require task_manager`) | page `admit: async (c,routeBindings)=>{check(hasRole(c,…),"forbidden");…}` — NOT a render node |
| `fieldset` | :123 (`fieldset "Task details"`) | `fieldset({context, caption:message(…), children:[input,radio,select,…]})` |
| `fab` | :139 (2 `button action=`) | `fab({context, main, actions})` — NO children prop (rev2 correction) |
| `chat_bubble` | :149 (`slot content`/`slot header`) | `chat_bubble({context, content, header,…})` |
| `select` | :190 (`select location`) | `select({context, field:"location"})` |
| `delete` | :196, :202 (bare) | `deleteRecord({context, action, operation, operationId, record, mode, itemLabel, confirm, idPrefix,…})` (rev2 correction) |
| `radio` (LATENT) | :126 (`radio priority`) | `radio({context, field:"priority"})` |
| `select` (LATENT) | :126 (`select location`) | same as above |

Latent-diag mechanism (verified by read): `lower_ui_ctx`
returns before lowering children when the factory is unknown, so
an unlisted factory **subsumes its subtree**. `fieldset`'s
`radio`/`select` children produce no diags today; adding
`fieldset` alone would surface 2 more. All three must land
together. Subsumption stays (agreed, §3.3).

## 2. What F already provides

`packages/ui/src/catalog.ts` lists every node as
`availability: implemented` with real exported implementations
(`forms.ts`, `overlays.ts`, `index.ts`):

- `radio`, `select`: profile `field-control`, header `selector`
  (same profile as `input`/`textarea`, which the compiler lowers
  via `decode_field_control`, `ir.rs:5690`). Catalog appearance:
  tone + size both (`catalog.ts:103,106`).
- `fieldset`: profile `group`, header `text`; caption confirmed
  (`caption?: MessageValue`, legend iff present). Catalog
  appearance: nothing admitted (`catalog.ts:76`).
- `fab`: profile `group` ("presentation of existing canonical
  actions; no batch transaction"). `FabProps={context, label?,
  main(required), actions(required)}` (`presentation.ts:1308`,
  `overlays.ts:386` `fab`); NO children prop. Catalog appearance:
  nothing admitted (`catalog.ts:75`).
- `chat_bubble` → js `chatBubble`: profile `slotted-group`,
  slots content(required)/avatar/header/footer (`catalog.ts:67`).
  Catalog appearance: tone only, no size.
- `delete` → js `deleteRecord` (`catalog.ts:50`, `forms.ts:1057`,
  `index.ts:168`): profile `leaf`, header `binding`; note:
  "`delete` is reserved, hence the js name"; archive/remove mode.
  `DeleteProps` (`presentation.ts:795`) requires context, action,
  operation, operationId, record, mode(`archive`|`remove`),
  itemLabel, confirm, idPrefix; optional cancelHref/timeZone.
  Rev1's `remove(...)` matches NO export — corrected to
  `deleteRecord` (rev2).
- No `require` entry — it is not a factory (see §3).

The gap is therefore compiler-side (allowlist + profiles), not
F implementation — except the confirmations in §4.

## 3. Proposal

1. **Compiler profiles** (no F work): add `radio`/`select` to
   the field-control arm (`ir.rs:5656`); `fieldset` as a
   captioned group; `fab` emitting `main` + `actions` (buttons-
   only is a compiler-side constraint — F renders any
   `PageChildren`); `chat_bubble` as a slotted group mapping
   `slot content`→`content` (required, `requireChildren` throws),
   `slot header`→`header` (optional), avatar/footer optional,
   `side` default `start`; `delete` as a `deleteRecord` leaf
   with operation+record inference mirroring bare `edit`
   (`decode_edit`, `row_ctx`-based). The compiler MUST supply
   `action` + `operation` + `operationId` (all three) and pick
   `mode` explicitly (no F default): bare `delete` →
   `mode:"archive"` (the `deleteMode` default,
   `artifact.ts:313-315`), explicit remove spelling →
   `mode:"remove"`.
2. **`require` is a desugar, not a factory** (AGREED): page-level
   `require X` becomes an admission guard (DESIGN:741: "The
   page's explicit `require` supplies any narrower page-wide
   rule"; matches the draft admits); nested-container `require`
   becomes the node's local gate (`IrUi.gate` exists and lowers
   as `cond ? node : null`, DESIGN:741: "keeps its context
   checks and gate local and is omitted when unavailable").
3. **Subtree subsumption stays** (AGREED): unknown factories keep
   failing closed without cascading child diags (current
   behavior, now documented).
4. **Appearance** (AGREED, catalog rule "absent appearance
   admits nothing"): the compiler passes only catalog-admitted
   attrs per node and defers/rejects the rest — radio/select:
   tone + size; chat_bubble: tone only; fab/fieldset: nothing.

## 4. F review answers (vs `9c1d35c`, ADOPTED rev2)

1. `delete` js name: MUST be `deleteRecord` — corrected (§1–§3).
2. `DeleteProps`: required list + compiler supplies
   action/operation/operationId and picks mode; bare-delete →
   `archive` mapping confirmed by the compiler (§3.1).
3. `chat_bubble` slots: CONFIRMED (§3.1).
4. `fab`/`fieldset`: fab has NO children — emit `main`+`actions`;
   fieldset caption CONFIRMED (§3.1).
5. Appearance: catalog rule adopted (§3.4).

## 5. Rejected alternatives

- Compiler desugars (e.g. `delete`→`form`, `fab`→`actions`):
  rejected — the catalog implements these natively with
  distinct semantics (confirmation card, slotted bubble);
  desugar would lose behavior F already owns.
- `require` as a render node: rejected — DESIGN:741 and the
  draft both place it in admission/gating, and it has no
  catalog entry.
