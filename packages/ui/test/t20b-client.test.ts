import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CSRF_FIELD } from "@canlang/contracts";
import type { DerivedOperationInputs } from "@canlang/contracts";
import {
  applyDocumentRerender,
  applyFormRerender,
  collectFormValues,
  GeneratedSubmitError,
  submitGeneratedForm,
} from "../src/client.js";
import type {
  DomControlLike,
  SubmitFetch,
  SubmitFetchInit,
} from "../src/client.js";
import { generatedForm } from "../src/forms.js";
import type { PresentationContext } from "@canlang/contracts";
import { loadHtml } from "./harness.js";

// T20b submit-client tests: flat-map collection, the S7 upload flow, the
// JSON envelope submit, and denial application. Fetch is always injected
// (scripted routes + call log); no test touches the network.

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: null,
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

const CREATE: DerivedOperationInputs = {
  operation: "Store.Gadget.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [{ name: "title", kind: "string", required: true }],
};

const FILE_CREATE: DerivedOperationInputs = {
  operation: "Ledger.Entry.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    { name: "title", kind: "string", required: true },
    {
      name: "doc",
      kind: "file",
      required: true,
      file: { valueShape: "opaque-file-id", format: "can-file" },
    },
  ],
};

const TWO_FILES: DerivedOperationInputs = {
  operation: "Ledger.Entry.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    {
      name: "doc",
      kind: "file",
      required: false,
      file: { valueShape: "opaque-file-id", format: "can-file" },
    },
    {
      name: "scan",
      kind: "file",
      required: false,
      file: { valueShape: "opaque-file-id", format: "can-file" },
    },
  ],
};

const FILE_UPDATE: DerivedOperationInputs = {
  operation: "Ledger.Entry.update",
  kind: "update",
  artifactVersion: 1,
  inputs: [
    { name: "record", kind: "ref", required: true, model: "Ledger.Entry", versioned: true },
    {
      name: "doc",
      kind: "file",
      required: false,
      file: { valueShape: "opaque-file-id", format: "can-file" },
    },
  ],
};

