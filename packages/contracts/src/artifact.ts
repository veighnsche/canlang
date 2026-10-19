import type { CanonicalNominalLeaf, CanonicalOwnerModelPolicies, CanonicalValueTypes, FieldMachine, ScenarioResultDisclosurePlan } from "./state.js";
import type { CanTypeId, WireValue } from "./values.js";
import type { InputChoiceBinding } from "./wire.js";

/**
 * Lane 01-owned compiled-artifact boundary.
 *
 * Type-only description of what `can compile` emits for one `.can` program:
 * versioned app definitions, the callable registry shape, pages, linked
 * library requirements, source maps and separate test artifacts. Lanes 3-7
 * consume this; lane 1 never implements their runtime behavior here.
 *
 * Compatibility: additive changes only. `artifact_version` starts at 1.
 * Unknown `kind` values or unmet `requires` entries must be rejected with a
 * precise error, never silently treated as supported.
 */

export const ARTIFACT_VERSION = 1 as const;

/** Exact source revision an artifact was compiled from. */
export interface ArtifactSource {
  path: string;
  /** Lowercase hex SHA-256 of the compiled bytes. */
  sha256: string;
}

/**
 * One library/runtime capability the emitted code links against, e.g.
 * `values@2` scalar semantics or `state@1` commit protocol. The compiler
 * emits requirements; lane 7 activation checks them against installed
 * artifacts. A missing implementation can never masquerade as callable.
 */
export interface ArtifactRequirement {
  /** Producer capability id, e.g. `values.decimal`. */
  capability: string;
  /** Minimum producer contract version. */
  min_version: number;
}

/** Emitted JavaScript module plus its source map. */
export interface ArtifactModule {
  /** Output path relative to the artifact root. */
  path: string;
  /** Compiled JavaScript (direct emission; no Can-to-TypeScript stage). */
  js: string;
  /** Source map JSON mapping emitted lines to `.can` byte spans. */
  map: SourceMap;
}

/** Minimal source-map shape (V3 subset) with `.can` byte-span resolution. */
export interface SourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}

/** One declared page descriptor reference (DESIGN §13 `appDefinition.pages`). */
export interface ArtifactPage {
  /** Canonical declaring package. */
  owner: string;
  /** Normalized route pattern. */
  path: string;
  /** Module exporting the page descriptor. */
  module: string;
  /** Exported descriptor binding name. */
  export: string;
}

/** One callable registry entry reference. */
export interface ArtifactCallable {
  /** Canonical qualified identity, e.g. `expense.Expense.create`. */
  id: string;
  kind: "operation" | "pure" | "rule" | "handler" | "migration";
  module: string;
  export: string;
  /**
   * Path segments into the module's `canApp()` registry object
   * (DESIGN §13). `["createNote"]` = top-level handler;
   * `["read","Note.read.1"]` = rule-map entry. Non-empty; every
   * segment a non-empty string. Exports stay identity consts; the
   * registry holds implementations — this is the linkage between them.
   */
  member: string[];
  /** Generated scenarios receive named admitted parameters; absent keeps the legacy envelope. */
  inputStyle?: "parameters";
  /**
   * Declaring source path. Present only for multi-source closures, where the
   * module source map cannot resolve one exact declaring file; absent keeps
   * the legacy module-map resolution.
   */
  source?: string;
}

/**
 * One T13c nominal result leaf, verbatim.
 *
 * `type` is the T13c transcribed kind spelling (`text?`, `file[]`,
 * `enum(a,b)`, nominal refs) — never a re-interpretation. T04b
 * ratifies any structured leaf vocabulary; verbatim leaves derive it
 * without loss.
 */
export interface ArtifactNominalLeaf extends CanonicalNominalLeaf {
  /** Leaf field name in producer order. */
  name: string;
  /** Verbatim T13c declared kind spelling. */
  type: string;
}

/**
 * One T13 provider-result nominal with its T13c leaves in producer
 * order. `name` is the source nominal spelling (e.g. `ImageRun`),
 * never a TS wire alias.
 */
export interface ArtifactNominalResult {
  /** Source nominal name. */
  name: string;
  /** Leaves in T13c producer order. */
  fields: ArtifactNominalLeaf[];
}

