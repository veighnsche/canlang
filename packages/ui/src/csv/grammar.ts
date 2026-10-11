/** Pure shared CSV grammar; callers own advisory/authoritative policy. */
import { CsvError, parse } from "csv-parse/browser/esm/sync";

export const CSV_GRAMMAR_MAX_ROWS = 1000;

/** Content failures carry fixed safe messages, never library/input text. */
export class CsvGrammarError extends Error {
  override name = "CsvGrammarError";

  constructor(
    readonly kind: "parse" | "limit", message: string,
    readonly resource?: "rows" | "bytes" | "cells",
  ) {
    super(message);
  }
}

export interface CsvGrammarRow {
  readonly cells: readonly string[];
  readonly malformed: boolean;
}

export interface CsvGrammarResult {
  readonly header: readonly string[];
  readonly rows: ReadonlyArray<CsvGrammarRow>;
}

/** Optional trusted caller budgets; no implicit byte or cell ceiling. */
export interface CsvResourceLimits {
  readonly maxBytes?: number;
  readonly maxCells?: number;
}

function checkCeiling(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`parseCsvGrammar ${name} must be a safe integer >= 0`);
  }
}

/** Count UTF-8 bytes without allocating an encoded copy. */
function checkText(text: string, maxBytes: number | undefined): void {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CsvGrammarError("parse", "CSV text contains an unpaired UTF-16 surrogate.");
      }
      i++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CsvGrammarError("parse", "CSV text contains an unpaired UTF-16 surrogate.");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    // A supplied byte cap intentionally wins before examining the remaining
    // source. Within budget, all Unicode is checked before quote admission.
    if (maxBytes !== undefined && bytes > maxBytes) {
      throw new CsvGrammarError("limit", "CSV text exceeds the byte limit.", "bytes");
    }
  }
}

/** Strict lexical preflight retains no cell strings or record arrays. */
function checkRecords(text: string, maxCells: number | undefined): void {
  let state: "start" | "unquoted" | "quoted" | "afterquote" = "start";
  let records = 0, cells = 0;
  let active = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') i++;
        else state = "afterquote";
      }
      continue;
    }
    const delimiter = char === "\n" || char === "\r" && text[i + 1] === "\n";
    if (delimiter) {
      if (char === "\r") i++;
      records++; cells++;
      state = "start"; active = false;
    } else if (char === ",") {
      cells++; state = "start"; active = true;
    } else if (state === "afterquote" || char === '"' && state !== "start") {
      throw new CsvGrammarError("parse", "Malformed quoting in CSV text.");
    } else {
      active = true;
      state = char === '"' ? "quoted" : "unquoted";
    }
  }
  if (state === "quoted") {
    throw new CsvGrammarError("parse", "Unterminated quoted field in CSV text.");
  }
  if (active) { records++; cells++; }
  if (records === 0) throw new CsvGrammarError("parse", "CSV text has no header row.");
  // Syntax has priority even if malformed text follows an oversized prefix.
  const rows = records - 1;
  if (rows > CSV_GRAMMAR_MAX_ROWS) {
    throw new CsvGrammarError("limit", `CSV text has ${String(rows)} data rows; the limit is ${String(CSV_GRAMMAR_MAX_ROWS)}.`, "rows");
  }
  if (maxCells !== undefined && cells > maxCells) {
    throw new CsvGrammarError("limit", "CSV text exceeds the cell limit.", "cells");
  }
}

/**
 * Preflight complete Unicode and strict CSV syntax before row/cell budgets and
 * materialization. Preserve BOM, whitespace, lone CR, blanks and raw cells.
 */
export function parseCsvGrammar(text: string, limits?: CsvResourceLimits): CsvGrammarResult {
  if (typeof text !== "string") throw new Error("parseCsvGrammar needs CSV text");
  if (limits !== undefined && (limits === null || typeof limits !== "object")) {
    throw new TypeError("parseCsvGrammar limits must be an object");
  }
  const maxBytes = limits?.maxBytes, maxCells = limits?.maxCells;
  checkCeiling(maxBytes, "maxBytes");
  checkCeiling(maxCells, "maxCells");
  checkText(text, maxBytes);
  checkRecords(text, maxCells);

  let records: string[][];
  try {
    records = parse(text, {
      columns: false,
      record_delimiter: ["\r\n", "\n"],
      bom: false,
      relax_column_count: true,
      skip_empty_lines: false,
      skip_records_with_error: false,
      relax_quotes: false,
      trim: false,
      cast: false,
    });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    switch (error.code) {
      case "CSV_QUOTE_NOT_CLOSED":
        throw new CsvGrammarError("parse", "Unterminated quoted field in CSV text.");
      case "INVALID_OPENING_QUOTE":
      case "CSV_INVALID_CLOSING_QUOTE":
        throw new CsvGrammarError("parse", "Malformed quoting in CSV text.");
      default:
        // Configuration/operational failures are programmer errors, not data.
        throw error;
    }
  }
  const header = records[0];
  if (header === undefined) throw new CsvGrammarError("parse", "CSV text has no header row.");
  const data = records.slice(1);
  if (data.length > CSV_GRAMMAR_MAX_ROWS) {
    throw new CsvGrammarError("limit", `CSV text has ${String(data.length)} data rows; the limit is ${String(CSV_GRAMMAR_MAX_ROWS)}.`, "rows");
  }
  return { header, rows: data.map((cells) => ({ cells, malformed: cells.length !== header.length })) };
}
