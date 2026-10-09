/** Actual captured native refusal joined to private session help; no profile/provider qualification. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { attachDevSessionService, startDevSessionService, type SessionCheckResponse } from "../src/dev/session-service.js";
import type { CompilerConstructCandidates } from "../src/dev/construct-help.js";

const project = resolve(import.meta.dirname, "../../..");

it("retains released native originating context and keeps unqualified ranking local by default", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "can-native-rank-"));
  const root = join(scratch, "source");
  const runtimeDir = join(scratch, "control");
  await mkdir(root, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  const source = "app T\nGiven\nWhen\n export scenairo\nThen\n";
  await writeFile(join(root, "T.can"), source);
  // Captured real help bytes retain their checked relative source links.
  for (const path of ["docs/specification/CONSTRUCT-HELP.md", "docs/specification/GRAMMAR.md",
    "docs/specification/DESIGN.md", "design/UI-COMPONENTS.md"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(project, path), join(root, path));
  }
  const version = async (name: string): Promise<string> => {
    const manifest = JSON.parse(await readFile(join(project, `packages/${name}/package.json`), "utf8")) as { version: string };
    return manifest.version;
  };
  const valuesVersion = await version("values");
  const uiVersion = await version("ui");
  let providerCalls = 0;
  const owner = await startDevSessionService({
    selectedApp: "T", runtimeDir,
    capture: {
      checkoutRoot: root, appPath: "T.can", profile: "local-d1-identity",
      compilerPath: join(project, "compiler/target/debug/can"),
      catalogPath: join(project, "packages/values/dist/catalog.json"),
      helpIndexPath: "docs/specification/CONSTRUCT-HELP.md",
      packageInputPaths: [
        { name: `@canlang/values@${valuesVersion}/dist/src/catalog.js`, path: join(project, "packages/values/dist/src/catalog.js") },
        { name: `@canlang/ui@${uiVersion}/dist/src/catalog.js`, path: join(project, "packages/ui/dist/src/catalog.js") },
      ],
      extraInputPaths: [
        { name: "grammar", path: "docs/specification/GRAMMAR.md" },
        { name: `source:@canlang/values@${valuesVersion}/src/catalog.ts`, path: join(project, "packages/values/src/catalog.ts") },
        { name: `source:@canlang/ui@${uiVersion}/src/catalog.ts`, path: join(project, "packages/ui/src/catalog.ts") },
      ],
    },
    // The actual native context is not safe ranking evidence or a profile proof.
    // No qualifier, disclosure callback, provider setup or external packet exists.
    constructRanking: { transport: { choose: async () => { providerCalls++; throw new Error("external transport must remain unused"); } } },
  });
  try {
    const client = await attachDevSessionService({ checkoutRoot: root, app: "T", profile: "local-d1-identity", runtimeDir });
    const checked = await client.request({ command: "check" }) as SessionCheckResponse;
    expect(checked.state).toBe("errors");
    expect(checked.current).toBe(true);
    expect(checked.evidence).toMatchObject({ capture_complete: true, analysis_complete: true,
      diagnostics_reported: 1, diagnostics_omitted: 0, diagnostics_service_omitted: 0 });
    expect(checked.preview).toBe("unavailable");
    const diagnostic = await client.request({ command: "diagnostic.detail", payload: { revision: checked.revision, index: 0 } }) as {
      current: boolean; source: { sha256: string };
      diagnostic: { code: string; primary: { start: number; end: number }; construct_candidates: CompilerConstructCandidates };
      construct_help: { candidateCoverage: string; cards: { id: string; status: string }[] };
    };
    expect(diagnostic.current).toBe(true);
    expect(diagnostic.source.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    const routing = diagnostic.diagnostic.construct_candidates;
    expect(diagnostic.diagnostic.code).toBe("E1200");
    expect(routing).toMatchObject({ version: 1, disposition: "exact", slot: "when.exported-declaration", complete: true,
      context: { version: 1, messageKind: "unknown_when_declaration", section: "When", guess: "scenairo",
        exactSourceSpan: true, structuralRecovery: false, recoveryComplete: true, nameFilterComplete: true,
        materialIntentChoice: true, evidenceSufficient: false, unsupportedBehaviorProven: false } });
    expect([...routing.ids].sort()).toEqual([
      "can.v1.when.scenario.cohort", "can.v1.when.scenario.periodic", "can.v1.when.scenario.read",
      "can.v1.when.scenario.trusted", "can.v1.when.scenario.user",
    ]);
    const span = diagnostic.diagnostic.primary;
    expect(Buffer.from(source).subarray(span.start, span.end).toString("utf8")).toBe("scenairo");
    expect(diagnostic.construct_help.candidateCoverage).toBe("unknown");
    expect(diagnostic.construct_help.cards.map(card => card.id).sort()).toEqual([...routing.ids].sort());
    expect(diagnostic.construct_help.cards.every(card => card.status !== "working")).toBe(true);
    const ranked = await client.request({ command: "construct.rank", payload: { revision: checked.revision, index: 0 } });
    expect(ranked).toMatchObject({ schema: "can.dev.construct-rank.v1", revision: checked.revision,
      result: { state: "candidate_coverage_unknown", reason: "host profile or diagnostic branch qualification is unavailable" } });
    expect(providerCalls).toBe(0);
    expect(await client.request({ command: "preview.status" })).toMatchObject({ state: "unavailable", serving_build: null });
  } finally {
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