/**
 * T15b provider delivery descriptor: the closed T04b-preview kind
 * for T14c typed `std` receipts, shared by operation inputs and
 * model field tags (one shape, no drift).
 *
 * `capability` + `operation` is the T13 send-target identity (the
 * `std.EmailV1.send` vocabulary); `version` is the frozen capability
 * contract version for T04a §7 fencing; `result` is the declared
 * provider result with its T13c leaves. Additive-only: old consumers
 * precisely reject the unknown `delivery` kind per T04a §3/§7.
 * T04b ratifies this shape.
 */
export interface ArtifactDeliveryDescriptor {
  kind: 'delivery';
  /** Qualified capability contract, e.g. `std.EmailV1`. */
  capability: string;
  /** Consumed operation name, e.g. `send`. */
  operation: string;
  /** Frozen capability contract version. */
  version: number;
  /** Declared provider result with its T13c leaves. */
  result: ArtifactNominalResult;
}

/** Static source-defined Judgment delivery; no narrowing to a JS number. */
export interface ArtifactJudgmentDeliveryDescriptor {
  kind: 'delivery';
  judgment: true;
  capability: string;
  operation: 'evaluate';
  version: string;
  result: ArtifactNominalResult;
}

/**
 * One closed typed input field of an operation descriptor (MCP P1).
 *
 * JSON shape of `McpSchemaField` (`@canlang/interfaces` ports.ts),
 * redeclared here so this lane-01 boundary stays dependency-free. The
 * two shapes must stay JSON-identical: `ref` carries the canonical
 * model plus the version requirement; `enum` carries case spellings in
 * declaration order; `delivery` carries the T15b provider descriptor;
 * every other kind is a bare tag. (T04b-p: identity holds for the
 * non-delivery members until T16/T19 mirror `delivery` in
 * `McpSchemaField` — delivery inputs are MCP-unsuppliable till then.)
 */
export type ArtifactOperationField =
  | { kind: 'ref'; model: string; requireVersion: boolean }
  | { kind: 'string' }
  | { kind: 'integer' }
  | { kind: 'decimal' }
  | { kind: 'money' }
  | { kind: 'datetime' }
  | { kind: 'duration' }
  | { kind: 'user' }
  | { kind: 'boolean' }
  | { kind: 'file' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'nominal'; name: string }
  | ArtifactDeliveryDescriptor
  | ArtifactJudgmentDeliveryDescriptor;

/** One named operation input (JSON shape of `McpNamedField`). */
export interface ArtifactOperationInput {
  /** Checked operation-owned candidate assistance; the referenced read owns result/schema. */
  choices?: InputChoiceBinding;
  /** Checked computed scenario parameter default; evaluation stays with the generated handler. */
  computedDefault?: true;
  /** Checked source type association; text requires this claim beside the collapsed string tag. */
  valueType?: CanTypeId;
  /** Input name (parameter or flattened model field). */
  name: string;
  field: ArtifactOperationField;
  /** Whether the caller must supply the member. */
  required: boolean;
  /**
   * Present and true exactly when the input accepts explicit null
   * (T15a additive: distinguishes nullable omission from
   * default-filled omission, which `required: false` alone conflates).
   */
  nullable?: boolean;
  /**
   * Present exactly for array inputs (T15a additive, same shape as the
   * model `array` marker): `field` is the element kind, `required` is
   * the T09 `!` spelling marker (scenario parameters are always
   * ordinary). T04a-intake consumers ignore it; T16 honors it and T04b
   * formalizes array admission.
   */
  array?: { required: boolean };
  /** Authored array-length bounds; absent bounds impose no inferred limit. */
  min?: number;
  max?: number;
  /**
   * Source-declared default, when representable as `literal`/`parent`
   * (T15a additive, mirrors L3 `CanonicalInputDef.default`). Absent
   * for computed defaults (marked by `computedDefault`; the emitted
   * `default(c)` callable owns evaluation) and for update changes
   * (partial: omission means unchanged, never default-filled).
   */
  default?: ArtifactFieldDefault;
  /**
   * Authored `@{desc="..."}` text, verbatim (MCP P4). Absent when the
   * input carries no annotation — loaders must treat absence as
   * "no description", never as an error.
   */
  description?: string;
}

/** MCP operation kinds with a `.can` source (`list`/`team` excluded). */
export type ArtifactOperationKind = 'read' | 'create' | 'update' | 'delete' | 'scenario';

