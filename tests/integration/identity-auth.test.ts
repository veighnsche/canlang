/**
 * Identity auth join (L7 directory; this ONE file is the identity-auth
 * case body per the join contract in `tests/integration/README.md`).
 *
 * Drives the REAL producers only through their owned surfaces — the
 * `@canlang/identity` account-recovery and CSRF entry points over the
 * identity memory store double, and the `@canlang/interfaces` operation-id
 * envelope validator — with no copied implementation. Every evidence row
 * is `local`; no processes spawned, no temp state.
 */
import { describe, expect, it } from "vitest";
import {
  deriveCsrfToken,
  hashPassword,
  recoverAccount,
  requestRecovery,
  verifyCsrfToken,
} from "@canlang/identity";
import { createMemoryIdentityStore } from "@canlang/identity/testing";
import { validateOperationId } from "@canlang/interfaces";

const RECOVERY_URL = "https://app.example/recover";

interface SentMail {
  to: string;
  subject: string;
  body: string;
}

function createMailOutbox(): { sent: SentMail[]; mail: { sendMail(to: string, subject: string, body: string): Promise<void> } } {
  const sent: SentMail[] = [];
  return {
    sent,
    mail: {
      async sendMail(to: string, subject: string, body: string): Promise<void> {
        sent.push({ to, subject, body });
      },
    },
  };
}

function extractToken(body: string): string {
  const match = body.match(/token=([^\s&]+)/);
  if (match === null) throw new Error("recovery mail carries no token link");
  return match[1];
}

/** Canonical UUIDv7 text form with an exact embedded unix-ms timestamp. */
function uuidV7(ms: number): string {
  const hex = Math.floor(ms).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
}

describe("identity auth", () => {
  it("requestRecovery is single-use: a second request consumes the first link", async () => {
    const store = createMemoryIdentityStore();
    const { sent, mail } = createMailOutbox();
    const user = await store.createUser({
      email: "sam@example.com",
      password_hash: await hashPassword("initial-password-1"),
      email_verified: true,
    });

    await expect(
      requestRecovery(store, mail, { email: "sam@example.com" }, { recoveryBaseUrl: RECOVERY_URL }),
    ).resolves.toEqual({ ok: true });
    await expect(
      requestRecovery(store, mail, { email: "sam@example.com" }, { recoveryBaseUrl: RECOVERY_URL }),
    ).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(2);

    const firstToken = extractToken(sent[0].body);
    const secondToken = extractToken(sent[1].body);
    expect(secondToken).not.toBe(firstToken);

    await expect(
      recoverAccount(store, { token: firstToken, new_password: "replacement-password-2" }),
    ).rejects.toThrow("Invalid or expired recovery link.");

    await expect(
      recoverAccount(store, { token: secondToken, new_password: "replacement-password-2" }),
    ).resolves.toEqual({ user_id: user.user_id });

    await expect(
      recoverAccount(store, { token: secondToken, new_password: "replacement-password-3" }),
    ).rejects.toThrow("Invalid or expired recovery link.");
  });

  it("requestRecovery stays silent for unknown addresses", async () => {
    const store = createMemoryIdentityStore();
    const { sent, mail } = createMailOutbox();
    await expect(
      requestRecovery(store, mail, { email: "nobody@example.com" }, { recoveryBaseUrl: RECOVERY_URL }),
    ).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("verifyCsrfToken accepts the derived token and rejects anything else", async () => {
    const sessionToken = "session-bearer-token";
    const token = await deriveCsrfToken(sessionToken);
    await expect(verifyCsrfToken(sessionToken, token)).resolves.toBe(true);
    await expect(verifyCsrfToken("other-session-token", token)).resolves.toBe(false);
    await expect(verifyCsrfToken(sessionToken, `${token}x`)).resolves.toBe(false);
    await expect(verifyCsrfToken("", token)).resolves.toBe(false);
    await expect(verifyCsrfToken(sessionToken, "")).resolves.toBe(false);
  });

  it("validateOperationId admits a current id and rejects shape, age, and future faults", () => {
    const now = 1_758_000_000_000;
    const clock = { nowMs: () => now };

    expect(validateOperationId(uuidV7(now), clock)).toBeNull();
    expect(validateOperationId(uuidV7(now - 60_000), clock)).toBeNull();

    expect(validateOperationId("not-an-operation-id", clock)?.message).toBe("Invalid operation_id.");
    expect(validateOperationId(42, clock)?.message).toBe("Invalid operation_id.");
    expect(validateOperationId("01960000-0000-6000-8000-000000000000", clock)?.message).toBe(
      "Invalid operation_id.",
    );
    expect(validateOperationId("01960000-0000-8000-8000-000000000000", clock)?.message).toBe(
      "Invalid operation_id.",
    );

    expect(validateOperationId(uuidV7(now - 25 * 60 * 60 * 1000), clock)?.message).toBe(
      "Expired operation_id.",
    );
    expect(validateOperationId(uuidV7(now + 10 * 60 * 1000), clock)?.message).toBe(
      "operation_id is from the future.",
    );
  });
});
