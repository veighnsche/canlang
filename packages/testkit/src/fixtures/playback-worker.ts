/**
 * Workerd entry for scenario-table playback (L7 S8d-playback): serves
 * caller-loaded tables through one fetch handler, routed by
 * `<scenario>.<provider>.playback` hostnames.
 *
 * Tables arrive per test via `POST /__playback/load` (`{tables: [...]}`,
 * validated fail-fast, state reset); requests before the first load
 * fail LOUD (every seed unknown). Per-test loading is the isolation
 * mechanism: one worker serves the whole B2 run, one table set per
 * test. The B2 runner loads L4's `SCENARIO_TABLES` (or a subset)
 * from outside the worker — this entry imports nothing from
 * services source, since `@canlang/services` has no build and
 * TS-source imports break emits (see `playback.ts` header).
 *
 * Fixture semantics: the handler (and all per-seed mail/media state)
 * lives at module scope, so it persists per isolate until the next
 * load. Tests needing strict isolation load exactly their tables.
 */

import {
  createPlaybackHandler,
  type PlaybackHandler,
  type PlaybackScenarioTable,
} from "./playback.js";

let handler: PlaybackHandler = createPlaybackHandler([]);

function loadResponse(req: Request): Promise<Response> {
  return req
    .json()
    .then((body: unknown) => {
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { tables?: unknown }).tables)
      ) {
        return Response.json(
          { error: "playback: load body must be {tables: [...]}." },
          { status: 500 },
        );
      }
      const tables = (body as { tables: PlaybackScenarioTable[] }).tables;
      handler = createPlaybackHandler(tables);
      return Response.json({ loaded: tables.length });
    })
    .catch((error: unknown) =>
      Response.json(
        {
          error: `playback: load rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        { status: 500 },
      ),
    );
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/__playback/load") {
      return loadResponse(req);
    }
    return handler.fetch(req);
  },
};
