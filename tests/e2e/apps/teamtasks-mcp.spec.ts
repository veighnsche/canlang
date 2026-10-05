/**
 * TeamTasks MCP leg (B1): the same `.can` operations over MCP actions and
 * the browser, against real workerd/D1 with two authed users.
 *
 * Bar (`implementation/PLAN.md` B1): browser and MCP invoke the same
 * operation with equal authority. Every D1 assertion is presence-shaped
 * (own rows only, never exact table counts): the worker — and its D1 — is
 * per Playwright *worker* process, shared across spec files (see
 * `../fixtures/e2e-test.ts`). Titles created here are unique to this file
 * so absence assertions are also safe.
 *
 * Operation names are derived, not invented: `app TeamTasks` +
 * `crud Todo` (`examples/TeamTasks.can:2,13`) in the canonical
 * `package.Model.verb` form (`packages/interfaces/src/ports.ts`
 * `OperationDescriptor`; `acme.Todo.create` in
 * `packages/interfaces/test/mcp-server.test.ts`). `policy Todo
 * read=members` (TeamTasks.can:6) proves the read operation exists. If P1
 * codegen emits a different package case, these two constants are the
 * one-line fix and the list test names the skew.
 */
import { randomBytes } from "node:crypto";
import { expect } from "@playwright/test";
import { CSRF_FIELD } from "@canlang/contracts";
import { test } from "../fixtures/e2e-test.js";
import { seedFixtureTask, seedTeamUsers, type SeededUser } from "../fixtures/seed.js";
import { mintMcpGrant } from "../fixtures/mcp-grants.js";
import {
  createMcpClient,
  rpcResult,
  toolResultFromCall,
  toolsFromList,
  type McpClient,
} from "../bridges/mcp-bridge.js";
import type { WorkerAssembly } from "../fixtures/artifact-loader.js";

/** Canonical `.can` operations under test (see header for derivation). */
const TODO_CREATE = "TeamTasks.Todo.create";
const TODO_READ = "TeamTasks.Todo.read";

/** Uniform safe denial, verbatim from `interfaces/src/errors/safe.ts`. */
const SAFE_FORBIDDEN = "You do not have permission to perform this action.";

const ALICE = { email: "alice.mcp@example.com", password: "correct-horse-45" };
const BOB = { email: "bob.mcp@example.com", password: "correct-horse-46" };
const OUTSIDER = { email: "outsider.mcp@example.com", password: "correct-horse-47" };
const MCP_TASK_TITLE = "MCP leg creates this task";
const HTTP_TASK_TITLE = "HTTP parity leg creates this task";

function d1Binding(assembly: WorkerAssembly): string {
  const first = assembly.d1Databases[0];
  if (first === undefined) throw new Error("teamtasks-mcp spec: assembly has no D1 database");
  return first.binding;
}

/**
 * Fresh canonical UUIDv7 `operation_id` with the time field at now —
 * mirrors `freshOperationId` in `mcp-server.test.ts` (shape enforced by
 * `validateOperationId`: lowercase UUIDv7, 24h age / 5min future bounds).
 */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

function fail(message: string): never {
  throw new Error(`teamtasks-mcp spec: ${message}`);
}

