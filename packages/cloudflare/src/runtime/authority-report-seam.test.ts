/**
 * Outcome 9 family E (Lane C host seam): authority-report adoption in
 * `runReadScenarioSeam`'s host.
 *
 * The compiler publishes the checked `scope:"authority"` fact on the
 * §13 operations descriptor (with description + declared result beside
 * it); the State engine from `4c6fe535` evaluates bound reports in
 * decision mode and serves the typed result as the grant. This suite
 * pins the host half: the seam routes the checked fact through
 * `bindAuthorityReportScope` so authority bodies read bounded owner
 * rows (confidential fields included) while ordinary reads stay
 * viewer-filtered and byte-identical.
 *
 * Fail-closed mirrors of the invoke-authority negatives: undescribed
 * and untyped binds refuse, marker/descriptor disagreement refuses,
 * ambiguous source origins refuse, `by`-denied callers refuse before
 * any decision read, and mid-evaluation membership change voids the
 * grant. Engine viewer/page refusals stay State-owned (11/11 green).
 *
 * Helper-consumer proof (DESIGN §442, Lane-A dual-emission precedent):
 * an authority body calling a pure helper (`derive` lowered once as the
 * emitted variant, invoked with the ambient `c`) keeps decision mode
 * inside the helper, so the helper-computed result grants to the
 * admitted `by`. The same declaration consumed by viewer code keeps
 * viewer restriction, and a corrupted helper body refuses instead of
 * serving a grant.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/authority-report-seam.test.js`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import type {
  CompileArtifact,
  ModelName,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
import type { AssembledModules } from "../worker/assembly.js";
import { invokeReadCanonical } from "./invoke.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  // Stage beside the compiled test so fixture modules import the
  // compiled stdlib relatively (`../stdlib.js`, the t17b precedent).
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(here, "authority-seam-fix-"));
  tempDirs.push(dir);
  return dir;
}

const DESCRIPTION = "Confidential totals granted to members.";
const SOURCE_PATH = "shop.can";

const POLICY_JSON = JSON.stringify({
  operations: {
    "Shop.totals": { by: ["members"] },
    "Shop.inspectAuthority": { by: ["members"] },
    "Shop.inspect": { by: ["members"] },
    "Shop.helperTotals": { by: ["members"] },
    "Shop.helperPeek": { by: ["members"] },
  },
  models: {
    "Shop.Gadget": { read: ["Gadget.read.1"], public: ["Gadget.read.1"] },
  },
});

/** Hand-written decision bodies mirroring the lowered shape Lane A will emit. */
function opsModule(
  policyJson: string,
  operationsJson: string,
  registryOpsJson: string,
  extra: { prelude?: string | undefined; shop?: string | undefined } = {},
): string {
  return `import { records } from "../stdlib.js";
${extra.prelude ?? ""}
const readRules = { "Gadget.read.1": () => true };
export function canApp() {
  return {
    policy: ${policyJson},
    operations: ${registryOpsJson},
    read: readRules,
    Shop: {
      totals: async (c) => {
        const rows = await records(c, "Shop.Gadget");
        let sum = 0n;
        for (const row of rows) sum += BigInt(row.stock);
        return sum;
      },
      inspectAuthority: async (c, input) => input.gadget.stock,
      inspect: async (c, input) => input.gadget.title,
${extra.shop ?? ""}    },
  };
}
export const appDefinition = {
  id: "AuthorityUnit",
  models: {
    "Shop.Gadget": {
      readGrants: [{ rule: "Gadget.read.1", by: ["public"], fields: ["title", "code"] }],
      fields: { title: { type: "text" }, code: { type: "text" }, stock: { type: "text" } },
    },
  },
  policy: ${policyJson},
  operations: ${operationsJson},
};
`;
}

