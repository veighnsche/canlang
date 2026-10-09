import { describe, expect, it } from "vitest";
import type { DiagnosticResult, ExampleReport, ResolvedCaller } from "@canlang/contracts";
import {
  projectBusinessRefusal,
  projectCompilerFailure,
  projectExampleFailure,
  type FailureContext,
} from "../src/dev/failure-occurrence.js";

const context: FailureContext = {
  session: "s7", revision: "r18", sourceRevision: `sha256:${"a".repeat(64)}`,
  sourcePaths: ["app.can"],
};
const runtime: FailureContext = { ...context, servingBuild: "b2" };
const caller: ResolvedCaller = { account: "member", team: "current", roles: ["member"], authenticated: true };

it("preserves exact compiler span and bounds source-authorized detail", () => {
  const result: DiagnosticResult = {
    tool: "can", tool_version: "0.1", language_version: "1.0", schema_version: 1,
    sources: [{ id: 0, path: "app.can", sha256: "b".repeat(64) }], complete: true, omitted: 0,
    diagnostics: [{
      code: "E1200", severity: "error", message: "expected a declaration\n", tags: [], related: [],
      primary: { file: 0, start: 8, end: 14 },
    }],
  };
  const projected = projectCompilerFailure({ context, result, index: 0, captureComplete: true, sourceReadable: true });
  expect(projected.occurrence.ref).toBe("s7/r18/d0");
  expect(projected.occurrence.at).toEqual({ kind: "exact_span", path: "app.can", sha256: "b".repeat(64), start: 8, end: 14 });
  expect(projected.detail["message"]).toBe("expected a declaration");
  const withheld = projectCompilerFailure({ context, result, index: 0, captureComplete: false, sourceReadable: false });
  expect(withheld.detail).not.toHaveProperty("message");
  expect(withheld.occurrence.evidence.missing).toContain("source_closure_unverified");
});

it("does not turn freeform example detail into a trace or disclose values without actor policy", () => {
  const report: ExampleReport = {
    contractsVersion: 1, examplesVersion: 1,
    artifact: { digest: "artifact-1", sourceRevision: "artifact-source-1" },
    startedAt: "now", finishedAt: "later",
    cases: [{ kind: "table", operation: "Office.edit", rows: [{
      rowIndex: 0, caller, outcome: "failed", detail: "secret token 123456",
      mismatches: [{ observation: "row.name", expected: "Secret", actual: "Wrong" }],
    }] }],
    summary: { total: 1, passed: 0, failed: 1, setupFailed: 0, unsupported: 0 },
  };
  const input = {
    context: runtime, report, artifactSourceRevision: "artifact-source-1",
    runId: "run3", caseIndex: 0, entryIndex: 0,
  };
  const withheld = projectExampleFailure(input);
  expect(withheld.occurrence.at).toBeUndefined();
  expect(withheld.occurrence.evidence.missing).toContain("structured_example_location_unavailable");
  expect(JSON.stringify(withheld)).not.toContain("secret token");
  expect(JSON.stringify(withheld)).not.toContain("Secret");
  expect(withheld.occurrence).not.toHaveProperty("trace");
  expect(withheld.occurrence).not.toHaveProperty("root_cause");
  const permitted = projectExampleFailure({
    ...input, mapped: { source: "app.can", line: 9, column: 3 },
    access: { viewer: caller, projectMismatch: (mismatch) => ({ ...mismatch, expected: "[redacted]", actual: "[redacted]" }) },
  });
  expect(permitted.occurrence.at).toEqual({ kind: "mapped_point", path: "app.can", line: 9, column: 3 });
  expect(permitted.detail["mismatches"]).toEqual([{ observation: "row.name", expected: "[redacted]", actual: "[redacted]" }]);
  expect(permitted.occurrence.at).not.toHaveProperty("start");
  const foreignMap = projectExampleFailure({ ...input, mapped: { source: "other.can", line: 1, column: 2 } });
  expect(foreignMap.occurrence.at).toBeUndefined();
});

it("uses canonical business code message and withholds raw conflict/current values", () => {
  const projection = projectBusinessRefusal({
    context: runtime, requestId: "request4", phase: "admission", status: 403,
    error: { code: "forbidden", message: "secret bearer token" },
  });
  expect(projection.occurrence.code).toBe("forbidden");
  expect(projection.occurrence.owner_ref).toEqual({ request_id: "request4", status: 403 });
  expect(JSON.stringify(projection)).not.toContain("secret bearer token");
  expect(projection.occurrence.evidence.missing).toContain("trace_unavailable");
  expect(() => projectBusinessRefusal({
    context, requestId: "request4", phase: "admission", status: 403,
    error: { code: "forbidden", message: "no" },
  })).toThrow(/serving build/);
});
