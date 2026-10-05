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
 * - `operations[]` IS present (the one exception to "no compiled ops"): the
 *   two ops the fixture worker serves over `/mcp`, in the exact P1
 *   `ArtifactOperation` shape, consumed by the REAL P2 adapters
 *   (`createArtifactRegistry`/`createArtifactCatalog`) inside the worker.
 *   The loader also stamps these entries into the `vendor/mcp/fixture-ops.js`
 *   module so the worker and the artifact JSON share one source of truth.
 *
 * Shape parity vs real P1 output (MCP closeout P4 closed both earlier
 * skews: generated CRUD op descriptions now inherit the crud `label=`
 * caption when authored, and a `package.Model.read` op (no inputs) is
 * emitted wherever `policy Model read=` exists). Remaining fixture-only
 * choices, honestly labeled:
 * - The create description here ("Add team work.", from the serving card
 *   `card "Add team work"` TeamTasks.can:23) is fuller than P1's inherited
 *   caption (`label={create=add}` → "Add"). The spec requires non-empty;
 *   both satisfy it.
 * - P1 also emits update/delete ops (uncaptioned `""` here); the fixture
 *   serves only the two ops the spec exercises (never claimed complete).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ArtifactOperation, CompileArtifact } from "@canlang/contracts";

export const TEAMTASKS_WORKER_NAME = "e2e-teamtasks";
export const TEAMTASKS_D1_BINDING = "DB";
export const TEAMTASKS_SOURCE_RELATIVE = "examples/TeamTasks.can";
// Slice-23 drift analysis (2026-10-05 closeout): the source gained
// breadcrumbs, form input/textarea children, text-for-badge rows,
// tooltip/pagination/empty-states and collapse-for-details — Then/UI
// vocabulary only; Given/When byte-identical, so the Todo D1 schema
// and the worker's rendered contract (headings, list content with
// Done/Open + assignee, title form, seed, login) are unaffected and
// every spec assertion still mirrors the source. Worker verified
// current; pin re-based to the replanned bytes.
export const TEAMTASKS_SOURCE_SHA256 =
  "78020054ba06d0282047d4c400487ea1da070e7ebdb624637f0ff1802683f3d0";

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

/**
 * The fixture's served `/mcp` ops in the exact P1 `ArtifactOperation` shape
 * (see the header for the documented skews vs real P1 output). `create`
 * inputs flatten the `crud Todo ... fields=title,done,assignee` allowlist
 * per the P1 rules (title required: no default, non-nullable; done/assignee
 * optional: default/nullable); scalar mapping is P1-verbatim
 * (text/member -> string, bool -> boolean).
 */
export const TEAMTASKS_OPERATIONS: ArtifactOperation[] = [
  {
    name: "TeamTasks.Todo.create",
    kind: "create",
    description: "Add team work.",
    inputs: {
      fields: [
        { name: "title", field: { kind: "string" }, required: true },
        { name: "done", field: { kind: "boolean" }, required: false },
        { name: "assignee", field: { kind: "string" }, required: false },
      ],
    },
  },
  {
    name: "TeamTasks.Todo.read",
    kind: "read",
    description: "Tasks and completion.",
    inputs: { fields: [] },
  },
];

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
    operations: TEAMTASKS_OPERATIONS.map((op) => ({
      ...op,
      inputs: { fields: op.inputs.fields.map((field) => ({ ...field })) },
    })),
    pages: [{ owner: "teamtasks", path: "/", module: "worker.mjs", export: "default" }],
    requires: [],
    tests: [],
  };
}
