import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { BrowserContext, Page, Response as BrowserResponse } from "@playwright/test";

export interface DraftSession {
  readonly session: string;
  readonly app: string;
  readonly identity: Readonly<{ revision: string; sourceRevision: string; servingBuild: string }>;
  /** Use a fresh context with tracing disabled: cookie injection carries real credentials. */
  /** Null retains only preview transport access, with no application identity. */
  authenticate(context: BrowserContext, actorLabel?: string | null): Promise<string>;
  assertCurrent(): Promise<void>;
  runExamples(operation?: string, row?: number): Promise<unknown>;
  close(): Promise<void>;
}

type JsonObject = Record<string, unknown>;
const exec = promisify(execFile);
const controlBin = process.env.CAN_DEV_BIN ?? "can";
const controlPrefix = process.env.CAN_DEV_BIN === undefined ? ["dev"] : [];
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Development control returned an invalid object");
  }
  return value as JsonObject;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Development control lacks ${name}`);
  return value;
}
class ControlFailure extends Error {
  constructor(readonly code: string, readonly endpointAbsent: boolean, command: string) {
    // Control details, stderr, and request bodies can contain credentials. Never retain them.
    super(`Development control ${command} failed (${/^[A-Z_]+$/.test(code) ? code : "INVALID_RESPONSE"})`);
  }
}

/** Actual installed can-dev owner and protected preview; no replacement server or artifact. */
export async function openDraftSession(options: {
  root: string; source: string; app: string; timeoutMs?: number;
  previewRoles?: Readonly<Record<string, readonly string[]>>;
}): Promise<DraftSession> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("Draft session timeout must be 1..3600000 milliseconds");
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Draft sessions require Node 22 or newer");
  const acceptanceSource = process.env.CAN_ACCEPTANCE_SOURCE;
  if (acceptanceSource !== undefined && !isAbsolute(acceptanceSource)) {
    throw new Error("CAN_ACCEPTANCE_SOURCE must be an absolute candidate source path");
  }
  const root = resolve(acceptanceSource === undefined ? options.root : process.env.CAN_ACCEPTANCE_WORKSPACE ?? options.root);
  const source = resolve(root, acceptanceSource ?? options.source);
  const app = options.app;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(app)) throw new Error("Draft session requires a declared app name");
  const deadline = Date.now() + timeoutMs;
  const remaining = (limit = 60_000): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Draft session deadline exceeded");
    return Math.min(limit, left);
  };
  const testState = await mkdtemp(join(tmpdir(), "can-draft-session-"));
  const controlEnv = { ...process.env, TMPDIR: testState, CAN_DEV_STATE_ROOT: join(testState, "preview") };
  let session = "";
  let owned = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let acceptanceIdentity: DraftSession["identity"] | undefined;
  let verifyAcceptanceCurrent: (() => Promise<void>) | undefined;
  let browserNavigations = 0;
  const watchedContexts = new WeakSet<BrowserContext>();
  const browserListeners: (() => void)[] = [];
  const flags = (): string[] => ["--root", root, "--session", session, "--app", app, "--profile", "local-d1-identity"];
  async function control(command: string, args: string[], cleanup = false): Promise<JsonObject> {
    let stdout: string;
    try {
      ({ stdout } = await exec(controlBin, [...controlPrefix, command, ...args], {
        cwd: root, env: controlEnv, timeout: cleanup ? 15_000 : remaining(), maxBuffer: 256 * 1024,
      }));
    } catch (error) {
      stdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
    }
    let envelope: JsonObject;
    try { envelope = object(JSON.parse(stdout)); }
    catch { throw new Error(`Development control ${command} failed or returned invalid JSON`); }
    if (envelope.ok !== true) {
      throw new ControlFailure(typeof envelope.code === "string" ? envelope.code : "INVALID_RESPONSE",
        envelope.code === "CONTROL_IO" && envelope.detail === "No such file or directory (os error 2)", command);
    }
    if (envelope.command !== command || (command !== "start" && envelope.session !== session)) {
      throw new Error(`Development control ${command} returned a different session`);
    }
    return envelope;
  }
  const close = (): Promise<void> => {
    closing ??= (async () => {
      let receiptCurrent = false;
      let currentError: unknown;
      if (verifyAcceptanceCurrent !== undefined) {
        try { await verifyAcceptanceCurrent(); receiptCurrent = true; }
        catch (error) { currentError = error; }
      }
      closed = true;
      if (!owned || !session) { await rm(testState, { recursive: true, force: true }); return; }
      const stopOwned = async (): Promise<void> => {
        try {
          const stopped = object((await control("stop", flags(), true)).result);
          if (stopped.stopped !== true) throw new Error("Owned session stop was not acknowledged");
        } catch (stopError) {
          // Stop can remove its socket before acknowledging. Only absence of this exact owner is sufficient.
          try { await control("discover", flags(), true); }
          catch (error) {
            if (error instanceof ControlFailure && error.endpointAbsent) return;
            throw new Error("Owned draft session cleanup could not verify endpoint absence");
          }
          const reason = stopError instanceof ControlFailure ? stopError.code : "invalid stop response";
          throw new Error(`Owned draft session cleanup failed; its endpoint still exists (${reason})`);
        }
      };
      await stopOwned();
      await rm(testState, { recursive: true, force: true });
      for (const remove of browserListeners) remove();
      if (currentError !== undefined) throw currentError;
      if (receiptCurrent && acceptanceIdentity !== undefined && process.env.CAN_ACCEPTANCE_OUTPUT !== undefined) {
        await mkdir(process.env.CAN_ACCEPTANCE_OUTPUT, { recursive: true });
        await writeFile(resolve(process.env.CAN_ACCEPTANCE_OUTPUT, "browser-session.json"), `${JSON.stringify({
          source, sourceRevision: acceptanceIdentity.sourceRevision, servingBuild: acceptanceIdentity.servingBuild,
          browserNavigations, closed: true,
        }, null, 2)}\n`);
      }
    })();
    return closing;
  };
  function current(status: JsonObject): boolean {
    return status.schema === "can.dev.status.v1" && status.session === session && status.app === app &&
      status.profile === "local-d1-identity" && status.preview === "ready" && status.dirty === false &&
      status.stale === false && status.capture_error === null && typeof status.revision === "string" &&
      status.serving_revision === status.revision && typeof status.source_revision === "string" &&
      typeof status.serving_build === "string";
  }
  try {
    const started = await control("start", ["--root", root, "--source", source, "--app", app,
      ...(options.previewRoles === undefined ? [] : ["--preview-roles", JSON.stringify(options.previewRoles)])]);
    session = text(started.session, "session");
    const start = object(started.result);
    owned = start.attached === false;
    if (!owned) throw new Error("An existing session owns this draft; implicit attachment is ambiguous");
    if (acceptanceSource !== undefined && process.env.CAN_ACCEPTANCE_OUTPUT !== undefined) {
      await mkdir(process.env.CAN_ACCEPTANCE_OUTPUT, { recursive: true });
      const ownerKey = createHash("sha256").update(session).digest("hex");
      await writeFile(resolve(process.env.CAN_ACCEPTANCE_OUTPUT, `browser-owner-${ownerKey}.json`), `${JSON.stringify({
        workspace: root, source, session, app, owned: true,
      }, null, 2)}\n`);
    }
    let status = object((await control("status", flags())).result);
    while (!current(status)) {
      const observation = object(status.observation);
      // Manual start publishes control readiness before any source revision.
      // Request its first check explicitly; an active or automatic check owns
      // its existing work and must settle without a competing request.
      if (observation.mode === "manual" && observation.operation === null) {
        const check = object((await control("check", flags())).result);
        status = object((await control("status", flags())).result);
        if (!current(status)) {
          const state = typeof check.state === "string" && /^[a-z_]+$/.test(check.state) ? check.state : "unavailable";
          const reason = typeof check.preview_reason === "string" && /^[a-z_]+$/.test(check.preview_reason)
            ? check.preview_reason : "preview_unavailable";
          throw new Error(`Draft has no current admitted serving preview (${state}, ${reason}); unsupported or failed profiles must be fixed`);
        }
        break;
      }
      await new Promise<void>(done => setTimeout(done, remaining(250)));
      status = object((await control("status", flags())).result);
    }
    const identity = Object.freeze({ revision: text(status.revision, "revision"),
      sourceRevision: text(status.source_revision, "source revision"), servingBuild: text(status.serving_build, "serving build") });
    const assertCurrent = async (): Promise<void> => {
      if (closed) throw new Error("Draft session is closed");
      const state = object((await control("status", flags())).result);
      if (!current(state) || state.revision !== identity.revision || state.source_revision !== identity.sourceRevision ||
          state.serving_build !== identity.servingBuild) throw new Error("Draft source or serving identity changed; this run is invalidated");
    };
    if (acceptanceSource !== undefined) {
      acceptanceIdentity = identity;
      verifyAcceptanceCurrent = assertCurrent;
    }
    let origin: string | undefined;
    const authenticate = async (context: BrowserContext, actorLabel: string | null = "Ava"): Promise<string> => {
      await assertCurrent();
      const opened = object((await control("preview.open", flags())).result);
      if (opened.schema !== "can.dev.preview-open.v1" || opened.serving_build !== identity.servingBuild) {
        throw new Error("Protected preview changed before authentication");
      }
      let bootstrap: URL;
      try { bootstrap = new URL(text(opened.url, "protected preview URL")); }
      catch { throw new Error("Protected preview issued an invalid URL"); }
      if (bootstrap.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(bootstrap.hostname) ||
          bootstrap.username || bootstrap.password || (origin !== undefined && origin !== bootstrap.origin)) {
        throw new Error("Protected preview must retain its loopback HTTP origin");
      }
      origin = bootstrap.origin;
      if (acceptanceSource !== undefined && !watchedContexts.has(context)) {
        watchedContexts.add(context);
        const watchPage = (page: Page): void => {
          const navigation = (response: BrowserResponse): void => {
            if (response.status() < 200 || response.status() >= 300 || !response.request().isNavigationRequest()) return;
            try {
              if (response.frame() === page.mainFrame() && new URL(response.url()).origin === origin) browserNavigations += 1;
            } catch { /* Closed/detached frames cannot establish candidate navigation. */ }
          };
          page.on("response", navigation);
          browserListeners.push(() => page.off("response", navigation));
        };
        context.on("page", watchPage);
        browserListeners.push(() => context.off("page", watchPage));
        for (const page of context.pages()) watchPage(page);
      }
      if (!Array.isArray(opened.actors)) throw new Error("Protected preview lacks real seeded Identity actors");
      const actors = opened.actors.map(object).filter(actor => actor.label === actorLabel);
      if (actorLabel !== null && actors.length !== 1) throw new Error("Requested seeded Identity actor is absent or ambiguous");
      // Native fetch keeps bootstrap URLs, login bodies and auth responses out of Playwright traces.
      const jar = new Map<string, { value: string; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None"; path: string; expires: number }>();
      async function request(url: string, phase: string, init: RequestInit = {}): Promise<Response> {
        try {
          const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(remaining(15_000)),
            headers: { cookie: [...jar].map(([name, cookie]) => `${name}=${cookie.value}`).join("; "), ...init.headers } });
          for (const raw of response.headers.getSetCookie()) {
            const [pair, ...attributes] = raw.split(";");
            const separator = pair!.indexOf("=");
            if (separator < 1) throw new Error("Invalid cookie");
            const name = pair!.slice(0, separator).trim();
            const cookie = { value: pair!.slice(separator + 1), httpOnly: false, secure: false,
              sameSite: "Lax" as "Strict" | "Lax" | "None", path: "/", expires: -1 };
            for (const attribute of attributes) {
              const [key, ...rest] = attribute.trim().split("=");
              const value = rest.join("=");
              switch (key!.toLowerCase()) {
                case "httponly": cookie.httpOnly = true; break;
                case "secure": cookie.secure = true; break;
                case "path": cookie.path = value; break;
                case "samesite":
                  if (/^(Strict|Lax|None)$/i.test(value)) cookie.sameSite = (value[0]!.toUpperCase() + value.slice(1).toLowerCase()) as typeof cookie.sameSite;
                  break;
                case "max-age": cookie.expires = Date.now() / 1000 + Number(value); break;
                case "expires": if (cookie.expires === -1) cookie.expires = Date.parse(value) / 1000; break;
              }
            }
            if (cookie.expires !== -1 && cookie.expires <= Date.now() / 1000) jar.delete(name);
            else jar.set(name, cookie);
          }
          return response;
        } catch { throw new Error(`Local Identity ${phase} request failed`); }
      }
      const json = async (response: Response, phase: string): Promise<JsonObject> => {
        if (response.status !== 200) throw new Error(`Local Identity ${phase} returned HTTP ${response.status}`);
        try { return object(await response.json()); }
        catch { throw new Error(`Local Identity ${phase} returned invalid JSON`); }
      };
      const boot = await request(bootstrap.href, "bootstrap");
      if (![200, 302, 303, 401, 403].includes(boot.status) || jar.size === 0) throw new Error("Protected preview bootstrap failed to issue its access cookie");
      await boot.body?.cancel();
      if (actorLabel === null) {
        if (jar.has("can_session") || (await context.cookies(origin)).some(cookie => cookie.name === "can_session")) {
          throw new Error("Anonymous preview needs a fresh browser context without Identity cookies");
        }
        await context.addCookies([...jar].map(([name, cookie]) => ({ name, ...cookie, domain: bootstrap.hostname })));
        await assertCurrent();
        return origin;
      }
      const actor = actors[0]!;
      const email = text(actor.email, "actor email");
      const password = text(actor.password, "actor credential");
      if (!Array.isArray(actor.teams)) throw new Error("Seeded Identity actor lacks team membership information");
      const descriptor = await json(await request(`${origin}/auth/login`, "descriptor"), "descriptor");
      const preSessionToken = text(descriptor.preSessionToken, "pre-session token");
      const login = await request(`${origin}/auth/login`, "login", { method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password, _presession: preSessionToken }) });
      if (login.status !== 200 || !jar.has("can_session")) throw new Error("Local Identity login failed to issue a session cookie");
      await login.body?.cancel();
      if (actor.teams.length) {
        const runtimeRequire = createRequire(resolve(root, "package.json"));
        const identityModule = await import(pathToFileURL(runtimeRequire.resolve("@canlang/identity")).href) as {
          deriveCsrfToken(token: string): Promise<string>;
        };
        const csrf = await identityModule.deriveCsrfToken(decodeURIComponent(jar.get("can_session")!.value));
        const teams = await json(await request(`${origin}/auth/teams`, "team discovery"), "team discovery");
        if (!Array.isArray(teams.teams) || teams.teams.length !== 1) throw new Error("Local member must have one unambiguous Identity team");
        const team = text(object(teams.teams[0]).team_id, "owned team ID");
        const selection = await request(`${origin}/auth/select-team`, "team selection", { method: "POST",
          headers: { origin, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ team, _csrf: csrf }) });
        if (selection.status !== 200) throw new Error(`Local Identity team selection returned HTTP ${selection.status}`);
        await selection.body?.cancel();
      }
      try {
        await context.addCookies([...jar].map(([name, cookie]) => ({ name, ...cookie, domain: bootstrap.hostname })));
      } catch { throw new Error("Browser context could not receive local Identity cookies"); }
      await assertCurrent();
      return origin;
    };
    const runExamples = async (operation?: string, row?: number): Promise<unknown> => {
      if ((operation === undefined) !== (row === undefined) || (operation !== undefined && !/^[A-Za-z_][A-Za-z0-9_.]{0,199}$/.test(operation)) ||
          (row !== undefined && (!Number.isSafeInteger(row) || row < 0))) throw new Error("Example selection needs an operation and nonnegative row index");
      await assertCurrent();
      const result = object((await control("example.run", [...flags(), "--expected-revision", identity.revision,
        ...(operation === undefined ? [] : ["--operation", operation, "--row", String(row)])])).result);
      await assertCurrent();
      if (result.schema !== "can.dev.example-run.v1" || result.session !== session || result.revision !== identity.revision ||
          result.source_revision !== identity.sourceRevision || result.serving_build !== identity.servingBuild || result.current !== true) {
        throw new Error("Source examples did not retain the admitted serving identity");
      }
      return result;
    };
    return { session, app, identity, authenticate, assertCurrent, runExamples, close };
  } catch (error) {
    try { await close(); }
    catch {
      // Startup errors above are already sanitized; retain their useful phase
      // without exposing the raw control response, credentials or request body.
      const reason = error instanceof Error ? error.message : "unknown startup error";
      throw new Error(`Draft startup failed (${reason}) and its owned session cleanup could not be verified`);
    }
    throw error;
  }
}
