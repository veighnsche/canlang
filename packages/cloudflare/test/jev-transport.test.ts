import { expect, it } from "vitest";
import { JevHttpTransport } from "../src/dev/jev-transport.js";
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

it("classifies provider rejection without reading or forwarding its body", async () => {
  const transport = new JevHttpTransport(() => "test-key", async () => new Response("private provider body", { status: 429 }));
  await expect(transport.choose(request, new AbortController().signal)).rejects.toMatchObject({
    code: "PROVIDER_REJECTED", status: 429,
  });
  const missingKey = new JevHttpTransport(() => undefined, async () => { throw new Error("must not fetch"); });
  await expect(missingKey.choose(request, new AbortController().signal)).rejects.toThrow(/key is unavailable/);
});

it("rejects an overlong response before parsing it", async () => {
  const transport = new JevHttpTransport(() => "test-key", async () => new Response("x".repeat(65 * 1024), { status: 200 }));
  await expect(transport.choose(request, new AbortController().signal)).rejects.toThrow(/byte limit/);
});
