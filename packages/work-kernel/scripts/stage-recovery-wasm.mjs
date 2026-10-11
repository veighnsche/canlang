// Explicit native build output only. Normal build:emit/prepare stays unchanged.
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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