/**
 * T18 closed server-initializer vocabulary (additive `init` payload on the
 * `server` default member). The L3 engine resolves exactly `actor` (the
 * invoking actor as a wire `{id}` user value), `now` (the frozen
 * invocation clock as an RFC 3339 millis datetime string), and
 * `random_secret` (fresh opaque hex material per execution, stable per
 * committed operation identity through the replay path). `computed` marks
 * a server initializer outside that closed set (e.g. `server=now+1h`):
 * descriptors stay total and diagnostic-free, and the L3 loader rejects
 * such sets fail-closed (T04b grows the execution vocabulary). Absent
 * `init` reads as unspecified (pre-T18 artifacts): the engine resolves
 * nothing and the field stays missing, never invented.
 */
export type ArtifactServerInit = 'actor' | 'now' | 'random_secret' | 'computed';

/**
 * T15a source-derived default vocabulary (JSON shape of L3
 * `CanonicalFieldDefault` in `state.ts`). The two spellings must stay
 * identical: `literal` carries a wire-encoded JSON value (ints, decimals
 * and durations as canonical decimal strings, money as
 * `{minor, currency}`, never a JS Number); `parent` carries the dot path
 * off the loaded parent row (create only, leading `parent.` stripped);
 * `context` carries the closed ordinary actor creation default, retaining
 * supplied overrides; `server`/`derived` mark engine-resolved values (T18 execution) and
 * exclude the field from writable inputs. T18 adds the optional `init`
 * payload on `server` (see `ArtifactServerInit`); L3 intake readers keep
 * ignoring extra members and only kinds reject.
 */
export type ArtifactFieldDefault =
  | { kind: 'literal'; value: unknown }
  | { kind: 'parent'; path: string }
  | { kind: 'context'; value: 'actor' }
  | { kind: 'server'; init?: ArtifactServerInit }
  | { kind: 'derived' };

/**
 * T15a closed field-type tag for stored model fields (T04a §3 model
 * vocabulary plus source-exact T04b-preview kinds).
 *
 * The `ref`/scalar/`enum` members mirror `ArtifactOperationField` (minus
 * `requireVersion`, which is meaningless for stored rows) and the L3
 * `CanonicalScalarKind` intake; `ref` names the canonical target model
 * and `enum` carries case spellings in declaration order. Arrays use the
 * element tag plus the sibling `array` marker (same shape as L3
 * `CanonicalFieldDef.array`).
 *
 * The `date`/`duration`/`secret`/`user`/`member`/`json`/`bytes` members
 * are additive T04b-preview tags: T04a consumers ignore them (the §3
 * `required`/`serverOnly`/`array`/`default` members stay complete for
 * every field regardless of type) and T04b formalizes their admission.
 * `delivery` is the T15b provider descriptor for T14c typed `std`
 * receipts (shared shape with operation inputs, above). `other` is
 * the honest fallback for bound-local deliveries, actions, unions,
 * contracts and unknown shapes; `type` carries the source type id.
 */
export type ArtifactModelFieldType =
  | { kind: 'ref'; model: string }
  | { kind: 'string' }
  | { kind: 'integer' }
  | { kind: 'decimal' }
  | { kind: 'money' }
  | { kind: 'datetime' }
  | { kind: 'boolean' }
  | { kind: 'file' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'date' }
  | { kind: 'duration' }
  | { kind: 'secret' }
  | { kind: 'user' }
  | { kind: 'member' }
  | { kind: 'json' }
  | { kind: 'bytes' }
  | { kind: 'nominal'; name: string }
  | ArtifactDeliveryDescriptor
  | ArtifactJudgmentDeliveryDescriptor
  | { kind: 'other'; type: string };

/**
 * T15a one stored (or derived) model field (JSON shape of L3
 * `CanonicalFieldDef` plus additive source-exact members).
 *
 * `required`/`serverOnly`/`array`/`default` mirror the L3 intake
 * exactly: `required` is omission-rejects at creation (false for
 * nullable, defaulted, server/derived and ordinary-array fields);
 * `serverOnly` rejects caller-supplied values; `array.required` is the
 * T09 `!` spelling marker (ordinary omits to empty, required rejects
 * omission); `default` records the source default. Additive members
 * (`field`, `nullable`, `description`) carry source-exact info L3
 * ignores: `field` is the element type tag, `nullable` marks explicit
 * null acceptance, `description` is the verbatim checked source text.
 * Derived fields render with `default: { kind: 'derived' }` and
 * `serverOnly: true`; they never appear in operation inputs.
 */
