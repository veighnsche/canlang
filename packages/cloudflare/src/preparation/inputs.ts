/**
 * Admitted-tree encoder (P03.2): parsed JSON artifact trees become
 * ordered tagged nodes for the native core (`input.rs`).
 *
 * - Strings/keys travel as explicit UTF-16 code-unit arrays, so lone
 *   surrogates survive (raw JSON text cannot carry them through UTF-8).
 * - Numbers travel as f64 bits (16 lowercase hex) plus the host
 *   canonical spelling (`JSON.stringify(n)`); bits are authoritative
 *   for identity, spelling for rendering.
 * - Objects travel as ordered `[keyUnits, node]` entry arrays, so
 *   insertion order and own `__proto__` survive.
 * - `undefined`, functions, symbols and bigints are rejected loudly:
 *   the parser domain never produces them.
 *
 * Limits mirror the Rust decoder (`MAX_TREE_DEPTH/NODES/UNITS`) and
 * are enforced before allocation on both sides.
 */

import type { ModuleSyntaxFacts } from "../deploy/bundle.js";

export const MAX_TREE_DEPTH = 32;
export const MAX_TREE_NODES = 1_048_576;
export const MAX_TREE_UNITS = 16_777_216;

export type TaggedNode =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; bits: string; spelling: string }
  | { t: "text"; units: number[] }
  | { t: "arr"; items: TaggedNode[] }
  | { t: "obj"; entries: Array<[number[], TaggedNode]> };

export class TreeEncodeError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`admitted-tree: ${detail}`);
    this.name = "TreeEncodeError";
    this.code = code;
  }
}

const bitsBuffer = new DataView(new ArrayBuffer(8));

function f64Bits(value: number): string {
  bitsBuffer.setFloat64(0, value);
  return bitsBuffer.getBigUint64(0).toString(16).padStart(16, "0");
}

