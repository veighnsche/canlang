// V03.3 owned parser token + lineage checks.
//
// The host capped reader arrives by injection (the branch interfaces
// tree cannot compile into values). Scripted readers below prove
// pass-through plumbing: reader outcomes propagate untouched, and the
// parser adds decode/parse/tokenize and ownership-only freezing with
// host-stage errors, without semantic validation or a new depth cap. The
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

  it("preserves overflow and replacement decoding without normalization", async () => {
    const overflow = await parseOwnedJsonBody(post("1e400"), fixedReader(utf8("1e400")));
    assert.equal(ownedJsonValue(overflow), Infinity);
    const invalidUtf8 = new Uint8Array([0x22, 0xff, 0x22]);
    const token = await parseOwnedJsonBody(post(invalidUtf8), fixedReader(invalidUtf8));
    assert.equal(ownedJsonText(token), '"\ufffd"');
    assert.equal(ownedJsonValue(token), "\ufffd");
    assert.deepEqual(readOwnedJson(token).bytes, invalidUtf8);
  });

  it("isolates reader and byte handoff mutations while keeping record and value identities", async () => {
    const raw = '{"nested":{"value":1},"list":[2]}';
    const bytes = utf8(raw);
    const token = await parseOwnedJsonBody(post(raw), fixedReader(bytes));
    const record = readOwnedJson(token);
    const value = ownedJsonValue(token) as { nested: { value: number }; list: number[] };
    bytes.fill(0);
    const handedBytes = record.bytes;
    assert.notEqual(handedBytes, bytes);
    handedBytes.fill(0);
    assert.notEqual(record.bytes, record.bytes);
    assert.deepEqual(record.bytes, utf8(raw));
    assert.equal(record.byteLength, utf8(raw).length);
    assert.equal(record.text, raw);
    assert.equal(readOwnedJson(token), record);
    assert.equal(readOwnedJson(token).value, value);
    assert.equal(ownedJsonValue(token), value);
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.nested), true);
    assert.equal(Object.isFrozen(value.list), true);
    assert.throws(() => { value.nested.value = 9; }, TypeError);
    assert.throws(() => { value.list.push(3); }, TypeError);
    assert.throws(() => { Object.defineProperty(record, "value", { value: null }); }, TypeError);
    assert.equal(Reflect.set(record, "bytes", new Uint8Array(0)), false);
    const descriptor = Object.getOwnPropertyDescriptor(record, "bytes");
    assert.equal(typeof descriptor?.get, "function");
    assert.equal(descriptor?.enumerable, true);
    assert.deepEqual(value, { nested: { value: 1 }, list: [2] });
  });

  it("freezes deep parser trees iteratively without a depth cap", async () => {
    const depth = 20_000;
    const raw = `${"[".repeat(depth)}-0${"]".repeat(depth)}`;
    const token = await parseOwnedJsonBody(post(raw), fixedReader(utf8(raw)));
    let current = ownedJsonValue(token);
    for (let index = 0; index < depth; index += 1) {
      assert.ok(Array.isArray(current));
      assert.equal(Object.isFrozen(current), true);
      current = current[0];
    }
    assert.equal(Object.is(current, -0), true);
  });

  it("freezes wide parser arrays without spreading their elements", async () => {
    const raw = `[${"0,".repeat(100_000)}0]`;
    const token = await parseOwnedJsonBody(post(raw), fixedReader(utf8(raw)));
    const value = ownedJsonValue(token);
    assert.ok(Array.isArray(value));
    assert.equal(value.length, 100_001);
    assert.equal(value[100_000], 0);
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { value[100_000] = 1; }, TypeError);
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
