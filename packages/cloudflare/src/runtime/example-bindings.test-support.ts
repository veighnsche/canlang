/** Test-only resource harness. Production selection and lifecycle are exercised by native examples.rs. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Log, LogLevel, Miniflare } from "miniflare";
import type { ExampleCaseResult } from "@canlang/contracts";
import { buildExampleReport, loadExampleBindings, type ExampleBindingInput, type ExampleTestkitPort } from "./example-bindings.js";
export { loadInstalledExampleTestkit, MissingExampleTestkitError, type ExampleRuntimeHooks, type ExampleRowScope } from "./example-bindings.js";
export interface CompiledExampleInput extends Omit<ExampleBindingInput, "applicationRoot" | "workDir"> {
  testkit: ExampleTestkitPort;
  workerName: string;
  compatibilityDate: string;
  d1Binding: string;
  worker: { mainModule: string; modules: Readonly<Record<string,string>>; binaryModules?: Readonly<Record<string,Uint8Array>> };
  selectedRow?: { operation: string; rowIndex: number };
  runId?: string;
}
export async function runCompiledExamples(input: CompiledExampleInput) {
  const artifact = JSON.parse(Buffer.from(input.artifactBytes).toString("utf8"));
  const cases: ExampleCaseResult[] = [];
  for (const [moduleIndex,test] of artifact.tests.entries()) {
    if (input.selectedRow !== undefined && input.selectedRow.operation !== test.scope) continue;
    const workDir = await mkdtemp(join(tmpdir(), "can-testkit-bindings-"));
    try {
      const suite = await loadExampleBindings({ ...input, applicationRoot: process.cwd(), workDir }, moduleIndex);
      const rows = [];
      for (const row of suite.metadata.rows) {
        if (input.selectedRow !== undefined && input.selectedRow.rowIndex !== row.rowIndex) continue;
        const d1Id=randomUUID(), currentStateId=randomUUID(), otherStateId=randomUUID();
        const dev = new Miniflare({ cf:false, host:"127.0.0.1", port:0, log:new Log(LogLevel.ERROR),
          name: input.workerName, compatibilityDate: input.compatibilityDate,
          modules: Object.entries(input.worker.modules).map(([path,contents])=>({path,type:"ESModule" as const,contents})),
          d1Databases: { [input.d1Binding]:d1Id, CAN_EXAMPLE_STATE_CURRENT:currentStateId, CAN_EXAMPLE_STATE_OTHER:otherStateId },
        });
        try {
          await dev.ready;
          const result=await suite.row(row.rowIndex, dev, { d1Id,currentStateId,otherStateId,d1Binding:input.d1Binding });
          rows.push(...result.rows);
        } finally { await dev.dispose(); }
      }
      if (rows.length) cases.push({kind:"table",operation:test.scope,rows});
    } finally { await rm(workDir, {recursive:true,force:true}); }
  }
  const digest=createHash("sha256").update(input.artifactBytes).digest("hex");
  const report=await buildExampleReport(process.cwd(),digest,input.sourceRevision,cases);
  return {ok:report.summary.failed===0 && report.summary.setupFailed===0 && report.summary.unsupported===0,
    executed:report.summary.total,report};
}
