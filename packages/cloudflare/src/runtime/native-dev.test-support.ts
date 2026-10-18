/** DTO adapters for semantic tests consuming the actual native owner modules. */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CompileArtifact } from "@canlang/contracts";
import type { ChromiumProducer } from "@canlang/contracts/browser/chromium";
import { nativeHandoff, nativeHandoffSync } from "../cli/native-handoff.js";
import type { GeneratedClosure } from "../generation/native-capture.js";
import type { ConsumedInput } from "../generation/journal.js";
export { discoverGeneratedClosure, snapshotGeneratedClosure } from "../generation/native-capture.js";

export interface NamedInputPath { name: string; path: string }
export interface SingleFileCaptureRequest {
  checkoutRoot: string; appPath: string; profile: string; compilerPath: string; catalogPath: string | null;
  helpIndexPath: string; packageInputPaths: readonly NamedInputPath[]; extraInputPaths?: readonly NamedInputPath[];
  semanticOptions?: Readonly<Record<string, string>>; inputInventory?: "installed-local-preview";
}
export interface CapturedFileIdentity {
  name: string; requestedPath: string | null; canonicalPath: string | null; sha256: string | null; bytes: number | null;
  state: "present" | "missing";
}
export interface SingleFileCapture {
  requestedRoot: string; root: string; requestedAppPath: string; appPath: string; compilerOperand: string;
  sourceText: string; sourceSha256: string; sourceBytes: number; sourceRevision: string; epochMaterial: string;
  profile: string; semanticOptions: Readonly<Record<string, string>>; inputs: readonly CapturedFileIdentity[];
  inputInventory?: "installed-local-preview"; generatedClosure?: GeneratedClosure; sourceSnapshot?: readonly ConsumedInput[];
}
export interface CompilerSourceReport { complete: boolean; sources: readonly { path: string; sha256: string }[] }
export type CompilerCaptureVerdict = { ok: true } | { ok: false; reason: "analysis_incomplete" | "source_membership_mismatch" | "source_path_mismatch" | "source_hash_mismatch" };
export type CapturedCompileResult =
  | { kind: "artifact"; artifact: CompileArtifact; artifactBytes: Uint8Array; capture: SingleFileCapture }
  | { kind: "diagnostics"; envelope: CompilerSourceReport & { diagnostics: readonly unknown[] }; capture: SingleFileCapture }
  | { kind: "profile_unsupported" | "capture_incomplete" | "tool_failure"; reason: string; capture: SingleFileCapture };
interface Inventory { packageInputPaths: readonly NamedInputPath[]; extraInputPaths: readonly NamedInputPath[] }
interface PrepareOptions { checkoutRoot: string; appPath: string; compilerPath: string; catalogPath: string; helpIndexPath: string; semanticOptions?: Readonly<Record<string, string>> }
const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
const catalog = () => process.env.CAN_NATIVE_CATALOG ?? process.env.CAN_CATALOG ?? join(checkout, "packages/cloudflare/dist/native-catalog.json");
function reviveCapture(capture: SingleFileCapture): SingleFileCapture {
  if (capture.sourceSnapshot) capture.sourceSnapshot = capture.sourceSnapshot.map(row => ({ ...row, bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from((row.bytes as unknown as { data: number[] }).data) }));
  return capture;
}
export function installedLocalPreviewInputInventory(root: string, compiler: string): Inventory {
  return nativeHandoffSync("inventory", { root, compiler, catalog: catalog() });
}
export function bundlerExecutableInputs(): readonly NamedInputPath[] {
  return installedLocalPreviewInputInventory(checkout, process.env.CAN_COMPILER_BIN ?? join(checkout, "compiler/target/debug/can"))
    .extraInputPaths.filter(row => row.name === "node" || row.name === "esbuild");
}
export function prepareLocalPreviewCapture(options: PrepareOptions): SingleFileCaptureRequest {
  return nativeHandoffSync("prepare", { root: options.checkoutRoot, app: options.appPath, compiler: options.compilerPath,
    catalog: options.catalogPath, help: options.helpIndexPath, semanticOptions: options.semanticOptions ?? {} });
}
export async function captureSingleFileSource(request: SingleFileCaptureRequest): Promise<SingleFileCapture> {
  return reviveCapture(await nativeHandoff("capture", { request }));
}
export function captureInputs(root: string, paths: readonly { name: string; path: string | null }[]): Promise<readonly CapturedFileIdentity[]> {
  return nativeHandoff("inputs", { root, paths });
}
export function captureIsCurrent(capture: SingleFileCapture): Promise<boolean> { return nativeHandoff("current", { capture }); }
export function capturedProducerInputsAreCurrent(capture: SingleFileCapture): Promise<boolean> { return nativeHandoff("producer-current", { capture }); }
export function capturedRuntimeInputsAreCurrent(capture: SingleFileCapture): Promise<boolean> { return nativeHandoff("runtime-current", { capture }); }
export function verifyCompilerSources(capture: SingleFileCapture, report: CompilerSourceReport): CompilerCaptureVerdict { return nativeHandoffSync("verify", { capture, report }); }
export function admitSingleAppProfile(source: string): { ok: true } | { ok: false; reason: string } { return nativeHandoffSync("admit", { source }); }
export async function compileCapturedSingleFile(capture: SingleFileCapture, signal?: AbortSignal,
  _reportPhase?: (phase: string) => void): Promise<CapturedCompileResult> {
  const result = await nativeHandoff<Record<string, unknown>>("compile", { capture }, signal);
  if (result.kind === "cancelled") { signal?.throwIfAborted(); throw new Error(String(result.reason)); }
  if (result.kind === "artifact") result.artifactBytes = new Uint8Array(result.artifactBytes as number[]);
  return { ...result, capture } as CapturedCompileResult;
}
export async function loadInstalledChromium(root: string): Promise<{ entryPath: string; producer: ChromiumProducer } | null> {
  const inventory = installedLocalPreviewInputInventory(root, process.env.CAN_COMPILER_BIN ?? join(checkout, "compiler/target/debug/can"));
  const entryPath = inventory.extraInputPaths.find(row => row.name === "browser:producer")?.path;
  if (!entryPath) return null;
  return { entryPath, producer: await import(pathToFileURL(entryPath).href) as ChromiumProducer };
}
