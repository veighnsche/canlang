/** Exact, portable example recipe. No serving resource or actor is retained here. */
import { createHash } from "node:crypto";
import type { CompiledExampleInput, CompiledExampleResult } from "./example-runner.js";
import { projectExampleFailure, type FailureContext } from "./failure-occurrence.js";
import { runtimeObject, runtimeString } from "./runtime-host-protocol.js";
export type RuntimeExampleRecipe = Omit<CompiledExampleInput, "testkit" | "signal" | "selectedRow" | "runId">;
export function serializeExampleRecipe(input: RuntimeExampleRecipe): unknown {
  return { ...input, artifactBytes: Buffer.from(input.artifactBytes).toString("base64"),
    worker: { ...input.worker, binaryModules: Object.fromEntries(Object.entries(input.worker.binaryModules ?? {})
      .map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")])) } };
}
function bytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 32 * 1024 * 1024) throw new Error("invalid recipe bytes");
  const encoded = value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("invalid recipe bytes");
  return Buffer.from(encoded, "base64");
}
function moduleMap(value: unknown): Record<string, string> {
  const modules = runtimeObject(value);
  if (Object.keys(modules).length > 32000) throw new Error("example recipe module limit");
  for (const [name, source] of Object.entries(modules)) {
    runtimeString(name);
    if (typeof source !== "string") throw new Error("invalid recipe module");
  }
  return modules as Record<string, string>;
}
export function parseExampleRecipe(value: unknown): RuntimeExampleRecipe {
  const input = runtimeObject(value), worker = runtimeObject(input.worker);
  return { artifactBytes: bytes(input.artifactBytes), artifactLabel: runtimeString(input.artifactLabel),
    sourceRevision: runtimeString(input.sourceRevision), workerName: runtimeString(input.workerName),
    compatibilityDate: runtimeString(input.compatibilityDate), d1Binding: runtimeString(input.d1Binding),
    worker: { mainModule: runtimeString(worker.mainModule), modules: moduleMap(worker.modules),
      binaryModules: Object.fromEntries(Object.entries(runtimeObject(worker.binaryModules)).map(([name, value]) => [name, bytes(value)])) } };
}
export function exampleProjections(context: FailureContext, runId: string, result: CompiledExampleResult) {
  const projections = [];
  for (const [caseIndex, example] of result.report.cases.entries()) {
    const entries = example.kind === "table" ? example.rows : example.steps;
    for (const [entryIndex, entry] of entries.entries()) {
      if (entry.outcome !== "passed") projections.push(projectExampleFailure({ context, report: result.report,
        artifactSourceRevision: context.sourceRevision, runId, caseIndex, entryIndex }));
    }
  }
  return projections;
}
export function exampleArtifactDigest(input: RuntimeExampleRecipe): string {
  return createHash("sha256").update(input.artifactBytes).digest("hex");
}
