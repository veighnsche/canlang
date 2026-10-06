/**
 * FS-backed blob store: the journey byte implementation behind
 * `BlobStorePort`.
 *
 * All keys live flat under one scoped root directory (a temp dir in
 * tests); keys are runtime-minted and gated by `assertSafeBlobKey`, so
 * caller input can never escape the root. This store is real local
 * persistence for slices, not a TEST-ONLY double — but it is not the
 * production binding either: live bytes move to R2 behind this same
 * port at the S8 join through the L7 runner, and no R2 traffic happens
 * here.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertSafeBlobKey, type BlobStorePort } from '../ports.js';

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

class FsBlobStore implements BlobStorePort {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private pathFor(key: string): string {
    assertSafeBlobKey(key);
    return join(this.rootDir, key);
  }

  write(key: string, bytes: Uint8Array): void {
    writeFileSync(this.pathFor(key), new Uint8Array(bytes));
  }

  append(key: string, chunk: Uint8Array): void {
    appendFileSync(this.pathFor(key), new Uint8Array(chunk));
  }

  read(key: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(this.pathFor(key)));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  remove(key: string): void {
    rmSync(this.pathFor(key), { force: true });
  }

  sizeOf(key: string): number | null {
    try {
      return statSync(this.pathFor(key)).size;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * Open (creating) an FS-backed blob store rooted at `rootDir`, which
 * must be absolute. Missing keys read as null; any other IO failure
 * propagates loudly instead of masquerading as absent bytes.
 */
export function createFsBlobStore(rootDir: string): BlobStorePort {
  if (typeof rootDir !== 'string' || rootDir.length === 0 || !isAbsolute(rootDir)) {
    throw new RangeError('createFsBlobStore: rootDir must be a non-empty absolute path');
  }
  mkdirSync(rootDir, { recursive: true });
  return new FsBlobStore(rootDir);
}
