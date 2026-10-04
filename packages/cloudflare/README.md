# @canlang/cloudflare

Lane-07 Cloudflare delivery. Two sides with a hard boundary:

- **Node side** (`@canlang/cloudflare`): local dev runner, deploy-plan
  generation, compatibility checks, install/upgrade orchestration. May use
  Node APIs, Miniflare, and spawned `wrangler`.
- **Worker side** (`@canlang/cloudflare/worker`): Worker entry assembly.
  Must import no Node builtins or Node-only packages; enforced by
  `test/worker-boundary.test.ts`.

`src/build/` (artifact packaging) and `src/upgrade/` (activation/recovery)
land when compiler artifacts and producer inventory contracts exist; the
directories are created with their first real module, not before.
