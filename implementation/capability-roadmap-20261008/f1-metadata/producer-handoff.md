# Values prepared-owner prerequisite: read-only producer map

Evidence uses frozen main `db57c3794d386fcd27f17f54b199272d58106a81` and draft `a55a0f700f07f6f972d9d6091b0fdbceee399eb9`, the actual locked/offline compiler and isolated producer outputs recorded in `pins.json`. `producer-handoff.json` contains exact source text, CLI commands, exit codes, complete raw stdout/diagnostics, frozen file SHA-256 hashes and numbered excerpts. Live committed HEAD observed separately is `27f211c9229e3ed55280396634d3a0726724e3e2`; every mapped source file has the same committed hash as the frozen snapshot. Live worktree hashes are recorded separately as observations and never acceptance inputs.

| Seam | Exact frozen producer / consumer | Meaning |
| --- | --- | --- |
| Artifact identity | `compiler/src/codegen/artifact.rs:26`, `:230`; `packages/cloudflare/src/runtime/artifact.ts:49` | `ARTIFACT_VERSION=1` is envelope format. Source path/SHA are copied from consulted sources. `assertCompiledIdentity` compares supplied expected first-source path/SHA and tool/language versions, returns void, and issues no owner authority. |
| Operation descriptors | `compiler/src/codegen/js.rs:4908`, `:4964`, `:5213` | `collect_operations` and MCP type mapping emit the published subset. Unsupported input types intentionally omit the whole operation (`:4881`); trusted/expose exclusions also apply. |
| Model descriptors | `compiler/src/codegen/js.rs:5299`, `:5431`, `:5576` | Stored-model metadata includes type tag, requiredness, nullable, serverOnly, array/default/machine/description and ownership. Model tags retain duration/date/etc; operation input tags have a narrower vocabulary. |
| Defaults | `compiler/src/codegen/js.rs:362`, `:391` | `js_field_default` emits literal wire form, parent path or closed server initializer; other computed defaults are absent from descriptors. Runtime default callables are a separate generated surface. Literal encoding documentation alone does not prove a full source compiles. |
| Richer runtime field schema | `compiler/src/codegen/js.rs:4387`, `:4450` | Generated `appDefinition.models` schemas carry type/min/max/trim and callable defaults; `JsModelField` (`:632`) and operation artifact fields (`:516`) have no bounds/trim slots. These are different representations. |
| State loader / canonical model table | `packages/state/src/invocation/registry.ts:771`, `:1177`; `packages/state/src/mutation/models.ts:729`; Cloudflare `runtime/invoke.ts:2221` | Production converts artifact models/operations into canonical intake and builds the State table. Literal defaults are preserved as serialized values via clone, not decoded into Values typed defaults. Nothing here issues a Values plan owner. |
| Catalog consumers | `packages/cloudflare/src/runtime/mcp-registry.ts:439`; `packages/state/src/catalog.ts:20` | Artifact catalog derives allowed/required input names (optional separately baked derived channel). State catalog is version/capability manifest with empty entries. Values `src/catalog.ts` and `scripts/emit-catalog.mjs` supply compiler builtin signatures/capabilities, not source-owner adoption. |
| Values normalization and plan registration | `packages/values/src/internal/schema-core.ts:149`, `:1385`, `:1794`; `src/prepared/plan.ts:105`, `:400` | `normalizeSchema` accepts its own closed `{contracts,enums,operations}` descriptor with `{type,min,max,default,...}` fields. This differs from artifact arrays/tags. Factory lineage only is recorded in a WeakSet; the source comment (`:108`) explicitly grants no owner/adoption authority. Registration requires issued owner plus private provenance with matching ownerRevision. |
| State prepared inputs | `packages/state/src/invocation/registry.ts:743`; `prepared-inputs.ts:15`, `:100` | Per-operation `state-generated/v1` rules retain required/ref/array framing, omit scalar kinds/bounds, and never fill operation defaults. Current frozen `admission.ts` has no preparedInputs reference. This is not a Values plan. |

Actual controlled `.can` output, not authored descriptor fixtures:

| Source vector | Actual compile result |
| --- | --- |
| `text=" hi " trim min=1 max=8` | Exit 0. Artifact literal stays `" hi "`; artifact fields omit trim/bounds. Richer generated module carries trim/min/max. |
| `int=2 min=1 max=4` | Exit 0. Model/create input default is literal string `"2"`; artifact fields omit min/max. |
| `decimal` without initializer/bounds | Exit 0, decimal model/create input tag emitted, no default. |
| `decimal=1.50`; `decimal min=1.00 max=4.50` | Exit 10, E6008 decimal literal lowering; no successful artifact. Claimed literal-encoding support is not source-level qualification. |
| `datetime=datetime("2026-10-08T00:00:00Z")` | Exit 0, datetime type tag and non-required field/input, no artifact default. Generated runtime module retains constructor default callable. |
| `duration=2s min=1s max=4s` | Exit 0, model duration tag and literal string `"2000"`; CRUD operation descriptors absent. Richer module carries bigint millisecond min/max/default. |
| `money=money(2,USD)` | Exit 10, E2001 unresolved `USD`; this exact source cannot qualify money emission. No corrective source substitution was used. |

**No already defined production source-owner/revision association was found.** `normalizeSchema` takes no revision/owner; it never calls `recordFactoryProvenance`. Production source has no caller that binds source identity to `createPlanOwner` and `registerValidationPlan`. `plan.ts:153` exposes an integrator-private provenance hook described as pending V02.6/test substitution, and registration compares that private revision to the issued owner's scope at `:418`. Factory lineage, envelope version, callable/model identities and a caller-supplied SHA comparison do not establish that missing association.

The needed handoff is a source-owner-defined schema/revision and adoption contract that preserves the relevant representations and default/bounds semantics. This evidence does not choose a bridge, mint a stamp, invent an owner string, clone a descriptor into authority, or alter product code.