interface ScriptedRoute {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

interface SeenCall {
  readonly url: string;
  readonly init: SubmitFetchInit;
  readonly json: unknown;
}

function stubFetch(routes: readonly ScriptedRoute[]): { fetch: SubmitFetch; calls: SeenCall[] } {
  const calls: SeenCall[] = [];
  const fetch: SubmitFetch = async (url, init) => {
    let json: unknown;
    try {
      json = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    } catch {
      json = undefined;
    }
    calls.push({ url, init, json });
    const route = routes.find((entry) => entry.method === init.method && entry.url === url);
    if (route === undefined) {
      throw new Error(`unstubbed ${init.method} ${url}`);
    }
    return {
      status: route.status,
      headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
      text: async () => route.body,
    };
  };
  return { fetch, calls };
}

function baseFlat(extra: Record<string, string> = {}): Record<string, string> {
  return {
    operation: "Store.Gadget.create",
    operation_id: "op-1",
    [CSRF_FIELD]: "csrf-123",
    timezone: "UTC",
    ...extra,
  };
}

function pickCall(calls: readonly SeenCall[], method: string, url: string): SeenCall {
  const found = calls.find((call) => call.init.method === method && call.url === url);
  assert.ok(found !== undefined, `${method} ${url} was called`);
  return found;
}

describe("T20b form collection", () => {
  it("collects a rendered generated form from the DOM", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Store.Gadget.create",
      derived: CREATE,
      mode: "create",
      operationId: "op-1",
      timeZone: "UTC",
      submit: "Create",
      idPrefix: "store",
    });
    const page = await loadHtml(html);
    try {
      const element = page.document.querySelector("form");
      assert.ok(element !== null);
      const collected = await collectFormValues(
        element as unknown as { readonly elements: ArrayLike<DomControlLike> },
      );
      assert.equal(collected.flat["operation"], "Store.Gadget.create");
      assert.equal(collected.flat["operation_id"], "op-1");
      assert.equal(collected.flat[CSRF_FIELD], "csrf-123");
      assert.equal(collected.flat["timezone"], "UTC");
      assert.equal(collected.flat["inputs[title]"], "");
      assert.deepEqual(collected.files, []);
    } finally {
      await page.close();
    }
  });

  it("skips empty pickers and honors native checkbox semantics", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Ledger.Entry.create",
      derived: FILE_CREATE,
      mode: "create",
      operationId: "op-1",
      timeZone: "UTC",
      submit: "Create",
      idPrefix: "ledger",
    });
    const page = await loadHtml(html);
    try {
      const element = page.document.querySelector("form");
      assert.ok(element !== null);
      const collected = await collectFormValues(
        element as unknown as { readonly elements: ArrayLike<DomControlLike> },
      );
      // The unnamed picker contributes no flat member and no upload.
      assert.ok(!Object.keys(collected.flat).some((key) => key.includes("fakepath")));
      assert.deepEqual(collected.files, []);
      assert.equal(collected.flat["inputs[doc]"], "");
    } finally {
      await page.close();
    }
    // Native checkbox/radio shape via structural fakes.
    const fake = await collectFormValues({
      elements: [
        { name: "inputs[flag]", type: "checkbox", value: "true", checked: false },
        { name: "inputs[other]", type: "checkbox", value: "true", checked: true },
        { name: "plain", type: "text", value: "v" },
        { type: "text", value: "unnamed-skipped" },
        { name: "dup", type: "text", value: "first" },
        { name: "dup", type: "text", value: "last" },
      ],
    });
    assert.deepEqual(fake.flat, { "inputs[other]": "true", plain: "v", dup: "last" });
    assert.deepEqual(fake.files, []);
  });

  it("collects picked bytes and rejects named file controls", async () => {
    const page = await loadHtml("<form></form>");
    try {
      const real = new File(["bye"], "a.pdf", { type: "application/pdf" });
      const collected = await collectFormValues({
        elements: [
          {
            type: "file",
            value: "C:\\fakepath\\a.pdf",
            files: [real],
            getAttribute: (name: string) => (name === "data-can-file" ? "doc" : null),
          },
        ],
      });
      assert.deepEqual(Object.keys(collected.flat), []);
      assert.equal(collected.files.length, 1);
      const file = collected.files[0];
      assert.ok(file !== undefined);
      assert.equal(file.field, "doc");
      assert.equal(file.name, "a.pdf");
      assert.equal(file.type, "application/pdf");
      assert.equal(file.size, 3);
      assert.deepEqual([...file.bytes], [98, 121, 101]);
    } finally {
      await page.close();
    }
    await assert.rejects(
      collectFormValues({
        elements: [{ name: "inputs[doc]", type: "file", files: [{ size: 1 } as never] }],
      }),
      /named file control "inputs\[doc\]" needs the S7 picker flow/,
    );
  });
});

