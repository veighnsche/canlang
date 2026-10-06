/**
 * Live ExampleHooks binding for pilot journeys (HELD — no callers until
 * the pilot go-ahead with released C1/E2b slice commits). Composes the
 * pure harness wiring (`createExampleHooks`) with real producer I/O:
 *
 * - dispatch via cloudflare `buildInvoker` (dist-loaded at live runs);
 * - live reads via an injected reader (state read ports);
 * - caller/operation/input mappings injected per owning slice:
 *   `resolveIdentity` (identity verification), `qualifyOperation`
 *   (T15b artifact FQ names), `wrapRecordRefs` (T15a descriptor
 *   MutationRef wrapping).
 *
 * Nothing here executes without dists: dist modules load through
 * variable-path dynamic imports (keeps the e2e tsc gate clean
 * pre-build; fails loud naming the build at live runs when absent).
 */
import { join } from "node:path";
import type { OperationId, StoragePort } from "@canlang/contracts";
import type { OperationInvoker } from "../../../packages/cloudflare/src/worker/assembly.js";
import type { ResolvedIdentity } from "../../../packages/contracts/src/identity.js";
import type { CompileArtifact } from "../../../packages/contracts/src/artifact.js";
import type { AssembledModules } from "../../../packages/cloudflare/src/runtime/modules.js";
import {
  createExampleHooks,
  type DispatchFn,
  type LiveReadFn,
} from "../../../packages/testkit/src/runner/dispatch.js";
import type { ExampleHooks } from "../../../packages/testkit/src/runner/steps.js";
import { freshOperationId } from "./compiled-seed.js";

async function loadDistModule<T>(repoRoot: string, distRelative: string, buildCommand: string): Promise<T> {
  // Variable path: tsc yields `any` (no TS2307 pre-build); live runs fail
  // loud with the exact build when the dist is absent.
  const path = join(repoRoot, distRelative);
  try {
    return (await import(path)) as T;
  } catch (thrown) {
    throw new Error(`example-hooks: ${distRelative} not built; run \`${buildCommand}\` first`, {
      cause: thrown,
    });
  }
}

export interface LiveHookMappers {
  /** Verified identity for one dispatch caller value (identity slice). */
  readonly resolveIdentity: (caller: unknown) => Promise<ResolvedIdentity>;
  /** Fully-qualified operation name (T15b artifact join). */
  readonly qualifyOperation: (operation: string) => string;
  /** Wrap record-typed inputs as MutationRefs (T15a descriptors). */
  readonly wrapRecordRefs: (
    operation: string,
    inputs: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Live value per fixture name (state read ports). */
  readonly readLive: LiveReadFn;
}

export interface LiveHookInputs extends LiveHookMappers {
  readonly repoRoot: string;
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly store: StoragePort;
}

type BuildInvokerFn = (
  artifact: CompileArtifact,
  asm: AssembledModules,
  store: StoragePort,
  opts?: Record<string, unknown>,
) => OperationInvoker;

/**
 * Builds live ExampleHooks (HELD — call only at the pilot go-ahead with
 * released slice commits; unverified until live runs).
 */
export async function createLiveExampleHooks(inputs: LiveHookInputs): Promise<ExampleHooks> {
  const mod = await loadDistModule<{ buildInvoker: BuildInvokerFn }>(
    inputs.repoRoot,
    "packages/cloudflare/dist/worker/assembly.js",
    "bun run --filter @canlang/cloudflare build",
  );
  const invoker = mod.buildInvoker(inputs.artifact, inputs.asm, inputs.store);
  const dispatch: DispatchFn = async (request) => {
    const identity = await inputs.resolveIdentity(request.caller);
    const outcome = await invoker.invokeMutation(
      {
        operation: inputs.qualifyOperation(request.operation),
        // UUIDv7 (time-prefixed): the engine rejects v4 with
        // `validation` (probe-proven); uniqueness per invocation.
        operation_id: freshOperationId(Date.now()) as OperationId,
        inputs: inputs.wrapRecordRefs(request.operation, request.inputs),
      },
      identity,
    );
    if ("error" in outcome) {
      const code: unknown = (outcome.error as { code?: unknown } | null)?.code;
      return { ok: false, error: typeof code === "string" ? code : "unknown" };
    }
    return { ok: true };
  };
  return createExampleHooks({ dispatch, readLive: inputs.readLive });
}