export interface ArtifactModelField {
  /** Checked source type association; text requires this claim beside the collapsed string tag. */
  valueType?: CanTypeId;
  /** Checked field normalization and inclusive wire-form bounds. */
  trim?: boolean;
  min?: WireValue;
  max?: WireValue;
  /** Opt-in flat lifecycle, with static operation-owned edges. */
  machine?: FieldMachine;
  /** Field name (model-local). */
  name: string;
  /** Element type tag (arrays add the `array` marker). */
  field: ArtifactModelFieldType;
  /** Whether omission rejects at creation. */
  required: boolean;
  /** Present and true exactly when the field accepts explicit null. */
  nullable?: boolean;
  /** Whether caller-supplied values are rejected. */
  serverOnly: boolean;
  /** Present exactly for array fields; `required` is the `!` marker. */
  array?: { required: boolean };
  /** Source-declared default, when representable (T18 executes). */
  default?: ArtifactFieldDefault;
  /** Authored description source text, when authored. */
  description?: string;
}

/**
 * T15a one stored model descriptor (JSON shape of L3
 * `CanonicalModelDescriptor` plus additive ownership).
 *
 * `name`/`fields`/`deleteMode`/`uniqueKeys` map to the L3 intake (T16
 * folds the `fields` array into a record by `name` and drops the
 * additive field members): `deleteMode` is `archive` (default),
 * `remove` (declared) or `none` (no enabled delete operation);
 * `uniqueKeys` holds field-level unique names only, in source order
 * (composite uniques moved to the `uniques` member of
 * `appDefinition.models`; A2b shed the comma-joined fold). Additive ownership
 * (`parent` for `Model in Parent` children, `scope: 'app'` for
 * `Model in app`) carries the T28-A containment rule; absent both
 * means team scope (the default). References between models use
 * canonical names, so recursive and mutually recursive models resolve
 * by name without expansion.
 */
export interface ArtifactModel {
  /** Canonical model identity, e.g. `expenses.Expense`. */
  name: string;
  /** Stored then derived fields in source order. */
  fields: ArtifactModelField[];
  /** What a caller-asked remove does. */
  deleteMode: 'archive' | 'remove' | 'none';
  /** Unique keys in source order; absent when the model has none. */
  uniqueKeys?: string[];
  /** Canonical parent model, present exactly for child models. */
  parent?: string;
  /** Present and `'app'` exactly for app-scoped models. */
  scope?: 'app';
}

/**
 * One user-invocable operation descriptor (MCP P1; JSON shape of
 * `OperationDescriptor`). `description` is the verbatim `#` source text
 * (`""` when the operation carries none — generated CRUD operations
 * never inherit captions). `inputs` is the closed typed input schema
 * derived from the operation signature.
 *
 * T18: child-model creates (`models[].parent` set) synthesize one
 * `parent` input beside the flattened fields — an unversioned `ref` to
 * the parent model, caller-required (source mandates `parent=` on
 * child creates). The L3 executor consumes it as record linkage, never
 * as field data. Update/delete carry no parent input (linkage is
 * immutable); root-model creates carry none.
 */
export interface ArtifactOperation {
  /** Inferred single root storage authority for the checked mutation closure. */
  rootAuthority?: { binding: string; model: string; createsRoot?: true };
  /** Canonical operation identity, e.g. `expenses.approve`. */
  name: string;
  kind: ArtifactOperationKind;
  description: string;
  inputs: {
    fields: ArtifactOperationInput[];
  };
  /** Optional declared result; absence leaves legacy result typing unknown. */
  result?: { readonly type: CanTypeId; readonly disclosure?: ScenarioResultDisclosurePlan };
}

/**
 * T34-F6 adopted fanout cohort spellings (mirrors F1
 * `FanoutCohortKind` in `work.ts`): whole-model enumeration or one
 * parent's contained reverse collection. No other spelling is
 * admitted; anything else stays diagnosed (`E4055`), never silently
 * emitted.
 */
export type ArtifactCohortKind = 'model' | 'anchored-collection';

