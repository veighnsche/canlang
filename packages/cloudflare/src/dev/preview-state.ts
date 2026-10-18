/** Retained local preview state. This is development data, never production configuration. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CompileArtifact } from "@canlang/contracts";
import type { LocalPreviewSeed } from "./preview-builder.js";
import type { SingleFileCapture } from "./source-capture.js";

export interface RetainedPreviewState {
  readonly persistence: string;
  readonly databaseId: string;
  readonly ownerDatabaseIds: readonly string[];
  readonly seed: LocalPreviewSeed | null;
  saveSeed(seed: LocalPreviewSeed): Promise<void>;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("preview storage must be an owner-only directory without a symbolic link");
  }
}

/** Selected by the installed host, never by browser or application request data. */
export function defaultPreviewStateRoot(): string {
  return process.env.CAN_DEV_STATE_ROOT ?? join(homedir(), ".local", "state", "canlang", "preview");
}

type PreviewManifest = { version: 1; identity: string; schema: string; databaseId: string; ownerDatabaseIds: string[]; seed: LocalPreviewSeed | null };

function assertValidManifest(value: PreviewManifest, identity: string): void {
  if (value.version !== 1 || value.identity !== identity || typeof value.databaseId !== "string" ||
      !/^can-preview-[0-9a-f-]{36}$/.test(value.databaseId) || !Array.isArray(value.ownerDatabaseIds) ||
      value.ownerDatabaseIds.length !== 2 || new Set(value.ownerDatabaseIds).size !== 2 ||
      value.ownerDatabaseIds.some(id => typeof id !== "string" || !/^can-preview-owner-[0-9a-f-]{36}$/.test(id)) ||
      !(value.seed === null || (typeof value.seed === "object" && Array.isArray(value.seed.actors) &&
        Array.isArray(value.seed.owners) && typeof value.seed.probe === "object" && value.seed.probe !== null))) {
    throw new Error("preview metadata is invalid; retained state was preserved");
  }
}

async function loadPreviewManifest(path: string, identity: string): Promise<PreviewManifest | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) {
      throw new Error("preview metadata must be a bounded owner-only regular file");
    }
    const value = JSON.parse(await readFile(path, "utf8")) as PreviewManifest;
    assertValidManifest(value, identity);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Schema edits require an explicit reset until the preview profile supports migrations. */
export async function openRetainedPreviewState(
  root: string, capture: Pick<SingleFileCapture, "root" | "appPath">,
  artifact: Pick<CompileArtifact, "models">, storageMode: "global" | "team",
): Promise<RetainedPreviewState> {
  const base = resolve(root);
  await privateDirectory(base);
  const identity = JSON.stringify({ root: capture.root, source: capture.appPath });
  const key = createHash("sha256").update(identity).digest("hex");
  const directory = join(base, key);
  await privateDirectory(directory);
  const persistence = join(directory, "d1");
  await privateDirectory(persistence);
  const path = join(directory, "preview.json");
  const schema = createHash("sha256").update(JSON.stringify({ storageMode, models: artifact.models ?? [] })).digest("hex");
  let manifest: PreviewManifest;
  const loaded = await loadPreviewManifest(path, identity);
  if (loaded === null) {
    manifest = { version: 1, identity, schema, databaseId: `can-preview-${randomUUID()}`,
      ownerDatabaseIds: [0, 1].map(() => `can-preview-owner-${randomUUID()}`), seed: null };
    await writeFile(path, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  } else if (loaded.schema !== schema) {
    throw new Error("retained preview models changed; migrations are unsupported, use a separate preview state root or explicitly reset this source's development data");
  } else {
    manifest = loaded;
  }
  return {
    persistence, databaseId: manifest.databaseId, ownerDatabaseIds: manifest.ownerDatabaseIds, seed: manifest.seed,
    async saveSeed(seed) {
      const staged = join(directory, `preview-${randomUUID()}.json`);
      await writeFile(staged, JSON.stringify({ ...manifest, seed }), { mode: 0o600, flag: "wx" });
      await rename(staged, path);
      manifest = { ...manifest, seed };
    },
  };
}
