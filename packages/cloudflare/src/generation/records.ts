/**
 * Saved generation-unit records (BGI-02): `can.generated/<id>/unit.json`
 * parsing plus saved-group intake for ordinary builds.
 *
 * This mirrors the Rust `analysis::generation_intake` record shapes
 * exactly: opaque ID, source association, kind/target, minimal contract
 * refs, original provenance, `abi_version = 1`. Intake reads only the
 * owning unit's current files; it consults no provider, configuration,
 * or login, and it never launches generation. Missing or incompatible
 * groups return the exact unit plus its generation or reconciliation
 * action instead of regenerating silently.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** ABI version every `unit.json` must carry (frozen v1 record shape). */
export const UNIT_ABI_VERSION = 1;

/** Tracked saved-output root relative to the project root. */
export const GENERATED_DIR = "can.generated";

/** Association record filename inside each unit directory. */
export const UNIT_FILE = "unit.json";

/**
 * Generation-unit kinds that own an ID and a saved output group.
 * Applications and named uses reuse their definition and never appear.
 */
export type UnitKind =
  | "named-trait"
  | "inline-trait"
  | "keyword"
  | "style"
  | "style-inline"
  | "view"
  | "view-style-inline";

const UNIT_KINDS: readonly UnitKind[] = [
  "named-trait",
  "inline-trait",
  "keyword",
  "style",
  "style-inline",
  "view",
  "view-style-inline",
];

export function isUnitKind(value: unknown): value is UnitKind {
  return typeof value === "string" && (UNIT_KINDS as readonly string[]).includes(value);
}

/**
 * Required primary outputs for a kind: unit-relative paths that must
 * exist among current files before saved intake is usable. Mirrors the
 * Rust `UnitKind::required_primary_outputs` exactly: style-family units
 * produce CSS, trait units produce the compiler-visible contributions
 * carrier, keyword and view units produce their saved JS module export.
 * Owned assets and any other historical files are never required: only
 * these declared primaries gate intake, and only by presence, never by
 * hash equality.
 */
export function requiredPrimaryOutputs(kind: UnitKind): readonly string[] {
  switch (kind) {
    case "style":
    case "style-inline":
    case "view-style-inline":
      return ["style.css"];
    case "named-trait":
    case "inline-trait":
      return ["contributions.can"];
    case "keyword":
    case "view":
      return ["implementation.js"];
  }
}

/**
 * Opaque generation-unit identity. Opaque means callers never parse
 * structure out of the text; allocation is sequential `u<N>` (see
 * `association.ts`), and the spelling carries no meaning.
 */
export type GenerationUnitId = string;

/** Reject empty, path-like, or whitespace-bearing unit IDs. */
export function validateUnitId(id: string): void {
  if (id.length === 0) {
    throw new RecordError("id-invalid", "unit id must not be empty");
  }
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    throw new RecordError("id-invalid", `unit id \`${id}\` must not name a path`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(id)) {
    throw new RecordError("id-invalid", `unit id \`${id}\` must not contain whitespace`);
  }
}

export class RecordError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`generation-record: ${detail}`);
    this.name = "RecordError";
    this.code = code;
  }
}

/**
 * Source side of a unit association. Matching uses only owner, kind,
 * label, and anchor; path, revision, and span are bind-time evidence.
 */
export interface LocalRegionCertificate {
  container: string;
  sha256: string;
  count: number;
  occurrence: number;
}

export interface SourceAssociation {
  owner: string;
  kind: UnitKind;
  label: string | null;
  /** Formatting-insensitive non-prompt anchor from discovery. */
  anchor: string;
  /** Workspace-relative source path at bind time. */
  path: string;
  /** Source revision (SHA-256 of the file text) at bind time. */
  revision: string;
  /** Inspected byte span at bind time (evidence, not identity). */
  start: number;
  end: number;
  /** Complete semantic containment and defining slot; absent in legacy records. */
  selector?: string;
  /** Occurrence is usable only inside this exact unchanged normalized region. */
  region?: LocalRegionCertificate;
}

