import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DeliveryObservableDecl } from "@canlang/contracts";
import {
  T13A_DELIVERY_OBSERVABLES,
  T13B_DELIVERY_OBSERVABLES,
  T26_PROGRESS_RELATIONS,
  WORK_CONTRACT_VERSION,
} from "@canlang/contracts";
import type {
  ProgressTerminalNotification,
  TerminalReceiptStatus,
} from "@canlang/contracts";
import { T26_KNOWN_RELATION_TARGETS } from "../src/observation/association.js";

// T26 progress-relation universe pins. Pure type/shape level: the T26
// universe derives from its matching T13 declarations by reference
// (never recopied strings), and the terminal notification stays
// data-minimized behind leaf authorization. Mechanism proofs ride the
// work package; durable resume rides its D1/DO suites.

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

describe("t26 progress relations derive from T13 declarations", () => {
  it("covers exactly the T13a common plus T13b rich targets in order", () => {
    assert.deepEqual(T26_PROGRESS_RELATIONS.map((decl) => decl.target), [
      ...T13A_DELIVERY_OBSERVABLES.map((decl) => decl.target),
      ...T13B_DELIVERY_OBSERVABLES.map((decl) => decl.target),
    ]);
  });

  it("holds 6 T13a + 10 T13b relations with no duplicates", () => {
    assert.equal(T13A_DELIVERY_OBSERVABLES.length, 6);
    assert.equal(T13B_DELIVERY_OBSERVABLES.length, 10);
    assert.equal(T26_PROGRESS_RELATIONS.length, 16);
    const targets = T26_PROGRESS_RELATIONS.map((decl) => decl.target);
    assert.equal(new Set(targets).size, 16);
  });

  it("shares declaration identity with the T13 tables (no drift)", () => {
    const byTarget = new Map<string, DeliveryObservableDecl>(
      T26_PROGRESS_RELATIONS.map((decl) => [decl.target, decl]),
    );
    for (const decl of [...T13A_DELIVERY_OBSERVABLES, ...T13B_DELIVERY_OBSERVABLES]) {
      assert.equal(byTarget.get(decl.target), decl);
    }
  });

  it("keeps every relation on the closed receipt leaf set at version 1", () => {
    for (const decl of T26_PROGRESS_RELATIONS) {
      assert.equal(decl.version, 1);
      assert.deepEqual([...decl.leaves], ["id", "status", "result", "error"]);
    }
  });

  it("leaves the work contract version untouched", () => {
    assert.equal(WORK_CONTRACT_VERSION, 1);
  });

  it("matches the work kernel's runtime universe in order (no forked correlation)", () => {
    assert.deepEqual([...T26_KNOWN_RELATION_TARGETS],
      T26_PROGRESS_RELATIONS.map((decl) => decl.target),
    );
  });
});

describe("t26 terminal notification shape", () => {
  it("carries exactly relation/deliveryId/revision/status", () => {
    const status: TerminalReceiptStatus = "succeeded";
    const notification: ProgressTerminalNotification = {
      relation: "std.EmailV1.send",
      deliveryId: "del_1",
      revision: 8,
      status,
    };
    assert.deepEqual(keysOf(notification), ["deliveryId", "relation", "revision", "status"]);
  });

  it("admits only the terminal receipt states", () => {
    const terminal: TerminalReceiptStatus[] = ["succeeded", "failed", "skipped"];
    assert.equal(terminal.length, 3);
  });
});
