# @canlang/ui

Server-rendered CanLang presentation library. Generated app JS calls canonical
factories with props/children; this library owns daisyUI markup/classes,
escaping, HTMX behavior and locale formatting. No `h`/JSX, no hydration, no
browser business-state store, no second CRUD/policy engine.

Contract: `packages/contracts/src/presentation.ts` (lane 05 owned). Compiler
emission (lane 1) and route dispatch (lane 6) consume that contract.

## B0 wiring (temporary)

`packages/contracts` assembly (`package.json`, `index.ts`) is lane 7 owned
and does not exist yet. Until it lands, this package compiles
`../contracts/src/presentation.ts` into its own program and imports it via an
explicit relative path. No duplicate definitions: the contract file is the
single source of truth. This wiring retires at L7 assembly (interface request
in `implementation/status/lane-05.md`).

## Layout

- `src/escape.ts` — HTML/attribute/URL escaping, CSV formula protection, bidi isolation.
- `src/messages.ts` — message descriptors, RFC 4647 lookup, ICU-profile formatting.
- Later slices: `navigation`, `shell`, `components`, `forms`, `collections`,
  `htmx`, `settings`, `review`, `catalog`.

## Exactness seams (lane 2)

Integers travel as bigint or canonical decimal strings; naive numbers are
accepted only when safe. Currency scales are an explicit formatting
parameter from the pinned lane 2 table, never a default here. Datetimes are
canonical RFC3339 UTC instants with explicit calendar/time validation
(leap second `:60` rejected); civil dates never shift timezones.
Grouping patterns and numbering-system digits are derived from Intl probes,
so safe-range output matches platform ICU exactly while big values stay
exact; negative plain numbers use a pinned ASCII hyphen-minus.

## Checks

```sh
npm install
npm run typecheck
npm test
```
