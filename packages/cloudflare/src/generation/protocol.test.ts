/**
 * BGI-03 protocol tests: v1 request validation, envelopes, events,
 * capability preflight, and the MCP submission contract. Mirrors
 * the Rust `bgi03_config` coverage so both hosts enforce the same
 * frozen v1 shapes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADAPTERS,
  GEN_OPERATIONS,
  MCP_CONTEXT_TOOL,
  MCP_SUBMIT_TOOL,
  McpError,
  PreflightError,
  ProtocolError,
  adapterCapabilities,
  allowedOutputsFor,
  errorEnvelope,
  handleGrammarValid,
  okEnvelope,
  parseRequest,
  preflightRecipe,
  progressEvent,
  refineCarrier,
  validateSubmissionBatch,
  type GenerationContext,
} from "./protocol.js";
import { parseSettingsToml, resolveRecipe, type LoadedSettings } from "./config.js";

const SETTINGS = `version = 1

[generation]
runner = "codex"
model = "shared-model"
max_attempts = 2
timeout_seconds = 300

[generation.profiles.fast]
runner = "opencode"
model = "fast-model"
`;

function loaded(): LoadedSettings {
  return { source: { kind: "root", path: "can.gen.toml" }, settings: parseSettingsToml(SETTINGS) };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProtocolError);
    return error.code;
  }
  assert.fail("expected a ProtocolError");
}

test("request schema validation", () => {
  assert.equal(codeOf(() => parseRequest("{oops")), "invalid-json");
  assert.equal(codeOf(() => parseRequest("[1]")), "invalid-json");
  assert.equal(
    codeOf(() => parseRequest('{"request_id":"r1","operation":"doctor"}')),
    "missing-param",
  );
  assert.equal(
    codeOf(() => parseRequest('{"version":2,"request_id":"r1","operation":"doctor"}')),
    "unsupported-version",
  );
  assert.equal(codeOf(() => parseRequest('{"version":1,"operation":"doctor"}')), "missing-param");
  assert.equal(
    codeOf(() => parseRequest('{"version":1,"request_id":"  ","operation":"doctor"}')),
    "invalid-param",
  );
  assert.equal(codeOf(() => parseRequest('{"version":1,"request_id":"r1"}')), "missing-param");
  assert.equal(
    codeOf(() => parseRequest('{"version":1,"request_id":"r1","operation":"teleport"}')),
    "unknown-operation",
  );
  assert.equal(GEN_OPERATIONS.length, 19);
});

test("bind forwards zero-AI copy only when allocating a fresh unit", () => {
  const request = { version: 1, request_id: "copy", operation: "bind", root: ".", file: "copy.can", start: 0, end: 10, revision: "current", unit: "new", copy_from: "u1" };
  const admitted = parseRequest(JSON.stringify(request));
  assert.equal(admitted.params.kind, "bind");
  if (admitted.params.kind === "bind") assert.equal(admitted.params.params.copy_from, "u1");
  assert.equal(codeOf(() => parseRequest(JSON.stringify({ ...request, unit: "u2" }))), "invalid-param");
  assert.equal(codeOf(() => parseRequest(JSON.stringify({ ...request, copy_from: "" }))), "invalid-param");
});

test("unknown fields reject per operation", () => {
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"status","root":".","files":["a.can"],"profile":"fast"}',
      ),
    ),
    "unknown-field",
  );
  assert.equal(
    codeOf(() =>
      parseRequest('{"version":1,"request_id":"r1","operation":"doctor","runer":"codex"}'),
    ),
    "unknown-field",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"mode":"fresh","instruction":"x"}',
      ),
    ),
    "unknown-field",
  );
});

test("exclusive instruction carriers", () => {
  const base = (carriers: string): string =>
    `{"version":1,"request_id":"r1","operation":"refine","root":".","unit_id":"u1",${carriers}}`;
  assert.equal(codeOf(() => parseRequest(base('"accept":false'))), "exclusive-carrier");
  assert.equal(
    codeOf(() => parseRequest(base('"instruction":"a","instruction_file":"b.txt"'))),
    "exclusive-carrier",
  );
  assert.equal(
    codeOf(() => parseRequest(base('"instruction_stdin":false'))),
    "exclusive-carrier",
  );
  assert.equal(codeOf(() => parseRequest(base('"instruction":""'))), "invalid-param");
  assert.equal(codeOf(() => parseRequest(base('"instruction_file":""'))), "invalid-param");
  const text = parseRequest(base('"instruction":"do it"'));
  assert.equal(text.params.kind, "refine");
  if (text.params.kind === "refine") {
    assert.deepEqual(refineCarrier(text.params.params), { kind: "text", text: "do it" });
  }
  const file = parseRequest(base('"instruction_file":"note.txt"'));
  if (file.params.kind === "refine") {
    assert.deepEqual(refineCarrier(file.params.params), { kind: "file", path: "note.txt" });
  }
  const stdin = parseRequest(base('"instruction_stdin":true'));
  if (stdin.params.kind === "refine") {
    assert.deepEqual(refineCarrier(stdin.params.params), { kind: "stdin" });
  }
});

test("modes, scopes, and selector exclusivity", () => {
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"mode":"vibes"}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"generate","root":".","mode":"fresh"}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"unit_ids":["u1"],"mode":"fresh"}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest('{"version":1,"request_id":"r1","operation":"retry","root":".","files":[]}'),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() => parseRequest('{"version":1,"request_id":"r1","operation":"inspect","root":"."}')),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"inspect","root":".","unit_id":"u1","file":"a.can","start":1,"end":2}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"accept","root":".","unit_id":"u1","attempt":"a1"}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"cancel","root":".","session_id":"s","request":"r"}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest('{"version":1,"request_id":"r1","operation":"reset","root":"."}'),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() =>
      parseRequest(
        '{"version":1,"request_id":"r1","operation":"validate","root":".","unit_id":"u1","files":["a.can"]}',
      ),
    ),
    "invalid-param",
  );
  assert.equal(
    codeOf(() => parseRequest('{"version":1,"request_id":"r1","operation":"edit.begin","root":"."}')),
    "invalid-param",
  );
});

test("zero run limits refuse at admission", () => {
  // Zero is outside the positive-finite domain on every
  // recipe-bearing operation, before any recipe or launch.
  const bodies = [
    '{"version":1,"request_id":"r1","operation":"doctor","max_attempts":0,"timeout_seconds":0}',
    '{"version":1,"request_id":"r1","operation":"inspect","root":".","unit_id":"u1","max_attempts":0}',
    '{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"mode":"fresh","timeout_seconds":0}',
    '{"version":1,"request_id":"r1","operation":"refine","root":".","unit_id":"u1","instruction":"x","max_attempts":0}',
    '{"version":1,"request_id":"r1","operation":"retry","root":".","files":["a.can"],"timeout_seconds":0}',
  ];
  for (const body of bodies) {
    assert.equal(codeOf(() => parseRequest(body)), "invalid-param", body);
  }
  // Explicit finite positive overrides still admit.
  const admitted = parseRequest(
    '{"version":1,"request_id":"r1","operation":"doctor","max_attempts":3,"timeout_seconds":45}',
  );
  assert.equal(admitted.params.kind, "doctor");
  if (admitted.params.kind === "doctor") {
    assert.equal(admitted.params.params.max_attempts, 3);
    assert.equal(admitted.params.params.timeout_seconds, 45);
  }
  // Span offsets still admit zero.
  const span = parseRequest(
    '{"version":1,"request_id":"r1","operation":"inspect","root":".","file":"a.can","start":0,"end":1}',
  );
  assert.equal(span.params.kind, "inspect");
});

test("envelope and event shapes", () => {
  const ok = JSON.parse(
    okEnvelope(
      { request_id: "r42", operation: "refine" },
      "candidate",
      { state_note: "candidate" },
      ["next-a"],
    ) as unknown as string,
  ) as Record<string, unknown>;
  assert.equal(ok["version"], 1);
  assert.equal(ok["request_id"], "r42");
  assert.equal(ok["operation"], "refine");
  assert.equal(ok["ok"], true);
  assert.equal(ok["state"], "candidate");
  assert.deepEqual(ok["next"], ["next-a"]);
  const failed = JSON.parse(
    errorEnvelope("r42", "refine", "stale-selector", "stale", []) as unknown as string,
  ) as Record<string, unknown>;
  assert.equal(failed["ok"], false);
  assert.equal(failed["state"], "error");
  assert.deepEqual((failed["error"] as Record<string, unknown>)["code"], "stale-selector");
  const event = JSON.parse(
    progressEvent("r42", "refine", "capture", "reading sources") as unknown as string,
  ) as Record<string, unknown>;
  assert.equal(event["version"], 1);
  assert.equal(event["event"], "progress");
  assert.equal(event["phase"], "capture");
});

test("capability tables advertise all required adapters", () => {
  assert.equal(ADAPTERS.length, 4);
  for (const id of ["codex", "muse", "claude-code", "opencode"] as const) {
    const adapter = adapterCapabilities(id);
    assert.ok(adapter !== undefined, id);
    assert.equal(adapter.id, id);
    assert.ok(adapter.probe_binaries.length > 0, id);
    // Only the implemented Codex adapter may launch.
    assert.equal(adapter.mcp_attachment.state, id === "codex" ? "supported" : "unsupported");
    assert.equal(adapter.write_restriction.state, id === "codex" ? "supported" : "unsupported");
  }
  assert.equal(adapterCapabilities("teleport"), undefined);
});

test("preflight refuses before launch", () => {
  const resolved = resolveRecipe(loaded(), "given", null, {});
  assert.doesNotThrow(() => preflightRecipe(resolved));
  assert.throws(() => preflightRecipe({ ...resolved, runner: "muse" }), (error: unknown) => {
    assert.ok(error instanceof PreflightError);
    assert.equal(error.code, "unsupported-capability");
    assert.match(error.detail, /MCP/);
    assert.match(error.detail, /before launch/);
    return true;
  });
  const native = resolveRecipe(loaded(), "given", null, { native: { mystery: true } });
  assert.throws(() => preflightRecipe(native), (error: unknown) => {
    assert.ok(error instanceof PreflightError);
    assert.equal(error.code, "unsupported-native-option");
    assert.match(error.detail, /mystery/);
    return true;
  });
  assert.throws(
    () => preflightRecipe({ ...resolved, runner: "teleport" }),
    (error: unknown) => {
      assert.ok(error instanceof PreflightError);
      assert.equal(error.code, "unknown-runner");
      return true;
    },
  );
});

test("MCP contract names server-issued targets only", () => {
  assert.equal(MCP_CONTEXT_TOOL, "generation_context");
  assert.equal(MCP_SUBMIT_TOOL, "generation_submit");
  const context: GenerationContext = {
    session: "s1",
    attempt: "a1",
    source_digest: "d0",
    allowed: [
      { handle: "t-style-1", role: "style", kind: "style", filename: "style.css" },
      { handle: "t_asset_2", role: "asset", kind: "style", filename: "asset.bin" },
    ],
  };
  const matched = validateSubmissionBatch(context, "s1", [
    { target: "t-style-1", role: "style", content_text: ".a{color:red}" },
    { target: "t_asset_2", role: "asset", content_base64: "aGk=" },
  ]);
  assert.equal(matched.length, 2);
  const mcpCode = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof McpError);
      return error.code;
    }
    assert.fail("expected an McpError");
  };
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s2", [
        { target: "t-style-1", role: "style", content_text: "x" },
      ]),
    ),
    "stale-session",
  );
  assert.equal(mcpCode(() => validateSubmissionBatch(context, "s1", [])), "empty-batch");
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [{ target: "t-nope", role: "style", content_text: "x" }]),
    ),
    "unknown-target",
  );
  for (const path of ["../evil.js", "can.generated/u1/server.js", "C:\\win\\x.js", ".."]) {
    assert.equal(
      mcpCode(() =>
        validateSubmissionBatch(context, "s1", [{ target: path, role: "style", content_text: "x" }]),
      ),
      "arbitrary-path",
      path,
    );
  }
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [
        { target: "t-style-1", role: "server", content_text: "x" },
      ]),
    ),
    "role-mismatch",
  );
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [
        { target: "t-style-1", role: "style", content_text: "x", content_base64: "aGk=" },
      ]),
    ),
    "malformed-content",
  );
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [{ target: "t-style-1", role: "style" }]),
    ),
    "malformed-content",
  );
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [
        { target: "t-style-1", role: "style", content_text: "" },
      ]),
    ),
    "malformed-content",
  );
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [
        { target: "t_asset_2", role: "asset", content_base64: "!!!" },
      ]),
    ),
    "malformed-content",
  );
  assert.equal(
    mcpCode(() =>
      validateSubmissionBatch(context, "s1", [
        { target: "t-style-1", role: "style", content_text: "x" },
        { target: "t-style-1", role: "style", content_text: "y" },
      ]),
    ),
    "duplicate-target",
  );
  assert.equal(handleGrammarValid("t-style-1"), true);
  assert.equal(handleGrammarValid(""), false);
  assert.equal(handleGrammarValid("has space"), false);
  assert.equal(handleGrammarValid("has/slash"), false);
  assert.deepEqual(
    allowedOutputsFor("style").map(([role]) => role),
    ["style", "asset"],
  );
  assert.deepEqual(
    allowedOutputsFor("view").map(([role]) => role),
    ["server", "browser", "style", "asset"],
  );
  assert.deepEqual(
    allowedOutputsFor("keyword").map(([role]) => role),
    ["server"],
  );
  assert.deepEqual(allowedOutputsFor("named-trait").map(([role]) => role), ["contributions", "server"]);
  assert.deepEqual(allowedOutputsFor("inline-trait").map(([role]) => role), ["contributions", "server"]);
});


test("Codex native reasoning accepts only supported explicit effort values", () => {
  const resolved = resolveRecipe(loaded(), "given", null, { runner: "codex", model: "gpt-6.1-sol" });
  for (const value of [true, 2, "turbo", ""]) {
    assert.throws(() => preflightRecipe({ ...resolved, native: { model_reasoning_effort: value } }), (error: unknown) => error instanceof PreflightError && error.code === "invalid-native-option");
  }
  for (const value of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.doesNotThrow(() => preflightRecipe({ ...resolved, native: { model_reasoning_effort: value } }));
  }
});
