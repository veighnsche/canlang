import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const emitted = path.basename(path.dirname(import.meta.dirname)) === "dist";
const packageRoot = path.resolve(import.meta.dirname, emitted ? "../.." : "..");
const fixturePath = path.resolve(packageRoot, "conformance/string-escape.json");
const oraclePath = path.resolve(packageRoot, "conformance/string-escape.oracle.mjs");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  contract: string;
  engine: { execPath: string };
  source: { frozenSha256: string };
  strings: { id: string; inputUnits: number[]; quotedUnits: number[]; actualWireUnits: number[]; rustStrAdmitted: boolean; helperParityAdmitted: boolean; actualWireParityAdmitted: boolean; excludedReason: string | null }[];
  callers: { id: string; observation: unknown }[];
  controls: { id: string; rowId: string; expectedQuotedUnits?: number[]; expectedActualWireUnits?: number[]; mutant: number[] }[];
  routeSummary: { strings: number; rustStrAdmitted: number; helperParityAdmitted: number; actualWireParityAdmitted: number; astralCutResidual: string[]; jsOnlyUnpaired: string[]; callerActualWireResiduals: string[] };
};

test("frozen corpus and source-current owning TypeScript caller observations reproduce", { timeout: 30_000 }, () => {
  assert.equal(fixture.contract, "n01.rust-str-escape.v1");
  assert.equal(fixture.strings.length, 93);
  assert.deepEqual(fixture.routeSummary, {
    strings: 93, rustStrAdmitted: 89, helperParityAdmitted: 89, actualWireParityAdmitted: 88,
    astralCutResidual: ["astral-cut:62"], jsOnlyUnpaired: ["lone-high", "lone-low", "reversed-pair", "unpaired-middle"], callerActualWireResiduals: ["decode-long-currency-wire"],
  });
  const tmp = mkdtempSync(path.join(os.tmpdir(), "can-n04-string-oracle-"));
  try {
    const regenerated = path.join(tmp, "captured.json");
    execFileSync(process.env.CAN_N04_NODE ?? "node", [oraclePath, path.join(tmp, "staged"), regenerated], { stdio: "pipe" });
    const actual = JSON.parse(readFileSync(regenerated, "utf8")) as typeof fixture & { engine: unknown };
    const semantic = (value: typeof fixture & { engine?: unknown }) => {
      const { engine: _engine, ...observations } = value;
      return observations;
    };
    assert.deepEqual(semantic(actual), semantic(fixture), "fixture differs from actual original-source capture");
    for (const control of fixture.controls) {
      const corrupted = structuredClone(fixture);
      const row = corrupted.strings.find(item => item.id === control.rowId)!;
      if (control.expectedActualWireUnits) row.actualWireUnits = control.mutant;
      else row.quotedUnits = control.mutant;
      assert.throws(
        () => assert.deepEqual(semantic(actual), semantic(corrupted), "fixture differs from actual original-source capture"),
        /fixture differs from actual original-source capture/,
        `${control.id} corruption must fail original-source fixture conformance`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deliberate escaping and truncation mutations differ from builtin expectations", () => {
  for (const control of fixture.controls) {
    const expected = control.expectedQuotedUnits ?? control.expectedActualWireUnits;
    assert.ok(expected, `${control.id} has an expected unit sequence`);
    assert.notDeepEqual(control.mutant, expected, `${control.id} mutation must be detected`);
  }
  const astral = fixture.strings.find(row => row.id === "astral-cut:62")!;
  assert.equal(astral.helperParityAdmitted, true);
  assert.equal(astral.actualWireParityAdmitted, false);
  assert.equal(astral.excludedReason, "64-unit-surrogate-split");
  assert.deepEqual(astral.inputUnits, [...Array(62).fill(0x61), 0xd83d, 0xde00]);
});