test.describe("teamtasks MCP leg", () => {
  let alice: SeededUser | undefined;
  let bob: SeededUser | undefined;
  let outsider: SeededUser | undefined;

  test.beforeAll(async ({ assembly, bridge, dev }) => {
    expect(assembly.label).toBe("fixture/handbuilt/teamtasks");
    await seedFixtureTask(dev, d1Binding(assembly));
    const team = await seedTeamUsers(bridge.url, [ALICE, BOB]);
    expect(team.label).toBe(assembly.label);
    expect(team.users).toHaveLength(2);
    [alice, bob] = team.users;
    // Second seed call = second team: the outsider is a non-member of the
    // members-only Todo policy, the denied-read principal.
    const foreign = await seedTeamUsers(bridge.url, [OUTSIDER]);
    expect(foreign.users).toHaveLength(1);
    [outsider] = foreign.users;
    if (alice === undefined || bob === undefined || outsider === undefined) {
      fail("seed returned no users");
    }
  });

  test("mcp route requires grant auth (401, never 404)", async ({ bridge }) => {
    const mcp: McpClient = createMcpClient(bridge);
    // No grant: the /mcp route exists and answers the safe 401
    // (`createMcpHandler` auth seam).
    const { status, body } = await mcp.initialize();
    expect(status).toBe(401);
    const envelope = body as { error?: { code?: unknown; message?: unknown } };
    expect(envelope.error?.code).toBe("forbidden");
    expect(envelope.error?.message).toBe("Authentication required.");
  });

  test("tools/list contains the .can operation with its closed schema", async ({ bridge }) => {
    if (alice === undefined) fail("alice not seeded");
    const mcp: McpClient = createMcpClient(bridge);
    const grant = await mintMcpGrant(bridge.url, alice.session_token, "teamtasks-mcp-e2e");

    const init = await mcp.initialize({ grant: grant.token });
    expect(init.status).toBe(200);
    const hello = rpcResult(init.body) as {
      protocolVersion?: unknown;
      serverInfo?: { name?: unknown; version?: unknown };
    };
    expect(typeof hello.protocolVersion).toBe("string");
    expect(hello.serverInfo?.name).toBe("can-mcp");

    const listed = await mcp.listTools(grant.token);
    expect(listed.status).toBe(200);
    const tools = toolsFromList(listed.body);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain(TODO_CREATE);
    const create = tools.find((tool) => tool.name === TODO_CREATE) ?? fail("create tool missing");
    // Authored description travels verbatim; P1 owns the exact text, the
    // seam (`toMcpTool`) guarantees presence.
    expect(typeof create.description).toBe("string");
    expect(create.description.length).toBeGreaterThan(0);
    // Mutation framing (`toToolInputSchema` seam): anyOf[ordinary, handle],
    // ordinary branch closed with `title` (required: `title:text` has no
    // default in TeamTasks.can:5) plus framing `operation_id`.
    const schema = create.inputSchema as {
      type?: unknown;
      anyOf?: Array<{
        properties?: Record<string, unknown>;
        required?: unknown;
        additionalProperties?: unknown;
      }>;
    };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toHaveLength(2);
    const ordinary = schema.anyOf?.[0] ?? fail("ordinary schema branch missing");
    expect(ordinary.additionalProperties).toBe(false);
    expect(ordinary.properties?.["title"]).toBeDefined();
    expect(ordinary.properties?.["operation_id"]).toBeDefined();
    expect(ordinary.required).toEqual(expect.arrayContaining(["title", "operation_id"]));
  });

  test("tools/call round-trips through the same worker as HTTP (parity row)", async ({
    page,
    bridge,
    assembly,
    dev,
  }) => {
    if (alice === undefined || bob === undefined) fail("team not seeded");
    const mcp: McpClient = createMcpClient(bridge);
    const grant = await mintMcpGrant(bridge.url, alice.session_token, "teamtasks-mcp-e2e");

    // MCP leg: alice creates a task through tools/call. Success here means
    // the call executed in the same worker and D1 table the HTTP leg
    // uses — proven below by the shared durable effect.
    const called = await mcp.callTool(grant.token, TODO_CREATE, {
      operation_id: freshOperationId(),
      title: MCP_TASK_TITLE,
    });
    expect(called.status).toBe(200);
    const created = toolResultFromCall(called.body);
    expect(created.isError).toBeUndefined();

    // HTTP leg: bob creates a task through the session+CSRF form POST.
    const http = await fetch(`${bridge.url}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `can_session=${bob.session_token}`,
      },
      body: new URLSearchParams({ title: HTTP_TASK_TITLE, [CSRF_FIELD]: bob.csrf_token }).toString(),
      redirect: "manual",
    });
    expect(http.status).toBe(303);

    // Parity row: both legs' tasks render on the same page and persist in
    // the same D1 table — one worker, one store, equal authority.
    await page.context().addCookies([{ name: "can_session", value: alice.session_token, url: bridge.url }]);
    await page.goto(`${bridge.url}/`);
    await expect(page.getByText(MCP_TASK_TITLE)).toBeVisible();
    await expect(page.getByText(HTTP_TASK_TITLE)).toBeVisible();

    const db = await dev.getD1Database(d1Binding(assembly));
    for (const title of [MCP_TASK_TITLE, HTTP_TASK_TITLE]) {
      const { results } = await db
        .prepare("SELECT title, done FROM todo WHERE title = ?")
        .bind(title)
        .all();
      expect(results).toHaveLength(1);
      expect(results[0]?.["done"]).toBe(0);
    }
  });

  test("denied read is isError with the safe projection", async ({ bridge }) => {
    if (outsider === undefined) fail("outsider not seeded");
    const mcp: McpClient = createMcpClient(bridge);
    const grant = await mintMcpGrant(bridge.url, outsider.session_token, "teamtasks-mcp-e2e");

    // Permission is rechecked before framing (`handleToolCall` seam), so a
    // non-member is denied without needing valid read inputs.
    const { status, body } = await mcp.callTool(grant.token, TODO_READ, {});
    expect(status).toBe(200);
    const denied = toolResultFromCall(body);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.["code"]).toBe("forbidden");
    expect(denied.structuredContent?.["message"]).toBe(SAFE_FORBIDDEN);
    // Safe projection: no credential material, no internals in the text.
    const text = denied.content.map((block) => block.text).join("\n");
    expect(text).toContain("forbidden");
    expect(text).not.toContain(grant.token);
  });
});
