/**
 * Hand-built TeamTasks fixture worker — TEST FIXTURE ONLY, never production.
 *
 * Stands in for the L1-compiled TeamTasks artifact until PR6 emission lands
 * (see `teamtasks.ts` for the honesty contract). What is REAL here:
 * workerd execution, D1 reads/writes, @canlang/identity auth/session logic
 * (resolve/verify/mint/cookie/CSRF), and @canlang/ui rendering factories.
 * What is HAND-BUILT: route wiring, the page descriptor, the D1 schema, and
 * the TEST-ONLY `POST /__e2e/seed` endpoint (the production worker entry
 * never includes a seed endpoint). Row plumbing is supplied, never queried:
 * the fixture PresentationContext query runner throws loud — in-render
 * reads arrive with the PR6 dispatcher.
 *
 * Auth semantics are entirely real L6 code: PBKDF2 password verify, opaque
 * session tokens, `resolveIdentity` admission, HMAC CSRF. Identity rows live
 * in a real L6 memory `IdentityStore` (module scope, seeded per test);
 * production binds the store to fenced D1 (join J2) — that join is NOT
 * proven by this fixture and must not be claimed from it.
 *
 * MCP leg (`POST /mcp` + TEST-ONLY `POST /__e2e/mcp-grant`): the SAME
 * treatment — the REAL `createMcpHandler` (interfaces dist, bundled with the
 * MCP SDK into `vendor/mcp/bundle.js` by the loader) over McpDeps assembled
 * exactly like `handleMcpRequest` in
 * `packages/cloudflare/src/worker/assembly.ts`: the REAL P2
 * `createArtifactRegistry`/`createArtifactCatalog` over the fixture ops, a
 * members-only permissions adapter mirroring `policy Todo read=members`
 * (deny-closed, never fail-open), and an `OperationInvoker` writing/reading
 * the SAME D1 `todo` table with the SAME INSERT shape as the HTTP leg.
 * Grants mint via real L6 `issueMcpGrant`. What is HAND-BUILT: the McpDeps
 * assembly itself, the permissions adapter (the app team is the FIRST team
 * seeded through `/__e2e/seed`; later teams are foreign by design), and the
 * invoker (a fixture-local D1 bridge, not L3 canonical invocation — that
 * join is NOT proven here and must not be claimed from it).
 *
 * Team identity (fixture-only approximation, dies at the J2 grant-recheck
 * join): the workerd instance — and this store — is shared across spec files
 * in one Playwright worker, so seed ORDER is meaningless (any file's team
 * may be created first). The adapter therefore identifies the app team
 * intrinsically: a team seeded with the app's collaborating users (2+),
 * versus the foreign single-user team. This encodes the MCP spec's seed
 * shapes (a two-user team plus a one-user outsider team) — NOT production
 * policy — and only ever evaluates grant-holder teams, which only the MCP
 * spec mints. Unknown or single-user teams are denied (fail-closed).
 *
 * Workerd-safe: no `node:` imports; victuals arrive via the module map.
 */
import {
  IdentityError,
  buildSessionCookie,
  createOpaqueToken,
  deriveCsrfToken,
  issueMcpGrant,
  parseSessionCookie,
  resolveIdentity,
  verifyCsrfToken,
  verifyPassword,
  hashPassword,
  checkPasswordPolicy,
} from "./vendor/identity/index.js";
import { createMemoryIdentityStore } from "./vendor/identity/testing.js";
import { CSRF_FIELD, DEFAULT_THEME } from "./vendor/contracts/presentation.js";
import { card, escapeHtml, renderLogin, text, title } from "./vendor/ui/index.js";
import {
  createArtifactCatalog,
  createArtifactRegistry,
  createMcpHandler,
} from "./vendor/mcp/bundle.js";
import { FIXTURE_OPERATIONS } from "./vendor/mcp/fixture-ops.js";

const LABEL = "fixture/handbuilt/teamtasks";
const SESSION_MAX_AGE_SECONDS = 3600;
const SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const TODO_CREATE = "TeamTasks.Todo.create";
const TODO_READ = "TeamTasks.Todo.read";

