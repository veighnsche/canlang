import type { FieldMachine } from "./state.js";
import type { CanTypeId } from "./values.js";

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
}

/**
 * One T13c nominal result leaf, verbatim.
 *
 * `type` is the T13c transcribed kind spelling (`text?`, `file[]`,
 * `enum(a,b)`, nominal refs) — never a re-interpretation. T04b
 * ratifies any structured leaf vocabulary; verbatim leaves derive it
 * without loss.
 */
export interface ArtifactNominalLeaf {
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
  | { kind: 'boolean' }
  | { kind: 'file' }
  | { kind: 'enum'; values: string[] }
  | ArtifactDeliveryDescriptor;

/** One named operation input (JSON shape of `McpNamedField`). */
export interface ArtifactOperationInput {
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
  /**
   * Source-declared default, when representable as `literal`/`parent`
   * (T15a additive, mirrors L3 `CanonicalInputDef.default`). Absent
   * for computed defaults (the emitted `default(c)` callable preserves
   * execution; T04b grows the vocabulary) and for update changes
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
 * `server`/`derived` mark engine-resolved values (T18 execution) and
 * exclude the field from writable inputs. T18 adds the optional `init`
 * payload on `server` (see `ArtifactServerInit`); L3 intake readers keep
 * ignoring extra members and only kinds reject.
 */
export type ArtifactFieldDefault =
  | { kind: 'literal'; value: unknown }
  | { kind: 'parent'; path: string }
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
  | ArtifactDeliveryDescriptor
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
  /** Canonical operation identity, e.g. `expenses.approve`. */
  name: string;
  kind: ArtifactOperationKind;
  description: string;
  inputs: {
    fields: ArtifactOperationInput[];
  };
  /** Optional declared result; absence leaves legacy result typing unknown. */
  result?: { readonly type: CanTypeId };
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

/** Root artifact emitted by `can compile` for one program. */
export interface CompileArtifact {
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
  /** Page descriptors in source order. */
  pages: ArtifactPage[];
  /** Linked library/runtime requirements checked at build/activation. */
  requires: ArtifactRequirement[];
  /** Test-only example artifacts, erased from production bundles. */
  tests: ArtifactTestModule[];
}
