/** Exact installed Email boundary for already committed canonical bound sends. */
import { STD_EMAIL_V1_VERSION } from "@canlang/contracts";
import type { CanValue, EmailSendInput, OutboxIntent, ProviderBinding } from "@canlang/contracts";
import { encodeValue, normalizeSchema, validateOperationInput } from "@canlang/values";
import type { FieldDescriptor, SchemaDescriptor } from "@canlang/values";
import type { InstalledMailSender, ResolveInstalledMailSender } from "@canlang/services";
import type { DispatchProviderOutcome, DispatchReconcileEvidence } from "./invoke.js";

const CAPABILITY = "std.EmailV1";
const TARGET = `${CAPABILITY}.send`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function member(value: unknown, key: string): unknown {
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

export interface BoundMailAdapterOptions {
  /** The real owning compiled module's appDefinition, not reconstructed metadata. */
  readonly appDefinition: unknown;
  /** Explicit host installation expectation, including the account absent from source. */
  readonly binding: ProviderBinding;
  readonly resolveInstalledMailSender: ResolveInstalledMailSender;
}

export interface BoundMailAdapter {
  /** The driver must check this before evaluating a guard or winning a claim. */
  available(intent: OutboxIntent): boolean;
  callProvider(intent: OutboxIntent): Promise<DispatchProviderOutcome>;
  /** Unknown evidence stays null; a 404 is never proof of not-found. */
  reconcile(intent: OutboxIntent): Promise<DispatchReconcileEvidence | null>;
}

interface ResolvedMail {
  readonly installed: InstalledMailSender;
  readonly input: EmailSendInput;
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
      if (typeof intent.intentId !== "string" || intent.intentId === "" || intent.target !== TARGET ||
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
      const operation = member(member(capability, "operations"), "send");
      if (member(member(operation, "result"), "type") !== "EmailAccepted") return null;
      const inputs = member(operation, "inputs");
      if (!record(inputs)) return null;
      const installed = options.resolveInstalledMailSender(expected.deployment);
      if (installed === null || installed.binding.deployment !== expected.deployment ||
          installed.binding.capability !== expected.capability || installed.binding.capabilityVersion !== expected.capabilityVersion ||
          installed.binding.account !== expected.account || typeof installed.mail.send !== "function" || typeof installed.mail.reconcile !== "function") return null;
      // Values owns normalization and wire admission against the exact emitted
      // operation declaration. Only its nested encoded arguments reach Services.
      const schema = normalizeSchema({
        operations: { [TARGET]: { inputs } },
      } as SchemaDescriptor);
      const checked = validateOperationInput(schema, TARGET, request["arguments"]);
      const args: Record<string, unknown> = Object.create(null);
      for (const [name, value] of Object.entries(checked)) {
        args[name] = encodeValue((inputs[name] as FieldDescriptor).type, value as CanValue);
      }
      if (!closed(args, ["to", "subject", "body", "attachments"]) || typeof args["to"] !== "string" ||
          typeof args["subject"] !== "string" || typeof args["body"] !== "string" || !Array.isArray(args["attachments"]) ||
          !args["attachments"].every(value => typeof value === "string")) return null;
      return { installed, input: args as unknown as EmailSendInput };
    } catch { return null; }
  };
  return {
    available: intent => resolve(intent) !== null,
    async callProvider(intent) {
      const resolved = resolve(intent);
      if (resolved === null) return { kind: "uncertain" };
      try {
        const completion = await resolved.installed.mail.send(resolved.input, { deliveryId: intent.intentId });
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
