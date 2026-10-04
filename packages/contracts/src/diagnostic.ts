/**
 * Lane 01-owned diagnostic boundary.
 *
 * Type-only mirror of the Rust `DiagnosticResult` JSON envelope produced by
 * `can check --format=json`, `can lint --format=json`, `can explain`, and the
 * `can lsp` server. Consumers (lane 7 testkit/reporting, editor clients) parse
 * this shape; they never re-derive diagnostics from text output.
 *
 * Compatibility: additive changes only (new optional fields, new codes, new
 * tags). `schema_version` starts at 1; a breaking change requires a version
 * bump plus an explicit handoff to affected consumers.
 */

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

/** Severity of one diagnostic. Only `error` blocks compilation output. */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * Canonical half-open byte range `[start, end)` inside one source.
 * 1-based line/column and LSP positions are always derived from these bytes
 * via the shared line index, never transported separately.
 */
export interface DiagnosticSpan {
  /** Matches a `DiagnosticSource.id` in `DiagnosticResult.sources`. */
  file: number;
  /** Inclusive start byte offset. */
  start: number;
  /** Exclusive end byte offset. */
  end: number;
}

/** Secondary span with its own message, e.g. the shadowed declaration. */
export interface DiagnosticRelated extends DiagnosticSpan {
  message: string;
}

/** One diagnostic: stable code, severity, message and spans. */
export interface Diagnostic {
  /** Stable machine code, e.g. `E1001`. Documented via `can explain CODE`. */
  code: string;
  severity: DiagnosticSeverity;
  /** Concise one-line message. Carries no executable shell commands. */
  message: string;
  /** Primary source range the message is about. */
  primary: DiagnosticSpan;
  related: DiagnosticRelated[];
  /** Documented machine tags, e.g. `unnecessary`. */
  tags: string[];
}

/** Source revision entry: identity of the exact bytes analyzed. */
export interface DiagnosticSource {
  id: number;
  path: string;
  /** Lowercase hex SHA-256 of the analyzed bytes. */
  sha256: string;
}

/**
 * Complete versioned result of one analysis pass.
 * Key order on the wire is fixed (tool first, omitted last) and diagnostics
 * are sorted by (file, start, end, code, message) so output is byte-deterministic.
 */
export interface DiagnosticResult {
  tool: "can";
  tool_version: string;
  language_version: string;
  schema_version: typeof DIAGNOSTIC_SCHEMA_VERSION;
  sources: DiagnosticSource[];
  /**
   * False when analysis was incomplete or cancelled; diagnostics must then
   * never be read as "only these problems exist".
   */
  complete: boolean;
  diagnostics: Diagnostic[];
  /**
   * Diagnostics withheld by an output limit. Always disclosed; nonzero means
   * the output must never suggest a clean file.
   */
  omitted: number;
}

/**
 * Safe code-action fix. Edits apply only when the target file still hashes
 * to `expected_sha256`; stale fixes are rejected and recomputed, never
 * force-applied.
 */
export interface DiagnosticFix {
  id: string;
  title: string;
  kind: string;
  /** True only for meaning-preserving fixes. Grants, guard removal, business
   * defaults, identity changes and destructive migrations are never safe. */
  safe: boolean;
  edits: DiagnosticFixEdit[];
}

export interface DiagnosticFixEdit {
  path: string;
  expected_sha256: string;
  range: DiagnosticSpan;
  new_text: string;
}