/**
 * T34-F6 one static fanout cohort descriptor, as emitted by the
 * compiler into the entry module's `appDefinition.cohorts` member
 * (keyed by canonical handler identity, omitted when the program
 * declares no checked `each=` cohort).
 *
 * `model` is the canonical enumerated/child model identity; `bind` is
 * the header `as` child binding (`null` when the header omits it);
 * anchored cohorts add the event-rooted dotted `parent` path (e.g.
 * `event.opportunity`). The F7 runtime join resolves the operating
 * owner plus the parent id at trigger time into an F5
 * `FanoutCohortSpec`; the compiler descriptor never carries owner,
 * identity sets, quotas, or cursors (all runtime-owned).
 */
export interface ArtifactCohortDescriptor {
  kind: ArtifactCohortKind;
  /** Canonical enumerated/child model identity, e.g. `volunteer.Signup`. */
  model: string;
  /** Header `as` child binding, `null` when the header omits it. */
  bind: string | null;
  /** Anchored cohorts only: event-rooted dotted parent path. */
  parent?: string;
}

/**
 * One checked committed-model trigger, published identically in the artifact
 * and emitted appDefinition.committedChanges. Identities come from checked
 * declarations, including imported symbols; handlers contains every matching
 * ordinary/cohort handler in declaration order, never a selected subset.
 *
 * Handler identities resolve through ArtifactCallable module/export/member.
 * Their private input admission lives in emitted appDefinition.operations
 * (not CompileArtifact.operations), with optional cohorts in the existing
 * appDefinition.cohorts map. The private required text id maps immutable
 * CommittedChangeEvent.recordId to event.id, including after deletion; required
 * int version uses the existing typed descriptor and canonical wire conversion.
 * Existing artifact sources/modules bind this metadata to its checked source.
 * Runtime app/owner/principal/operation association stays in InvocationContext.
 */
export interface ArtifactCommittedChangeDescriptor {
  /** Canonical trigger identity, e.g. volunteer.Opportunity.updated. */
  source: string;
  /** Canonical declaring model, e.g. volunteer.Opportunity. */
  model: string;
  change: 'create' | 'update' | 'delete';
  /** Complete canonical matching handler identities in declaration order. */
  handlers: string[];
}

/**
 * Separately emitted test artifact for inline behavior examples.
 * Production modules never import from test artifacts; the test runner
 * provisions fixtures and invokes compiled operations through production
 * admission.
 */
export interface ArtifactTestModule {
  /** Attaching scenario/CRUD identity, or file scope for orphans (error). */
  scope: string;
  module: ArtifactModule;
  /** Canonical fixture identities provisioned by this module. */
  fixtures: string[];
}

/**
 * BGI-07 one emitted contributed field: the typed leaf a checked trait
 * instantiation adds. Mirrors Rust `ArtifactGivenField`.
 */
export interface ArtifactGivenField {
  /** Field name. */
  name: string;
  /** Checked type text. */
  type: string;
  /** Checked default constant (source text), when the template carries one. */
  default?: string;
  /** Contributed `trim` normalization. */
  trim: boolean;
  /** Contributed `min=` bound (source text), when given. */
  min?: string;
  /** Contributed `max=` bound (source text), when given. */
  max?: string;
}

/**
 * BGI-07 one emitted trait instantiation: a saved template applied at
 * one target, sharing its definition's saved unit with every sibling.
 * Mirrors Rust `ArtifactGivenTrait`.
 */
export interface ArtifactGivenTrait {
  /** Compiler-owned instantiation identity. */
  id: string;
  /** Owning module. */
  owner: string;
  /** Trait name (absent for inline attachments). */
  trait?: string;
  /** Whether this instance owns a one-off inline attachment. */
  inline: boolean;
  /** Definition anchor (the stable association key). */
  anchor: string;
  /** Saved unit this instance reuses. */
  unitId: string;
  /** Canonical target identity (`Owner.Model[.field]`). */
  target: string;
  /** Instantiated template fields. */
  fields: ArtifactGivenField[];
  /** SHA-256 over the contributions carrier bytes. */
  fingerprint: string;
  /** Source order among the definition's applications. */
  order: number;
  /** Source-derived pure text field check; never supplied authority. */
  validation?: {
    producer: 'state.field-validation@1';
    export: 'check';
    lifecycle: 'validate-fields';
    input: { name: 'value'; type: 'text' };
    result: { type: 'bool' };
    reads: [];
    effects: [];
    authority: [];
    /** SHA-256 over the saved implementation and its consumed imports. */
    fingerprint: string;
  };
}