describe("T20b envelope submit", () => {
  it("posts the JSON envelope with header CSRF and negotiates denials", async () => {
    const { fetch, calls } = stubFetch([
      {
        method: "POST",
        url: "/api/operations/Store.Gadget.create",
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ status: "committed", operation_id: "op-1" }),
      },
    ]);
    const result = await submitGeneratedForm({
      derived: CREATE,
      mode: "create",
      flat: baseFlat({ "inputs[title]": "wrench", operation: "tampered.Op", form_binding: "opaque-host-proof" }),
      action: "/api/operations/Store.Gadget.create",
      fragment: true,
      fetchImpl: fetch,
    });
    assert.deepEqual(result, {
      kind: "committed",
      result: { status: "committed", operation_id: "op-1" },
    });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    // The derivation's operation wins over the tampered flat-map member.
    assert.deepEqual(call.json, {
      operation: "Store.Gadget.create",
      operation_id: "op-1",
      inputs: { title: "wrench" },
      form_binding: "opaque-host-proof",
    });
    assert.equal(call.init.headers["content-type"], "application/json");
    assert.equal(call.init.headers["x-csrf-token"], "csrf-123");
    assert.equal(call.init.headers["accept"], "text/html");
    assert.equal(call.init.headers["HX-Request"], "true");
  });

  it("omits HX-Request on full-page submits", async () => {
    const { fetch, calls } = stubFetch([
      {
        method: "POST",
        url: "/x",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "replayed", operation_id: "op-1" }),
      },
    ]);
    const result = await submitGeneratedForm({
      derived: CREATE,
      mode: "create",
      flat: baseFlat({ "inputs[title]": "t" }),
      action: "/x",
      fragment: false,
      fetchImpl: fetch,
    });
    assert.equal(result.kind, "committed");
    assert.ok(!Object.hasOwn(calls[0]?.init.headers ?? {}, "HX-Request"));
  });

  it("returns fragment and document re-renders with their status", async () => {
    const fragment = stubFetch([
      {
        method: "POST",
        url: "/x",
        status: 422,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: '<div id="store-form">retry</div>',
      },
    ]);
    assert.deepEqual(
      await submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: true,
        fetchImpl: fragment.fetch,
      }),
      { kind: "rerender", html: '<div id="store-form">retry</div>', status: 422, fragment: true },
    );
    const full = stubFetch([
      {
        method: "POST",
        url: "/x",
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html>denied</html>",
      },
    ]);
    assert.deepEqual(
      await submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: false,
        fetchImpl: full.fetch,
      }),
      { kind: "rerender", html: "<html>denied</html>", status: 400, fragment: false },
    );
  });

  it("returns JSON denials with safe members only", async () => {
    const { fetch } = stubFetch([
      {
        method: "POST",
        url: "/x",
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          code: "forbidden",
          message: "Authentication required.",
          operation_id: "op-1",
          fields: [
            { path: "/title", code: "validation", message: "Bad." },
            { path: "/title", code: 7 },
          ],
          retryable: false,
          secret: "dropped",
        }),
      },
    ]);
    assert.deepEqual(
      await submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: true,
        fetchImpl: fetch,
      }),
      {
        kind: "denied",
        error: {
          code: "forbidden",
          message: "Authentication required.",
          operation_id: "op-1",
          fields: [{ path: "/title", code: "validation", message: "Bad." }],
          retryable: false,
        },
        status: 403,
      },
    );
  });

  it("rejects denials speaking an unknown error code", async () => {
    const { fetch } = stubFetch([
      {
        method: "POST",
        url: "/x",
        status: 499,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "bogus", message: "?" }),
      },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: false,
        fetchImpl: fetch,
      }),
      /carries no business error/,
    );
  });

  it("fails loud on contract breaks and reports usage faults", async () => {
    const htmlSuccess = stubFetch([
      { method: "POST", url: "/x", status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: true,
        fetchImpl: htmlSuccess.fetch,
      }),
      /answered success without its JSON result/,
    );
    const badResult = stubFetch([
      { method: "POST", url: "/x", status: 200, headers: { "content-type": "application/json" }, body: "{}" },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: false,
        fetchImpl: badResult.fetch,
      }),
      /answered no mutation result/,
    );
    const badDenial = stubFetch([
      { method: "POST", url: "/x", status: 500, headers: { "content-type": "text/plain" }, body: "boom" },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        action: "/x",
        fragment: false,
        fetchImpl: badDenial.fetch,
      }),
      /carries no business error/,
    );
  });

  it("wraps projection failures correctably before any fetch", async () => {
    const { fetch, calls } = stubFetch([]);
    const failing: DerivedOperationInputs = {
      operation: "Store.Gadget.create",
      kind: "create",
      artifactVersion: 1,
      inputs: [
        { name: "title", kind: "string", required: true },
        { name: "flag", kind: "boolean", required: false },
      ],
    };
    await assert.rejects(
      submitGeneratedForm({
        derived: failing,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t", "inputs[flag]": "yes" }),
        action: "/x",
        fragment: true,
        fetchImpl: fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GeneratedSubmitError);
        assert.equal(error.code, "projection");
        assert.equal(error.correctable, true);
        assert.equal(error.field, "flag");
        assert.match(error.message, /bool input "flag"/);
        return true;
      },
    );
    assert.deepEqual(calls, []);
  });

  it("rejects misshapen submit inputs without fetching", async () => {
    const { fetch, calls } = stubFetch([]);
    const run = (extra: Record<string, unknown>, action = "/x") =>
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: { ...baseFlat({ "inputs[title]": "t" }), ...(extra as Record<string, string>) },
        action,
        fragment: false,
        fetchImpl: fetch,
      });
    await assert.rejects(run({}, ""), /action must be a nonempty string/);
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: { operation_id: "", [CSRF_FIELD]: "c" },
        action: "/x",
        fragment: false,
        fetchImpl: fetch,
      }),
      /must carry its operation_id/,
    );
    await assert.rejects(run({ "inputs[title]": 7 }), /flat value for "inputs\[title\]" must be a string/);
    const { [CSRF_FIELD]: _dropped, ...noCsrf } = baseFlat({ "inputs[title]": "t" });
    void _dropped;
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: noCsrf,
        action: "/x",
        fragment: false,
        fetchImpl: fetch,
      }),
      /must carry its CSRF field/,
    );
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        files: [{ field: "nope", name: "a", type: "text/plain", size: 1, bytes: new Uint8Array([1]) }],
        action: "/x",
        fragment: false,
        fetchImpl: fetch,
      }),
      /unknown file field "nope"/,
    );
    await assert.rejects(
      submitGeneratedForm({
        derived: CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        files: [{ field: "title", name: "a", type: "text/plain", size: 1, bytes: new Uint8Array([1]) }],
        action: "/x",
        fragment: false,
        fetchImpl: fetch,
      }),
      /"title" is not a file input/,
    );
    assert.deepEqual(calls, []);
  });
});

