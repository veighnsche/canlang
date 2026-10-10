import { expect, it, vi } from "vitest";
import { JevHttpTransport, JevProviderRejected } from "../src/dev/jev-transport.js";
import type { JevChoiceRequest } from "../src/dev/jev-ranker.js";

const request: JevChoiceRequest = {
  model: "jev-latest", state: { guess: "metric" },
  questions: { construct_for_occurrence: {
    type: "choice", instructions: "choose", criteria: { "can.v1.then.metric": "metric", none: "none", unclear: "unclear" },
  } },
};

it("posts only the constructed packet with the configured key and returns bounded JSON", async () => {
  let seen = false;
  const transport = new JevHttpTransport(() => "test-key", async (url, init) => {
    seen = true;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(JSON.parse(String(init?.body))).toEqual(request);
    return new Response(JSON.stringify({ model: "jev-1.13.0" }), { status: 200 });
  });
  expect(await transport.choose(request, new AbortController().signal)).toEqual({ model: "jev-1.13.0" });
  expect(seen).toBe(true);
});

it("cancels rejected response streams without reading them or replacing the safe HTTP failure", async () => {
  for (const { status, cancellation } of [
    { status: 429, cancellation: "complete" },
    { status: 503, cancellation: "complete" },
    { status: 429, cancellation: "failed" },
    { status: 503, cancellation: "pending" },
  ] as const) {
    let reads = 0, cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() { reads++; throw new Error("private provider body must not be read"); },
      cancel() {
        cancellations++;
        if (cancellation === "failed") throw new Error("private cancellation failure");
        if (cancellation === "pending") return new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 });
    const response = new Response(body, { status });
    const getReader = vi.spyOn(body, "getReader");
    const transport = new JevHttpTransport(() => "test-key", async () => response);
    const result = transport.choose(request, new AbortController().signal);
    await expect(result).rejects.toMatchObject(status === 429
      ? { code: "PROVIDER_REJECTED", status, message: "Jev rejected the request with HTTP 429" }
      : { message: "Jev HTTP 503" });
    if (status === 503) await expect(result).rejects.not.toBeInstanceOf(JevProviderRejected);
    expect(cancellations).toBe(1);
    expect(reads).toBe(0);
    expect(getReader).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  }
  for (const status of [429, 503]) {
    const transport = new JevHttpTransport(() => "test-key", async () => new Response(null, { status }));
    await expect(transport.choose(request, new AbortController().signal)).rejects.toMatchObject(status === 429
      ? { code: "PROVIDER_REJECTED", status, message: "Jev rejected the request with HTTP 429" }
      : { message: "Jev HTTP 503" });
  }
  const missingKey = new JevHttpTransport(() => undefined, async () => { throw new Error("must not fetch"); });
  await expect(missingKey.choose(request, new AbortController().signal)).rejects.toThrow(/key is unavailable/);
});

it("rejects an overlong response before parsing it", async () => {
  const transport = new JevHttpTransport(() => "test-key", async () => new Response("x".repeat(65 * 1024), { status: 200 }));
  await expect(transport.choose(request, new AbortController().signal)).rejects.toThrow(/byte limit/);
});