const AUTHORITY_OPERATIONS_JSON = JSON.stringify({
  "Shop.totals": {
    handler: "Shop.totals",
    inputs: {},
    scope: "authority",
    by: "members",
    read: true,
    result: { type: "int" },
    description: DESCRIPTION,
  },
  "Shop.inspectAuthority": {
    handler: "Shop.inspectAuthority",
    inputs: {},
    scope: "authority",
    by: "members",
    read: true,
    result: { type: "text" },
    description: DESCRIPTION,
  },
  "Shop.inspect": {
    handler: "Shop.inspect",
    inputs: {},
    by: "members",
    read: true,
    result: { type: "text" },
    description: "Return visible gadget details.",
  },
});

/** Same shape with the §13 marker stripped: descriptions/results stay, grant does not. */
const ORDINARY_OPERATIONS_JSON = JSON.stringify({
  "Shop.totals": {
    handler: "Shop.totals",
    inputs: {},
    by: "members",
    read: true,
    result: { type: "int" },
    description: DESCRIPTION,
  },
  "Shop.inspectAuthority": {
    handler: "Shop.inspectAuthority",
    inputs: {},
    by: "members",
    read: true,
    result: { type: "text" },
    description: DESCRIPTION,
  },
  "Shop.inspect": {
    handler: "Shop.inspect",
    inputs: {},
    by: "members",
    read: true,
    result: { type: "text" },
    description: "Return visible gadget details.",
  },
});

/**
 * Helper-consumer fixture (DESIGN §442 consuming-authority mode): the
 * module-level `sumHelper` mirrors the once-emitted pure-helper variant
 * Lane A lowers (`derive` calls resolve to the single emitted variant
 * invoked with the ambient `c`). The authority body consumes it with
 * the decision-mode `c`, so helper reads keep decision mode; the
 * ordinary body consumes the same declaration with a viewer `c`.
 */
const HELPER_PRELUDE = `async function sumHelper(c) {
  const rows = await records(c, "Shop.Gadget");
  let sum = 0n;
  for (const row of rows) sum += BigInt(row.stock);
  return sum;
}
`;

/** Tampered helper body: fails instead of computing the grant. */
const HELPER_PRELUDE_TAMPERED = `async function sumHelper(c) {
  throw new Error("tampered helper body");
}
`;

const HELPER_SHOP_EXTRA = `      helperTotals: async (c) => sumHelper(c),
      helperPeek: async (c) => sumHelper(c),
`;

const HELPER_AUTHORITY_OPERATIONS_JSON = JSON.stringify({
  ...JSON.parse(AUTHORITY_OPERATIONS_JSON),
  "Shop.helperTotals": {
    handler: "Shop.helperTotals",
    inputs: {},
    scope: "authority",
    by: "members",
    read: true,
    result: { type: "int" },
    description: DESCRIPTION,
  },
  "Shop.helperPeek": {
    handler: "Shop.helperPeek",
    inputs: {},
    by: "members",
    read: true,
    result: { type: "int" },
    description: "Viewer helper probe; refuses the confidential field.",
  },
});

function helperArtifactOperations(): unknown[] {
  return [
    ...defaultArtifactOperations(),
    { name: "Shop.helperTotals", kind: "read", description: DESCRIPTION, inputs: { fields: [] }, result: { type: "int" } },
    {
      name: "Shop.helperPeek",
      kind: "read",
      description: "Viewer helper probe; refuses the confidential field.",
      inputs: { fields: [] },
      result: { type: "int" },
    },
  ];
}

interface ArtifactOptions {
  readonly operationsJson?: string;
  readonly artifactOperations?: unknown[];
  readonly sources?: Array<{ path: string; sha256: string }>;
  readonly prelude?: string;
  readonly shopExtra?: string;
  readonly extraCallableIds?: string[];
}

