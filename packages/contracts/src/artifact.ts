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
}

/**
 * One closed typed input field of an operation descriptor (MCP P1).
 *
 * JSON shape of `McpSchemaField` (`@canlang/interfaces` ports.ts),
 * redeclared here so this lane-01 boundary stays dependency-free. The
 * two shapes must stay JSON-identical: `ref` carries the canonical
 * model plus the version requirement; `enum` carries case spellings in
 * declaration order; every other kind is a bare tag.
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
  | { kind: 'enum'; values: string[] };

/** One named operation input (JSON shape of `McpNamedField`). */
export interface ArtifactOperationInput {
  /** Input name (parameter or flattened model field). */
  name: string;
  field: ArtifactOperationField;
  /** Whether the caller must supply the member. */
  required: boolean;
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
 * One user-invocable operation descriptor (MCP P1; JSON shape of
 * `OperationDescriptor`). `description` is the verbatim `#` source text
 * (`""` when the operation carries none — generated CRUD operations
 * never inherit captions). `inputs` is the closed typed input schema
 * derived from the operation signature.
 */
export interface ArtifactOperation {
  /** Canonical operation identity, e.g. `expenses.approve`. */
  name: string;
  kind: ArtifactOperationKind;
  description: string;
  inputs: {
    fields: ArtifactOperationInput[];
  };
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
  /** Page descriptors in source order. */
  pages: ArtifactPage[];
  /** Linked library/runtime requirements checked at build/activation. */
  requires: ArtifactRequirement[];
  /** Test-only example artifacts, erased from production bundles. */
  tests: ArtifactTestModule[];
}
