/**
 * Hand-built TeamTasks artifact metadata — TEST FIXTURE ONLY.
 *
 * Honesty contract (read before touching):
 * - This is NOT compiler output. `tool_version` says `e2e-fixture/*` and the
 *   assembly label is `fixture/handbuilt/teamtasks`; specs assert the label.
 * - `sources[0].sha256` pins the real `examples/TeamTasks.can` bytes the
 *   fixture mirrors; the loader re-hashes and fails loud on drift. A drift
 *   means the fixture is stale: update the fixture, never the pin alone.
 * - `modules[0]` is the worker source from `./teamtasks-worker.mjs`
 *   (verbatim, via `buildTeamTasksWorkerSource`). The source map is honestly
 *   empty: no `.can` byte-span mapping exists before L1 emission.
 * - `callables`/`tests`/`requires` are all empty: there are no compiled ops,
 *   no example artifacts, and producer linkage is by dist-bundling (see the
 *   loader), not by `requires`. L1 PR6 emission replaces this whole module
 *   for compiled runs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CompileArtifact } from "@canlang/contracts";

export const TEAMTASKS_WORKER_NAME = "e2e-teamtasks";
export const TEAMTASKS_D1_BINDING = "DB";
export const TEAMTASKS_SOURCE_RELATIVE = "examples/TeamTasks.can";
export const TEAMTASKS_SOURCE_SHA256 =
  "a483233beab09a6380e60f94f50795ad290e0a71ef066e9951de2d363c0b66aa";

/**
 * Hand-built D1 schema mirroring the `Todo` record in TeamTasks.can
 * (title/done/assignee + id/version/created bookkeeping). Migrations arrive
 * with L1 emission; until then the seed applies this verbatim.
 */
// Single-line, no trailing semicolon: matches the proven `db.exec` shape in
// testkit/cloudflare fixtures (multi-line input errors as incomplete).
export const TEAMTASKS_D1_SCHEMA =
  "CREATE TABLE IF NOT EXISTS todo (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, assignee TEXT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)";

export function buildTeamTasksWorkerSource(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(dir, "teamtasks-worker.mjs"), "utf8");
}

export function teamTasksArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "handbuilt/0 (no L1 emission; fixture only)",
    tool_version: "e2e-fixture/0.1.0",
    sources: [{ path: TEAMTASKS_SOURCE_RELATIVE, sha256: TEAMTASKS_SOURCE_SHA256 }],
    modules: [
      {
        path: "worker.mjs",
        js: buildTeamTasksWorkerSource(),
        map: {
          version: 3,
          file: "worker.mjs",
          sources: ["fixture/handbuilt/teamtasks"],
          sourcesContent: [null],
          names: [],
          mappings: "",
        },
      },
    ],
    callables: [],
    pages: [{ owner: "teamtasks", path: "/", module: "worker.mjs", export: "default" }],
    requires: [],
    tests: [],
  };
}