function gadgetModel(): unknown {
  return {
    name: "Shop.Gadget",
    fields: [
      { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
      { name: "code", required: true, serverOnly: false, field: { kind: "string" } },
      { name: "stock", required: false, serverOnly: false, field: { kind: "string" } },
    ],
    deleteMode: "remove",
  };
}

function refInput(name: string, model: string): unknown {
  return { name, field: { kind: "ref", model, requireVersion: true }, required: true };
}

function defaultArtifactOperations(): unknown[] {
  return [
    { name: "Shop.Gadget.read", kind: "read", description: "", inputs: { fields: [] } },
    { name: "Shop.totals", kind: "read", description: DESCRIPTION, inputs: { fields: [] }, result: { type: "int" } },
    {
      name: "Shop.inspectAuthority",
      kind: "read",
      description: DESCRIPTION,
      inputs: { fields: [refInput("gadget", "Shop.Gadget")] },
      result: { type: "text" },
    },
    {
      name: "Shop.inspect",
      kind: "read",
      description: "Return visible gadget details.",
      inputs: { fields: [refInput("gadget", "Shop.Gadget")] },
      result: { type: "text" },
    },
  ];
}

function authorityArtifact(moduleJs: string, options: ArtifactOptions = {}): CompileArtifact {
  const sha = createHash("sha256").update(moduleJs, "utf8").digest("hex");
  return {
    artifact_version: 1,
    language_version: "authority-seam-fixture/0 (hand-written §13 shape; NOT compiler output)",
    tool_version: "authority-seam-fixture/0",
    sources: options.sources ?? [{ path: SOURCE_PATH, sha256: sha }],
    // No module metadata claims on the direct path (d3b precedent):
    // loading runs off artifact.callables + asm.moduleUrls.
    modules: [],
    callables: [
      {
        id: "Shop.totals",
        kind: "operation",
        module: "ops.mjs",
        export: "Shop_totals",
        member: ["Shop", "totals"],
        inputStyle: "parameters",
      },
      {
        id: "Shop.inspectAuthority",
        kind: "operation",
        module: "ops.mjs",
        export: "Shop_inspectAuthority",
        member: ["Shop", "inspectAuthority"],
        inputStyle: "parameters",
      },
      {
        id: "Shop.inspect",
        kind: "operation",
        module: "ops.mjs",
        export: "Shop_inspect",
        member: ["Shop", "inspect"],
        inputStyle: "parameters",
      },
      ...(options.extraCallableIds ?? []).map((id) => {
        const member = id.slice(id.indexOf(".") + 1);
        return {
          id,
          kind: "operation",
          module: "ops.mjs",
          export: `Shop_${member}`,
          member: ["Shop", member],
          inputStyle: "parameters",
        };
      }),
    ],
    pages: [],
    requires: [{ capability: "state.parameters", min_version: 1 }],
    tests: [],
    operations: options.artifactOperations ?? defaultArtifactOperations(),
    models: [gadgetModel()],
  } as unknown as CompileArtifact;
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly memberToken: string;
  readonly outsiderToken: string;
}

async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const member = await store.createUser({
    email: "member@authority.test",
    password_hash: "x",
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: member.user_id,
    is_owner: false,
    roles: [],
  });
  const outsider = await store.createUser({
    email: "outsider@authority.test",
    password_hash: "x",
    email_verified: true,
  });
  const sessionFor = async (userId: string, token: string): Promise<void> => {
    await store.createSession({
      user_id: userId,
      token_sha256: await sha256HexText(token),
      expires_at: new Date(now + 3600_000).toISOString(),
      last_team_id: team.team_id,
    });
  };
  const memberToken = `member-token-${randomBytes(8).toString("hex")}`;
  const outsiderToken = `outsider-token-${randomBytes(8).toString("hex")}`;
  await sessionFor(member.user_id, memberToken);
  await sessionFor(outsider.user_id, outsiderToken);
  return { now, store, memberToken, outsiderToken };
}

async function identityFor(seed: SeededIdentity, token: string): Promise<ResolvedIdentity> {
  return resolveIdentity(
    seed.store,
    { session_token: token },
    { clock: { nowMs: () => seed.now } },
  );
}