describe("T20b S7 upload flow", () => {
  const INTENT = {
    intent_id: "in-1",
    content: "https://uploads.test/c1",
    finalize: "https://uploads.test/f1",
    expires_at: "2026-10-06T06:30:00.000Z",
  };

  it("mints intent, puts bytes, finalizes, then submits the opaque id", async () => {
    const { fetch, calls } = stubFetch([
      {
        method: "POST",
        url: "https://uploads.test/intents",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(INTENT),
      },
      { method: "PUT", url: INTENT.content, status: 200, body: "" },
      {
        method: "POST",
        url: INTENT.finalize,
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "file-opaque-1" }),
      },
      {
        method: "POST",
        url: "/api/operations/Ledger.Entry.create",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "committed", operation_id: "op-1" }),
      },
    ]);
    const result = await submitGeneratedForm({
      derived: FILE_CREATE,
      mode: "create",
      flat: baseFlat({ "inputs[title]": "t" }),
      files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 3, bytes: new Uint8Array([1, 2, 3]) }],
      action: "/api/operations/Ledger.Entry.create",
      fragment: true,
      intentsUrl: "https://uploads.test/intents",
      fetchImpl: fetch,
      mintUploadId: () => "up-1",
    });
    assert.equal(result.kind, "committed");
    assert.equal(calls.length, 4);
    const intent = pickCall(calls, "POST", "https://uploads.test/intents");
    assert.deepEqual(intent.json, {
      upload_id: "up-1",
      operation: "Ledger.Entry.create",
      field: "/doc",
      arguments: { title: "t" },
      name: "a.pdf",
      type: "application/pdf",
      size: "3",
    });
    assert.equal(intent.init.headers["x-csrf-token"], "csrf-123");
    const put = pickCall(calls, "PUT", INTENT.content);
    assert.equal(put.init.headers["content-type"], "application/octet-stream");
    assert.equal(put.init.headers["x-csrf-token"], "csrf-123");
    assert.deepEqual(put.init.body, new Uint8Array([1, 2, 3]));
    const op = pickCall(calls, "POST", "/api/operations/Ledger.Entry.create");
    assert.deepEqual(op.json, {
      operation: "Ledger.Entry.create",
      operation_id: "op-1",
      inputs: { title: "t", doc: "file-opaque-1" },
    });
  });

  it("points update intents at the changes slot", async () => {
    const { fetch, calls } = stubFetch([
      {
        method: "POST",
        url: "https://uploads.test/intents",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(INTENT),
      },
      { method: "PUT", url: INTENT.content, status: 200, body: "" },
      {
        method: "POST",
        url: INTENT.finalize,
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "file-opaque-2" }),
      },
      {
        method: "POST",
        url: "/api/operations/Ledger.Entry.update",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "committed", operation_id: "op-1" }),
      },
    ]);
    await submitGeneratedForm({
      derived: FILE_UPDATE,
      mode: "update",
      flat: {
        ...baseFlat(),
        "inputs[record][id]": "e1",
        "inputs[record][version]": "4",
      },
      files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([9]) }],
      action: "/api/operations/Ledger.Entry.update",
      fragment: false,
      intentsUrl: "https://uploads.test/intents",
      fetchImpl: fetch,
      mintUploadId: () => "up-2",
    });
    const intent = pickCall(calls, "POST", "https://uploads.test/intents");
    assert.deepEqual(intent.json, {
      upload_id: "up-2",
      operation: "Ledger.Entry.update",
      field: "/changes/doc",
      arguments: { record: { id: "e1", version: "4" } },
      name: "a.pdf",
      type: "application/pdf",
      size: "1",
    });
    const op = pickCall(calls, "POST", "/api/operations/Ledger.Entry.update");
    assert.deepEqual(op.json, {
      operation: "Ledger.Entry.update",
      operation_id: "op-1",
      inputs: { record: { id: "e1", version: "4" }, doc: "file-opaque-2" },
    });
  });

  it("uploads in derivation order with accumulating arguments", async () => {
    const second = { ...INTENT, intent_id: "in-2", content: "https://uploads.test/c2", finalize: "https://uploads.test/f2" };
    const seen: unknown[] = [];
    const fetch: SubmitFetch = async (url, init) => {
      if (url === "https://uploads.test/intents") {
        seen.push(typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined);
        const first = seen.length === 1;
        return {
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify(first ? INTENT : second),
        };
      }
      if (init.method === "PUT") {
        return { status: 200, headers: { get: () => null }, text: async () => "" };
      }
      if (url === INTENT.finalize) {
        return {
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ file: "file-1" }),
        };
      }
      if (url === second.finalize) {
        return {
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ file: "file-2" }),
        };
      }
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ status: "committed", operation_id: "op-1" }),
      };
    };
    // Files arrive reversed; derivation order (doc, scan) still wins.
    const result = await submitGeneratedForm({
      derived: TWO_FILES,
      mode: "create",
      flat: baseFlat(),
      files: [
        { field: "scan", name: "b.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([2]) },
        { field: "doc", name: "a.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([1]) },
      ],
      action: "/x",
      fragment: false,
      intentsUrl: "https://uploads.test/intents",
      fetchImpl: fetch,
      mintUploadId: () => "up-x",
    });
    assert.equal(result.kind, "committed");
    assert.equal(seen.length, 2);
    const first = seen[0] as Record<string, unknown>;
    const next = seen[1] as Record<string, unknown>;
    assert.equal(first["field"], "/doc");
    assert.deepEqual(first["arguments"], {});
    assert.equal(next["field"], "/scan");
    assert.deepEqual(next["arguments"], { doc: "file-1" });
  });

  it("reuses draft ids without uploads and mints upload ids by default", async () => {
    const { fetch, calls } = stubFetch([
      {
        method: "POST",
        url: "/x",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "committed", operation_id: "op-1" }),
      },
    ]);
    const result = await submitGeneratedForm({
      derived: FILE_CREATE,
      mode: "create",
      flat: baseFlat({ "inputs[title]": "t", "inputs[doc]": "file-opaque-9" }),
      action: "/x",
      fragment: false,
      fetchImpl: fetch,
    });
    assert.equal(result.kind, "committed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.json, {
      operation: "Ledger.Entry.create",
      operation_id: "op-1",
      inputs: { title: "t", doc: "file-opaque-9" },
    });

    // Default upload_id mint: Web Crypto randomUUID, no injection needed.
    let minted = "";
    const minting = stubFetch([
      {
        method: "POST",
        url: "https://uploads.test/intents",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(INTENT),
      },
      { method: "PUT", url: INTENT.content, status: 200, body: "" },
      {
        method: "POST",
        url: INTENT.finalize,
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "file-opaque-3" }),
      },
      {
        method: "POST",
        url: "/x",
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "committed", operation_id: "op-1" }),
      },
    ]);
    await submitGeneratedForm({
      derived: FILE_CREATE,
      mode: "create",
      flat: baseFlat({ "inputs[title]": "t" }),
      files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([1]) }],
      action: "/x",
      fragment: false,
      intentsUrl: "https://uploads.test/intents",
      fetchImpl: minting.fetch,
    });
    const intent = pickCall(minting.calls, "POST", "https://uploads.test/intents");
    minted = String((intent.json as Record<string, unknown>)["upload_id"] ?? "");
    assert.match(minted, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("requires the intents URL exactly when bytes are present", async () => {
    const { fetch, calls } = stubFetch([]);
    await assert.rejects(
      submitGeneratedForm({
        derived: FILE_CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([1]) }],
        action: "/x",
        fragment: false,
        fetchImpl: fetch,
      }),
      /file upload needs its intents URL/,
    );
    assert.deepEqual(calls, []);
  });

  it("fails uploads safely and loudly on contract breaks", async () => {
    const denied = stubFetch([
      {
        method: "POST",
        url: "https://uploads.test/intents",
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "validation", message: "File too large." }),
      },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: FILE_CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 9, bytes: new Uint8Array([1]) }],
        action: "/x",
        fragment: false,
        intentsUrl: "https://uploads.test/intents",
        fetchImpl: denied.fetch,
        mintUploadId: () => "up-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GeneratedSubmitError);
        assert.equal(error.code, "upload_failed");
        assert.equal(error.correctable, true);
        assert.match(error.message, /File too large\./);
        return true;
      },
    );
    const raw = stubFetch([
      { method: "POST", url: "https://uploads.test/intents", status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(INTENT) },
      { method: "PUT", url: INTENT.content, status: 500, body: "<html>stack</html>" },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: FILE_CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([1]) }],
        action: "/x",
        fragment: false,
        intentsUrl: "https://uploads.test/intents",
        fetchImpl: raw.fetch,
        mintUploadId: () => "up-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GeneratedSubmitError);
        assert.equal(error.code, "upload_failed");
        assert.ok(!error.message.includes("stack"));
        return true;
      },
    );
    const broken = stubFetch([
      { method: "POST", url: "https://uploads.test/intents", status: 200, headers: { "content-type": "application/json" }, body: "{}" },
    ]);
    await assert.rejects(
      submitGeneratedForm({
        derived: FILE_CREATE,
        mode: "create",
        flat: baseFlat({ "inputs[title]": "t" }),
        files: [{ field: "doc", name: "a.pdf", type: "application/pdf", size: 1, bytes: new Uint8Array([1]) }],
        action: "/x",
        fragment: false,
        intentsUrl: "https://uploads.test/intents",
        fetchImpl: broken.fetch,
        mintUploadId: () => "up-1",
      }),
      /must answer \{intent_id, content, finalize, expires_at\}/,
    );
  });
});

describe("T20b denial application", () => {
  it("swaps fragments into their stable target", async () => {
    const page = await loadHtml('<div id="store-form"><form>old</form></div>');
    try {
      applyFormRerender(page.document, "store", '<div id="store-form"><form>new</form></div>');
      assert.ok(page.document.body.innerHTML.includes("<form>new</form>"));
      assert.ok(!page.document.body.innerHTML.includes("<form>old</form>"));
    } finally {
      await page.close();
    }
    const missing = await loadHtml("<div></div>");
    try {
      assert.throws(
        () => applyFormRerender(missing.document, "store", "<div></div>"),
        /missing swap target "store-form"/,
      );
    } finally {
      await missing.close();
    }
  });

  it("swaps full-page denials over the document", async () => {
    const page = await loadHtml("<main>old page</main>");
    try {
      applyDocumentRerender(
        page.document,
        "<html><head></head><body><main>denied-doc</main></body></html>",
      );
      assert.ok(page.document.body.innerHTML.includes("denied-doc"));
      assert.ok(!page.document.body.innerHTML.includes("old page"));
    } finally {
      await page.close();
    }
  });
});
