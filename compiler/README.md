# CanLang compiler

A Rust compiler with pinned, focused infrastructure libraries: library crate
`canlang_compiler` plus the `can` binary. Fifteen subcommands, one dispatch
(`src/cli.rs`), exit
0 clean / 10 errors reported / 2 tool failure:

- `compile`, `check`, `lint`, `fmt`, `explain`, `lsp`, `policy` — the
  compiler and authoring tools (full pipeline over the producer catalog;
  `can check` reports `complete=true`).
- `docs` — extract the checked reference model and pipe typed JSON to the
  installed `can-platform docs` renderer; rendering needs that runtime.
- `run`, `test`, `build`, `deploy`, `activate` — thin lane-7 entries that
  exec `can-platform` with argument passthrough (override with
  `CAN_PLATFORM_BIN`); never a second engine.
- `completions bash|zsh|fish` — print the shell completion script
  (also shipped as `can-completions.<shell>` in this directory).
- `help [COMMAND]` — alias for `--help`.

`can --version` prints the tool, commit, language, and schema versions
(commit via `build.rs`, no VERGEN). An unwinding internal panic prints one
`error[E7005]` line and exits 2. Aborts, including stack overflow and the
default allocation-error handler, bypass that boundary; public library callers
do not inherit the executable's panic handler.
`can lsp` shuts down gracefully on stdin EOF or the `shutdown`/`exit`
handshake. `can fmt` replaces each changed file atomically using a
destination-local owned temporary file and preserves the promised source mode.
Atomic entry replacement does not promise crash durability or owner/ACL retention.

`can check FILE.can...` analyzes the supplied sources together, including their
package imports and exports. `can lsp` analyzes each open document independently;
definitions, references and rename are confined to that document. Opening another
file does not add it to the document's checked program. The server loads one
catalog at startup from `CAN_CATALOG`, `./can-catalog.json`, or
`./packages/values/dist/catalog.json`, in that order, relative to its process
working directory. Every open document uses it. Workspace-folder, configuration
and watched-file notifications do not reload the catalog; start a new server
process to use changed catalog contents. `can lsp` accepts no `--catalog` flag.

Implemented modules:

- `src/source.rs`: `SourceDb`/`SourceId`, byte `Span`, `LineIndex`
  (LF/CRLF, LSP UTF-16 positions) and the stable `sha2` byte-hash adapter.
- `src/diagnostic.rs`: the one diagnostic engine — stable codes, severity,
  deterministic compact JSON envelope and human text rendering.
- `src/lib.rs`: shared version/exit-code constants.
- `src/cli.rs`: single dispatch for all `can` subcommands.
- `src/explain.rs`: diagnostic code catalog behind `can explain`.
- `src/lsp/`: bounded stdio framing and explicit request admission/lifecycle,
  typed `lsp-types` output, versioned edits/diagnostics and the production backend.
- `src/json.rs`: bounded Serde JSON input and typed output adapters; the
  compatibility view retains ordered duplicates and exact numeric lexemes for
  the catalog/LSP callers that require them.
- `src/analysis/`: producer-catalog consumer (`--catalog`, `CAN_CATALOG`),
  name resolution, type checking, and effects over the CST.
  Recurring scope analysis follows executed create-field server initializers
  and omitted ordinary defaults through their checked declarations. An explicit
  ordinary-default override and unused model defaults add no dependencies.
  Selected anonymous localized-format descriptors use their checked empty
  parameter schema: undeclared variables fail with E5007 at the source or
  translated literal, including declaration defaults and grouped operands.
  Named-message parameter checking and other descriptor profiles retain their
  existing contracts.
- `src/syntax/`: lossless recoverable CST parser for the full GRAMMAR.md
  (lexer, layout/descriptions, CST, parser, E1xxx diagnostics). Parses the
  whole `examples/` + `draft/` corpus cleanly; see `tests/syntax.rs`.
  Standalone JSON-string decoding checks its absolute byte endpoint before
  decoding: exact `u32::MAX` endpoints fit, and overflow returns a point-span
  range error. Finite source controls cover byte offsets through 65,536 and
  257 immutable snapshots; larger whole-source/count admission remains open.
