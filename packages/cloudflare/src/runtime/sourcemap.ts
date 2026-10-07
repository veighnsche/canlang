/**
 * B3 I2 source-mapped diagnostics: V3 `mappings` decode + lookup.
 *
 * Pure, workerd-safe, with sourcemap-codec for VLQ numeric decoding.
 * Preserves Can's raw-map compatibility around the Rust encoder/decoder
 * (`compiler/src/codegen/sourcemap.rs`) and consumes the `SourceMap`
 * contract from `@canlang/contracts` artifact.ts (validated structurally:
 * `version: 3`, `file`, `sources`, `sourcesContent`, `names`, `mappings`).
 *
 * Conventions (matching the Rust side):
 * - `mappings` lines are `;`-separated, one per emitted line; segments are
 *   `,`-separated base64 VLQ fields. Decoder accepts the 1-, 4- and 5-field
 *   forms the Rust decoder accepts; anything else throws.
 * - Decoded source positions are 0-based; `lookup` returns 1-based
 *   `.can` line/column for diagnostics.
 * - `lookup` takes a 0-based generated column (spec convention); callers
 *   holding V8's 1-based columns subtract one first.
 */

import type { SourceMap } from "@canlang/contracts";
import { decode } from "@jridgewell/sourcemap-codec";

/** One decoded mappings segment (0-based source position). */
export interface DecodedSegment {
  /** 0-based generated column. */
  readonly genCol: number;
  /** Source index, present on 4- and 5-field segments. */
  readonly src?: number;
  /** 0-based source line, present on 4- and 5-field segments. */
  readonly srcLine?: number;
  /** 0-based source column, present on 4- and 5-field segments. */
  readonly srcCol?: number;
  /** Name index, present on 5-field segments. */
  readonly name?: number;
}

/** Decoded segments for one generated line, preserving encoded source order. */
export type DecodedLine = readonly DecodedSegment[];

/** 1-based `.can` position a generated frame maps to. */
export interface MappedPosition {
  readonly source: string;
  /** 1-based source line. */
  readonly line: number;
  /** 1-based source column. */
  readonly column: number;
  readonly name?: string;
}

function fail(detail: string): never {
  throw new Error(`sourcemap: ${detail}`);
}

/** Decode one segment into its signed VLQ fields. */
function decodeSegment(segment: string): number[] {
  if (segment === "") fail("empty segment");
  const invalid = /[^A-Za-z0-9+/]/.exec(segment);
  if (invalid) fail(`bad VLQ character ${JSON.stringify(invalid[0])}`);
  if (/[g-z0-9+/]$/.test(segment)) fail("truncated VLQ value");
  const count = (segment.match(/[A-Za-f]/g) ?? []).length;
  if (count !== 1 && count !== 4 && count !== 5) fail(`bad segment field count ${count}`);
  // Isolated segments keep source order despite the codec's whole-line sorting.
  // The codec shares Can's modulo-32 accumulation but shifts magnitudes unsigned.
  // Restore signed arithmetic shifts; its INT32_MIN sentinel represents signed zero.
  return decode(segment)[0]![0]!.map((value) =>
    value === -2147483648 ? 0 : value < 0 ? -((-value << 1) >> 1) : (value << 1) >> 1,
  );
}

/**
 * Decode VLQ `mappings` into per-line segments. Throws a loud `sourcemap:`
 * error on malformed input (bad characters, truncated values, bad field
 * counts). Preserves legacy 32-bit numeric semantics and accepts unsorted
 * or negative coordinates. An empty string decodes to no lines.
 */
export function decodeMappings(mappings: string): DecodedLine[] {
  if (mappings === "") return [];
  const lines: DecodedSegment[][] = [];
  let prevSrc = 0;
  let prevLine = 0;
  let prevCol = 0;
  let prevName = 0;
  for (const line of mappings.split(";")) {
    const segments: DecodedSegment[] = [];
    let genCol = 0;
    if (line !== "") {
      for (const segment of line.split(",")) {
        const fields = decodeSegment(segment);
        if (fields.length === 0 || fields.length === 2 || fields.length === 3 || fields.length > 5) {
          fail(`bad segment field count ${fields.length}`);
        }
        const genDelta = fields[0];
        if (genDelta === undefined) fail("bad segment field count 0");
        genCol += genDelta;
        if (fields.length >= 4) {
          const srcDelta = fields[1];
          const lineDelta = fields[2];
          const colDelta = fields[3];
          if (srcDelta === undefined || lineDelta === undefined || colDelta === undefined) {
            fail("bad segment field count");
          }
          prevSrc += srcDelta;
          prevLine += lineDelta;
          prevCol += colDelta;
          const src = prevSrc;
          const srcLine = prevLine;
          const srcCol = prevCol;
          if (fields.length === 5) {
            const nameDelta = fields[4];
            if (nameDelta === undefined) fail("bad segment field count");
            prevName += nameDelta;
            segments.push({ genCol, src, srcLine, srcCol, name: prevName });
          } else {
            segments.push({ genCol, src, srcLine, srcCol });
          }
        } else {
          segments.push({ genCol });
        }
      }
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * Map a 1-based generated line + 0-based generated column through `map`.
 * Returns the 1-based `.can` position, or `null` for unknown frames
 * (out-of-range lines, lines without segments, unmapped 1-field segments,
 * source indexes outside `sources`). Invalid optional names are omitted.
 * Throws on malformed `mappings` (fail loud via `decodeMappings`); missing
 * or wrong-type mappings retain native type failures after query validation.
 */
export function lookup(map: SourceMap, genLine: number, genCol: number): MappedPosition | null {
  if (!Number.isInteger(genLine) || genLine < 1) return null;
  if (!Number.isInteger(genCol) || genCol < 0) return null;
  const lines = decodeMappings(map.mappings);
  const segments = lines[genLine - 1];
  if (segments === undefined || segments.length === 0) return null;
  let best: DecodedSegment | null = null;
  for (const segment of segments) {
    if (segment.genCol > genCol) break;
    best = segment;
  }
  if (best === null) return null;
  const { src, srcLine, srcCol } = best;
  if (src === undefined || srcLine === undefined || srcCol === undefined) return null;
  if (!Array.isArray(map.sources)) return null;
  const source = map.sources[src];
  if (typeof source !== "string") return null;
  const position: { source: string; line: number; column: number; name?: string } = {
    source,
    line: srcLine + 1,
    column: srcCol + 1,
  };
  if (best.name !== undefined && Array.isArray(map.names)) {
    const name = map.names[best.name];
    if (typeof name === "string") position.name = name;
  }
  return position;
}
