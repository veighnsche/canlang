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
 * Workerd-safe: no `node:` imports; victuals arrive via the module map.
 */
import {
  IdentityError,
  buildSessionCookie,
  createOpaqueToken,
  deriveCsrfToken,
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

const LABEL = "fixture/handbuilt/teamtasks";
const SESSION_MAX_AGE_SECONDS = 3600;
const SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const store = createMemoryIdentityStore();

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
    // as an expired session.
    if (!(error instanceof IdentityError)) throw error;
    return { viewer: "invalid", sessionToken: token };
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__e2e/seed") {
      return handleSeed(request);
    }
    if (url.pathname === "/login") {
      if (request.method === "GET") {
        return html(await loginPage(makeContext("/login", "", null), undefined));
      }
      if (request.method === "POST") return handleLogin(request);
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname === "/" && request.method === "GET") {
      const { viewer, sessionToken } = await currentViewer(request);
      if (viewer === null) {
        return html(await loginPage(makeContext("/", "", null), undefined));
      }
      if (viewer === "invalid" || sessionToken === null) {
        return html(
          await loginPage(makeContext("/", "", null), "Session expired or revoked."),
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
