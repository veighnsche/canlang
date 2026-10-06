// V03.3 owned parser token + lineage checks.
//
// The host capped reader arrives by injection (the branch interfaces
// tree cannot compile into values). Scripted readers below prove
// pass-through plumbing: reader outcomes propagate untouched, and the
// parser adds only decode/parse/tokenize with host-stage errors. The
// owned-vs-host differential against the real readCappedBody runs on
// main; any divergence found there routes to the reader owner.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OWNED_JSON_MAX_BYTES,
  OwnedInputError,
  OwnedJsonToken,
  ownedJsonText,
  ownedJsonValue,
  parseOwnedJsonBody,
  readOwnedJson,
  type CappedBodyReader,
} from "../bindings/owned-input.js";

function post(body: string | Uint8Array | null): Request {
  if (body === null) {
    return new Request("http://owned.test/input", { method: "POST" });
  }
  return new Request("http://owned.test/input", { method: "POST", body });
}

/** Scripted reader: fixed bytes, records observed calls. */
function fixedReader(bytes: Uint8Array): CappedBodyReader & { calls: Array<{ maxBytes: number }> } {
  const calls: Array<{ maxBytes: number }> = [];
  const reader = (async (_request: Request, maxBytes: number) => {
    calls.push({ maxBytes });
    return bytes;
  }) as CappedBodyReader & { calls: Array<{ maxBytes: number }> };
  reader.calls = calls;
  return reader;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("owned json parser", () => {
  it("tokenizes objects with original key order and last-wins duplicates", async () => {
    const token = await parseOwnedJsonBody(post('{"b":1,"a":2,"b":3}'), fixedReader(utf8('{"b":1,"a":2,"b":3}')));
    const value = ownedJsonValue(token) as Record<string, number>;
    assert.deepEqual(Object.keys(value), ["b", "a"]);
    assert.equal(value.b, 3);
  });

  it("accepts scalar roots without semantic traversal", async () => {
    for (const [raw, expected] of [["5", 5], ['"x"', "x"], ["true", true], ["null", null]] as const) {
      const token = await parseOwnedJsonBody(post(raw), fixedReader(utf8(raw)));
      assert.deepEqual(ownedJsonValue(token), expected);
    }
  });

  it("accepts deep nests with identical references across reads", async () => {
    const raw = `{"a":${"[".repeat(100)}1${"]".repeat(100)}}`;
    const token = await parseOwnedJsonBody(post(raw), fixedReader(utf8(raw)));
    const first = ownedJsonValue(token);
    const second = readOwnedJson(token).value;
    assert.equal(first === second, true);
    assert.deepEqual(first, JSON.parse(raw));
  });

  it("rejects empty and whitespace bodies at the validation stage", async () => {
    for (const raw of ["", "  \n\t "]) {
      await assert.rejects(parseOwnedJsonBody(post(raw), fixedReader(utf8(raw))), (err: unknown) => {
        assert.ok(err instanceof OwnedInputError);
        assert.equal(err.code, "validation");
        assert.equal(err.message, "Invalid JSON body.");
        return true;
      });
    }
  });

  it("rejects malformed JSON at the validation stage", async () => {
    for (const raw of ["{", "[1,", "Infinity", "NaN", '"unterminated']) {
      await assert.rejects(parseOwnedJsonBody(post(raw), fixedReader(utf8(raw))), (err: unknown) => {
        assert.ok(err instanceof OwnedInputError);
        assert.equal(err.code, "validation");
        return true;
      });
    }
  });

  it("rejects raw control characters in strings like the host", async () => {
    const raw = '"a\nb"';
    await assert.rejects(parseOwnedJsonBody(post(raw), fixedReader(utf8(raw))), (err: unknown) => {
      assert.ok(err instanceof OwnedInputError);
      assert.equal(err.code, "validation");
      return true;
    });
  });

  it("strips a UTF-8 BOM via the default TextDecoder", async () => {
    const raw = '﻿{"a":1}';
    const token = await parseOwnedJsonBody(post(raw), fixedReader(utf8(raw)));
    assert.deepEqual(ownedJsonValue(token), { a: 1 });
    assert.equal(ownedJsonText(token), '{"a":1}');
  });

  it("keeps __proto__ as own data without polluting prototypes", async () => {
    const raw = '{"__proto__":{"x":1}}';
    const token = await parseOwnedJsonBody(post(raw), fixedReader(utf8(raw)));
    const value = ownedJsonValue(token) as Record<string, unknown>;
    assert.equal(Object.hasOwn(value, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  it("retains -0 and lone surrogates exactly", async () => {
    const token = await parseOwnedJsonBody(post("[0,-0]"), fixedReader(utf8("[0,-0]")));
    const pair = ownedJsonValue(token) as number[];
    assert.equal(Object.is(pair[1], -0), true);
    const lone = await parseOwnedJsonBody(post('"\\ud800"'), fixedReader(utf8('"\\ud800"')));
    const text = ownedJsonValue(lone) as string;
    assert.equal(text.length, 1);
    assert.equal(text.charCodeAt(0), 0xd800);
  });

  it("leaves form bodies to the form path (no sniffing)", async () => {
    await assert.rejects(
      parseOwnedJsonBody(post("a=1&b=2"), fixedReader(utf8("a=1&b=2"))),
      (err: unknown) => {
        assert.ok(err instanceof OwnedInputError);
        assert.equal(err.code, "validation");
        return true;
      },
    );
  });

  it("treats a null body as empty at the validation stage", async () => {
    const reader = fixedReader(new Uint8Array(0));
    await assert.rejects(parseOwnedJsonBody(post(null), reader), (err: unknown) => {
      assert.ok(err instanceof OwnedInputError);
      assert.equal(err.code, "validation");
      return true;
    });
  });

  it("propagates reader failures untouched by identity", async () => {
    const failure = new Error("reader blew up");
    const reader: CappedBodyReader = async () => {
      throw failure;
    };
    await assert.rejects(parseOwnedJsonBody(post("{}"), reader), (err: unknown) => {
      assert.equal(err === failure, true);
      return true;
    });
  });

  it("passes the default and explicit caps to the reader", async () => {
    assert.equal(OWNED_JSON_MAX_BYTES, 1_048_576);
    const reader = fixedReader(utf8("{}"));
    await parseOwnedJsonBody(post("{}"), reader);
    assert.deepEqual(reader.calls, [{ maxBytes: 1_048_576 }]);
    await parseOwnedJsonBody(post("{}"), reader, 16);
    assert.deepEqual(reader.calls[1], { maxBytes: 16 });
  });

  it("freezes the token and records byte length", async () => {
    const token = await parseOwnedJsonBody(post("[1]"), fixedReader(utf8("[1]")));
    assert.equal(Object.isFrozen(token), true);
    assert.equal(token.brand(), "owned-json");
    const record = readOwnedJson(token);
    assert.equal(record.byteLength, 3);
    assert.equal(record.text, "[1]");
    assert.deepEqual(record.bytes, utf8("[1]"));
  });
});

describe("owned token lineage", () => {
  it("rejects forged tokens, fresh tokens and schema tags", async () => {
    const token = await parseOwnedJsonBody(post("{}"), fixedReader(utf8("{}")));
    assert.deepEqual(ownedJsonValue(token), {});
    for (const forged of [{}, { __owned: true }, new OwnedJsonToken(), null, undefined, 5, "x"]) {
      assert.throws(() => readOwnedJson(forged as OwnedJsonToken), (err: unknown) => {
        assert.ok(err instanceof OwnedInputError);
        assert.equal(err.code, "forged-token");
        return true;
      });
      assert.throws(() => ownedJsonValue(forged as OwnedJsonToken), OwnedInputError);
      assert.throws(() => ownedJsonText(forged as OwnedJsonToken), OwnedInputError);
    }
  });

  it("rejects proxies around genuine tokens", async () => {
    const token = await parseOwnedJsonBody(post("{}"), fixedReader(utf8("{}")));
    const proxy = new Proxy(token, {});
    assert.throws(() => readOwnedJson(proxy), (err: unknown) => {
      assert.ok(err instanceof OwnedInputError);
      assert.equal(err.code, "forged-token");
      return true;
    });
    // The genuine token still resolves: proxies never poison lineage.
    assert.deepEqual(ownedJsonValue(token), {});
  });

  it("keeps lineage per token across many parses", async () => {
    const first = await parseOwnedJsonBody(post("[1]"), fixedReader(utf8("[1]")));
    const second = await parseOwnedJsonBody(post("[2]"), fixedReader(utf8("[2]")));
    assert.deepEqual(ownedJsonValue(first), [1]);
    assert.deepEqual(ownedJsonValue(second), [2]);
  });
});