- `src/codegen/`: lexer-decoded IR strings, JS/BDD emitters and `sourcemap`
  codec behind `can compile`; original Can map columns retain byte units.
- UI lowering has a finite source-to-factory surface. It carries Card captions
  and stack/columns layout, `details` captions/open state into `collapse`,
  `title` text, `text` values, single-value `content`/`badge`/`stat` and optional
  `divider` captions, transient tabs, `fieldset`/`join` children, named slots for modal/drawer/chat bubbles,
  and main/action children for FAB. Forms go through the runtime's
  `prepareForm`, awaiting preparation once before authored children; collection
  row rendering carries the same asynchronous preparation. `list`/`table` carry
  named model and query scope. Catalog
  availability alone does not make a word or profile authorable: unsupported
  source-to-factory shapes fail with E6008. The generic catalog fallback and
  incomplete legacy `action`, `actions`, `edit`, `history`, `copy`, `metrics`,
  `breadcrumbs`, and `pagination` profiles are rejected explicitly; structural
  `slot` and tab-item carriers are not imported as standalone factories.
  Unsupported attributes, header shapes and child forms are diagnosed instead
  of being dropped. This bounded surface does not qualify whole-app generation,
  every backend/browser workflow, protected forms or BDD3 returned/live
  payloads.
- Checked sends retain the exact selected deployment binding alongside their
  canonical operation. Capability input/result metadata derives from owning
  declarations and the standard catalog, with named standard types retained as
  references. Request fields use canonical Values type IDs and wire-valued
  literal defaults; captions remain separate from validation descriptors. The
  existing native binding witness checks actual Values request validation,
  omitted-array defaults and unknown-input refusal, along with alias selection,
  request schemas, context identity, input reads and lazy guard order. Canonical
  Work staging and dispatch are qualified by their owning runtime consumers.
  Checked standard delivery values use the owning operation's canonical Values
  type ID and delivery field schema, including nullability. Their public
  capability/operation/version/result descriptor keeps its existing owner.
  The native Email fixture qualifies metadata, codec and send/association
  order. Joined singular delivery fields also publish the existing reserved
  `Receipt.read` read operation with required `recordId`, `field` and `selected`
  inputs. The real State loader consumes its generated public gate; an exact
  source identity collision refuses with E6008. Model binding, current grants,
  persistence and provider observation remain runtime duties.
- Ordinary checked schedules emit
  `schedule(c,key,at,event,payload,{ownerPackage})`; cancellation emits
  `cancel(c,key,{ownerPackage})`. The compiler supplies the declaring package
  name and canonical event identity, preserving authored argument order and
  native datetime/record values. Verified app/owner/occurrence identity,
  payload encoding, atomic replacement/cancellation and current due-time
  eligibility remain runtime duties. Declared events publish closed canonical
  Values input descriptors at `appDefinition.events[event].inputs`. Ordinary
  declared-event handlers without `each` publish their checked event identity
  at `appDefinition.operations[handler].event`, using the existing trusted
  callable and `c,{event}` signature. Their private `invocation` member uses
  the existing flat operation descriptor, derived from the owning event's
  fields, and stays outside public `artifact.operations`. Model references
  request current admission without making a captured version authoritative.
  The runtime must verify the Work occurrence, admit those current fields and
  bind them into `{event}`. Unsupported compound inputs omit the entire
  private descriptor. Other triggers retain their explicit refusal. The
  pre-commit hook ABI is unchanged.
- Decimal literals and contextual integral values lower through the existing
  `parseDecimal` path. Decimal arithmetic and value comparisons use the owning
  `Values` helpers. Permanent native runtime witnesses cover these supported
  paths in `tests/decimal_runtime.rs` and `tests/fixtures/decimal-runtime/`;
  this does not qualify every Decimal expression, backend, transport or host.