/** Minimal checked contract refs carried beside the association. */
export interface UnitContract {
  /** Declared target (`workerd`, `browser`, CSS, or a row model). */
  target: string | null;
  /** Owning declaration's optional generation profile (`agent=...`). */
  profile: string | null;
  /** SHA-256 of the bound prompt text; prompt freshness evidence. */
  prompt_sha256: string;
  /** Normalized keyword signature for keyword units, else null. */
  signature: string | null;
}

/**
 * Truthful original-generation facts, preserved separately from current
 * edited bytes. Intake compares against these; it never overwrites them.
 */
export interface OriginalOutput {
  /** SHA-256 of the prompt the original output was generated from. */
  prompt_sha256: string;
  /** Original generated bytes per unit-relative path (rel path -> sha256). */
  files: Record<string, string>;
}

export type ProvenanceOrigin = "generated" | "adopted" | "bound";

/** Truthful original provenance for the saved group. */
export interface UnitProvenance {
  origin: ProvenanceOrigin;
  runner: string | null;
  model: string | null;
  note: string | null;
}

/**
 * The `can.generated/<id>/unit.json` record. Field spellings are frozen:
 * `unit.json` is shared byte-shape between the Rust compiler and Node
 * tooling, so both sides use these exact snake_case names.
 */
export interface UnitRecord {
  abi_version: number;
  id: GenerationUnitId;
  source: SourceAssociation;
  contract: UnitContract;
  original: OriginalOutput;
  provenance: UnitProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RecordError("shape-invalid", `unit.json field \`${field}\` must be a string`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, field);
}

function asUint(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RecordError("shape-invalid", `unit.json field \`${field}\` must be a uint`);
  }
  return value;
}

function parseSource(value: unknown): SourceAssociation {
  if (!isRecord(value)) {
    throw new RecordError("shape-invalid", "unit.json `source` must be an object");
  }
  const kind = value["kind"];
  if (!isUnitKind(kind)) {
    throw new RecordError("shape-invalid", "unit.json `source.kind` is not a known unit kind");
  }
  const source: SourceAssociation = {
    owner: asString(value["owner"], "source.owner"),
    kind,
    label: asNullableString(value["label"], "source.label"),
    anchor: asString(value["anchor"], "source.anchor"),
    path: asString(value["path"], "source.path"),
    revision: asString(value["revision"], "source.revision"),
    start: asUint(value["start"], "source.start"),
    end: asUint(value["end"], "source.end"),
    ...(value["selector"] === undefined || value["selector"] === null ? {} : {
      selector: asString(value["selector"], "source.selector"),
    }),
    ...(value["region"] === undefined || value["region"] === null ? {} : {
      region: parseLocalRegion(value["region"]),
    }),
  };
  if (source.region !== undefined && source.selector === undefined) {
    throw new RecordError("shape-invalid", "unit.json `source.region` requires `source.selector`");
  }
  return source;
}

function parseLocalRegion(value: unknown): LocalRegionCertificate {
  if (!isRecord(value)) throw new RecordError("shape-invalid", "unit.json `source.region` must be an object");
  const region = {
    container: asString(value["container"], "source.region.container"),
    sha256: asString(value["sha256"], "source.region.sha256"),
    count: asUint(value["count"], "source.region.count"),
    occurrence: asUint(value["occurrence"], "source.region.occurrence"),
  };
  if (region.container.length === 0 || !/^[0-9a-f]{64}$/.test(region.sha256) || region.count === 0 || region.occurrence >= region.count) {
    throw new RecordError("shape-invalid", "unit.json `source.region` needs a nonempty container, SHA-256 and an occurrence within its nonempty region");
  }
  return region;
}

