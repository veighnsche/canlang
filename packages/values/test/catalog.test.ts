import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, LANE02_CATALOG_VERSION } from "../src/catalog.js";
import { VALUES_CONTRACT_VERSION } from "../../contracts/src/values.js";

/** The closed DESIGN §3 builtin names (L215), as an independent oracle. */
const EXPECTED_BUILTINS = [
  "count", "sum", "min", "max", "any", "all", "first", "group", "flatten",
  "at", "abs", "round", "lower", "upper", "trim", "contains", "starts_with",
  "join", "format", "app_url", "active_member", "overlaps", "local_date",
  "local_instant", "add_days", "add_months", "date_year", "weekday", "dates",
  "money", "date", "datetime", "action", "random_secret",
];

/** The DESIGN §13 lowering helpers (L992), as an independent oracle. */
const EXPECTED_HELPERS = [
  "addMoney", "subtractMoney", "multiplyMoney", "compareMoney", "equalMoney",
  "negateMoney", "divideDecimal", "durationBetween", "compareInstant",
  "compareDate", "compareDecimal", "addDuration", "subtractDuration", "same",
  "equalValue", "int64",
];

describe("builtin catalog", () => {
  it("carries the draft envelope version over language 1.0", () => {
    assert.equal(CATALOG.catalog_version, LANE02_CATALOG_VERSION);
    assert.equal(CATALOG.language_version, "1.0");
    assert.ok(CATALOG.features.length > 0);
  });

  it("tracks the owned contract version", () => {
    assert.equal(VALUES_CONTRACT_VERSION, 1);
  });

  it("lists exactly the closed builtin names", () => {
    const builtins = CATALOG.entries.filter((entry) => entry.kind === "builtin");
    assert.deepEqual(
      builtins.map((entry) => entry.id).sort(),
      [...EXPECTED_BUILTINS].sort(),
    );
  });

  it("lists exactly the §13 helpers and no banned spellings", () => {
    const helpers = CATALOG.entries.filter((entry) => entry.kind === "helper");
    assert.deepEqual(
      helpers.map((entry) => entry.id).sort(),
      [...EXPECTED_HELPERS].sort(),
    );
    for (const entry of CATALOG.entries) {
      assert.ok(!entry.js.startsWith("money_"), entry.js);
      assert.ok(!["moneySub", "moneyLTE", "addInstant"].includes(entry.js), entry.js);
    }
  });

  it("keeps builtin JS names verbatim and entries well-formed", () => {
    for (const entry of CATALOG.entries) {
      if (entry.kind === "builtin") assert.equal(entry.js, entry.id);
      assert.ok(entry.signature.length > 0);
      assert.ok(["pure", "server-default-only", "state-read"].includes(entry.effects));
      assert.ok(["planned", "implemented", "external"].includes(entry.availability));
      assert.ok(entry.owner.length > 0);
    }
  });

  it("keeps the codegen equalValue shape with leading context", () => {
    const byId = new Map(CATALOG.entries.map((entry) => [entry.id, entry]));
    const signature = byId.get("equalValue")?.signature ?? "";
    assert.ok(signature.startsWith("equalValue(c:"), signature);
  });

  it("marks non-pure builtins external with their owner", () => {
    const byId = new Map(CATALOG.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("random_secret")?.availability, "external");
    assert.equal(byId.get("random_secret")?.owner, "lane-03");
    assert.equal(byId.get("random_secret")?.effects, "server-default-only");
    assert.equal(byId.get("active_member")?.availability, "external");
    assert.equal(byId.get("active_member")?.owner, "lane-03");
    assert.equal(byId.get("active_member")?.effects, "state-read");
  });
});
