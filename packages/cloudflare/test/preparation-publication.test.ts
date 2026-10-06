/**
 * Publication adapter tests (P07.1): containment, reviewed bytes,
 * preview policy, honest partial writes, and cleanup on every exit.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PublicationError,
  PublicationSession,
  assertNoSymlinkEscape,
  resolveStagingRoot,
  validateRelativeKey,
  withPublicationSession,
} from "../src/preparation/publication.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("publication path validation", () => {
  it.each(["app/main.js", "a", "a/b/c.txt", "./x.js", "a/./b.js"])("accepts %j", (key) => {
    expect(() => validateRelativeKey(key)).not.toThrow();
  });

  it("normalizes dot segments without escaping", () => {
    expect(validateRelativeKey("a/./b.js")).toBe("a/b.js");
    expect(validateRelativeKey("a/b/../c.js")).toBe("a/c.js");
  });

  it.each([
    "/abs/path.js",
    "C:/win/path.js",
    "C:relative.js",
    "\\\\unc\\share",
    "..",
    "../escape.js",
    "a/../../escape.js",
    "",
    ".",
    "a\0b.js",
    "a\\b.js",
    "back\\slash",
  ])("refuses %j", (key) => {
    expect(() => validateRelativeKey(key)).toThrow(PublicationError);
  });
});

describe("publication staging roots", () => {
  it("rejects missing and non-directory roots", () => {
    expect(() => resolveStagingRoot(join(tmpdir(), "can-no-such-root-p071"))).toThrow(
      /does not exist/,
    );
    const file = join(mkdtempSync(join(tmpdir(), "can-p071-")), "f.txt");
    writeFileSync(file, "x");
    expect(() => resolveStagingRoot(file)).toThrow(/not a directory/);
  });

  it("resolves symlink roots to their realpath", () => {
    const base = mkdtempSync(join(tmpdir(), "can-p071-"));
    const link = join(tmpdir(), `can-p071-link-${Date.now()}`);
    symlinkSync(base, link);
    try {
      expect(resolveStagingRoot(link)).toBe(resolveStagingRoot(base));
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe("publication symlink containment", () => {
  it("refuses writes through a symlinked parent", () => {
    const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
    const outside = mkdtempSync(join(tmpdir(), "can-p071-out-"));
    symlinkSync(outside, join(dest, "link"));
    expect(() => assertNoSymlinkEscape(dest, join(dest, "link", "x.js"), "test")).toThrow(
      /symlink .*link/,
    );
    expect(existsSync(join(outside, "x.js"))).toBe(false);
  });

  it("refuses writes onto a symlink target", () => {
    const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
    const target = join(mkdtempSync(join(tmpdir(), "can-p071-out-")), "real.txt");
    writeFileSync(target, "real");
    symlinkSync(target, join(dest, "x.js"));
    expect(() => assertNoSymlinkEscape(dest, join(dest, "x.js"), "test")).toThrow(/symlink/);
  });

  it("allows missing components and plain files", () => {
    const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
    expect(() =>
      assertNoSymlinkEscape(dest, join(dest, "new", "dir", "x.js"), "test"),
    ).not.toThrow();
    const file = join(dest, "plain.txt");
    writeFileSync(file, "x");
    expect(() => assertNoSymlinkEscape(dest, file, "test")).not.toThrow();
  });

  it("refuses absolute escapes from the root", () => {
    const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
    expect(() => assertNoSymlinkEscape(dest, "/etc/passwd", "test")).toThrow(/escapes/);
  });
});

describe("publication session lifecycle", () => {
  it("stages bytes with exact lengths and hashes", () => {
    withPublicationSession("confirmed", (session) => {
      const records = session.stage([
        { relativePath: "a.js", bytes: "export const a = 1;\n" },
        { relativePath: "sub/b.bin", bytes: new Uint8Array([0, 255, 1]) },
      ]);
      expect(records).toHaveLength(2);
      expect(records[0]?.byteLength).toBe("export const a = 1;\n".length);
      expect(records[0]?.sha256).toBe(sha("export const a = 1;\n"));
      expect(records[1]?.byteLength).toBe(3);
      expect(readFileSync(records[0]?.absolutePath as string, "utf8")).toBe(
        "export const a = 1;\n",
      );
    });
  });

  it("verifies staged bytes against reviewed buffers, byte for byte", () => {
    withPublicationSession("confirmed", (session) => {
      const staged = session.stage([{ relativePath: "a.js", bytes: "v1\n" }]);
      expect(() =>
        session.verifyReviewed(staged, [{ relativePath: "a.js", bytes: "v1\n" }]),
      ).not.toThrow();
      expect(() =>
        session.verifyReviewed(staged, [{ relativePath: "a.js", bytes: "v2\n" }]),
      ).toThrow(/drifted/);
      expect(() =>
        session.verifyReviewed(staged, [{ relativePath: "other.js", bytes: "v1\n" }]),
      ).toThrow(/no reviewed buffer/);
    });
  });

  it("detects on-disk drift between stage and verify via re-read", () => {
    withPublicationSession("confirmed", (session) => {
      const staged = session.stage([{ relativePath: "a.js", bytes: "v1\n" }]);
      writeFileSync(staged[0]?.absolutePath as string, "tampered\n");
      // Records still describe v1: publishing re-reads the tampered
      // bytes, so a verify-then-publish flow must re-verify; here we
      // prove the record no longer matches a fresh hash of the file.
      const fresh = createHash("sha256")
        .update(readFileSync(staged[0]?.absolutePath as string))
        .digest("hex");
      expect(fresh).not.toBe(staged[0]?.sha256);
    });
  });

  it("preview sessions stage and verify but never publish", () => {
    withPublicationSession("preview", (session) => {
      const staged = session.stage([{ relativePath: "a.js", bytes: "x\n" }]);
      session.verifyReviewed(staged, [{ relativePath: "a.js", bytes: "x\n" }]);
      const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
      expect(() => session.publish(staged, dest)).toThrow(/never publish/);
      expect(existsSync(join(dest, "a.js"))).toBe(false);
    });
  });

  it("confirmed sessions publish staged bytes in order", () => {
    withPublicationSession("confirmed", (session) => {
      const staged = session.stage([
        { relativePath: "b.js", bytes: "B\n" },
        { relativePath: "a.js", bytes: "A\n" },
      ]);
      const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
      const result = session.publish(staged, dest);
      expect(result.written).toEqual(["b.js", "a.js"]);
      expect(readFileSync(join(dest, "b.js"), "utf8")).toBe("B\n");
      expect(readFileSync(join(dest, "a.js"), "utf8")).toBe("A\n");
    });
  });

  it("classifies partial publication honestly: written vs pending", () => {
    withPublicationSession("confirmed", (session) => {
      const staged = session.stage([
        { relativePath: "one.js", bytes: "1\n" },
        { relativePath: "two.js", bytes: "2\n" },
        { relativePath: "three.js", bytes: "3\n" },
      ]);
      const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
      let calls = 0;
      let caught: PublicationError | null = null;
      try {
        session.publish(staged, dest, (absolutePath, bytes) => {
          calls += 1;
          if (calls === 2) throw new Error("disk full (simulated)");
          mkdirSync(dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, bytes);
        });
      } catch (error) {
        caught = error as PublicationError;
      }
      expect(caught).toBeInstanceOf(PublicationError);
      expect(caught?.written).toEqual(["one.js"]);
      expect(caught?.pending).toEqual(["two.js", "three.js"]);
      // On-disk state matches the report exactly: one file, nothing more.
      expect(readFileSync(join(dest, "one.js"), "utf8")).toBe("1\n");
      expect(existsSync(join(dest, "two.js"))).toBe(false);
      expect(existsSync(join(dest, "three.js"))).toBe(false);
    });
  });

  it("refuses publish through symlinked destinations", () => {
    withPublicationSession("confirmed", (session) => {
      const staged = session.stage([{ relativePath: "x.js", bytes: "x\n" }]);
      const dest = mkdtempSync(join(tmpdir(), "can-p071-"));
      const outside = mkdtempSync(join(tmpdir(), "can-p071-out-"));
      symlinkSync(outside, join(dest, "sub"));
      // Stage under a sub path by re-staging with the link prefix.
      const staged2 = session.stage([{ relativePath: "sub/evil.js", bytes: "x\n" }]);
      expect(() => session.publish(staged2, dest)).toThrow(/symlink/);
      expect(staged).toHaveLength(1);
    });
  });
});

describe("publication cleanup on every exit", () => {
  it("removes the private root after success", () => {
    let root = "";
    withPublicationSession("confirmed", (session) => {
      root = session.root;
      session.stage([{ relativePath: "a.js", bytes: "x\n" }]);
      expect(existsSync(root)).toBe(true);
    });
    expect(existsSync(root)).toBe(false);
  });

  it("removes the private root after a throw", () => {
    let root = "";
    expect(() =>
      withPublicationSession("confirmed", (session) => {
        root = session.root;
        session.stage([{ relativePath: "a.js", bytes: "x\n" }]);
        throw new Error("boom (simulated)");
      }),
    ).toThrow("boom (simulated)");
    expect(existsSync(root)).toBe(false);
  });

  it("dispose is idempotent and overRoot never removes caller roots", () => {
    const session = PublicationSession.create("preview");
    const root = session.root;
    session.dispose();
    expect(existsSync(root)).toBe(false);
    session.dispose();
    expect(session.isDisposed).toBe(true);

    const callerRoot = mkdtempSync(join(tmpdir(), "can-p071-"));
    const owned = PublicationSession.overRoot("confirmed", callerRoot);
    owned.stage([{ relativePath: "k.js", bytes: "k\n" }]);
    owned.dispose();
    expect(existsSync(callerRoot)).toBe(true);
    expect(lstatSync(join(callerRoot, "k.js")).isFile()).toBe(true);
  });

  it("disposed sessions refuse further work", () => {
    const session = PublicationSession.create("confirmed");
    session.dispose();
    expect(() => session.stage([{ relativePath: "a.js", bytes: "x" }])).toThrow(/disposed/);
    expect(() => session.publish([], mkdtempSync(join(tmpdir(), "can-p071-")))).toThrow(/disposed/);
  });

  it("missing custom roots refuse loudly", () => {
    expect(() =>
      PublicationSession.overRoot("confirmed", join(tmpdir(), "can-no-such-p071")),
    ).toThrow(/does not exist/);
  });
});
