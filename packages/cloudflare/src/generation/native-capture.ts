/** Fixed native saved-generation discovery and cooperative snapshot handoff. */
import { nativeHandoff } from "../cli/native-handoff.js";
import type { ConsumedInput } from "./journal.js";

export interface GeneratedClosure {
  root: string;
  files: Array<{ path: string; sha256: string }>;
  compilerSources: string[];
}
export function discoverGeneratedClosure(compiler: string, root: string, app: string): Promise<GeneratedClosure> {
  return nativeHandoff("discover", { compiler, root, app });
}
export async function snapshotGeneratedClosure(root: string, app: string, closure: GeneratedClosure): Promise<ConsumedInput[]> {
  const rows = await nativeHandoff<Array<Omit<ConsumedInput, "bytes"> & { bytes: { type: "Buffer"; data: number[] } }>>("snapshot", { root, app, closure });
  return rows.map(row => ({ ...row, bytes: Buffer.from(row.bytes.data) }));
}