const store = createMemoryIdentityStore();

/**
 * Seeded team sizes (`team_id` -> users created with the team in one
 * `/__e2e/seed` call). The `/mcp` permissions adapter reads this — and only
 * this — to tell the app team (2+ collaborating users) from the foreign
 * single-user team (see the header). HTTP routes never consult it.
 */
const teamSizes = new Map();

function queryStub() {
  throw new Error(
    "fixture: in-render reads need the PR6 dispatcher; rows are supplied, never queried",
  );
}

function makeContext(path, csrfToken, principal) {
  return {
    preferredLocales: ["en"],
    appDefaultLocale: "en",
    theme: DEFAULT_THEME,
    path,
    isPartial: false,
    csrfToken,
    principal,
    invocation: null,
    query: queryStub,
  };
}

function shell(pageTitle, body) {
  return (
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    `<title>${escapeHtml(pageTitle)}</title></head><body>${body}</body></html>`
  );
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function redirect(location, setCookie) {
  const headers = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}

async function currentViewer(request) {
  const token = parseSessionCookie(request.headers.get("cookie") ?? undefined);
  if (token === null) return { viewer: null, sessionToken: null };
  try {
    const identity = await resolveIdentity(store, { session_token: token });
    return { viewer: identity, sessionToken: token };
  } catch (error) {
    // Credential failures are IdentityError (expired/revoked/unknown);
    // anything else is a store bug and must surface, never masquerade
    // as an expired session. The real L6 message threads through so a
    // future L6 rewording surfaces instead of silently desyncing.
    if (!(error instanceof IdentityError)) throw error;
    return { viewer: "invalid", sessionToken: token, detail: error.message };
  }
}

async function loginPage(context, error) {
  // renderLogin returns a FULL document; serve it directly, never nested.
  return renderLogin({
    context,
    action: "/login",
    brand: "TeamTasks",
    idPrefix: "e2e-login",
    ...(error === undefined ? null : { error }),
  });
}

async function homePage(context, db, csrfToken) {
  let rows;
  try {
    const result = await db
      .prepare("SELECT id, title, done, assignee, version FROM todo ORDER BY created ASC")
      .all();
    rows = result.results ?? [];
  } catch {
    return html(
      shell("TeamTasks", "<p>fixture: todo table missing; run the D1 seed first.</p>"),
      500,
    );
  }
  const count = rows.length;
  const countLine =
    count === 1 ? "1 task" : `${count} tasks`;
  const items = rows
    .map((row) => {
      const done = row.done === 1;
      const badge = done ? "Done" : "Open";
      const assignee =
        row.assignee === null || row.assignee === undefined
          ? ""
          : ` <span>(${escapeHtml(String(row.assignee))})</span>`;
      return (
        `<li data-task-id="${escapeHtml(String(row.id))}">` +
        `<strong>${escapeHtml(String(row.title))}</strong> ` +
        `<span>${badge}</span>${assignee}</li>`
      );
    })
    .join("");
  const contexted = context;
  const addCard = await card({
    context: contexted,
    title: "Add team work",
    children: [
      `<form method="post" action="/tasks">` +
        `<input type="hidden" name="${escapeHtml(CSRF_FIELD)}" value="${escapeHtml(csrfToken)}">` +
        `<label for="e2e-task-title">Title</label>` +
        `<input id="e2e-task-title" name="title" type="text" maxlength="200" required>` +
        `<button type="submit">Add</button></form>`,
    ],
  });
  const listCard = await card({
    context: contexted,
    title: "Tasks and completion",
    children: [
      await text({ context: contexted, values: [countLine] }),
      `<ul>${items}</ul>`,
    ],
  });
  const heading = await title({ context: contexted, text: "Team tasks" });
  return html(shell("Team tasks", `${heading}${addCard}${listCard}`));
}

async function handleSeed(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "seed body must be JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || !Array.isArray(body.users)) {
    return Response.json({ error: "seed body must be {team?, users: [...]}" }, { status: 400 });
  }
  const teamInput = body.team ?? {};
  const team = await store.createTeam({
    timezone: typeof teamInput.timezone === "string" ? teamInput.timezone : "UTC",
  });
  teamSizes.set(team.team_id, body.users.length);
  const users = [];
  for (const spec of body.users) {
    if (typeof spec?.email !== "string" || typeof spec?.password !== "string") {
      return Response.json({ error: "each seed user needs {email, password}" }, { status: 400 });
    }
    try {
      checkPasswordPolicy(spec.password);
    } catch {
      return Response.json({ error: "seed user password violates policy" }, { status: 400 });
    }
    const user = await store.createUser({
      email: spec.email,
      email_verified: true,
      password_hash: await hashPassword(spec.password),
    });
    await store.createMembership({
      team_id: team.team_id,
      user_id: user.user_id,
      is_owner: spec.owner === true,
      roles: [],
    });
    const { token: sessionToken, token_sha256 } = await createOpaqueToken();
    await store.createSession({
      user_id: user.user_id,
      token_sha256,
      expires_at: SESSION_EXPIRES_AT,
      last_team_id: team.team_id,
    });
    users.push({
      user_id: user.user_id,
      email: user.email,
      session_token: sessionToken,
      csrf_token: await deriveCsrfToken(sessionToken),
      cookie: buildSessionCookie(sessionToken, {
        maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
        secure: false,
      }),
    });
  }
  return Response.json({ label: LABEL, team_id: team.team_id, users });
}

