import { describe, expect, it } from "vitest";
import type {
  FanoutCheckpoint,
  FanoutChildCause,
  FanoutChildId,
  FanoutChildOutcome,
  FanoutCohortDiagnosis,
  FanoutCohortDiagnosisKind,
  FanoutCutoff,
  FanoutFailedReason,
  FanoutIntent,
  FanoutProgress,
  FanoutSkippedReason,
} from "../src/work.js";

// T34-F1 closed-vocabulary shape tests. Pure type/shape level: exact
// keys, identity composition, and diagnosis shapes. Durable rows ride
// F2; dispatch claim/record rides F3; recovery resume rides F4.

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

const PARENT = "occ-source-1";

function childId(handler: string, recordId: string): FanoutChildId {
  return { parentOccurrence: PARENT, handler, recordId };
}

describe("fanout intent (frozen membership + cutoff + source)", () => {
  const cutoff: FanoutCutoff = {
    sourceOccurrence: PARENT,
    handler: "shift.review_commitment",
  };

  it("cutoff carries exactly source occurrence + handler", () => {
    expect(keysOf(cutoff)).toEqual(["handler", "sourceOccurrence"]);
  });

  it("intent carries exactly id + cutoff + cohort + frozen members", () => {
    const intent: FanoutIntent = {
      id: "fanout-1",
      cutoff,
      cohort: "model",
      members: ["c-1", "c-2"],
    };
    expect(keysOf(intent)).toEqual(["cohort", "cutoff", "id", "members"]);
    expect(intent.members).toEqual(["c-1", "c-2"]);
  });

  it("admits both adopted cohort spellings", () => {
    const bare: FanoutIntent = {
      id: "fanout-1",
      cutoff,
      cohort: "model",
      members: [],
    };
    const anchored: FanoutIntent = {
      id: "fanout-2",
      cutoff,
      cohort: "anchored-collection",
      members: [],
    };
    expect(bare.cohort).toBe("model");
    expect(anchored.cohort).toBe("anchored-collection");
  });

  it("carries no quota or capacity field", () => {
    const intent: FanoutIntent = {
      id: "fanout-1",
      cutoff,
      cohort: "model",
      members: [],
    };
    for (const key of keysOf(intent)) {
      expect(key).not.toMatch(/quota|capac|limit|max/i);
    }
  });
});

describe("fanout child identity (parent + handler + record)", () => {
  it("child id carries exactly the three components", () => {
    expect(keysOf(childId("shift.review_commitment", "c-1"))).toEqual([
      "handler",
      "parentOccurrence",
      "recordId",
    ]);
  });

  it("handler component prevents Commitment/Swap collision", () => {
    const commitment = childId("shift.review_commitment", "shared-record");
    const swap = childId("shift.review_swap", "shared-record");
    const key = (c: FanoutChildId) =>
      `${c.parentOccurrence} ${c.handler} ${c.recordId}`;
    expect(key(commitment)).not.toBe(key(swap));
    // Same handler + same record replays the same identity.
    expect(key(commitment)).toBe(
      key(childId("shift.review_commitment", "shared-record")),
    );
  });

  it("parent occurrence scopes the identity", () => {
    const a: FanoutChildId = {
      parentOccurrence: "occ-a",
      handler: "h",
      recordId: "r",
    };
    const b: FanoutChildId = {
      parentOccurrence: "occ-b",
      handler: "h",
      recordId: "r",
    };
    expect(a).not.toEqual(b);
  });
});

describe("fanout checkpoint (completed set + cursor)", () => {
  it("checkpoint carries exactly fanout id + completed + cursor", () => {
    const checkpoint: FanoutCheckpoint = {
      fanoutId: "fanout-1",
      completed: ["c-1"],
      cursor: "c-1",
    };
    expect(keysOf(checkpoint)).toEqual(["completed", "cursor", "fanoutId"]);
  });

  it("null cursor marks fully admitted enumeration only", () => {
    const done: FanoutCheckpoint = {
      fanoutId: "fanout-1",
      completed: ["c-1", "c-2"],
      cursor: null,
    };
    const resumed: FanoutCheckpoint = {
      fanoutId: "fanout-1",
      completed: ["c-1"],
      cursor: "c-1",
    };
    expect(done.cursor).toBeNull();
    expect(resumed.cursor).not.toBeNull();
  });
});