/**
 * BGI-07 typed input schema of an emitted keyword rule. Mirrors Rust
 * `ArtifactGivenInputSchema`.
 */
export interface ArtifactGivenInputSchema {
  /** Input binding name. */
  name: string;
  /** Checked input type. */
  type: string;
}

/**
 * BGI-07 typed result schema of an emitted keyword rule. Mirrors Rust
 * `ArtifactGivenResultSchema`.
 */
export interface ArtifactGivenResultSchema {
  /** Checked result type (producer-fixed). */
  type: string;
}

/**
 * BGI-07 one emitted keyword-rule argument: references carry canonical
 * identities, constants carry their checked source text. Mirrors Rust
 * `ArtifactGivenKeywordArg`.
 */
export interface ArtifactGivenKeywordArg {
  /** Argument name. */
  name: string;
  /** Resolved value. */
  value: string;
}

/**
 * BGI-07 one emitted keyword rule: a standalone application bound to
 * its saved implementation through the checked owner-producer
 * descriptor. Mirrors Rust `ArtifactGivenKeyword`.
 */
export interface ArtifactGivenKeyword {
  /** Compiler-owned rule identity (`Owner.Model.field#keyword`). */
  ruleId: string;
  /** Owning module. */
  owner: string;
  /** Keyword name (the standalone declaration form). */
  keyword: string;
  /** Definition anchor (the stable association key). */
  anchor: string;
  /** Saved unit this rule reuses. */
  unitId: string;
  /** Bound owner-versioned producer (compiler-known). */
  producer: string;
  /** Fixed producer semantics id (compiler-owned). */
  semantics: string;
  /** Producer lifecycle binding (compiler-owned). */
  lifecycle: string;
  /** Saved export implementing the behavior. */
  export: string;
  /** Typed input schema derived from the bound arguments. */
  input: ArtifactGivenInputSchema;
  /** Typed result schema (producer-fixed). */
  result: ArtifactGivenResultSchema;
  /** Admitted reads (empty for pure producers). */
  reads: string[];
  /** Admitted effects (empty for pure producers). */
  effects: string[];
  /** Admitted authority (empty: canonical owners admit bindings). */
  authority: string[];
  /** Canonical value dependencies (the bound fields). */
  dependencies: string[];
  /** SHA-256 over the saved implementation closure bytes. */
  fingerprint: string;
  /** Canonical target model identity. */
  targetModel: string;
  /** Canonical target field identity. */
  targetField: string;
  /** Resolved arguments. */
  args: ArtifactGivenKeywordArg[];
  /** Source order among the definition's applications. */
  order: number;
}

/**
 * BGI-07 emitted Given contracts: trait instantiations and keyword
 * rules in global source order. The BGI-11/12 join folds this content
 * into `CompileArtifact.givenContracts`.
 */
export interface ArtifactGivenContracts {
  /** Trait instantiations in global source order. */
  traits: ArtifactGivenTrait[];
  /** Keyword rules in global source order. */
  keywords: ArtifactGivenKeyword[];
}

/** Can owner link carried by packed saved-unit entries. */
export interface ArtifactOwnerLink {
  /** Opaque saved unit id (`can.generated/<id>/`). */
  unitId: string;
  /** Saved unit kind (`keyword`, `view`, `style`, ...). */
  kind: string;
  /** Owning `.can` source path. */
  canPath: string;
  /** Owning source revision the unit was bound against. */
  canRevision: string;
  /** Owning definition span start (bytes). */
  start: number;
  /** Owning definition span end (bytes). */
  end: number;
}

/** One compiler-resolved asset referenced by scoped saved CSS. */
export interface ArtifactStyleAsset {
  /** Staged resource key, inside this stylesheet's owning generated unit. */
  path: string;
  /** Exact file bytes encoded as canonical base64. */
  contentBase64: string;
  sha256: string;
  contentType: string;
}