function parseContract(value: unknown): UnitContract {
  if (!isRecord(value)) {
    throw new RecordError("shape-invalid", "unit.json `contract` must be an object");
  }
  return {
    target: asNullableString(value["target"], "contract.target"),
    profile: asNullableString(value["profile"], "contract.profile"),
    prompt_sha256: asString(value["prompt_sha256"], "contract.prompt_sha256"),
    signature: asNullableString(value["signature"], "contract.signature"),
  };
}

function parseOriginal(value: unknown): OriginalOutput {
  if (!isRecord(value)) {
    throw new RecordError("shape-invalid", "unit.json `original` must be an object");
  }
  const files = value["files"];
  if (!isRecord(files)) {
    throw new RecordError("shape-invalid", "unit.json `original.files` must be an object");
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(files)) {
    out[key] = asString(entry, `original.files[${key}]`);
  }
  return { prompt_sha256: asString(value["prompt_sha256"], "original.prompt_sha256"), files: out };
}

function parseProvenance(value: unknown): UnitProvenance {
  if (!isRecord(value)) {
    throw new RecordError("shape-invalid", "unit.json `provenance` must be an object");
  }
  const origin = value["origin"];
  if (origin !== "generated" && origin !== "adopted" && origin !== "bound") {
    throw new RecordError("shape-invalid", "unit.json `provenance.origin` is not known");
  }
  return {
    origin,
    runner: asNullableString(value["runner"], "provenance.runner"),
    model: asNullableString(value["model"], "provenance.model"),
    note: asNullableString(value["note"], "provenance.note"),
  };
}

/**
 * Parse and validate a `unit.json` document: the ABI version must be
 * exactly `UNIT_ABI_VERSION` and the record ID must match the
 * directory-selected `expected` ID. Throws `RecordError`.
 */
export function parseUnitRecord(text: string, expected: GenerationUnitId): UnitRecord {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RecordError("record-malformed", "unit.json is not valid JSON");
  }
  if (!isRecord(value)) {
    throw new RecordError("record-malformed", "unit.json must be an object");
  }
  const abi = value["abi_version"];
  if (abi !== UNIT_ABI_VERSION) {
    throw new RecordError(
      "abi-mismatch",
      `unit has abi_version ${String(abi)}, want ${UNIT_ABI_VERSION}`,
    );
  }
  const id = asString(value["id"], "id");
  validateUnitId(id);
  if (id !== expected) {
    throw new RecordError(
      "id-mismatch",
      `unit.json id \`${id}\` does not match its directory \`${expected}\``,
    );
  }
  return {
    abi_version: UNIT_ABI_VERSION,
    id,
    source: parseSource(value["source"]),
    contract: parseContract(value["contract"]),
    original: parseOriginal(value["original"]),
    provenance: parseProvenance(value["provenance"]),
  };
}

/** Lowercase hex SHA-256 over exact bytes (no normalization). */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lowercase hex SHA-256 over UTF-8 text. */
export function sha256HexText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One current file of a saved group: live bytes plus their fresh
 * fingerprint, kept distinct from the original fingerprints in `unit.json`.
 */
export interface SavedFile {
  /** Unit-relative path with `/` separators (e.g. `style.css`). */
  relPath: string;
  /** Current bytes, exactly as read (direct edits are build inputs). */
  bytes: Uint8Array;
  /** SHA-256 over the current bytes. */
  sha256: string;
}

/** An intaken saved group: its association record plus current files. */
export interface SavedGroup {
  record: UnitRecord;
  /** Unit directory (`<root>/can.generated/<id>/`). */
  dir: string;
  /** Current files sorted by unit-relative path. */
  files: SavedFile[];
}

/** The generation or reconciliation action a missing/incompatible group needs. */
export type IntakeAction = "generate" | "bind" | "adopt";

/**
 * A saved-group intake failure: the exact unit plus its action.
 * Intake never regenerates, repairs, or consults providers on its own.
 */
export interface IntakeIssue {
  /** Opaque unit ID, or the `owner/kind/label` key when unbound. */
  unit: string;
  action: IntakeAction;
  detail: string;
}

