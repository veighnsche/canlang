import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeRuntimeFiles, writeRuntimeFile } from "./runtime-host-protocol.js";

test("consume releases only verified own spool outputs after copying, and permits acknowledgement retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "can-runtime-consume-"));
  const foreign = await mkdtemp(join(tmpdir(), "can-runtime-foreign-"));
  try {
    const output = await writeRuntimeFile(directory, { semantic: "copied result" });
    const other = await writeRuntimeFile(foreign, { semantic: "other owner" });
    await assert.rejects(consumeRuntimeFiles(directory, [other]), /owned spool child/);
    await access(other.path);
    await assert.rejects(consumeRuntimeFiles(directory, [{ ...output, sha256: "0".repeat(64) }]), /hash mismatch/);
    await access(output.path);
    await assert.rejects(consumeRuntimeFiles(directory, Array(129).fill(output)), /consume batch/);
    await consumeRuntimeFiles(directory, [output]);
    await assert.rejects(access(output.path), { code: "ENOENT" });
    await consumeRuntimeFiles(directory, [output]);
  } finally {
    await Promise.all([rm(directory, { force: true, recursive: true }), rm(foreign, { force: true, recursive: true })]);
  }
});