async function handleLogin(request) {
  // Pre-session endpoint: no CSRF check is possible without a session key
  // (standard login exemption); the fixture login form posts directly.
  // Field names follow the real renderLogin form: username + password.
  const form = await request.formData();
  const email = form.get("username");
  const password = form.get("password");
  const context = makeContext("/login", "", null);
  if (typeof email !== "string" || typeof password !== "string") {
    return html(await loginPage(context, "Invalid email or password."), 403);
  }
  const user = await store.findUserByEmail(email);
  if (user === null || !(await verifyPassword(password, user.password_hash))) {
    return html(await loginPage(context, "Invalid email or password."), 403);
  }
  const { token: sessionToken, token_sha256 } = await createOpaqueToken();
  const memberships = await store.listUserMemberships(user.user_id);
  const first = memberships.find((m) => m.status === "active") ?? null;
  await store.createSession({
    user_id: user.user_id,
    token_sha256,
    expires_at: SESSION_EXPIRES_AT,
    last_team_id: first === null ? null : first.team_id,
  });
  return redirect(
    "/",
    buildSessionCookie(sessionToken, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS, secure: false }),
  );
}

async function handleCreateTask(request, env, sessionToken) {
  const form = await request.formData();
  const presented = form.get(CSRF_FIELD);
  if (
    typeof presented !== "string" ||
    !(await verifyCsrfToken(sessionToken, presented))
  ) {
    return new Response("forbidden: bad CSRF token", { status: 403 });
  }
  const rawTitle = form.get("title");
  if (typeof rawTitle !== "string") {
    return new Response("bad request: title required", { status: 400 });
  }
  const titleText = rawTitle.trim();
  if (titleText.length === 0 || titleText.length > 200) {
    return new Response("bad request: title must be 1–200 chars", { status: 400 });
  }
  try {
    await env.DB.prepare(
      "INSERT INTO todo (id, title, done, assignee, version, created) VALUES (?, ?, 0, NULL, 1, ?)",
    )
      .bind(globalThis.crypto.randomUUID(), titleText, Date.now())
      .run();
  } catch {
    return new Response("fixture: todo table missing; run the D1 seed first", { status: 500 });
  }
  return redirect("/");
}

/**
 * Members-only `/mcp` permissions mirroring `policy Todo read=members`:
 * the caller must present an active membership in the app team — the team
 * seeded with the app's collaborating users (see `teamSizes`). Every other
 * shape — anonymous, unverified, foreign-team, removed, unknown-team, or
 * pre-seed — is denied. Deny-closed, never fail-open.
 */
