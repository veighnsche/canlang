/**
 * T21 compiled-identity negatives: the pinned rule (source path +
 * content-hash binding against the toolchain stamps) accepts the real
 * toolchain product and rejects everything else — in particular a
 * hand-built fixture NEVER passes the compiled-identity assertion, and
 * the `compiled/` vs `fixture/handbuilt/` labels stay distinguishable.
 */
import { expect } from "@playwright/test";
import { assertCompiledIdentity } from "@canlang/cloudflare/runtime/artifact";
import { compiledTest as test } from "../fixtures/e2e-test.js";
import { COMPILED_LABEL_PREFIX } from "../fixtures/artifact-loader.js";
import { teamTasksArtifact } from "../fixtures/handbuilt/teamtasks.js";

test.describe("compiled identity", () => {
  test("handbuilt fixture never passes the compiled-identity assertion", async ({ compiled }) => {
    const expected = {
      sourcePath: compiled.sourcePath,
      sourceSha256: compiled.sourceSha256,
      toolVersion: compiled.toolVersion,
      languageVersion: compiled.languageVersion,
    };
    // The genuine product passes (the rule is not vacuous)…
    expect(() => assertCompiledIdentity(compiled.artifact, expected)).not.toThrow();
    // …while the honestly-labeled handbuilt fixture fails the version
    // binding (`language_version: "handbuilt/…"`, never the toolchain's).
    expect(() => assertCompiledIdentity(teamTasksArtifact(), expected)).toThrow(/language_version/);
  });

  test("tampered bytes fail the content-hash binding", async ({ compiled }) => {
    expect(() =>
      assertCompiledIdentity(compiled.artifact, {
        sourcePath: compiled.sourcePath,
        sourceSha256: "0".repeat(64),
        toolVersion: compiled.toolVersion,
        languageVersion: compiled.languageVersion,
      }),
    ).toThrow(/sha256/);
  });

  test("wrong path and wrong toolchain stamps fail their bindings", async ({ compiled }) => {
    expect(() =>
      assertCompiledIdentity(compiled.artifact, {
        sourcePath: "elsewhere.can",
        sourceSha256: compiled.sourceSha256,
        toolVersion: compiled.toolVersion,
        languageVersion: compiled.languageVersion,
      }),
    ).toThrow(/sources\[0\]\.path/);
    expect(() =>
      assertCompiledIdentity(compiled.artifact, {
        sourcePath: compiled.sourcePath,
        sourceSha256: compiled.sourceSha256,
        toolVersion: "9.9.9",
        languageVersion: compiled.languageVersion,
      }),
    ).toThrow(/tool_version/);
  });

  test("labels stay distinguishable", async ({ compiled }) => {
    expect(compiled.label.startsWith(COMPILED_LABEL_PREFIX)).toBe(true);
    expect(compiled.label).not.toBe("fixture/handbuilt/teamtasks");
  });
});
