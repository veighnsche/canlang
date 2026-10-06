# A2b: UI-node/factory convention — evidence + proposal (for F review)

Compiler-side draft (A2b scope, base `d93fc4b`). No checker/emitter
edits. Implementation follows F's review + a later grant.

## 1. Corpus evidence (9 diags + 2 latent)

B8 rows 41–55 (`CanDo.can`); every message is `X is not a §13
server factory`, gated at `js.rs:3038-3047` against
`is_ui_factory` (`js.rs:1008-1039`):

| Node | Sites | Draft `CanDo.mjs` shape |
|---|---|---|
| `require` | :119, :158, :185 (`require members` / `require task_manager`) | page `admit: async (c,routeBindings)=>{check(hasRole(c,…),"forbidden");…}` — NOT a render node |
| `fieldset` | :123 (`fieldset "Task details"`) | `fieldset({context, caption:message(…), children:[input,radio,select,…]})` |
| `fab` | :139 (2 `button action=`) | `fab({context, children:[button,…]})` |
| `chat_bubble` | :149 (`slot content`/`slot header`) | `chat_bubble({context, content, header,…})` |
| `select` | :190 (`select location`) | `select({context, field:"location"})` |
| `delete` | :196, :202 (bare) | `remove({context, operation:"todo….delete", record})` |
| `radio` (LATENT) | :126 (`radio priority`) | `radio({context, field:"priority"})` |
| `select` (LATENT) | :126 (`select location`) | same as above |

Latent-diag mechanism (verified by read): `lower_ui_ctx`
returns before lowering children when the factory is unknown, so
an unlisted factory **subsumes its subtree**. `fieldset`'s
`radio`/`select` children produce no diags today; adding
`fieldset` alone would surface 2 more. All three must land
together.

## 2. What F already provides

`packages/ui/src/catalog.ts` (owner lane-05) lists every node as
`availability: implemented` with real exported implementations
(`forms.ts`, `overlays.ts`, `index.ts`):

- `radio`, `select`: profile `field-control`, header `selector`
  (same profile as `input`/`textarea`, which the compiler lowers
  via `decode_field_control`, `ir.rs:5690`).
- `fieldset`: profile `group`, header `text` (caption).
- `fab`: profile `group` ("presentation of existing canonical
  actions; no batch transaction").
- `chat_bubble` → js `chatBubble`: profile `slotted-group`,
  slots content(required)/avatar/header/footer.
- `delete` → js `deleteRecord`: profile `leaf`, header
  `binding`; note: "`delete` is reserved, hence the js name";
  archive/remove mode (`DeleteProps` in `forms.ts:1057`).
- No `require` entry — it is not a factory (see §3).

The gap is therefore compiler-side (allowlist + profiles), not
F implementation — except the confirmations in §4.

## 3. Proposal

1. **Compiler profiles** (no F work): add `radio`/`select` to
   the field-control arm (`ir.rs:5656`); `fieldset` as a
   captioned group; `fab` as a button group; `chat_bubble` as a
   slotted group mapping `slot <name>` children to the catalog
   slot props; `delete` as a `deleteRecord` leaf with
   operation+record inference mirroring bare `edit`
   (`decode_edit`, `row_ctx`-based).
2. **`require` is a desugar, not a factory**: page-level
   `require X` becomes an admission guard (DESIGN:741: "The
   page's explicit `require` supplies any narrower page-wide
   rule"; matches the draft admits); nested-container `require`
   becomes the node's local gate (`IrUi.gate` exists and lowers
   as `cond ? node : null`, DESIGN:741: "keeps its context
   checks and gate local and is omitted when unavailable").
3. **Subtree subsumption stays**: unknown factories keep
   failing closed without cascading child diags (current
   behavior, now documented).

## 4. Questions for F

1. `delete` js name: catalog says `deleteRecord`, the draft
   target uses `remove(...)` — confirm the canonical name the
   compiler must emit.
2. Confirm required `DeleteProps` the compiler must supply
   (operation + record? mode? itemLabel/confirm/action?).
3. Confirm `chat_bubble` slot mapping (`slot content`/`slot
   header` → `content`/`header` props?) and the required
   `content` slot.
4. Confirm `fab` children constraint (buttons only?) and
   `fieldset` caption prop name.
5. Are appearance attributes (`tone=`/`size=`/…) in compiler
   scope for these nodes, or deferred?

## 5. Rejected alternatives

- Compiler desugars (e.g. `delete`→`form`, `fab`→`actions`):
  rejected — the catalog implements these natively with
  distinct semantics (confirmation card, slotted bubble);
  desugar would lose behavior F already owns.
- `require` as a render node: rejected — DESIGN:741 and the
  draft both place it in admission/gating, and it has no
  catalog entry.
