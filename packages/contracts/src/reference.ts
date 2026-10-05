/**
 * Internal declaration reference model v1 (D04a, frozen).
 *
 * Versioned contract between the Rust reference extractor (D04b) and the
 * localized Markdown renderer (D05a). JSON-safe: the `can docs` boundary
 * passes this model through stdin to the TypeScript renderer.
 *
 * The model carries checked description values (source text, owning source
 * language, ordered locale variants, source location) plus declaration
 * facts already located by analysis: owners, models/contracts with fields,
 * user operations with inputs/results/row examples, authored examples
 * with canonical labels, source links, resolved constraints and explicit
 * implementation availability.
 *
 * Absence is distinct from empty text throughout: an absent description is
 * an omitted property, while an empty source or variant string is authored
 * empty text. A `null` variant is an absent translation, never empty text.
 * Descriptions carry no parameters.
 *
 * Explicitly OUT of v1: inferred caller authorization, invented example
 * execution results, policies/guards/effects/routes inventories, and any
 * translation quota. Implementation availability is `unknown` unless a
 * verified owner/catalog supplies it.
 */
export const REFERENCE_MODEL_VERSION = 1;

/** Project-relative source span of one owning declaration. */
export interface ReferenceSourceLocation {
  /** Project-relative source path (portable output keeps this relative). */
  readonly sourceId: string;
  /** Zero-based start offset in the source file. */
  readonly start: number;
  /** Zero-based end offset in the source file. */
  readonly end: number;
}

/** One ordered locale variant of a checked description. */
export interface ReferenceDescriptionVariant {
  /** BCP 47 tag as authored (canonicalized at render time). */
  readonly tag: string;
  /** `null` = absent translation; `""` = authored empty text. */
  readonly text: string | null;
}

/**
 * Checked description value: source prose plus owning source language,
 * ordered variants and the owning declaration location. No parameters;
 * static message references resolve to wording before this value is built.
 */
export interface ReferenceDescriptionValue {
  readonly source: string;
  readonly sourceLang: string;
  readonly variants: readonly ReferenceDescriptionVariant[];
  readonly location: ReferenceSourceLocation;
}

/** One resolved value constraint on a field or operation input. */
export interface ReferenceConstraint {
  /** Constraint kind as located by analysis (e.g. `min`, `max`, `one-of`). */
  readonly kind: string;
  /** Human-readable constraint detail; rendered verbatim (escaped). */
  readonly detail: string;
}

/** One model/contract field with creation metadata kept separate from type. */
export interface ReferenceField {
  readonly name: string;
  /** Declared/resolved type spelling; never localized. */
  readonly type: string;
  readonly nullable: boolean;
  /** Creation requiredness (distinct from value nullability). */
  readonly creationRequired: boolean;
  /** Default value spelling, when the declaration supplies one. */
  readonly default?: string;
  readonly constraints: readonly ReferenceConstraint[];
  readonly description?: ReferenceDescriptionValue;
}

/** One user-operation input parameter. */
export interface ReferenceOperationInput {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly creationRequired: boolean;
  readonly default?: string;
  readonly constraints: readonly ReferenceConstraint[];
  readonly description?: ReferenceDescriptionValue;
}

/** Declared result of one user operation. */
export interface ReferenceOperationResult {
  readonly type: string;
  readonly nullable: boolean;
  readonly description?: ReferenceDescriptionValue;
}

/** One user operation: callable surface only, no inferred authorization. */
export interface ReferenceOperation {
  /** Canonical operation ID; never localized. */
  readonly id: string;
  readonly description?: ReferenceDescriptionValue;
  readonly inputs: readonly ReferenceOperationInput[];
  readonly result: ReferenceOperationResult;
  /**
   * Operation-owned authored examples: one entry per data row of every
   * table-form `examples` block attached to this operation, in source
   * order (`source` = authored input cells, `expected` = authored
   * expectation). Rendered labeled as authored examples; v1 carries NO
   * execution status. Optional for forward compatibility: payloads
   * extracted before the R4 join omit this key and render as before.
   */
  readonly examples?: readonly ReferenceExample[];
  readonly location: ReferenceSourceLocation;
}

/**
 * One source example with its expected result. Rendered labeled as an
 * authored example; v1 carries NO execution status (generation never runs
 * examples or invents passed/failed state).
 */
export interface ReferenceExample {
  /** Canonical example label from source. */
  readonly label: string;
  /** Example source text from the owning declaration. */
  readonly source: string;
  /** Expected result text, when the source states one. */
  readonly expected?: string;
}

/** One model or contract declaration with its fields and examples. */
export interface ReferenceDeclaration {
  readonly owner: string;
  readonly name: string;
  readonly kind: "model" | "contract";
  readonly description?: ReferenceDescriptionValue;
  readonly fields: readonly ReferenceField[];
  readonly examples: readonly ReferenceExample[];
  readonly location: ReferenceSourceLocation;
}

/** One canonical owner with its declarations and user operations. */
export interface ReferenceOwner {
  readonly name: string;
  readonly declarations: readonly ReferenceDeclaration[];
  readonly operations: readonly ReferenceOperation[];
}

/**
 * Implementation availability: `unknown` unless a verified owner/catalog
 * supplies a fact. Passing analysis never implies availability.
 */
export type ReferenceAvailability =
  | { readonly status: "unknown" }
  | { readonly status: "available"; readonly owner: string; readonly catalog: string };

/** Frozen reference model v1 root. */
export interface ReferenceModel {
  readonly version: typeof REFERENCE_MODEL_VERSION;
  /** Source revision the reference was extracted from. */
  readonly sourceRevision: string;
  /** Catalog version, or null when no catalog contributed. */
  readonly catalogVersion: string | null;
  /** Language/compiler version identity. */
  readonly languageVersion: string;
  /** App default locale (BCP 47); render fallback route. */
  readonly appDefaultLocale: string;
  readonly owners: readonly ReferenceOwner[];
  readonly availability: ReferenceAvailability;
}