/** One packed scoped stylesheet: the BGI-10 scoped output of a style unit. */
export interface ArtifactStylesheet {
  /** Only assets actually referenced by the checked scoped CSS. */
  assets?: ArtifactStyleAsset[];
  /** Staged artifact path (`can.generated/<id>/style.css`). */
  path: string;
  /** Scoped CSS bytes (the ownership guards). */
  css: string;
  /** SHA-256 over the scoped CSS bytes (lowercase hex). */
  sha256: string;
  /** Owning `.can` intent link. */
  owner: ArtifactOwnerLink;
}

/** Derived checked saved renderer registration; absent mount is browser-inert. */
export interface ArtifactGeneratedView {
  view: string;
  module: string;
  renderExport: "render";
  mountExport?: "mount";
}

/** Root artifact emitted by `can compile` for one program. */
/** Source-declared host resources. Select the app's runtime owner closure before
 * provisioning; merely sharing a source file never selects another app. */
export type ArtifactRuntimeBinding = {
  owner: string;
  name: string;
  /** Canonical logical source binding; implicit R2 uses FILES. */
  binding: string;
} & (
  | { kind: "durable-object"; key: string }
  | { kind: "queue"; type: string; handlers: string[] }
  | { kind: "kv"; ttlMilliseconds: string }
  | { kind: "analytics-engine"; schema: { name: string; type: string }[] }
  | { kind: "service"; from: string; capability: string }
  | { kind: "r2"; implicit: true }
);

export interface CompileArtifact {
  /** Same source inventory as entry appDefinition.runtimeBindings. Omission is legacy. */
  runtimeBindings?: ArtifactRuntimeBinding[];
  artifact_version: typeof ARTIFACT_VERSION;
  language_version: string;
  tool_version: string;
  /** Every source revision consulted, in compilation order. */
  sources: ArtifactSource[];
  /** Production modules; the first entry is the program entrypoint. */
  modules: ArtifactModule[];
  /** Callable registry references (handlers/rules only, no metadata spread). */
  callables: ArtifactCallable[];
  /**
   * User-invocable operation descriptors in source order (MCP P1).
   * Optional for backward compatibility: artifacts compiled before P1
   * have no `operations` key. Every P1 compiler emits it (possibly
   * empty); loaders must treat absence as "no descriptors", never as
   * an error.
   */
  operations?: ArtifactOperation[];
  /**
   * Stored model descriptors in source order (T15a, T04a §3 intake
   * plus additive ownership). Optional for backward compatibility:
   * artifacts compiled before T15a have no `models` key. Every T15a
   * compiler emits it (possibly empty); loaders must treat absence as
   * "no descriptors", never as an error. Together with `operations`
   * (and `artifact_version` 1, the pinned contract version) this is
   * the L3 `ExecutionDescriptorSet` content the T16 join loads: T16
   * folds each model's `fields` array into a record by `name`.
   */
  models?: ArtifactModel[];
  /** Checked source-ordered metadata; native callbacks live separately in each emitted
   * module's canApp().modelPolicyBindings, never in this JSON claim. Omission is legacy. */
  modelPolicies?: CanonicalOwnerModelPolicies[];
  /** Checked complete committed-model routes; omission carries no trigger claim. */
  committedChanges?: ArtifactCommittedChangeDescriptor[];
  /**
   * BGI-07 checked Given contracts in global source order (trait
   * instantiations plus keyword rules). Optional for backward
   * compatibility: artifacts compiled before BGI-07 have no
   * `givenContracts` key; loaders must treat absence as "no
   * descriptors", never as an error.
   */
  givenContracts?: ArtifactGivenContracts;
  /**
   * Packed scoped stylesheets for the style units this build consumes,
   * in staged-path order. Each entry carries the BGI-10 scoped CSS
   * bytes plus its Can owner link, so the deploy host can serve the
   * guards the emitted `data-can-style` hooks select. Optional:
   * loaders must treat absence as "no stylesheets", never as an error.
   */
  stylesheets?: ArtifactStylesheet[];
  /** Checked consumed view modules; omission registers no browser enhancement. */
  generatedViews?: ArtifactGeneratedView[];
  /** Checked source nominal definitions used by field/input/result claims. */
  valueTypes?: CanonicalValueTypes;
  /** Page descriptors in source order. */
  pages: ArtifactPage[];
  /** Linked library/runtime requirements checked at build/activation. */
  requires: ArtifactRequirement[];
  /** Test-only example artifacts, erased from production bundles. */
  tests: ArtifactTestModule[];
}
