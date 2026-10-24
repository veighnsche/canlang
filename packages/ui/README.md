# @canlang/ui

Server-rendered CanLang presentation library. Generated app JS calls canonical
factories with props/children; this library owns daisyUI markup/classes,
escaping, HTMX behavior and locale formatting. No `h`/JSX, no hydration, no
browser business-state store, no second CRUD/policy engine.

Contract: `packages/contracts/src/presentation.ts`. Compiler emission and
route dispatch consume that contract.

## Package boundaries

This package extends the root `tsconfig.base.json` and builds only its own
source and tests into `dist/src` and `dist/test`. Contracts are consumed through
the declared `@canlang/contracts` workspace dependency. The root workspace owns
the dependency lockfile.

The `@canlang/ui/distribution` API supplies the compiled module and browser
asset directory URLs used by Worker staging. Browser assets remain in
`dist/browser`; the browser build validates their local import closure. Browser export and print consumers have explicit
`@canlang/ui/browser/export` and `@canlang/ui/browser/print` APIs.

Generated operation forms emit `data-can-generated-form` and use the existing
prepared submit transport. One pending occurrence captures native successful
controls before disabling its activated submitter. Success, denial or failure
settles that occurrence; binder disposal restores its temporary state and aborts
its fetch through response-body reading. An obsolete transport reply cannot
report into a replacement binding. Native fetch consumes the abort signal;
injected transports own their physical cancellation and eventual settlement.
An aborted reply can leave an already committed server operation uncertain, so
the original operation ID and canonical replay remain authoritative.

The fixed team primitive catalog uses `kind: "team"` and generated form mode
`"team"`. Its editable email, exact role choices and member user references use
the shared controls and typed projection. Native bracket controls submit to the
same canonical operation routes as enhanced JSON submissions; current session,
CSRF, source, team and owner checks remain server-owned. These primitive forms
do not carry protected record bindings because their schemas contain no
versioned record inputs.

`action()` can receive the same owning `derived` inputs and optional source
binding metadata as `form()`. It then uses the existing prepared submitter,
operation mode, pending guard and direct transport settlement. Interfaces
authenticates an opaque source binding; UI does not grant it authority.
Companion controls require their base input, and prepared browser actions
refuse MCP-only sealed handles before rendering effects. Original callers
must supply genuine checked/prepared metadata for this behavior.

Actions without metadata retain native POST; their asynchronous completion
and structural `data-can-once`/`can:settled` behavior remain unqualified.

## Layout

- `src/escape.ts` — HTML/attribute/URL escaping, CSV formula protection, bidi isolation.
- `src/messages.ts` — message descriptors, RFC 4647 lookup, ICU-profile formatting.
- `src/navigation.ts` — pure discovery shaping over dispatcher admission outcomes.
- `src/shell.ts` — renderPage: drawer shell, account menu, settings frame, partials.
- `src/components.ts` — card/title/text/content, shared states, text values, row headings.
- `src/collections.ts` — list/table renderers over the authorized query runner.
- `src/catalog.ts` — versioned machine-readable component catalog.
- `themes.css` — `can-{mode}-{accent}` daisyUI themes + density rules.
- Later slices: `forms`, `htmx`, `settings`, `review` (+ controls in `collections`).

## Themes and class audit

`themes.css` defines nine themes based on daisyUI.
`test/themes.test.ts` audits theme-name coverage, variable names against the
installed daisyUI and every markup class used in src
(daisyUI bundle, reviewed tailwind utilities, or `can-*` structural hooks).

## Exact values

Integers travel as bigint or canonical decimal strings; naive numbers are
accepted only when safe. Currency scales are an explicit formatting
parameter from the Values currency table, never a default here. Datetimes are
canonical RFC3339 UTC instants with explicit calendar/time validation
(leap second `:60` rejected); civil dates never shift timezones.
Grouping patterns and numbering-system digits are derived from Intl probes,
so safe-range output matches platform ICU exactly while big values stay
exact; negative plain numbers use an ASCII hyphen-minus.

## Checks

```sh
bun install --frozen-lockfile   # from the repo root
bun run --filter @canlang/ui typecheck
bun run --filter @canlang/ui test
```

Source-declared paginated collections use `collectionCursorName(occurrence)`
for opaque GET continuation state. The original authorized query receives only
that occurrence's token; its next link preserves team, filters, sibling cursors
and selected rows. Duplicate/empty own selectors refuse, explicit authored
`cursor` remains supported, and applying or clearing an own filter resets that
cursor. UI transport grants no access and does not authenticate the token.

CSV grammar preflights Unicode, quoting, records and cells without retaining
records, then uses the existing parser to materialize accepted raw cells.
Malformed syntax retains priority over the fixed 1,000-data-row ceiling.
`parseCsvText(text, limits)` and the exported grammar accept optional trusted
byte/cell ceilings; they introduce no default byte/cell quota. An explicit byte
cap can stop before later content is examined. Advisory output grants no
authority, and the server always applies its checked operation profile.
