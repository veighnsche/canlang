/**
 * Executor input-hash fence: the admission fast path must not skip the raw
 * hash check.
 *
 * `assertScenarioReceiptExecution` memoizes a passing deep scope check per
 * admitted call so same-reference observations skip the re-walk. The raw
 * input hash is a mutable string property outside the frozen scope, so the
 * fast path must still identity-check it on every assertion: an executor
 * that changes, deletes or replaces `call.inputHash` after the witness is
 * established must hit the full check and its exact forbidden error, never
 * a silent pass. The tamper must also roll back atomically (exactly the
 * rejected receipt commits, nothing else) and replay deterministically.
 *
 * Genuine end to end through the real `invoke()`: real admission of an
 * interim operation, a real tampering executor, real fencing, real rollback
 * and real replay. No mocks, no new API.
 */
import { describe, expect, it } from "vitest";
import type { OperationId, OperationName } from "@canlang/contracts";
import { invoke, assertScenarioReceiptExecution } from "@canlang/state/invocation/invoke";
import type { InterimOperationDef } from "@canlang/state/invocation/registry";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
import {
  createMemoryIdentityStore,
  seedMember,
  makeIdentity,
  uuidv7,
  FIXED_NOW,
} from "@canlang/state/testing/invocation/fixtures";

const def: InterimOperationDef = { name: "test.tamper" as OperationName, kind: "scenario", by: "public", inputs: {} };
const operationId = (sequence: number): OperationId => uuidv7(FIXED_NOW, sequence) as OperationId;
const registry = new Map([["test.tamper", def]]);
const memberships = createMemoryIdentityStore();
const emptyEffects = () => ({
  writes: [],
  history: [],
  outbox: [],
  schedules: [],
  uniqueClaims: [],
  uniqueReleases: [],
  resolvedDefaults: {},
  result: null,
});

async function setup() {
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const { store } = createTestMemoryStorage();
  const base = {
    registry,
    identity,
    app: "test",
    source: "test",
    store,
    memberships,
    clock: { nowMs: () => FIXED_NOW },
    kind: "trusted" as const,
    trustedSource: "test",
  };
  return { base, store };
}

describe("executor input-hash fence", () => {
  it("commits and replays an honest executor (control)", async () => {
    const { base, store } = await setup();
    const cleanId = operationId(1);
    const clean = await invoke({
      ...base,
      envelope: { operation: "test.tamper", operation_id: cleanId, inputs: {} },
      execute: async () => emptyEffects(),
    });
    expect(clean.status).toBe("committed");
    const revision = await store.readRevision();
    const replayed = await invoke({
      ...base,
      envelope: { operation: "test.tamper", operation_id: cleanId, inputs: {} },
      execute: async () => emptyEffects(),
    });
    expect(replayed.status).toBe("replayed");
    expect(await store.readRevision()).toBe(revision);
  });

  it("leaves caller-owned nested inputs writable after an interim invoke", async () => {
    const { base, store } = await setup();
    const callerInputs: Record<string, unknown> = {};
    const callerId = operationId(3);
    const clean = await invoke({
      ...base,
      envelope: { operation: "test.tamper", operation_id: callerId, inputs: callerInputs },
      execute: async () => emptyEffects(),
    });
    expect(clean.status).toBe("committed");
    // The engine observes privately owned immutable admission data: the
    // caller's own object must accept later nested writes without throwing.
    callerInputs.note = { text: "x" };
    (callerInputs.note as { text: string }).text = "y";
    expect(callerInputs).toMatchObject({ note: { text: "y" } });
    expect(await store.readRevision()).toBeGreaterThan(0);
  });

  it("forbids a post-witness inputHash change with atomic rollback and deterministic replay", async () => {
    const { base, store } = await setup();
    const revisionBefore = await store.readRevision();
    const tamperId = operationId(2);
    let tamperRan = false;
    const tampered = await invoke({
      ...base,
      envelope: { operation: "test.tamper", operation_id: tamperId, inputs: {} },
      execute: async (call) => {
        assertScenarioReceiptExecution(call, store);
        (call as { inputHash: string }).inputHash = "tampered-hash";
        tamperRan = true;
        assertScenarioReceiptExecution(call, store);
        return emptyEffects();
      },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: { code: (error as { code: string }).code, message: (error as { message: string }).message } }),
    );
    expect(tamperRan).toBe(true);
    expect(tampered).toMatchObject({
      error: {
        code: "forbidden",
        message: "Scenario observation requires unchanged admitted scope, checkpoint, inputs, references and raw hash.",
      },
    });
    // Atomic rollback: exactly the rejected receipt commits, nothing else.
    const revisionAfterReject = await store.readRevision();
    expect(revisionAfterReject).toBe(revisionBefore + 1);

    // Deterministic replay: the same refusal, no new commit, stable revision.
    const replayed = await invoke({
      ...base,
      envelope: { operation: "test.tamper", operation_id: tamperId, inputs: {} },
      execute: async () => emptyEffects(),
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: { code: (error as { code: string }).code, message: (error as { message: string }).message } }),
    );
    expect(replayed).toMatchObject({
      error: {
        code: "forbidden",
        message: "Scenario observation requires unchanged admitted scope, checkpoint, inputs, references and raw hash.",
      },
    });
    expect(await store.readRevision()).toBe(revisionAfterReject);
  });
});
