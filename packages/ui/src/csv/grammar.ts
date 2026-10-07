/** Pure shared CSV grammar; callers own advisory/authoritative policy. */
import { CsvError, parse } from "csv-parse/browser/esm/sync";

export const CSV_GRAMMAR_MAX_ROWS = 1000;

/** Content failures carry fixed safe messages, never library/input text. */
export class CsvGrammarError extends Error {
  override name = "CsvGrammarError";

  constructor(readonly kind: "parse" | "limit", message: string) {
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

/**
 * Parse all records before applying the data-row ceiling. Preserve BOM,
 * whitespace, lone CR, blank records, and every accepted raw cell string.
 * Strict quote admission deliberately rejects the former quote stripping.
 */
export function parseCsvGrammar(text: string): CsvGrammarResult {
  if (typeof text !== "string") throw new Error("parseCsvGrammar needs CSV text");
  // Native UTF-8 roundtrip admits scalar strings without a second CSV scanner.
  // ignoreBOM retains the initial BOM instead of silently normalizing source.
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(text)) !== text) {
    throw new CsvGrammarError("parse", "CSV text contains an unpaired UTF-16 surrogate.");
  }

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
    throw new CsvGrammarError("limit", `CSV text has ${String(data.length)} data rows; the limit is ${String(CSV_GRAMMAR_MAX_ROWS)}.`);
  }
  return { header, rows: data.map((cells) => ({ cells, malformed: cells.length !== header.length })) };
}
