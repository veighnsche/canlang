# C04 finite conditional serializer evaluation

Decision: retain the existing bounded serializer. Conditional adoption of a new CSV writer library is declined for this packet; no new serializer is implemented. The parsing change C02/C03 is independent.

The interfaces owner projects values and refuses secrets; file values emit only opaque IDs. It chooses columns and preserves their order, ID/version prefix, LF records and terminal LF, then neutralizes formula-leading cells (`=`, `+`, `-`, `@` after leading whitespace) before CSV escaping. The single tiny `escapeCsvCell` quotes exactly comma/double-quote/CR/LF and doubles inner quotes. UI's browser export adapter transports the authorized server bytes to an injected download sink. It does not reserialize them. A general writer would still need the same projection/authority/formula policy and byte defaults, adding a dependency and compatibility adapter for a currently bounded three-line mechanism. The shared csv-parse grammar library reads CSV; treating it as a writer would not satisfy export requirements.

Fair alternatives: a pinned serializer with explicit record delimiter/quoting/header/formula options can be reconsidered if a real streaming or dialect requirement appears; automatic library defaults cannot establish current bytes. Retaining the leaf is simpler for the same current behavior, and preserves independence of parsing and export policy. This is not a policy against libraries or a claim that arbitrary new CSV dialects are supported.

Source-current private Node24 CSV/export gate reports 45/45, including actual route-to-browser-adapter sink bytes, selected columns, formula neutralization/quoting/file IDs, secret refusal, live membership/CSRF refusal before reads, truncated descriptor/no-polling behavior and unknown/missing mount behavior. The route tests inject real subhandlers over memory identity/scripted reads. They do not prove a production deployed durable app export mount, a real browser download UI installation, or all original finished-product export duties. No new browser-export production claim follows from this evaluation. Evidence: `delivery/interfaces-final-tests.log` and `delivery/final-gates-commands.json` in the private step10 root.

Economical allocation: Luna medium was selected for this frozen bounded inventory, but the dispatcher rejected that new packet and also the existing Sol-medium reuse with `agent thread limit reached`. Root completed only this finite evaluation; no cheap-worker progress is invented. C03/H full independent review remains the actual Sol-high report.

## Source pins

- `packages/interfaces/src/http/export.ts`: `5da1415db2a27e24a79d045145e1fddf520b9ef525a7bf7ea2b316e1cf1321d3`
- `packages/interfaces/test/export-print.test.ts`: `d8d58be75556c910d0c0c099d66f1871caf4576c24c868e7df6f4bb98e3deb2f`
- `packages/interfaces/test/export-route.test.ts`: `a41b82d9d9a7f4846e0f2f51b8d336d69204207a09bc8d041a6f52e3770ccf41`
- `packages/interfaces/test/export-join.test.ts`: `27056c7b91ed4fea6f045bc3939875c1d7ea51424dce76ba4536c8bb745f5d4f`
- `packages/ui/src/browser/export.ts`: `9c85f8b85632ef10383eaffba1b0aea12c48302effc0a5d609c22a0c85070e63`