interface SeamSetup {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  readonly store: StoragePort;
  readonly seed: SeededIdentity;
}

async function seamSetup(options: ArtifactOptions = {}): Promise<SeamSetup> {
  const dir = tempDir();
  // The canApp() registry operations array must JSON-equal the artifact
  // descriptors (loader pairing); both channels share one array.
  const artifactOps = options.artifactOperations ?? defaultArtifactOperations();
  const moduleJs = opsModule(
    POLICY_JSON,
    options.operationsJson ?? AUTHORITY_OPERATIONS_JSON,
    JSON.stringify(artifactOps),
    { prelude: options.prelude, shop: options.shopExtra },
  );
  const opsPath = join(dir, "ops.mjs");
  writeFileSync(opsPath, moduleJs);
  const asm: AssembledModules = {
    dir,
    entryUrl: pathToFileURL(opsPath).href,
    moduleUrls: { "ops.mjs": pathToFileURL(opsPath).href },
  };
  const { store } = createTestMemoryStorage();
  const seed = await seedIdentity();
  return { asm, artifact: authorityArtifact(moduleJs, { ...options, artifactOperations: artifactOps }), store, seed };
}

async function seedStock(store: StoragePort, now: number, id: string, stock: string): Promise<StoredRow> {
  const revision = await store.readRevision();
  await store.commit({
    expectedRevision: revision,
    writes: [
      {
        kind: "insert",
        model: "Shop.Gadget" as ModelName,
        row: {
          id: id as RecordId,
          version: 1 as RecordVersion,
          created: now,
          updated: now,
          createdBy: "member@authority.test",
          updatedBy: "member@authority.test",
          archivedAt: null,
          parent: null,
          data: { title: `item-${id}`, code: `C-${id}`, stock },
        } as StoredRow,
      },
    ],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  });
  const row = await store.load("Shop.Gadget" as ModelName, id as RecordId);
  assert.ok(row !== null);
  return row;
}

async function captureError(fn: () => Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `want Error, got ${String(error)}`);
    return error as Error & { code?: unknown };
  }
  assert.fail("expected a throw");
}

function readOptions(setup: SeamSetup, operation: string, inputs: Record<string, unknown> = {}) {
  return {
    asm: setup.asm,
    artifact: setup.artifact,
    operation,
    inputs,
    store: setup.store,
    memberships: setup.seed.store,
  };
}

