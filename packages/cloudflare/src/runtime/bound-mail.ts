/** Exact installed Email boundary for already committed canonical bound sends. */
import { STD_EMAIL_V1_VERSION } from "@canlang/contracts";
import type { CanValue, EmailSendInput, OutboxIntent, ProviderBinding, Membership } from "@canlang/contracts";
import { normalizeTag } from "@canlang/ui";
import { encodeValue, normalizeSchema, validateOperationInput } from "@canlang/values";
import type { FieldDescriptor, SchemaDescriptor } from "@canlang/values";
import type { InstalledMailSender, ResolveInstalledMailSender } from "@canlang/services";
import type { DispatchProviderOutcome, DispatchReconcileEvidence } from "./invoke.js";

const CAPABILITY = "std.EmailV1";
const TARGET = `${CAPABILITY}.send`;
const USER_TARGET = `${CAPABILITY}.send_user`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function member(value: unknown, key: string): unknown {
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * Frozen `{text,locale}` carriers produced by the checked message
 * formatter arrive inline in recorded human-text paths (`subject`,
 * `body`). Only the exact frozen shape is accepted and only its already
 * selected text reaches the provider; the locale stays informational.
 * Mirrors `resolvedText` without resolving or parsing anything else.
 */
export function carrierText(value: unknown): string | null {
  if (!closed(value, ["text", "locale"])) return null;
  const text = value["text"], locale = value["locale"];
  if (typeof text !== "string" || typeof locale !== "string") return null;
  try {
    if (normalizeTag(locale) !== locale) return null;
  } catch { return null; }
  return text;
}

/**
 * Single slot-qualified carrier gate shared by the mail provider adapter
 * and generic bound-capability staging. Only the exact Email human-text
 * slots (`subject`/`body` on either mail send target) unwrap to their
 * selected text; every other slot or source keeps its value unchanged so
 * normal field validation still refuses a structural `{text,locale}`.
 */
export function mailHumanText(source: string, name: string, value: unknown): unknown {
  if ((source === TARGET || source === USER_TARGET) && (name === "subject" || name === "body")) {
    const carried = carrierText(value);
    if (carried !== null) return carried;
  }
  return value;
}

export interface BoundMailAdapterOptions {
  /** The real owning compiled module's appDefinition, not reconstructed metadata. */
  readonly appDefinition: unknown;
  /** Explicit host installation expectation, including the account absent from source. */
  readonly binding: ProviderBinding;
  readonly resolveInstalledMailSender: ResolveInstalledMailSender;
  /** Private host-only Identity access; never a source directory or result. */
  readonly userRecipients?: {
    readonly teamId: string;
    findMembership(team: string, user: string): Promise<Membership | null>;
    findUserById(user: string): Promise<{ readonly user_id: string; readonly email: string; readonly email_verified: boolean } | null>;
  };
}

export interface BoundMailAdapter {
  /** The fence kernel preflights this after the structural claim win but before guard evaluation; a false refusal terminalizes under the held claim. */
  available(intent: OutboxIntent): boolean;
  userRecipient(intent: OutboxIntent): { readonly user: string; readonly team: string } | null;
  recipientActive(intent: OutboxIntent): Promise<boolean>;
  resolveRecipient(intent: OutboxIntent): Promise<string | null>;
  callProvider(intent: OutboxIntent, pinnedEmail?: string): Promise<DispatchProviderOutcome>;
  /** Unknown evidence stays null; a 404 is never proof of not-found. */
  reconcile(intent: OutboxIntent): Promise<DispatchReconcileEvidence | null>;
}

interface ResolvedMail {
  readonly installed: InstalledMailSender;
  readonly input: EmailSendInput;
  readonly recipientUser?: string;
}

type MailEvidence =
  | { readonly kind: "delivered"; readonly result: { readonly reference: string } }
  | { readonly kind: "failed"; readonly code: "provider_rejected"; readonly message: string };

/** Validate completion identity and closed payload before interpreting certainty. */
function decisiveCompletion(value: unknown, deliveryId: string): MailEvidence | null {
  if (!closed(value, ["delivery_id", "status", "result", "error"]) || value["delivery_id"] !== deliveryId) return null;
  const result = value["result"], error = value["error"];
  if (value["status"] === "succeeded" && error === null && closed(result, ["reference"]) &&
      typeof result["reference"] === "string" && result["reference"] !== "") {
    return { kind: "delivered", result: { reference: result["reference"] } };
  }
  // Services distinguishes definite provider rejection from malformed replies,
  // timeouts and unknown_delivery. Only the documented rejection is terminal.
  if (value["status"] === "failed" && result === null && closed(error, ["code", "message"]) &&
      error["code"] === "provider_rejected" && typeof error["message"] === "string") {
    return { kind: "failed", code: "provider_rejected", message: "Mail delivery rejected by provider." };
  }
  return null;
}

/** No discovery, alias fallback, transport implementation or receipt association. */
export function createBoundMailAdapter(options: BoundMailAdapterOptions): BoundMailAdapter {
  const expected = { ...options.binding };
  const resolve = (intent: OutboxIntent): ResolvedMail | null => {
    try {
      if (typeof intent.intentId !== "string" || intent.intentId === "" || ![TARGET, USER_TARGET].includes(intent.target) ||
          !closed(intent.arguments, ["binding", "from", "arguments"])) return null;
      const request = intent.arguments;
      if (typeof request["binding"] !== "string" || typeof request["from"] !== "string" ||
          !record(request["arguments"])) return null;
      const definition = options.appDefinition;
      const declaredBinding = member(member(definition, "bindings"), request["binding"]);
      if (member(declaredBinding, "capability") !== CAPABILITY || member(declaredBinding, "from") !== request["from"] ||
          request["from"] !== expected.deployment || expected.capability !== CAPABILITY ||
          expected.capabilityVersion !== STD_EMAIL_V1_VERSION || typeof expected.account !== "string" || expected.account === "") return null;
      const capability = member(member(definition, "capabilities"), CAPABILITY);
      const version = member(capability, "version");
      if (version !== STD_EMAIL_V1_VERSION && version !== BigInt(STD_EMAIL_V1_VERSION)) return null;
      const operation = member(member(capability, "operations"), intent.target === USER_TARGET ? "send_user" : "send");
      if (member(member(operation, "result"), "type") !== "EmailAccepted") return null;
      const inputs = member(operation, "inputs");
      if (!record(inputs)) return null;
      const installed = options.resolveInstalledMailSender(expected.deployment);
      if (installed === null || installed.binding.deployment !== expected.deployment ||
          installed.binding.capability !== expected.capability || installed.binding.capabilityVersion !== expected.capabilityVersion ||
          installed.binding.account !== expected.account || typeof installed.mail.send !== "function" || typeof installed.mail.reconcile !== "function") return null;
      // Frozen carriers in recorded human-text paths unwrap to their
      // already selected text before Values admission; every other value
      // keeps the existing string-only admission below.
      const rawArguments = record(request["arguments"]) ? request["arguments"] : null;
      if (rawArguments === null) return null;
      const sendArguments: Record<string, unknown> = { ...rawArguments };
      for (const name of ["subject", "body"] as const) {
        sendArguments[name] = mailHumanText(intent.target, name, sendArguments[name]);
      }
      // Values owns normalization and wire admission against the exact emitted
      // operation declaration. Only its nested encoded arguments reach Services.
      const schema = normalizeSchema({
        operations: { [intent.target]: { inputs } },
      } as SchemaDescriptor);
      const checked = validateOperationInput(schema, intent.target, sendArguments);
      const args: Record<string, unknown> = Object.create(null);
      for (const [name, value] of Object.entries(checked)) {
        args[name] = encodeValue((inputs[name] as FieldDescriptor).type, value as CanValue, undefined, schema);
      }
      const recipient = intent.target === USER_TARGET ? args["to"] : undefined;
      const recipientUser = closed(recipient, ['id']) && typeof recipient['id'] === 'string' && recipient['id'] !== '' ? recipient['id'] : undefined;
      if (intent.target === USER_TARGET && (recipientUser === undefined || options.userRecipients === undefined)) return null;
      if (!closed(args, ["to", "subject", "body", "attachments"]) || (intent.target === TARGET && typeof args["to"] !== "string") ||
          typeof args["subject"] !== "string" || typeof args["body"] !== "string" || !Array.isArray(args["attachments"]) ||
          !args["attachments"].every(value => typeof value === "string")) return null;
      return { installed, input: args as unknown as EmailSendInput, ...(recipientUser === undefined ? {} : { recipientUser }) };
    } catch { return null; }
  };
  const userRecipient = (intent: OutboxIntent) => {
    const resolved = resolve(intent);
    return resolved?.recipientUser === undefined || options.userRecipients === undefined ? null
      : { user: resolved.recipientUser, team: options.userRecipients.teamId };
  };
  const recipientActive = async (intent: OutboxIntent): Promise<boolean> => {
    const recipient = userRecipient(intent);
    if (recipient === null) return false;
    try {
      const membership = await options.userRecipients!.findMembership(recipient.team, recipient.user);
      return membership?.status === 'active' && membership.user_id === recipient.user && membership.team_id === recipient.team;
    } catch { throw new Error('Private mail recipient lookup unavailable.'); }
  };
  return {
    userRecipient, recipientActive,
    async resolveRecipient(intent) {
      const recipient = userRecipient(intent);
      if (recipient === null || !await recipientActive(intent)) return null;
      let user: Awaited<ReturnType<NonNullable<BoundMailAdapterOptions['userRecipients']>['findUserById']>>;
      try { user = await options.userRecipients!.findUserById(recipient.user); }
      catch { throw new Error('Private mail recipient lookup unavailable.'); }
      if (user?.user_id !== recipient.user || !user.email_verified) return null;
      try { return encodeValue('email', user.email) as string; } catch { return null; }
    },
    available: intent => resolve(intent) !== null,
    async callProvider(intent, pinnedEmail) {
      const resolved = resolve(intent);
      if (resolved === null) return { kind: "uncertain" };
      if (resolved.recipientUser !== undefined && (typeof pinnedEmail !== 'string' || pinnedEmail === '' || !await recipientActive(intent))) {
        return { kind: 'failed', cause: { kind: 'permanent', code: 'recipient_unavailable', message: 'Mail recipient unavailable.' } };
      }
      try {
        const completion = await resolved.installed.mail.send(resolved.recipientUser === undefined ? resolved.input : { ...resolved.input, to: pinnedEmail! }, { deliveryId: intent.intentId });
        const evidence = decisiveCompletion(completion, intent.intentId);
        if (evidence?.kind === "delivered") return evidence;
        if (evidence?.kind === "failed") return { kind: "failed", cause: { kind: "permanent", code: evidence.code, message: evidence.message } };
      } catch { /* A thrown transport or adapter outcome proves no final result. */ }
      return { kind: "uncertain" };
    },
    async reconcile(intent) {
      const resolved = resolve(intent);
      if (resolved === null) return null;
      try {
        return decisiveCompletion(await resolved.installed.mail.reconcile(intent.intentId), intent.intentId);
      } catch { return null; }
    },
  };
}
