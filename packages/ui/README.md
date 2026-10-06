# @canlang/ui

Server-rendered CanLang presentation library. Generated app JS calls canonical
factories with props/children; this library owns daisyUI markup/classes,
escaping, HTMX behavior and locale formatting. No `h`/JSX, no hydration, no
browser business-state store, no second CRUD/policy engine.

Contract: `packages/contracts/src/presentation.ts` (lane 05 owned). Compiler
emission (lane 1) and route dispatch (lane 6) consume that contract.

## Package boundaries

This package extends the root `tsconfig.base.json` and builds only its own
source and tests into `dist/src` and `dist/test`. Contracts are consumed through
the declared `@canlang/contracts` workspace dependency. The root workspace owns
the dependency lockfile.

The `@canlang/ui/distribution` API supplies the compiled module and browser
asset directory URLs used by Worker staging. Browser assets remain in
`dist/browser`; the browser build validates their local import closure and the
pinned daisyUI version. Browser export and print consumers have explicit
`@canlang/ui/browser/export` and `@canlang/ui/browser/print` APIs.

## Layout

- `src/escape.ts` — HTML/attribute/URL escaping, CSV formula protection, bidi isolation.
- `src/messages.ts` — message descriptors, RFC 4647 lookup, ICU-profile formatting.
- `src/navigation.ts` — pure discovery shaping over dispatcher admission outcomes.
- `src/shell.ts` — renderPage: drawer shell, account menu, settings frame, partials.
- `src/components.ts` — card/title/text/content, shared states, text values, row headings.
- `src/collections.ts` — list/table renderers over the authorized query runner.
- `src/catalog.ts` — versioned machine-readable component catalog.
- `themes.css` — pinned `can-{mode}-{accent}` daisyUI themes + density rules.
- Later slices: `forms`, `htmx`, `settings`, `review` (+ controls in `collections`).

## Themes and class audit

`themes.css` pins nine themes against daisyUI 5.7.47 (exact devDependency).
`test/themes.test.ts` audits theme-name coverage, variable names against the
installed daisyUI, the pinned version, and every markup class used in src
(daisyUI bundle, reviewed tailwind utilities, or `can-*` structural hooks).

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
bun install --frozen-lockfile   # from the repo root
bun run --filter @canlang/ui typecheck
bun run --filter @canlang/ui test
```
