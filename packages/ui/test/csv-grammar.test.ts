import assert from "node:assert/strict";
import { test } from "node:test";
import { CsvGrammarError, parseCsvGrammar } from "../src/csv/grammar.js";
import { parseCsvText } from "../src/csv/parse.js";

// Expected raw records independently pinned from the original scanner.
const accepted: ReadonlyArray<readonly [string, string[][]]> = [
  ["\n", [[""]]],
  ["a\n", [["a"]]],
  ["a\n\n", [["a"], [""]]],
  ["a,b\r\n1,2\n3,4", [["a", "b"], ["1", "2"], ["3", "4"]]],
  ["a\rb,c", [["a\rb", "c"]]],
  ["\uFEFFa,b\n1,2", [["\uFEFFa", "b"], ["1", "2"]]],
  ["a,b\n\"one\r\nmore\",2", [["a", "b"], ["one\r\nmore", "2"]]],
  ["a,b\n1\n1,2,3\n\n", [["a", "b"], ["1"], ["1", "2", "3"], [""]]],
  ["a\n\"\"", [["a"], [""]]],
  ["a,b\n\"a\"\"b\",2", [["a", "b"], ['a"b', "2"]]],
  [" a , b \n x , y ", [[" a ", " b "], [" x ", " y "]]],
  ["a\n😀\n\uFEFFx\n�", [["a"], ["😀"], ["\uFEFFx"], ["�"]]],
];

test("shared grammar preserves original accepted records and advisory results", () => {
  for (const [text, records] of accepted) {
    const header = records[0]!;
    const expected = { header, rows: records.slice(1).map((cells) => ({ cells, malformed: cells.length !== header.length })) };
    assert.deepEqual(parseCsvGrammar(text), expected);
    assert.deepEqual(parseCsvText(text), { ok: true, ...expected });
  }
});

function refusal(text: string, kind: "parse" | "limit", message: string): void {
  assert.throws(() => parseCsvGrammar(text), (error: unknown) => {
    assert.ok(error instanceof CsvGrammarError);
    assert.equal(error.kind, kind);
    assert.equal(error.message, message);
    return true;
  });
  assert.deepEqual(parseCsvText(text), { ok: false, error: { kind, message } });
}

test("original empty/header and unterminated-quote refusals remain safe", () => {
  refusal("", "parse", "CSV text has no header row.");
  refusal('a,b\n"unterminated', "parse", "Unterminated quoted field in CSV text.");
});

test("full row count and parsing-error precedence remain pinned", () => {
  assert.equal(parseCsvGrammar(`a\n${"x\n".repeat(1000)}`).rows.length, 1000);
  refusal(`a\n${"x\n".repeat(1234)}`, "limit", "CSV text has 1234 data rows; the limit is 1000.");
  refusal(`a\n${"x\n".repeat(1001)}"unfinished`, "parse", "Unterminated quoted field in CSV text.");
});

test("deliberate admission correction: malformed quote stripping is rejected", () => {
  for (const text of ['a,b\nx"q",2', 'a,b\n"q"x,2', 'a\n"q" ', 'a\n"q"\r']) {
    refusal(text, "parse", "Malformed quoting in CSV text.");
  }
});

test("deliberate admission correction: unpaired UTF-16 rejects before grammar/limit", () => {
  for (const text of ["a\n\uD800", "a\n\uDFFF", '\uD800\n"unfinished', `a\n${"x\n".repeat(1001)}\uD800`]) {
    refusal(text, "parse", "CSV text contains an unpaired UTF-16 surrogate.");
  }
});

test("programmer misuse still throws instead of becoming advisory content data", () => {
  assert.throws(() => parseCsvText(null as unknown as string), /^Error: parseCsvText needs CSV text$/);
  assert.throws(() => parseCsvGrammar(null as unknown as string), /^Error: parseCsvGrammar needs CSV text$/);
});