export type IntakeResult = { ok: true; group: SavedGroup } | { ok: false; issue: IntakeIssue };

async function collectCurrentFiles(dir: string, unitDir: string, out: SavedFile[]): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    const path = join(dir, entry);
    // lstat never follows symlinks: a link reads as a link, never as
    // its target.
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const relPath = relative(unitDir, path).split(sep).join("/");
      throw new Error(
        `entry \`${relPath}\` is a symlink; saved groups hold only regular files owned by the unit — reconcile with an explicit bind`,
      );
    }
    if (info.isDirectory()) {
      await collectCurrentFiles(path, unitDir, out);
      continue;
    }
    if (!info.isFile()) {
      continue;
    }
    if (entry === UNIT_FILE && dir === unitDir) {
      continue; // unit.json is parsed, not a current input file.
    }
    const relPath = relative(unitDir, path).split(sep).join("/");
    const bytes = await readFile(path);
    out.push({ relPath, bytes: new Uint8Array(bytes), sha256: sha256HexBytes(bytes) });
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Read one saved group: `unit.json` plus the owning unit's current files.
 * Only the unit's own directory is read (recursively, so owned assets
 * travel with their unit). No provider, configuration, login, or ambient
 * state is consulted. Current bytes return as-is with fresh fingerprints;
 * the original fingerprints in `unit.json` stay untouched for comparison.
 *
 * Intake is exactly the owning unit: symlinks (which could escape to
 * outside bytes) refuse with the affected unit, and the kind's required
 * primary outputs must be present before the group is usable. Fresh
 * preparation groups (a `bound` record with no recorded original outputs)
 * may still be allocated without outputs; direct edits remain current
 * inputs and historical optional assets are never required.
 */
export async function readSavedGroup(
  root: string,
  id: GenerationUnitId,
): Promise<IntakeResult> {
  validateUnitId(id);
  const dir = join(root, GENERATED_DIR, id);
  if (await isSymlink(dir)) {
    return {
      ok: false,
      issue: {
        unit: id,
        action: "bind",
        detail:
          `saved group at ${dir} is a symlink; intake reads only the owning unit's own directory` +
          ` — reconcile with an explicit bind`,
      },
    };
  }
  const recordPath = join(dir, UNIT_FILE);
  if (await isSymlink(recordPath)) {
    return {
      ok: false,
      issue: {
        unit: id,
        action: "bind",
        detail:
          `saved group \`${id}\` record at ${recordPath} is a symlink;` +
          ` intake reads only the owning unit's own files — reconcile with an explicit bind`,
      },
    };
  }
  let text: string;
  try {
    text = await readFile(recordPath, "utf8");
  } catch {
    return {
      ok: false,
      issue: {
        unit: id,
        action: "generate",
        detail: `no saved group at ${recordPath}; prepare generation for the unit`,
      },
    };
  }
  let record: UnitRecord;
  try {
    record = parseUnitRecord(text, id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issue: {
        unit: id,
        action: "bind",
        detail: `saved group is incompatible: ${reason}; reconcile with an explicit bind`,
      },
    };
  }
  const files: SavedFile[] = [];
  try {
    await collectCurrentFiles(dir, dir, files);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issue: {
        unit: id,
        action: "bind",
        detail: `saved group at ${dir} is unreadable: ${reason}`,
      },
    };
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const freshPreparation =
    record.provenance.origin === "bound" && Object.keys(record.original.files).length === 0;
  if (!freshPreparation) {
    const missing = requiredPrimaryOutputs(record.source.kind).filter(
      (wanted) => !files.some((file) => file.relPath === wanted),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        issue: {
          unit: id,
          action: "generate",
          detail:
            `saved group \`${id}\` (${record.source.kind}) is missing required primary output` +
            ` ${missing.map((name) => `\`${name}\``).join(", ")}; prepare generation for the unit`,
        },
      };
    }
  }
  return { ok: true, group: { record, dir, files } };
}