describe("child outcome (terminal state + retry/exhaustion attribution)", () => {
  it("outcome carries exactly child + state + attempts + cause", () => {
    const outcome: FanoutChildOutcome = {
      child: childId("shift.review_commitment", "c-1"),
      state: "completed",
      attempts: 1,
      cause: { kind: "completed" },
    };
    expect(keysOf(outcome)).toEqual(["attempts", "cause", "child", "state"]);
  });

  it("skipped attribution is exactly deleted / non-applicable", () => {
    const reasons: FanoutSkippedReason[] = ["deleted", "non-applicable"];
    expect(reasons).toHaveLength(2);
    const deleted: FanoutChildOutcome = {
      child: childId("h", "c-1"),
      state: "skipped",
      attempts: 1,
      cause: { kind: "skipped", reason: "deleted" },
    };
    expect(keysOf(deleted.cause)).toEqual(["kind", "reason"]);
    expect(deleted.cause).toEqual({ kind: "skipped", reason: "deleted" });
  });

  it("failed attribution keeps all six reasons distinct", () => {
    const reasons: FanoutFailedReason[] = [
      "business-rejection",
      "terminal",
      "exhausted",
      "missing-record",
      "inaccessible-record",
      "infra-read-failure",
    ];
    expect(new Set(reasons).size).toBe(6);
    // Missing vs inaccessible vs infra read failure are three reasons.
    expect(reasons).toContain("missing-record");
    expect(reasons).toContain("inaccessible-record");
    expect(reasons).toContain("infra-read-failure");
  });

  it("exhaustion reuses identity via attempts + cause", () => {
    const outcome: FanoutChildOutcome = {
      child: childId("h", "c-9"),
      state: "failed",
      attempts: 4,
      cause: { kind: "failed", reason: "exhausted" },
    };
    expect(outcome.child).toEqual(childId("h", "c-9"));
    expect(outcome.cause).toEqual({ kind: "failed", reason: "exhausted" });
  });

  it("cause kind matches outcome state in every variant", () => {
    const completed: FanoutChildCause = { kind: "completed" };
    const skipped: FanoutChildCause = { kind: "skipped", reason: "deleted" };
    const failed: FanoutChildCause = {
      kind: "failed",
      reason: "business-rejection",
    };
    expect(keysOf(completed)).toEqual(["kind"]);
    expect(completed.kind).toBe("completed");
    expect(skipped.kind).toBe("skipped");
    expect(failed.kind).toBe("failed");
  });
});

describe("fanout progress (counts + aggregate attention input)", () => {
  it("progress carries exactly counts + terminal + attention", () => {
    const progress: FanoutProgress = {
      fanoutId: "fanout-1",
      pending: 1,
      running: 1,
      completed: 2,
      skipped: 1,
      failed: 1,
      terminal: false,
      attention: false,
    };
    expect(keysOf(progress)).toEqual([
      "attention",
      "completed",
      "failed",
      "fanoutId",
      "pending",
      "running",
      "skipped",
      "terminal",
    ]);
  });

  it("terminal with failures is attention, never success", () => {
    const attention: FanoutProgress = {
      fanoutId: "fanout-1",
      pending: 0,
      running: 0,
      completed: 3,
      skipped: 1,
      failed: 1,
      terminal: true,
      attention: true,
    };
    const clean: FanoutProgress = {
      fanoutId: "fanout-1",
      pending: 0,
      running: 0,
      completed: 4,
      skipped: 1,
      failed: 0,
      terminal: true,
      attention: false,
    };
    expect(attention.terminal && attention.attention).toBe(true);
    expect(clean.terminal && !clean.attention).toBe(true);
  });
});

describe("cohort diagnosis (unsupported / cross-owner / unavailable)", () => {
  it("diagnosis carries exactly kind + code + message", () => {
    const diagnosis: FanoutCohortDiagnosis = {
      kind: "unsupported-cohort",
      code: "E1203",
      message: "unsupported cohort form",
    };
    expect(keysOf(diagnosis)).toEqual(["code", "kind", "message"]);
  });

  it("covers exactly the three M10 diagnosis kinds", () => {
    const kinds: FanoutCohortDiagnosisKind[] = [
      "unsupported-cohort",
      "cross-owner-cohort",
      "membership-unavailable",
    ];
    expect(new Set(kinds).size).toBe(3);
    for (const kind of kinds) {
      const diagnosis: FanoutCohortDiagnosis = {
        kind,
        code: "X",
        message: "m",
      };
      expect(diagnosis.kind).toBe(kind);
    }
  });
});