describe("authority report host seam (decision mode + result-as-grant)", () => {
  it("grants a typed result computed from decision rows invisible to viewer reads", async () => {
    const setup = await seamSetup();
    await seedStock(setup.store, setup.seed.now, "first", "3");
    await seedStock(setup.store, setup.seed.now, "second", "4");
    const served = (await invokeReadCanonical({
      ...readOptions(setup, "Shop.totals"),
      identity: await identityFor(setup.seed, setup.seed.memberToken),
    })) as { result: unknown; revision: unknown };
    assert.equal(served.result, "7");

    // Viewer contrast: the same rows project without the confidential field.
    const viewer = (await invokeReadCanonical({
      ...readOptions(setup, "Shop.Gadget.read"),
      identity: await identityFor(setup.seed, setup.seed.memberToken),
    })) as { records: Array<{ data: Record<string, unknown> }> };
    assert.equal(viewer.records.length, 2);
    for (const record of viewer.records) {
      assert.deepEqual(Object.keys(record.data).sort(), ["code", "title"]);
    }
  });

  it("loads decision refs unprojected for the admitted by", async () => {
    const setup = await seamSetup();
    const row = await seedStock(setup.store, setup.seed.now, "only", "9");
    const served = (await invokeReadCanonical({
      ...readOptions(setup, "Shop.inspectAuthority", {
        gadget: { id: row.id, version: String(row.version) },
      }),
      identity: await identityFor(setup.seed, setup.seed.memberToken),
    })) as { result: unknown };
    assert.equal(served.result, "9");
  });

  it("leaves ordinary reads viewer-filtered without a grant", async () => {
    const setup = await seamSetup();
    const row = await seedStock(setup.store, setup.seed.now, "plain", "2");
    const served = (await invokeReadCanonical({
      ...readOptions(setup, "Shop.inspect", {
        gadget: { id: row.id, version: String(row.version) },
      }),
      identity: await identityFor(setup.seed, setup.seed.memberToken),
    })) as { result: unknown };
    assert.equal(served.result, "item-plain");
  });

  it("keeps viewer teeth with no grant when the marker is stripped", async () => {
    // Same descriptors and body, no §13 marker: the body keeps running
    // under viewer rules, so touching the confidential field refuses
    // loudly instead of serving a grant.
    const setup = await seamSetup({ operationsJson: ORDINARY_OPERATIONS_JSON });
    await seedStock(setup.store, setup.seed.now, "first", "3");
    await seedStock(setup.store, setup.seed.now, "second", "4");
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.totals"), identity }),
    );
    assert.match(error.message, /not readable/);
  });

  it("refuses undescribed authority bindings instead of serving filtered rows", async () => {
    const operations = defaultArtifactOperations().map((entry) =>
      isAuthorityOp(entry) ? { ...(entry as Record<string, unknown>), description: "" } : entry,
    );
    const setup = await seamSetup({ artifactOperations: operations });
    await seedStock(setup.store, setup.seed.now, "hidden", "5");
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.totals"), identity }),
    );
    assert.equal(error.code, "validation");
    assert.match(error.message, /[Aa]uthority report/);
  });

  it("refuses untyped authority bindings without a declared grant", async () => {
    // A callable read without a declared result never reaches the bind:
    // the loader pairing refuses the declaration/descriptor disagreement
    // at load (fail-closed before any row is served).
    const operations = defaultArtifactOperations().map((entry) =>
      isAuthorityOp(entry) ? withoutResult(entry) : entry,
    );
    const setup = await seamSetup({ artifactOperations: operations });
    await seedStock(setup.store, setup.seed.now, "hidden", "5");
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.totals"), identity }),
    );
    assert.match(error.message, /checked result declaration\/descriptor disagreement/);
  });

  it("refuses marker/descriptor disagreement without a checked read", async () => {
    const operations = defaultArtifactOperations().filter(
      (entry) => (entry as { name?: string }).name !== "Shop.totals",
    );
    const setup = await seamSetup({ artifactOperations: operations });
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.totals"), identity }),
    );
    assert.equal(error.code, "validation");
    assert.match(error.message, /[Aa]uthority report/);
  });

  it("refuses ambiguous source origins instead of binding a provenance guess", async () => {
    const setup = await seamSetup({
      sources: [
        { path: "shop.can", sha256: "a".repeat(64) },
        { path: "extra.can", sha256: "b".repeat(64) },
      ],
    });
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.totals"), identity }),
    );
    assert.equal(error.code, "validation");
    assert.match(error.message, /[Aa]uthority report/);
  });

  it("refuses by-denied callers before any decision read", async () => {
    const setup = await seamSetup();
    await seedStock(setup.store, setup.seed.now, "hidden", "5");
    const identity = await identityFor(setup.seed, setup.seed.outsiderToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.totals"), identity }),
    );
    assert.equal(error.code, "forbidden");
  });

  it("voids the grant when decision rows move during evaluation", async () => {
    // Read-only bodies cannot commit, so the drift arrives beneath the
    // store port: the first domain observation is real, later reads see
    // moved rows. The seam recheck (or State's decision revalidation)
    // voids the grant with `forbidden` instead of serving a torn grant.
    const setup = await seamSetup();
    await seedStock(setup.store, setup.seed.now, "roles", "1");
    let queries = 0;
    const inner = setup.store;
    const drifted: StoragePort = {
      ...inner,
      query: (async (spec: Parameters<StoragePort["query"]>[0]) => {
        queries += 1;
        const rows = await inner.query(spec);
        if (queries === 1) return rows;
        return rows.map((row) => ({ ...row, data: { ...row.data, stock: "30" } }));
      }) as StoragePort["query"],
    };
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({
        ...readOptions(setup, "Shop.totals"),
        store: drifted,
        identity,
      }),
    );
    assert.equal(error.code, "forbidden");
    assert.match(error.message, /authority changed/);
  });
});