function isAppMember(identity) {
  if (identity === null || typeof identity !== "object") return false;
  if (identity.actor === null || identity.actor === undefined) return false;
  if (identity.membership === null || identity.membership === undefined) return false;
  if (identity.membership.status !== "active") return false;
  if (identity.team === null || identity.team === undefined) return false;
  const size = teamSizes.get(identity.team.team_id);
  return size !== undefined && size >= 2;
}

const mcpPermissions = {
  canDiscover: (identity) => isAppMember(identity),
  canCall: (identity) => isAppMember(identity),
};

/**
 * Fixture `OperationInvoker`: the `/mcp` D1 bridge over the SAME `todo`
 * table and the SAME INSERT shape as `handleCreateTask` (id, title, done,
 * assignee, version, created). Caller-provided `done`/`assignee` apply when
 * present (they are real Todo columns); defaults match the HTTP leg
 * (open, unassigned). Shape failures are `validation`, unknown operations
 * are `not_found` (the MCP server maps catalog skew to `not_found` first),
 * D1 failures are `rule_failed` — never a throw, never a leak.
 */
function buildMcpInvoker(db) {
  return {
    invokeMutation: async (envelope, identity) => {
      void identity;
      if (envelope.operation !== TODO_CREATE) {
        return { error: { code: "not_found", message: "Unknown operation.", retryable: false } };
      }
      const inputs = envelope.inputs ?? {};
      const rawTitle = inputs.title;
      if (typeof rawTitle !== "string") {
        return { error: { code: "validation", message: "Invalid title.", retryable: false } };
      }
      const titleText = rawTitle.trim();
      if (titleText.length === 0 || titleText.length > 200) {
        return { error: { code: "validation", message: "Invalid title.", retryable: false } };
      }
      let done = 0;
      if (inputs.done !== undefined) {
        if (typeof inputs.done !== "boolean") {
          return { error: { code: "validation", message: "Invalid done.", retryable: false } };
        }
        done = inputs.done ? 1 : 0;
      }
      let assignee = null;
      if (inputs.assignee !== undefined && inputs.assignee !== null) {
        if (typeof inputs.assignee !== "string" || inputs.assignee.length > 200) {
          return { error: { code: "validation", message: "Invalid assignee.", retryable: false } };
        }
        assignee = inputs.assignee;
      }
      const id = globalThis.crypto.randomUUID();
      try {
        await db
          .prepare(
            "INSERT INTO todo (id, title, done, assignee, version, created) VALUES (?, ?, ?, ?, 1, ?)",
          )
          .bind(id, titleText, done, assignee, Date.now())
          .run();
      } catch {
        return {
          error: {
            code: "rule_failed",
            message: "The operation was rejected.",
            operation_id: envelope.operation_id,
            retryable: false,
          },
        };
      }
      return {
        result: {
          status: "committed",
          operation_id: envelope.operation_id,
          records: [{ id, title: titleText, done, assignee, version: 1 }],
        },
      };
    },
    invokeRead: async (envelope, identity) => {
      void identity;
      if (envelope.operation !== TODO_READ) {
        return { error: { code: "not_found", message: "Unknown operation.", retryable: false } };
      }
      try {
        const result = await db
          .prepare("SELECT id, title, done, assignee, version FROM todo ORDER BY created ASC")
          .all();
        return { result: result.results ?? [] };
      } catch {
        return {
          error: { code: "rule_failed", message: "The operation was rejected.", retryable: false },
        };
      }
    },
  };
}

/**
 * `POST /mcp`: assemble the REAL `McpDeps` and delegate to the REAL
 * `createMcpHandler`, mirroring `handleMcpRequest` in
 * `packages/cloudflare/src/worker/assembly.ts` (registry/catalog from the
 * artifact via the REAL P2 builders, members-only permissions, the D1
 * invoker, grant identity from the fixture store). Registry build failures
 * are contained to a 500 on `/mcp` (pages keep serving), exactly like the
 * production assembly.
 */
