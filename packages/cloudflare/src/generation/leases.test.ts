/**
 * BGI-04 lease tests: canonical lock order, token-checked read/write
 * lock files, and explicit stopped-writer recovery. Mirrors the Rust
 * `bgi04_leases` lease coverage so both hosts enforce the same protocol:
 * shared escaping/token vectors, conflicting participants, shared
 * readers fencing writes, and recovery that never steals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquire,
  canonicalOrder,
  escapeRel,
  newToken,
  parseToken,
  platformDurability,
  recoverStoppedWriter,
  release,
  validateLeaseId,
  validateRel,
  LeaseError,
} from "./leases.js";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "can-bgi04-leases-"));
}

async function errorOf(promise: Promise<unknown>): Promise<LeaseError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LeaseError);
    return error;
  }
  assert.fail("expected a LeaseError");
}

test("shared protocol vectors match both hosts", () => {
  assert.equal(escapeRel("can.generated/u1/style.css"), "can.generated%2Fu1%2Fstyle.css");
  assert.equal(escapeRel("app.can"), "app.can");
  assert.equal(escapeRel("a b/c+d"), "a%20b%2Fc%2Bd");
  assert.deepEqual(
    canonicalOrder(["can.generated/u2/x", "app.can", "can.generated/u1/x"]),
    ["app.can", "can.generated/u1/x", "can.generated/u2/x"],
  );
  assert.equal(parseToken("v1-0123456789abcdef"), "v1-0123456789abcdef");
  for (const bad of ["v1-0123456789ABCDEF", "v1-short", "0123456789abcdef", "v1-0123456789abcdef0"]) {
    assert.throws(() => parseToken(bad), LeaseError, bad);
  }
  assert.notEqual(newToken(), newToken());
  validateRel("can.generated/u1/style.css");
  for (const bad of ["", "/abs", "a/../b", "a/./b", "a//b", "a\\b", ".", "a/.."]) {
    assert.throws(() => validateRel(bad), LeaseError, bad);
  }
  for (const bad of ["", "a/b", "a b", ".", ".."]) {
    assert.throws(() => validateLeaseId("run id", bad), LeaseError, bad);
  }
  validateLeaseId("run id", "r42");
  const durability = platformDurability();
  assert.ok(durability.includes("not filesystem CAS"), durability);
});

test("participating edits conflict and lock files match the shared shape", async () => {
  const root = await freshRoot();
  const capture = await acquire(
    root,
    ["app.can", "can.generated/u1/style.css"],
    "write",
    "accept-r1",
  );
  assert.deepEqual(capture.paths, ["app.can", "can.generated/u1/style.css"]);
  const sourceEdit = await errorOf(acquire(root, ["app.can"], "write", "edit-agent"));
  assert.equal(sourceEdit.code, "conflict");
  const unitEdit = await errorOf(
    acquire(root, ["can.generated/u1/style.css"], "write", "edit-agent"),
  );
  assert.equal(unitEdit.code, "conflict");
  assert.ok(unitEdit.message.includes("can.generated/u1/style.css"), unitEdit.message);
  const other = await acquire(root, ["can.generated/u9/out.js"], "write", "edit-agent");
  await release(root, other);
  await release(root, capture);
  const edit = await acquire(root, ["app.can"], "write", "edit-agent");
  await release(root, edit);
  // Byte-identical lock-file body with the Rust host for a fixed token.
  const held = await acquire(root, ["app.can"], "write", "probe");
  const lockText = await readFile(join(root, ".can/gen/locks/app.can.write.lock"), "utf8");
  assert.equal(
    lockText,
    `{"version":1,"holder":"probe","token":"${held.token}","mode":"write","path":"app.can"}`,
  );
  await release(root, held);
});

test("read leases share and fence writes", async () => {
  const root = await freshRoot();
  const path = "can.generated/u1/style.css";
  const readerA = await acquire(root, [path], "read", "build-a");
  const readerB = await acquire(root, [path], "read", "build-b");
  const write = await errorOf(acquire(root, [path], "write", "accept"));
  assert.equal(write.code, "conflict");
  await release(root, readerA);
  await release(root, readerB);
  const held = await acquire(root, [path], "write", "accept");
  const read = await errorOf(acquire(root, [path], "read", "build"));
  assert.equal(read.code, "conflict");
  await release(root, held);
  const again = await acquire(root, [path], "read", "build");
  await release(root, again);
  // Release is idempotent and never steals a re-acquired foreign lock.
  const first = await acquire(root, ["app.can"], "write", "holder-a");
  await release(root, first);
  await release(root, first);
  const second = await acquire(root, ["app.can"], "write", "holder-b");
  const stale = await errorOf(release(root, first));
  assert.equal(stale.code, "stale-token");
  await release(root, second);
});

test("stopped-writer recovery needs confirmation and never steals", async () => {
  const root = await freshRoot();
  const crashed = await acquire(root, ["can.generated/u1/style.css"], "write", "crashed");
  const live = await acquire(root, ["app.can"], "write", "live");
  const blocked = await errorOf(
    acquire(root, ["can.generated/u1/style.css"], "write", "next"),
  );
  assert.equal(blocked.code, "conflict");
  const unconfirmed = await errorOf(
    recoverStoppedWriter(root, "crashed", crashed.token, false),
  );
  assert.equal(unconfirmed.code, "not-confirmed");
  const recovered = await recoverStoppedWriter(root, "crashed", crashed.token, true);
  assert.deepEqual(recovered, ["can.generated/u1/style.css"]);
  const remaining = await readdir(join(root, ".can/gen/locks"));
  assert.deepEqual(remaining, ["app.can.write.lock"]);
  const next = await acquire(root, ["can.generated/u1/style.css"], "write", "next");
  await release(root, next);
  await release(root, live);
});
