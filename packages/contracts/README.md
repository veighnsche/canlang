# @canlang/contracts

Type-only shared boundaries between CanLang producers. No execution engine,
no catalog, no runtime behavior lives here (CONTRACTS.md).

Each `src/*.ts` module defines a producer boundary shared by its consumers.

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

`ScenarioReceiptAssociation.observations` can retain optional `files` facts for
original stored File field inputs, including ordered File[] occurrences. These
facts belong to the existing checked dependency and observed row, independently
of final-write `fileAssignments`. The owning runtime must match every retained
item to the original ordered field occurrence and the whole source census;
omission or an empty list does not certify File absence or grant authority.
Capability/State owns admission, current revalidation and durable replay; Dev
supplies genuine originating rows and Files observations, and Compiler supplies
the exact original CALL-site dependency correspondence. This type implements
none of those behaviors.

Contained receipt queries add optional `ScenarioReceiptQueryPlan.parent` with
the checked selector source, canonical parent model and either an
`admitted-reference` parameter or prior `stored-reference` dependency ID. The
parent model must match the queried `ArtifactModel.parent`. The corresponding
`ScenarioReceiptQueryObservation.parent` retains the genuine `StoredRow` and
secret-field evidence, including when `candidates` is empty. Both fields are
omitted for existing unscoped queries; State must reject mismatched pairing.
Compiler owns exact selector/origin correspondence; State owns resolution,
child-domain filtering, capture and saved/current parent, ancestor and full
Identity authority checks at the original owner/stage/physical store. Dev binds
the real observation privately. These shapes grant no authority and implement
none of those runtime checks.

A return ordinary dependency may add `queryId` only when Compiler proves it is
used exclusively while evaluating that existing checked query's candidates.
State must validate the same authentic source/owner/stage/store and completed
candidate capture consumed by the return before accepting an absent dependency
observation for an empty domain or short-circuited predicate. Every actual read,
including a second hop, remains retained and revalidated. Omitted associations
keep ordinary dependencies mandatory; intrinsic observations gain no exemption.
This additive fact implements no Compiler matcher or State permission/recovery.

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
