/**
 * P-C adapter evaluation-order pinning (extraction follow-ups).
 *
 * Guards must run before the reads they gate: an invalid binding must never
 * touch capability/operation reads, and a retained intent must be read once.
 * Happy-path suites do not cover these orders.
 */
import { describe, expect, it } from "vitest";
import { createBoundImagesAdapter } from "../src/runtime/bound-images.js";
import { createBoundTextGenerationAdapter } from "../src/runtime/bound-text-generation.js";
import type { OperationId, OperationName, OutboxIntent } from "@canlang/contracts";

function imagesAdapter(accesses: string[]) {
  return createBoundImagesAdapter({
    appDefinition: {
      id: "app",
      bindings: {},
      get capabilities(): unknown {
        accesses.push("capabilities");
        return {};
      },
    },
    binding: {
      capability: "std.ImagesV1",
      capabilityVersion: 1,
      deployment: "dep",
      account: "acct",
    },
    resolveInstalledImages: () => {
      throw new Error("must not resolve with an invalid binding");
    },
    finalizeOutput: () => {
      throw new Error("must not finalize with an invalid binding");
    },
  });
}

function textAdapter(accesses: string[]) {
  return createBoundTextGenerationAdapter({
    appDefinition: {
      id: "app",
      bindings: {},
      get capabilities(): unknown {
        accesses.push("capabilities");
        return {};
      },
    },
    binding: {
      capability: "std.TextGenerationV1",
      capabilityVersion: 1,
      deployment: "dep",
      account: "acct",
    },
    resolveInstalledTextGeneration: () => {
      throw new Error("must not resolve with an invalid binding");
    },
  });
}

function submitIntent(target: string): OutboxIntent {
  return {
    intentId: "i1",
    operation: "op" as OperationName,
    operationId: "oid" as OperationId,
    target,
    occurrenceIndex: 0,
    arguments: { binding: "missing", from: "dep", arguments: {} },
  };
}

describe("adapter binding-gate order", () => {
  it("images submit rejects an unknown binding without reading capabilities", () => {
    const accesses: string[] = [];
    expect(imagesAdapter(accesses).available(submitIntent("std.ImagesV1.submit"))).toBe(false);
    expect(accesses).toEqual([]);
  });

  it("text submit rejects an unknown binding without reading capabilities", () => {
    const accesses: string[] = [];
    expect(textAdapter(accesses).available(submitIntent("std.TextGenerationV1.generate"))).toBe(false);
    expect(accesses).toEqual([]);
  });
});

type AdapterKind = "images" | "text";

function mutatingResultFixture(kind: AdapterKind) {
  const accesses: string[] = [];
  let contractsState: unknown = { ImageRun: { fields: {} }, TextRun: { fields: {} } };
  const capabilityName = kind === "images" ? "std.ImagesV1" : "std.TextGenerationV1";
  const operationName = kind === "images" ? "submit" : "generate";
  const resultType = kind === "images" ? "ImageRun" : "TextRun";
  const operation = {
    inputs: {},
    get result(): unknown {
      accesses.push("result");
      contractsState = {};
      return { type: resultType };
    },
  };
  const appDefinition = {
    id: "app",
    bindings: { b1: { capability: capabilityName, from: "dep" } },
    get capabilities(): unknown {
      accesses.push("capabilities");
      return { [capabilityName]: { version: 1, operations: { [operationName]: operation } } };
    },
    get contracts(): unknown {
      accesses.push("contracts");
      return contractsState;
    },
    enums: {},
  };
  return { accesses, appDefinition };
}

function versionMismatchFixture(kind: AdapterKind) {
  const accesses: string[] = [];
  const capabilityName = kind === "images" ? "std.ImagesV1" : "std.TextGenerationV1";
  const operationName = kind === "images" ? "submit" : "generate";
  const operation = {
    inputs: {},
    get result(): unknown {
      accesses.push("result");
      throw new Error("result must not be read when the version mismatches");
    },
  };
  const appDefinition = {
    id: "app",
    bindings: { b1: { capability: capabilityName, from: "dep" } },
    get capabilities(): unknown {
      accesses.push("capabilities");
      return { [capabilityName]: { version: 2, operations: { [operationName]: operation } } };
    },
    get contracts(): unknown {
      accesses.push("contracts");
      return {};
    },
    enums: {},
  };
  return { accesses, appDefinition };
}

function boundIntent(kind: AdapterKind): OutboxIntent {
  const target = kind === "images" ? "std.ImagesV1.submit" : "std.TextGenerationV1.generate";
  return {
    ...submitIntent(target),
    arguments: { binding: "b1", from: "dep", arguments: {} },
  };
}

describe("adapter result-guard order", () => {
  it("images submit reads result before contracts and rejects the invalidated descriptor", () => {
    const { accesses, appDefinition } = mutatingResultFixture("images");
    const adapter = createBoundImagesAdapter({
      appDefinition,
      binding: { capability: "std.ImagesV1", capabilityVersion: 1, deployment: "dep", account: "acct" },
      resolveInstalledImages: () => {
        throw new Error("must not resolve past an invalidated descriptor");
      },
      finalizeOutput: () => {
        throw new Error("must not finalize a rejected submit");
      },
    });
    expect(adapter.available(boundIntent("images"))).toBe(false);
    expect(accesses).toEqual(["capabilities", "result", "contracts"]);
  });

  it("text submit reads result before contracts and rejects the invalidated descriptor", () => {
    const { accesses, appDefinition } = mutatingResultFixture("text");
    const adapter = createBoundTextGenerationAdapter({
      appDefinition,
      binding: { capability: "std.TextGenerationV1", capabilityVersion: 1, deployment: "dep", account: "acct" },
      resolveInstalledTextGeneration: () => {
        throw new Error("must not resolve past an invalidated descriptor");
      },
    });
    expect(adapter.available(boundIntent("text"))).toBe(false);
    expect(accesses).toEqual(["capabilities", "result", "contracts"]);
  });

  it("images submit short-circuits a version mismatch without reading result", () => {
    const { accesses, appDefinition } = versionMismatchFixture("images");
    const adapter = createBoundImagesAdapter({
      appDefinition,
      binding: { capability: "std.ImagesV1", capabilityVersion: 1, deployment: "dep", account: "acct" },
      resolveInstalledImages: () => {
        throw new Error("must not resolve past a version mismatch");
      },
      finalizeOutput: () => {
        throw new Error("must not finalize a rejected submit");
      },
    });
    expect(adapter.available(boundIntent("images"))).toBe(false);
    expect(accesses).not.toContain("result");
  });

  it("text submit short-circuits a version mismatch without reading result", () => {
    const { accesses, appDefinition } = versionMismatchFixture("text");
    const adapter = createBoundTextGenerationAdapter({
      appDefinition,
      binding: { capability: "std.TextGenerationV1", capabilityVersion: 1, deployment: "dep", account: "acct" },
      resolveInstalledTextGeneration: () => {
        throw new Error("must not resolve past a version mismatch");
      },
    });
    expect(adapter.available(boundIntent("text"))).toBe(false);
    expect(accesses).not.toContain("result");
  });
});