- Scenario handlers fill checked literal and supported computed signature
  defaults in source order after admission and before guards/effects. Native
  parameter-style execution covers nonnullable scalar defaults, selected async
  calls, supplied empty/false/zero overrides and first-failure order. Real State
  admission preserves their omitted inputs; computed values make no fabricated
  wire-default claim. Nullable, array and reference computed defaults retain
  E6008 until an owning omission/hydration seam is qualified. Read-scenario
  runtime joins and resolved-default receipt/replay remain separate.
  Scope analysis follows only executed omitted parameter/create defaults and
  server initializers through selected calls; supplied ordinary overrides stay
  inactive. Permanent controls are in `tests/default_parameter_runtime.rs` and
  `tests/effects.rs`.
- Checked File scalar, nullable and array profiles publish their owning Values
  type in model/input/result metadata. `tests/file_profile_runtime.rs` exercises
  unchanged native returns and the real identity-only `{id}` codec; File
  authority and byte-transfer workflows remain runtime duties. Known imported
  standard nominal constructors use their owning catalog field schemas,
  including contextual enum cases and aliases. The actual TextRequest source
  in `tests/std_nominal_construct.rs` preserves lexical binding priority,
  closed field checks and native send/association/require order; unknown
  external types retain their existing behavior.
  Reachable standard nominal schemas also populate `appDefinition.contracts`
  from imported capability input/result declarations. The real Values facade
  admits the emitted TextRequest/TextMessage closure, including inline role
  cases and the existing canonical duration representation. This qualifies the
  demonstrated request path; unrelated standard shapes retain their scope.
- Public native compile/runtime facades have permanent execution witnesses for
  value equality and membership, nullable and mixed numeric equality, text
  scalar ordering and mixed numeric relations (including values above 2^53 and
  astral codepoints), selected calls and binding/default/order behavior, finite
  BDD fixture callbacks, and string payloads. See `tests/flat_expression_runtime.rs`,
  `tests/selected_calls.rs`, `tests/bdd_binding_runtime.rs`, and
  `tests/string_payload_runtime.rs`. These qualify the named paths and recorded
  profiles only; they do not establish full backend, transport, UI or host
  workflows.
- `src/policy.rs`, `src/lint/`, `src/format.rs`, `src/ide/`: policy dumps,
  lint rules, the formatter, and editor services.

Run from this directory with `cargo run -- --help`. Check with
`cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings` and
`cargo fmt --check`. Ship with `cargo build --release --locked`
(`[profile.release]` strips and optimizes for size). Install from a
release binary with `docs/install.md` at the repo root. Local build
output in `target/` is ignored.

The [final compiler qualification](../docs/research/compiler-library-audit-20261006/pass10/README.md)
records the locked dependency/features, supported host/consumer scope, release
measurements and retired predecessor engines. URL admission uses `url` while
retaining authored values; JSON output uses `serde`/`serde_json`. Destination
policy, protocol IDs/bounds, grammar and value rules remain compiler-owned.

The [production-reduction follow-up](../docs/research/compiler-library-audit-20261006/production-reduction/README.md)
requires smaller owned implementations as well as faithful behavior. Its first
packet consolidates URI-bearing LSP output into one authored-identity projection
while retaining the library's ranges, diagnostics, edits and action fields.

Conditional locale, CLI framework, ICU, temporal, graph and position-library
mechanisms have explicit retain/defer results. The [locale candidate gate](../docs/research/compiler-library-audit-20261006/pass3/README.md)
and [remaining ICU/graph packets](../docs/research/compiler-library-audit-20261006/pass9/correctness/QUEUE.md) stay explicit;
compiler qualification does not complete original-app or installed-release
product gates. See the [pass sequence](../docs/research/compiler-library-audit-20261006/implementation-passes.md)
for task/acceptance links.
