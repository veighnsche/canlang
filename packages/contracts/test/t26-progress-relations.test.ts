import { describe, expect, it } from "vitest";
import type { DeliveryObservableDecl } from "../src/work.js";
import {
  T13A_DELIVERY_OBSERVABLES,
  T13B_DELIVERY_OBSERVABLES,
  T26_PROGRESS_RELATIONS,
  WORK_CONTRACT_VERSION,
} from "../src/work.js";
import type {
  ProgressTerminalNotification,
  TerminalReceiptStatus,
} from "../src/work.js";
import { T26_KNOWN_RELATION_TARGETS } from "../../work/src/observation/association.ts";

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
    expect(T26_PROGRESS_RELATIONS.map((decl) => decl.target)).toEqual([
      ...T13A_DELIVERY_OBSERVABLES.map((decl) => decl.target),
      ...T13B_DELIVERY_OBSERVABLES.map((decl) => decl.target),
    ]);
  });

  it("holds 6 T13a + 10 T13b relations with no duplicates", () => {
    expect(T13A_DELIVERY_OBSERVABLES).toHaveLength(6);
    expect(T13B_DELIVERY_OBSERVABLES).toHaveLength(10);
    expect(T26_PROGRESS_RELATIONS).toHaveLength(16);
    const targets = T26_PROGRESS_RELATIONS.map((decl) => decl.target);
    expect(new Set(targets).size).toBe(16);
  });

  it("shares declaration identity with the T13 tables (no drift)", () => {
    const byTarget = new Map<string, DeliveryObservableDecl>(
      T26_PROGRESS_RELATIONS.map((decl) => [decl.target, decl]),
    );
    for (const decl of [...T13A_DELIVERY_OBSERVABLES, ...T13B_DELIVERY_OBSERVABLES]) {
      expect(byTarget.get(decl.target)).toBe(decl);
    }
  });

  it("keeps every relation on the closed receipt leaf set at version 1", () => {
    for (const decl of T26_PROGRESS_RELATIONS) {
      expect(decl.version).toBe(1);
      expect([...decl.leaves]).toEqual(["id", "status", "result", "error"]);
    }
  });

  it("leaves the work contract version untouched", () => {
    expect(WORK_CONTRACT_VERSION).toBe(1);
  });

  it("matches the work kernel's runtime universe in order (no forked correlation)", () => {
    expect([...T26_KNOWN_RELATION_TARGETS]).toEqual(
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
    expect(keysOf(notification)).toEqual(["deliveryId", "relation", "revision", "status"]);
  });

  it("admits only the terminal receipt states", () => {
    const terminal: TerminalReceiptStatus[] = ["succeeded", "failed", "skipped"];
    expect(terminal).toHaveLength(3);
  });
});