function codeUnits(text: string): number[] {
  const out: number[] = new Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

interface Budget {
  nodes: number;
  units: number;
}

function encodeNode(value: unknown, depth: number, budget: Budget, path: string): TaggedNode {
  if (depth > MAX_TREE_DEPTH) {
    throw new TreeEncodeError("tree-too-deep", `depth ${depth} exceeds ${MAX_TREE_DEPTH} at ${path}`);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_TREE_NODES) {
    throw new TreeEncodeError("tree-too-many-nodes", `nodes exceed ${MAX_TREE_NODES} at ${path}`);
  }
  if (value === null) return { t: "null" };
  switch (typeof value) {
    case "boolean":
      return { t: "bool", v: value };
    case "number": {
      // Canonical host spelling; JSON.stringify(-0) === "0" and
      // JSON.stringify(nonfinite) === "null" — bits keep the truth.
      return { t: "num", bits: f64Bits(value), spelling: JSON.stringify(value) as string };
    }
    case "string": {
      const units = codeUnits(value);
      budget.units += units.length;
      if (budget.units > MAX_TREE_UNITS) {
        throw new TreeEncodeError("tree-too-many-units", `units exceed ${MAX_TREE_UNITS} at ${path}`);
      }
      return { t: "text", units };
    }
    case "object": {
      if (Array.isArray(value)) {
        return {
          t: "arr",
          items: value.map((entry, index) => encodeNode(entry, depth + 1, budget, `${path}[${index}]`)),
        };
      }
      const entries: Array<[number[], TaggedNode]> = [];
      // Own enumerable string keys in host enumeration order; the
      // entry-array form keeps order and own __proto__ intact.
      for (const key of Object.keys(value)) {
        const units = codeUnits(key);
        budget.units += units.length;
        if (budget.units > MAX_TREE_UNITS) {
          throw new TreeEncodeError(
            "tree-too-many-units",
            `units exceed ${MAX_TREE_UNITS} at ${path}.${key}`,
          );
        }
        entries.push([
          units,
          encodeNode((value as Record<string, unknown>)[key], depth + 1, budget, `${path}.${key}`),
        ]);
      }
      return { t: "obj", entries };
    }
    default:
      throw new TreeEncodeError(
        "bad-node",
        `${path} holds ${typeof value}: the parser domain never produces it`,
      );
  }
}

/** Encode one admitted tree; throws `TreeEncodeError` on limits/exotics. */
export function encodeAdmittedTree(value: unknown): TaggedNode {
  return encodeNode(value, 1, { nodes: 0, units: 0 }, "$");
}

/** Encode + serialize to the JSON bytes carried in one frame. */
export function encodeAdmittedTreeJson(value: unknown): string {
  return JSON.stringify(encodeAdmittedTree(value));
}

/** One staged module buffer served to the native LOAD_MODULES stage. */
export interface StagedModuleBuffer {
  readonly key: string;
  readonly js: string;
  /** Owner syntax facts (deploy only; absent on the build path). */
  readonly facts?: ModuleSyntaxFacts | undefined;
}

/**
 * Build the LOAD_MODULES resume payload from actual staged module
 * buffers: `{modules: [{key, js, facts?}]}` as one admitted tree,
 * the exact shape the native `module_buffers` gate decodes (key/js
 * as text, facts as the owner `scanModuleFacts` object when
 * served). The host serves real bundle buffers through this; the
 * native import/graph gates refuse before any bundle assembly
 * materializes. Facts ride the same entries (029: never stripped).
 */
export function buildLoadModulesPayload(modules: ReadonlyArray<StagedModuleBuffer>): {
  readonly modules: TaggedNode;
} {
  return {
    modules: encodeAdmittedTree(
      modules.map((module) =>
        module.facts === undefined ? { key: module.key, js: module.js } : { key: module.key, js: module.js, facts: module.facts },
      ),
    ),
  };
}

/**
 * Build the LOAD_MODULES binary-key closure: `{binaries: [key…]}`
 * as one admitted tree. Binary asset keys (e.g. staged Wasm) join
 * the module keys for link resolution; executables stay excluded.
 * Absent when the bundle stages no binaries.
 */
export function buildBinariesPayload(binaryKeys: ReadonlyArray<string>): {
  readonly binaries: TaggedNode;
} {
  return {
    binaries: encodeAdmittedTree(binaryKeys.map((key) => key)),
  };
}

/**
 * Build the PLAN resume payload from actual deploy plan options:
 * `{options: {...}}` as one admitted tree, the exact shape the
 * native `build_plan` gate decodes (workerName/main/
 * compatibilityDate as text, plus the optional bundle ref). The
 * caller passes the exact oracle options object (no undefined
 * members — the encoder rejects them); binding failures refuse
 * natively as unresolved-binding before any previous-plan demand.
 */
export function buildPlanOptionsPayload(options: {
  readonly workerName: string;
  readonly main: string;
  readonly compatibilityDate: string;
  readonly bundle?: { readonly main: string; readonly moduleCount: number; readonly sha256: string };
}): {
  readonly options: TaggedNode;
} {
  return {
    options: encodeAdmittedTree(options),
  };
}

/**
 * Build the LOAD_PREVIOUS_PLAN resume payload from the already-read
 * previous plan: every present sidecar value rides its admitted
 * tree — including present-parsed null, which rides the tagged
 * `{t:"null"}` tree so the native shape check refuses it as
 * not-a-DeployPlan (never the absent marker). Literal
 * `{previous: null}` is reserved for the actually-absent (ENOENT)
 * sidecar and is produced by the adapter, not here.
 */
export function buildPreviousPlanPayload(previous: unknown): {
  readonly previous: TaggedNode;
} {
  return { previous: encodeAdmittedTree(previous) };
}

/**
 * Build the LOAD_ARTIFACT resume payload from the already-loaded
 * artifact JSON: `{tree}` as one admitted tree, the exact shape the
 * native artifact gate decodes. Reader failures ride
 * `buildLoadErrorPayload` instead (the native side maps them to
 * missing-producer with its own detail voice).
 */
export function buildArtifactPayload(artifact: unknown): {
  readonly tree: TaggedNode;
} {
  return { tree: encodeAdmittedTree(artifact) };
}

/**
 * Build a host reader-failure resume: `{load_error: detail}`. Each
 * native stage maps this to its owning refusal code with the host
 * detail (companions/lockstep) or its own detail voice (artifact).
 */
export function buildLoadErrorPayload(detail: string): {
  readonly load_error: string;
} {
  return { load_error: detail };
}

/**
 * Build the LOAD_COMPANIONS resume payload from the already-loaded
 * companion files: `{descriptor, environment, target}` as three
 * admitted trees, the exact shape the native companions gate
 * decodes.
 */
export function buildCompanionsPayload(
  descriptor: unknown,
  environment: unknown,
  target: unknown,
): {
  readonly descriptor: TaggedNode;
  readonly environment: TaggedNode;
  readonly target: TaggedNode;
} {
  return {
    descriptor: encodeAdmittedTree(descriptor),
    environment: encodeAdmittedTree(environment),
    target: encodeAdmittedTree(target),
  };
}

/**
 * Build the LOCKSTEP_INPUTS resume payload from the already-read
 * release stamp: `{inputs}` as one admitted tree, the exact shape
 * the native `lockstep_inputs` gate decodes (rootVersion,
 * platformVersion, compilerVersion, contractsVersion,
 * packageVersions).
 */
export function buildLockstepPayload(inputs: unknown): {
  readonly inputs: TaggedNode;
} {
  return { inputs: encodeAdmittedTree(inputs) };
}
