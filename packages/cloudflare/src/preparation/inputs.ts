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
