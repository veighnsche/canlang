/**
 * BGI-04 lease tests: canonical lock order, token-checked read/write
 * lock files, and explicit stopped-writer recovery. Mirrors the Rust
 * `bgi04_leases` lease coverage so both hosts enforce the same protocol:
 * shared escaping/token vectors, conflicting participants, shared
 * readers fencing writes, and recovery that never steals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("shared protocol vectors match both hosts", async () => {
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
  // Read-lock files pin the shared admission shape too: exact filename and
  // byte-identical body, so the other host's locks arbitrate this host.
  const root = await freshRoot();
  const reader = await acquire(root, ["app.can"], "read", "build");
  const lockText = await readFile(
    join(root, ".can/gen/locks", `app.can.read.${reader.token}.lock`),
    "utf8",
  );
  assert.equal(
    lockText,
    `{"version":1,"holder":"build","token":"${reader.token}","mode":"read","path":"app.can"}`,
  );
  await release(root, reader);
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

test("simultaneous read/write acquisitions cannot both be admitted", async () => {
  // Both creators wait after their existing checks, before create: shared
  // atomic admission must refuse at least one side, never both.
  const root = await freshRoot();
  const mutable = fs as unknown as { writeFile: typeof writeFile };
  const realWriteFile = fs.writeFile;
  let arrivals = 0;
  let unblock!: () => void;
  const both = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  mutable.writeFile = (async (
    path: Parameters<typeof writeFile>[0],
    ...args: unknown[]
  ) => {
    const options = args[1] as { flag?: string } | undefined;
    if (String(path).includes("/.can/gen/locks/") && options?.flag === "wx") {
      arrivals += 1;
      if (arrivals === 2) {
        unblock();
      }
      await both;
    }
    return Reflect.apply(realWriteFile, fs, [path, ...args]) as ReturnType<
      typeof writeFile
    >;
  }) as typeof writeFile;
  syncBuiltinESMExports();
  try {
    const results = await Promise.allSettled([
      acquire(root, ["app.can"], "read", "build"),
      acquire(root, ["app.can"], "write", "accept"),
    ]);
    const admitted = results.filter((result) => result.status === "fulfilled");
    assert.ok(
      admitted.length < 2,
      `incompatible leases co-admitted: ${results.map((result) => (result.status === "fulfilled" ? result.value.mode : result.reason.code)).join(", ")}`,
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        await release(root, result.value);
      } else {
        assert.ok(result.reason instanceof LeaseError);
        assert.equal(result.reason.code, "conflict");
      }
    }
  } finally {
    mutable.writeFile = realWriteFile;
    syncBuiltinESMExports();
  }
});

test("foreign lock files arbitrate admission", async () => {
  // Hand-write the exact bytes the Rust host emits; this host must honor
  // them (shared admission interoperability across hosts).
  const root = await freshRoot();
  await mkdir(join(root, ".can/gen/locks"), { recursive: true });
  await writeFile(
    join(root, ".can/gen/locks/app.can.read.v1-0123456789abcdef.lock"),
    '{"version":1,"holder":"rust-build","token":"v1-0123456789abcdef","mode":"read","path":"app.can"}',
  );
  const blocked = await errorOf(acquire(root, ["app.can"], "write", "accept"));
  assert.equal(blocked.code, "conflict");
  const reader = await acquire(root, ["app.can"], "read", "build");
  await release(root, reader);
  const recovered = await recoverStoppedWriter(root, "rust-build", "v1-0123456789abcdef", true);
  assert.deepEqual(recovered, ["app.can"]);
  await writeFile(
    join(root, ".can/gen/locks/app.can.write.lock"),
    '{"version":1,"holder":"rust-accept","token":"v1-fedcba9876543210","mode":"write","path":"app.can"}',
  );
  assert.equal((await errorOf(acquire(root, ["app.can"], "write", "next"))).code, "conflict");
  assert.equal((await errorOf(acquire(root, ["app.can"], "read", "build"))).code, "conflict");
});
