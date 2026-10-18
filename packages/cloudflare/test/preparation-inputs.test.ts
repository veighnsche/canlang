/** P05.4: LOAD_MODULES resume payload shape pins the native gate input. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadModulesResumeForModules,
  loadModulesResumeWithFacts,
  previousPlanResumeForPath,
  scanModuleFacts,
} from "../src/preparation/build-adapter.js";
import {
  buildArtifactPayload,
  buildCompanionsPayload,
  buildLoadErrorPayload,
  buildLoadModulesPayload,
  buildLockstepPayload,
  buildPlanOptionsPayload,
  buildPreviousPlanPayload,
  encodeAdmittedTreeJson,
} from "../src/preparation/inputs.js";

function entryKeys(node: { t: string; entries: Array<[number[], unknown]> }): string[] {
  return node.entries.map(([units]) => String.fromCharCode(...units));
}

const units = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

describe("LOAD_MODULES resume payload", () => {
  it("encodes staged buffers as the admitted modules tree", () => {
    const payload = buildLoadModulesPayload([{ key: "main", js: "export const x = 1;" }]);
    expect(payload).toEqual({
      modules: {
        t: "arr",
        items: [
          {
            t: "obj",
            entries: [
              [units("key"), { t: "text", units: units("main") }],
              [units("js"), { t: "text", units: units("export const x = 1;") }],
            ],
          },
        ],
      },
    });
  });

  it("round-trips through plain JSON framing like driveSession", () => {
    const payload = buildLoadModulesPayload([{ key: "main", js: "export const x = 1;" }]);
    const framed = JSON.parse(JSON.stringify(payload)) as {
      modules: { t: string; items: Array<{ t: string }> };
    };
    expect(framed.modules.t).toBe("arr");
    expect(framed.modules.items).toHaveLength(1);
    expect(framed.modules.items[0]?.t).toBe("obj");
  });

  it("refuses exotic buffer contents loudly", () => {
    expect(() =>
      buildLoadModulesPayload([{ key: "main", js: "export const x = 1;" }, undefined as never]),
    ).toThrow();
  });

  it("serves a staged bundle map in bundle order", () => {
    const payload = loadModulesResumeForModules({
      "app/main.js": `import "./util.js";\nexport const descriptor = {};`,
      "app/util.js": `export function util() { return 1; }\n`,
    });
    expect(payload.modules.t).toBe("arr");
    const items = (payload.modules as {
      items: Array<{ entries: Array<[number[], { units: number[] }]> }>;
    }).items;
    expect(items).toHaveLength(2);
    const keys = items.map((item) => String.fromCharCode(...item.entries[0]![1].units));
    expect(keys).toEqual(["app/main.js", "app/util.js"]);
  });

  it("carries owner facts on every module entry (029: never stripped)", () => {
    const modules = {
      "a.js": "function f(exports) {} exports.x = 1;",
      "b.js": "export const b = 2;",
    };
    const payload = loadModulesResumeWithFacts(modules);
    const items = (payload.modules as {
      items: Array<{ entries: Array<[number[], unknown]> }>;
    }).items;
    expect(items).toHaveLength(2);
    const byKey = new Map(
      items.map((item) => {
        const keyEntry = item.entries.find(([k]) => String.fromCharCode(...k) === "key")?.[1] as
          | { units: number[] }
          | undefined;
        return [String.fromCharCode(...(keyEntry?.units ?? [])), item] as const;
      }),
    );
    for (const [key, js] of Object.entries(modules)) {
      const entry = byKey.get(key);
      expect(entry, `entry for ${key}`).toBeDefined();
      const factsNode = entry!.entries.find(([k]) => String.fromCharCode(...k) === "facts")?.[1];
      expect(factsNode, `facts for ${key}`).toBeDefined();
      // The encoded facts equal the single frontend's output over
      // those exact bytes, wire-for-wire (plain-JSON round trip
      // like driveSession).
      expect(JSON.parse(JSON.stringify(factsNode))).toEqual(
        JSON.parse(encodeAdmittedTreeJson(scanModuleFacts(js, key))),
      );
    }
    expect(payload.binaries).toEqual({ t: "arr", items: [] });
  });

  it("carries staged binary keys alongside module facts", () => {
    const payload = loadModulesResumeWithFacts({ "a.js": "export const a = 1;" }, ["vendor/r.wasm"]);
    const binaries = payload.binaries as { t: string; items: Array<{ t: string; units: number[] }> };
    expect(binaries.t).toBe("arr");
    expect(binaries.items.map((item) => String.fromCharCode(...item.units))).toEqual(["vendor/r.wasm"]);
  });
});

describe("LOAD_ARTIFACT resume payload", () => {
  it("carries the artifact as one object tree", () => {
    const payload = buildArtifactPayload({ artifact_version: 1, tool_version: "0.1.0" });
    expect(payload.tree.t).toBe("obj");
    expect(entryKeys(payload.tree as { t: string; entries: Array<[number[], unknown]> })).toEqual([
      "artifact_version",
      "tool_version",
    ]);
  });

  it("rides reader failures as an exact load_error frame", () => {
    expect(JSON.stringify(buildLoadErrorPayload("artifact x: invalid JSON: oops"))).toBe(
      `{"load_error":"artifact x: invalid JSON: oops"}`,
    );
  });
});

describe("LOAD_COMPANIONS resume payload", () => {
  it("carries descriptor, environment and target as three trees", () => {
    const payload = buildCompanionsPayload(
      { identity: { appName: "a" } },
      { environment: "prod", resources: [] },
      { contractsVersion: 1 },
    );
    for (const tree of [payload.descriptor, payload.environment, payload.target]) {
      expect(tree.t).toBe("obj");
    }
    expect(
      entryKeys(payload.descriptor as { t: string; entries: Array<[number[], unknown]> }),
    ).toEqual(["identity"]);
  });
});

describe("LOCKSTEP_INPUTS resume payload", () => {
  it("carries the release stamp keys the native gate decodes", () => {
    const payload = buildLockstepPayload({
      rootVersion: "0.1.0",
      platformVersion: "0.1.0",
      compilerVersion: "0.1.0",
      contractsVersion: 1,
      packageVersions: {},
    });
    expect(payload.inputs.t).toBe("obj");
    expect(
      entryKeys(payload.inputs as { t: string; entries: Array<[number[], unknown]> }),
    ).toEqual([
      "rootVersion",
      "platformVersion",
      "compilerVersion",
      "contractsVersion",
      "packageVersions",
    ]);
  });
});

describe("PLAN resume payload", () => {
  it("byte-matches the native vector options resume", () => {
    const payload = buildPlanOptionsPayload({
      workerName: "w1",
      main: "./dist/worker/entry.js",
      compatibilityDate: "2026-07-15",
    });
    expect(JSON.stringify(payload)).toBe(
      `{"options":{"t":"obj","entries":[[[119,111,114,107,101,114,78,97,109,101],{"t":"text","units":[119,49]}],[[109,97,105,110],{"t":"text","units":[46,47,100,105,115,116,47,119,111,114,107,101,114,47,101,110,116,114,121,46,106,115]}],[[99,111,109,112,97,116,105,98,105,108,105,116,121,68,97,116,101],{"t":"text","units":[50,48,50,54,45,48,55,45,49,53]}]]}}`,
    );
  });

  it("carries the optional bundle ref as a three-entry object", () => {
    const payload = buildPlanOptionsPayload({
      workerName: "w1",
      main: "./x.deploy/worker/main.js",
      compatibilityDate: "2026-07-15",
      bundle: { main: "./x.deploy/worker/main.js", moduleCount: 7, sha256: "abc" },
    });
    const options = payload.options as {
      t: string;
      entries: Array<[number[], { t: string; entries?: Array<[number[], unknown]> }]>;
    };
    expect(options.t).toBe("obj");
    expect(options.entries).toHaveLength(4);
    const bundle = options.entries[3]![1];
    expect(bundle.t).toBe("obj");
    expect(bundle.entries).toHaveLength(3);
  });
});

describe("LOAD_PREVIOUS_PLAN resume payload", () => {
  it("rides present-parsed null as the tagged null tree, never the absent marker", () => {
    expect(JSON.stringify(buildPreviousPlanPayload(null))).toBe(`{"previous":{"t":"null"}}`);
  });

  it("rides present valid-JSON strings as text trees like the d15 bytes", () => {
    expect(JSON.stringify(buildPreviousPlanPayload("not json"))).toBe(
      `{"previous":{"t":"text","units":[110,111,116,32,106,115,111,110]}}`,
    );
  });

  it("serves real sidecar files: missing, valid, present-null, quoted-string", () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prev-"));
    expect(previousPlanResumeForPath(join(dir, "no.deploy-plan.json"))).toEqual({
      previous: null,
    });
    const valid = join(dir, "ok.deploy-plan.json");
    writeFileSync(valid, `{"wrangler": {"name": "w0"}, "schedules": []}`);
    const served = previousPlanResumeForPath(valid);
    expect(served.previous).toMatchObject({ t: "obj" });
    const presentNull = join(dir, "null.deploy-plan.json");
    writeFileSync(presentNull, "null");
    expect(JSON.stringify(previousPlanResumeForPath(presentNull))).toBe(
      `{"previous":{"t":"null"}}`,
    );
    const quoted = join(dir, "str.deploy-plan.json");
    writeFileSync(quoted, `"not json"`);
    expect(JSON.stringify(previousPlanResumeForPath(quoted))).toBe(
      `{"previous":{"t":"text","units":[110,111,116,32,106,115,111,110]}}`,
    );
  });

  it("refuses malformed sidecars in the oracle parse voice", () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prev-"));
    const garbage = join(dir, "bad.deploy-plan.json");
    writeFileSync(garbage, "not json");
    expect(() => previousPlanResumeForPath(garbage)).toThrow(/is not valid JSON/);
  });

  it("refuses unreadable sidecars in the oracle voice", () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prev-"));
    expect(() => previousPlanResumeForPath(dir)).toThrow(/cannot read previous plan/);
  });
});
