// Explicit native build output only. Normal build:emit/prepare stays unchanged.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../target/wasm32-unknown-unknown/release/canlang_work_kernel.wasm', import.meta.url));
const directory = fileURLToPath(new URL('../dist/native/', import.meta.url));
const target = fileURLToPath(new URL('../dist/native/recovery.wasm', import.meta.url));
const temporary = `${target}.${process.pid}.tmp`;
mkdirSync(directory, { recursive: true });
try {
  copyFileSync(source, temporary);
  renameSync(temporary, target);
} finally {
  rmSync(temporary, { force: true });
}
// Pinned integrity manifest for the deploy package-assets gather: the exact
// file set plus per-file bytes/sha256, mirroring the values BUILD.json shape
// the shared verifiedFiles mechanism consumes. Missing/corrupt staged bytes
// refuse at gather time, never at Worker dispatch.
const bytes = readFileSync(target);
writeFileSync(
  fileURLToPath(new URL('../dist/native/BUILD.json', import.meta.url)),
  `${JSON.stringify({ builder: 'packages/work-kernel/scripts/stage-recovery-wasm.mjs', files: { 'recovery.wasm': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } }, null, 2)}\n`,
);