async function helperSeamSetup(prelude: string = HELPER_PRELUDE): Promise<SeamSetup> {
  return seamSetup({
    operationsJson: HELPER_AUTHORITY_OPERATIONS_JSON,
    artifactOperations: helperArtifactOperations(),
    prelude,
    shopExtra: HELPER_SHOP_EXTRA,
    extraCallableIds: ["Shop.helperTotals", "Shop.helperPeek"],
  });
}

describe("authority report helper-consumer seam (DESIGN §442 consuming-authority mode)", () => {
  it("grants a helper-computed result to the admitted by while viewer reads stay filtered", async () => {
    const setup = await helperSeamSetup();
    await seedStock(setup.store, setup.seed.now, "first", "3");
    await seedStock(setup.store, setup.seed.now, "second", "4");
    const served = (await invokeReadCanonical({
      ...readOptions(setup, "Shop.helperTotals"),
      identity: await identityFor(setup.seed, setup.seed.memberToken),
    })) as { result: unknown; revision: unknown };
    assert.equal(served.result, "7");

    // Viewer contrast: the same rows project without the confidential field.
    const viewer = (await invokeReadCanonical({
      ...readOptions(setup, "Shop.Gadget.read"),
      identity: await identityFor(setup.seed, setup.seed.memberToken),
    })) as { records: Array<{ data: Record<string, unknown> }> };
    assert.equal(viewer.records.length, 2);
    for (const record of viewer.records) {
      assert.deepEqual(Object.keys(record.data).sort(), ["code", "title"]);
    }

    // The grant is to the admitted `by`: outsiders refuse before any helper read.
    const outsider = await identityFor(setup.seed, setup.seed.outsiderToken);
    const denied = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.helperTotals"), identity: outsider }),
    );
    assert.equal(denied.code, "forbidden");
  });

  it("refuses the same helper under viewer consumption without a grant", async () => {
    // The same `sumHelper` declaration consumed by an ordinary read runs
    // with a viewer `c`: touching the confidential field refuses loudly
    // instead of obtaining decision authority (§442 second direction).
    const setup = await helperSeamSetup();
    await seedStock(setup.store, setup.seed.now, "hidden", "5");
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.helperPeek"), identity }),
    );
    assert.match(error.message, /not readable/);
  });

  it("refuses a corrupted helper body instead of serving a grant", async () => {
    // A tampered helper that fails cannot serve a forged grant: the
    // seam invokes bodies with `preserveThrown`, so the helper failure
    // escapes loudly with no result served. (Semantic forgery that
    // still type-checks is outside any runtime boundary; helper
    // identity is pinned by the bound single source origin.)
    const setup = await helperSeamSetup(HELPER_PRELUDE_TAMPERED);
    await seedStock(setup.store, setup.seed.now, "hidden", "5");
    const identity = await identityFor(setup.seed, setup.seed.memberToken);
    const error = await captureError(() =>
      invokeReadCanonical({ ...readOptions(setup, "Shop.helperTotals"), identity }),
    );
    assert.match(error.message, /tampered helper body/);
  });
});

function isAuthorityOp(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { name?: unknown }).name === "Shop.totals"
  );
}

function withoutResult(entry: unknown): unknown {
  const record = { ...(entry as Record<string, unknown>) };
  delete record["result"];
  return record;
}
