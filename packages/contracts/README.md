# @canlang/contracts

Type-only shared boundaries between CanLang producers. No execution engine,
no catalog, no runtime behavior lives here (CONTRACTS.md).

Ownership per `implementation/PLAN.md`: lane 07 assembles this manifest and
`src/index.ts`. Each `src/*.ts` boundary module is owned by its producer
lane; only `deployment.ts` and `examples.ts` exist until producers land
theirs. Consumers must not guess imports or duplicate these definitions.

Build: `bun run build --filter=@canlang/contracts` emits deterministic `dist/`
(JS + declarations + source maps) from `src/`.

The `./distribution` export locates the built module tree after installation.
The `./values` export preserves the exact value-contract module surface.

The root also exports the defining File retirement types from `state.ts` and
`files.ts`. `FileReferenceStoragePort` requires one permanent store authority,
complete persisted declarations, retirement/readback and checked migration
publication/activation. Generic `StoragePort` has no such capability. State must
implement the atomic guards even through legacy calls; Files and Dev must consume
the genuine persisted issuer and physical pins. These declarations implement no
storage or deletion and do not qualify the current cross-store profile.

`FileReferenceInventory.frameworkModels` is required alongside domain models
and value types. Actual owning exports supply `FrameworkFileReferenceProducer`
inventories and closed row validators; the host binds those same-load exports
outside persisted JSON and checks their source/shape correspondence. Copied
tags or validators do not establish authority. Unknown/colliding models and
opaque retained results/deferred inputs without checked declarations refuse
census/admission. A successful shape read does not establish File absence.
Structured controls can declare a closed flat map of required string fields,
including State's actual nullable `ReceiptError` with only `code` and `message`.
This adds no arbitrary JSON or opaque-payload exemption; the owning producer
checks its actual declaration and closed nested data.

The additive opaque File ABI is declared in `state.ts` and exported by the root.
`opaqueDeclarationSets` retains each original installed/source/model/value-type
closure with complete canonical/artifact inputs, results and explicit void.
`FrameworkFilePayloadOrigin` describes the owning `row.data.filePayloadOrigin`:
original slot lifetime, scope, closed delivery/event/handler/routing/completion
origin and genuine original receiving facts at typed payload paths. A framework
field with `kind: 'opaque', role: 'payload-origin'` links that evidence to
`payloadField`; State must validate this header separately without recursively
resolving it or exempting arbitrary nested JSON.

The optional `resolveOpaqueField` method is synchronous and data-only. The actual
same-load owning export validates every retained-result/deferred-input field
against its persisted origin and historical declarations; State independently
traverses the actual typed values and matches original File facts. Completion
covers original source inputs, terminal result, duplicate event result and typed
schema defaults. Raw committed change payloads differ from handler projections.
Historical sets require complete `valueDefaults` entries (`contract`, `field`,
`value`) for every original own contract-field literal before schema normalization.
The required `originalContracts` input uses the existing JSON wire carrier for
the entire original `appDefinition.contracts` map, including unused contracts and
every field descriptor, detached before normalization from the same verified
native load/source/snapshot. State compares complete contract/field/type/constraint
correspondence and independently derives every own literal default, requiring
one-to-one raw equality with `valueDefaults`. Missing, extra, duplicate or changed
defaults refuse. Null/empty/File-free defaults remain entries; `{}` and `[]`
establish absence only after complete genuine capture/comparison. Preserve both
inputs through reopen/migration; a copied map proves no source correspondence.
`value-field` projections select that set's exact entry and compare the physically
retained literal before independent typed File traversal. Canonical nominal field
reuse still drops defaults; missing evidence refuses, with no current-schema lookup.
Explicit void and phase-bound no-result projections require positive declaration
evidence. Judgment persists canonical int64 text and original question order.

These types implement no row capture, census, migration or receiving authority.
Current State/Work runtime adoption is separate, and existing opaque refusal
remains. Optional members preserve legacy typing, with missing evidence refused
for bound opaque rows even when their value is null, empty or File-free.
