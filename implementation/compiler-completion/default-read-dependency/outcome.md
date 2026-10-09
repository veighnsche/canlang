# Read-dependent default owner handoff

The single permanent case
`compiler/tests/default_read_dependency.rs::computed_read_default_uses_admitted_context_and_skips_explicit_override`
passed **1/1 (5.13s)** on its first run. After the required host migration
`45cbbd3e`, the affected case passed again **1/1 (0.51s)** after a consumer-only
setup correction; the affected `--no-run` build passed **0 (5.60s)**. The first
run remains historical, and no production repair was required. The genuine
`DefaultRead` source declares `Entry.count`, a member read policy,
`entry_count():int = count(Entry)` and
`selected(total:int=entry_count())->int` returning `total`.

Public `load_catalog` and `check_program` with the actual installed catalog pin
the scenario parameter's authored default NodeKey to
`SelectedCallTarget::DeriveFn` for the owning `DefaultRead.entry_count` symbol
and type `Int`. Building typed IR with the same SourceDb/catalog yields the
parameter's `IrDefault::Computed`, canonical derive call with no arguments,
and `Int` result. Production CLI output advertises `computedDefault:true`,
no wire literal default, parameter-style callable inputs and the existing
`state`/`state.parameters` requirements.

Actual public artifact loading/module assembly and native Cloudflare/State
Memory invocation execute unchanged generated imports. Two canonical CRUD
creates seed actual rows. Under the migrated host, public CRUD returns `null`
when read authorization is absent. Setup therefore supplies an explicit
operation ID, asserts the public `null`, then confirms the created row through
the owning internal store lookup by that ID (`count=1`, `version=1`). Omitted
`total` reads the native domain once and counts it once, returning wire `"2"`;
explicit wire `"9"` skips the default helper/read/count and returns `"9"`. A
forwarding observer for
`hasRole`/`records`/`count` delegates every behavior to its installed owner. It
retains the first admitted handler context, verifies that `records(c)` receives
that identical context, and verifies unchanged native row/array identity and
integer projections into `count`. Domain rows, versions and per-row history
remain unchanged by both default and explicit pure bodies.

Before the first run, the initial full-role-trace assertion was narrowed to
allow legitimate owning policy checks while preserving the first admitted
context and exact once helper read/count observations. The host-migration
rerun changes only consumer setup for the new public null result; authored
source grants/default expectations and all omission/override, context,
identity, domain/history assertions remain unchanged and pass. Earlier
actor/read/default/effects outcomes, including `d2fb9024`, are reused without
execution. This is a bounded SEM-R08
default-context/read-dependency handoff qualification; no server-marker,
unsupported-default API expansion, broad default/replay/actor matrix or full
SEM-R08 completion or task-count credit is claimed. Completion remains 58/67
with 9 open references. Source/test are frozen; coordinator owns
DECISIONS/coverage/index joins.
