import { describe, expect, it } from "vitest";
import type { LocalDev } from "../src/dev/local-run.js";
import { startProtectedPreview } from "../src/dev/preview-bridge.js";
import { toMcpError } from "@canlang/interfaces";

function cookieOf(response: Response): string {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("bootstrap did not set an access cookie");
  return raw.split(";", 1)[0]!;
}

describe("protected local preview", () => {
  it("mints a one-use access URL and relays authorized bytes without passing bridge identity to the app", async () => {
    const seen: Array<{ url: string; init: unknown }> = [];
    const dev: Pick<LocalDev, "dispatchUrl"> = {
      dispatchUrl: async (url, init) => {
        seen.push({ url, init });
        const headers = new Headers();
        headers.append("set-cookie", "can_session=app-one; HttpOnly; Path=/");
        headers.append("set-cookie", "app_pref=two; Path=/");
        headers.set("content-type", "application/octet-stream");
        headers.set("x-app-header", "kept");
        return new Response(Buffer.from([0, 255, 1]), { status: 206, headers }) as unknown as Awaited<ReturnType<LocalDev["dispatchUrl"]>>;
      },
    };
    const preview = await startProtectedPreview(dev, { maxBodyBytes: 4 });
    try {
      expect(new URL(preview.url).hostname).toBe("127.0.0.1");
      expect(new URL(preview.url).port).not.toBe("0");
      const unauthenticated = await fetch(`${preview.url}/app`);
      expect(unauthenticated.status).toBe(401);
      expect(seen).toHaveLength(0);

      const openUrl = preview.issueOpenUrl();
      const bootstrap = await fetch(openUrl, { redirect: "manual" });
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get("location")).toBe("/");
      expect(bootstrap.headers.get("cache-control")).toBe("no-store");
      expect(bootstrap.headers.get("referrer-policy")).toBe("no-referrer");
      const setCookie = bootstrap.headers.get("set-cookie")!;
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).not.toContain(new URL(openUrl).searchParams.get("token")!);
      const accessCookie = cookieOf(bootstrap);
      expect((await fetch(openUrl, { redirect: "manual" })).status).toBe(403);

      const relayed = await fetch(`${preview.url}/asset?x=1`, {
        headers: { cookie: `${accessCookie}; can_session=app-one` },
      });
      expect(relayed.status).toBe(206);
      expect(Array.from(new Uint8Array(await relayed.arrayBuffer()))).toEqual([0, 255, 1]);
      expect(relayed.headers.get("x-app-header")).toBe("kept");
      expect(relayed.headers.getSetCookie()).toEqual([
        "can_session=app-one; HttpOnly; Path=/",
        "app_pref=two; Path=/",
      ]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`${preview.url}/asset?x=1`);
      const sent = seen[0]!.init as { headers: Array<[string, string]>; redirect: string };
      expect(new Headers(sent.headers).get("cookie")).toBe("can_session=app-one");
      expect(sent.redirect).toBe("manual");

      const missingOrigin = await fetch(`${preview.url}/write`, {
        method: "POST", headers: { cookie: accessCookie }, body: "ok",
      });
      expect(missingOrigin.status).toBe(403);
      const foreignOrigin = await fetch(`${preview.url}/write`, {
        method: "POST", headers: { cookie: accessCookie, origin: "http://evil.invalid" }, body: "ok",
      });
      expect(foreignOrigin.status).toBe(403);
      const tooLarge = await fetch(`${preview.url}/write`, {
        method: "POST", headers: { cookie: accessCookie, origin: preview.url }, body: "12345",
      });
      expect(tooLarge.status).toBe(413);
      const accepted = await fetch(`${preview.url}/write`, {
        method: "POST", headers: { cookie: accessCookie, origin: preview.url }, body: "1234",
      });
      expect(accepted.status).toBe(206);
      expect(seen).toHaveLength(2);
      expect(seen[1]!.url).toBe(`${preview.url}/write`);
      expect(Array.from((seen[1]!.init as { body: Buffer }).body)).toEqual([49, 50, 51, 52]);
    } finally {
      await preview.close();
      await preview.close();
    }
    expect(() => preview.issueOpenUrl()).toThrow(/closed/);
  });

  it("expires bootstrap and access cookies and refuses app attempts to set the bridge cookie", async () => {
    let now = 1_000;
    let calls = 0;
    const dev: Pick<LocalDev, "dispatchUrl"> = {
      dispatchUrl: async () => {
        calls += 1;
        return new Response("app", { headers: { "set-cookie": "can_dev_preview=forged; Path=/" } }) as unknown as Awaited<ReturnType<LocalDev["dispatchUrl"]>>;
      },
    };
    const preview = await startProtectedPreview(dev, {
      now: () => now,
      bootstrapTtlMs: 1000,
      cookieTtlMs: 2000,
    });
    try {
      const stale = preview.issueOpenUrl();
      now += 1000;
      expect((await fetch(stale, { redirect: "manual" })).status).toBe(403);
      const openUrl = preview.issueOpenUrl();
      const bootstrap = await fetch(openUrl, { redirect: "manual" });
      expect(bootstrap.status).toBe(303);
      const cookie = cookieOf(bootstrap);
      const conflict = await fetch(`${preview.url}/`, { headers: { cookie } });
      expect(conflict.status).toBe(502);
      expect(await conflict.json()).toEqual({ code: "preview_cookie_conflict" });
      expect(calls).toBe(1);
      now += 2000;
      expect((await fetch(`${preview.url}/`, { headers: { cookie } })).status).toBe(401);
      expect(calls).toBe(1);
    } finally {
      await preview.close();
    }
  });

  it("observes dispatched business refusals without changing bytes or exposing response secrets", async () => {
    const secret = "member-secret-and-row-value";
    const body = JSON.stringify({ error: { code: "forbidden", message: secret, fields: [{ path: "/private", message: secret }] } });
    const dev: Pick<LocalDev, "dispatchUrl"> = {
      dispatchUrl: async url => new Response(url.endsWith("/big") ? `${body}${" ".repeat(8 * 1024)}` : body, {
        status: 401, headers: { "content-type": "application/json; charset=utf-8", "x-secret": secret },
      }) as Awaited<ReturnType<LocalDev["dispatchUrl"]>>,
    };
    const preview = await startProtectedPreview(dev);
    const events: unknown[] = [];
    const unsubscribe = preview.observeRefusals(event => { events.push(event); throw new Error("observer failed"); });
    try {
      // Bridge authentication is not a business refusal.
      expect((await fetch(`${preview.url}/mcp`)).status).toBe(401);
      expect(events).toHaveLength(0);
      const bootstrap = await fetch(preview.issueOpenUrl(), { redirect: "manual" });
      const cookie = cookieOf(bootstrap);
      const response = await fetch(`${preview.url}/mcp`, { headers: { cookie, authorization: `Bearer ${secret}` } });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("x-secret")).toBe(secret);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 401, error: { code: "forbidden" } });
      expect((events[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(Object.keys((events[0] as { error: object }).error)).toEqual(["code", "message", "retryable"]);
      const large = await fetch(`${preview.url}/big`, { headers: { cookie } });
      expect((await large.text()).length).toBeGreaterThan(8 * 1024);
      expect(events).toHaveLength(1);
      unsubscribe();
      await fetch(`${preview.url}/mcp`, { headers: { cookie } });
      expect(events).toHaveLength(1);
    } finally {
      await preview.close();
    }
  });

  it("keeps the Worker's retryable fact in a safe observation without changing HTTP bytes", async () => {
    const secret = "secret-worker-message-and-field";
    const bodies = {
      busy: JSON.stringify({ error: { code: "busy", message: secret, retryable: true,
        operation_id: "private.operation", fields: [{ path: "/secret", message: secret }] } }),
      override: JSON.stringify({ error: { code: "busy", message: secret, retryable: false } }),
      default: JSON.stringify({ error: { code: "delivery_unknown", message: secret } }),
    };
    const dev: Pick<LocalDev, "dispatchUrl"> = {
      dispatchUrl: async url => new Response(
        url.endsWith("/override") ? bodies.override : url.endsWith("/default") ? bodies.default : bodies.busy,
        { status: 503, headers: { "content-type": "application/json", "x-worker-secret": secret } },
      ) as Awaited<ReturnType<LocalDev["dispatchUrl"]>>,
    };
    const preview = await startProtectedPreview(dev);
    const events: Array<{ error: { code: string; message: string; retryable?: boolean } }> = [];
    const unsubscribe = preview.observeRefusals(event => events.push(event));
    try {
      const bootstrap = await fetch(preview.issueOpenUrl(), { redirect: "manual" });
      const cookie = cookieOf(bootstrap);
      for (const [path, expectedBody, retryable] of [
        ["busy", bodies.busy, true], ["override", bodies.override, false], ["default", bodies.default, true],
      ] as const) {
        const response = await fetch(`${preview.url}/${path}`, { headers: { cookie } });
        expect(response.status).toBe(503);
        expect(await response.text()).toBe(expectedBody);
        expect(response.headers.get("x-worker-secret")).toBe(secret);
        expect(events.at(-1)?.error).toMatchObject({ retryable });
      }
      expect(events).toHaveLength(3);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain("private.operation");
      expect(JSON.stringify(events)).not.toContain("/secret");
      expect(events.map(event => Object.keys(event.error))).toEqual([
        ["code", "message", "retryable"], ["code", "message", "retryable"], ["code", "message", "retryable"],
      ]);
    } finally {
      unsubscribe();
      await preview.close();
    }
  });

  it("observes only matched MCP tool business errors while relaying the real HTTP 200 response", async () => {
    const secret = "PRIVATE_TOOL_VALUES";
    const canonical = toMcpError({ code: "busy", message: secret, retryable: true,
      fields: [{ path: "/PRIVATE_FIELD", code: "PRIVATE_CODE", message: secret }] });
    let result: unknown = canonical;
    let id: unknown = 7;
    let protocolError = false;
    let oversized = false;
    const dev: Pick<LocalDev, "dispatchUrl"> = {
      dispatchUrl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id,
        ...(protocolError ? { error: { code: -32602, message: secret } } : { result }) }) +
        (oversized ? " ".repeat(8 * 1024) : ""), {
        headers: { "content-type": "application/json", "x-worker-secret": secret },
      }) as Awaited<ReturnType<LocalDev["dispatchUrl"]>>,
    };
    const preview = await startProtectedPreview(dev);
    const events: unknown[] = [];
    preview.observeRefusals(event => events.push(event));
    try {
      const cookie = cookieOf(await fetch(preview.issueOpenUrl(), { redirect: "manual" }));
      const call = async (path = "/mcp", method = "tools/call") => fetch(preview.url + path, {
        method: "POST", headers: { cookie, origin: preview.url, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method,
          params: { name: "PRIVATE_OPERATION", arguments: { secret } } }),
      });
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: canonical });
      expect(response.headers.get("x-worker-secret")).toBe(secret);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 200, transport: "mcp",
        error: { code: "busy", retryable: true } });
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_/);

      // Ordinary success may contain error-looking business values.
      result = { ...canonical, isError: false };
      await call();
      result = canonical;
      id = 8;
      await call();
      id = 7;
      await call("/other");
      await call("/mcp", "tools/list");
      protocolError = true;
      await call();
      protocolError = false;
      result = { ...canonical, structuredContent: { code: "unknown", message: secret } };
      await call();
      result = canonical;
      oversized = true;
      await call();
      expect(events).toHaveLength(1);
    } finally { await preview.close(); }
  });

  it.each(["dispatch", "response body"] as const)(
    "closes an active preview when the Worker %s never settles",
    async stage => {
      let entered!: () => void;
      const inWorker = new Promise<void>(resolve => { entered = resolve; });
      let signal: AbortSignal | null | undefined;
      const dev: Pick<LocalDev, "dispatchUrl"> = {
        dispatchUrl: async (_url, init) => {
          signal = init?.signal;
          if (stage === "dispatch") {
            entered();
            return new Promise<Awaited<ReturnType<LocalDev["dispatchUrl"]>>>(() => {});
          }
          const response = new Response("unused");
          Object.defineProperty(response, "arrayBuffer", { value: () => {
            entered();
            return new Promise<ArrayBuffer>(() => {});
          } });
          return response as Awaited<ReturnType<LocalDev["dispatchUrl"]>>;
        },
      };
      const preview = await startProtectedPreview(dev);
      try {
        const bootstrap = await fetch(preview.issueOpenUrl(), { redirect: "manual" });
        const pendingRequest = fetch(`${preview.url}/`, {
          headers: { cookie: cookieOf(bootstrap) },
        }).then(() => "fulfilled", () => "rejected");
        await inWorker;
        const closing = preview.close();
        expect(preview.close()).toBe(closing);
        await closing;
        expect(signal?.aborted).toBe(true);
        expect(await pendingRequest).toBe("rejected");
      } finally {
        await preview.close();
      }
    },
  );
});