async function handleMcp(request, env) {
  let registry;
  let catalog;
  try {
    const artifact = { operations: FIXTURE_OPERATIONS };
    registry = createArtifactRegistry(artifact);
    catalog = createArtifactCatalog(artifact);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ code: "mcp-registry", message }, { status: 500 });
  }
  const handler = createMcpHandler({
    app: { appId: "teamtasks", brand: "TeamTasks", appDefaultLocale: "en", ownerLabels: new Map() },
    registry,
    permissions: mcpPermissions,
    invoker: buildMcpInvoker(env.DB),
    catalog,
    files: {
      usesFiles: () => false,
      intentsUrl: () => "/files/intents",
    },
    identity: {
      store,
      mail: {
        sendMail: async () => {
          throw new Error("fixture: mail is unbound on the MCP path (no MCP flow sends mail)");
        },
      },
      clock: { nowMs: () => Date.now() },
      verifyBaseUrl: "",
      recoveryBaseUrl: "",
      inviteBaseUrl: "",
      sessionMaxAgeSeconds: 0,
    },
    logger: {
      log: (level, message, fields) => {
        if (fields === undefined) console.log(`[mcp] ${level} ${message}`);
        else console.log(`[mcp] ${level} ${message}`, fields);
      },
    },
    clock: { nowMs: () => Date.now() },
  });
  return handler(request);
}

/**
 * TEST-ONLY `POST /__e2e/mcp-grant`: session cookie in, worker-minted MCP
 * grant out (same pattern as `/__e2e/seed`). The session resolves through
 * real L6 `resolveIdentity`; the grant mints through real L6
 * `issueMcpGrant` bound to the session's active team; the raw Bearer [REDACTED]
 * returned once. The response carries ONLY
 * `{token, grant_id, user_id, team_id}` — never stored, never logged.
 */
async function handleMcpGrant(request) {
  const sessionToken = parseSessionCookie(request.headers.get("cookie") ?? undefined);
  if (sessionToken === null) {
    return Response.json({ error: "mcp-grant needs a session" }, { status: 401 });
  }
  let identity;
  try {
    identity = await resolveIdentity(store, { session_token: sessionToken });
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (
    identity.actor === null ||
    identity.membership === null ||
    identity.membership.status !== "active" ||
    identity.team === null
  ) {
    return Response.json({ error: "mcp-grant needs an active team membership" }, { status: 403 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "grant body must be JSON" }, { status: 400 });
  }
  const clientId = body?.client_id;
  if (typeof clientId !== "string" || clientId.trim() === "") {
    return Response.json({ error: "client_id is required" }, { status: 400 });
  }
  try {
    const issued = await issueMcpGrant(store, {
      user_id: identity.actor.user_id,
      team_id: identity.team.team_id,
      client_id: clientId,
    });
    return Response.json({
      token: issued.token,
      grant_id: issued.grant.grant_id,
      user_id: issued.grant.user_id,
      team_id: issued.grant.team_id,
    });
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__e2e/seed") {
      return handleSeed(request);
    }
    if (request.method === "POST" && url.pathname === "/__e2e/mcp-grant") {
      return handleMcpGrant(request);
    }
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }
    if (url.pathname === "/login") {
      if (request.method === "GET") {
        return html(await loginPage(makeContext("/login", "", null), undefined));
      }
      if (request.method === "POST") return handleLogin(request);
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname === "/" && request.method === "GET") {
      const { viewer, sessionToken, detail } = await currentViewer(request);
      if (viewer === null) {
        return html(await loginPage(makeContext("/", "", null), undefined));
      }
      if (viewer === "invalid" || sessionToken === null) {
        // `detail` is always set when viewer is "invalid"; the fallback
        // covers only the defensive null-token arm above.
        return html(
          await loginPage(makeContext("/", "", null), detail ?? "Session expired or revoked."),
          403,
        );
      }
      const csrfToken = await deriveCsrfToken(sessionToken);
      return homePage(makeContext("/", csrfToken, viewer), env.DB, csrfToken);
    }
    if (url.pathname === "/tasks" && request.method === "POST") {
      const { viewer, sessionToken } = await currentViewer(request);
      if (viewer === null || viewer === "invalid" || sessionToken === null) {
        return new Response("forbidden: sign in first", { status: 403 });
      }
      return handleCreateTask(request, env, sessionToken);
    }
    return new Response("not found", { status: 404 });
  },
};
