/**
 * Browser submit client for generated operation forms (T20b).
 *
 * Production submits never post the form element natively: bracket field
 * names are never expanded server-side, so this client collects the flat
 * submitted map, uploads picked file bytes through the S7 intent flow,
 * projects the envelope through `projectGeneratedInputs`, and POSTs the
 * JSON mutation envelope to the dispatcher-supplied action. Source form
 * occurrences opt into JSON denials to retain their own draft DOM. Default
 * callers receive JSON (no binding) or HTML (re-rendered form, fragment iff the
 * submit carried HX-Request); success is always the JSON mutation result
 * (E-pinned: no success headers, no HTML success swaps). The caller owns
 * all URLs (action, intents) and all DOM swaps; this module stays DOM-free
 * (structural control/document types) with injected fetch for tests.
 */

import { CSRF_FIELD } from "@canlang/contracts";
import type { FormMode } from "@canlang/contracts";
import type {
  BusinessError,
  BusinessErrorCode,
  ClosedInputs,
  DerivedOperationInputs,
  FieldError,
  MutationEnvelope,
  MutationResult,
} from "@canlang/contracts";
import { projectGeneratedInputs } from "./forms.js";

/**
 * Session CSRF header (mirrors the identity-owned spelling the dispatcher
 * asserts; see interfaces http/context.ts — cited, never redefined here).
 */
const CSRF_HEADER = "x-csrf-token";

/** Default denial content preserves the existing re-renderable HTML contract. */
const SUBMIT_ACCEPT = "text/html";

/** Typed submit failure: correctable keeps input for retry, else loud. */
export type GeneratedSubmitErrorCode =
  | "projection"
  | "upload_failed"
  | "transport"
  | "contract"
  | "usage";

export class GeneratedSubmitError extends Error {
  readonly code: GeneratedSubmitErrorCode;
  readonly correctable: boolean;
  readonly field?: string;

  constructor(
    code: GeneratedSubmitErrorCode,
    message: string,
    correctable: boolean,
    field?: string,
  ) {
    super(message);
    this.name = "GeneratedSubmitError";
    this.code = code;
    this.correctable = correctable;
    if (field !== undefined) {
      this.field = field;
    }
  }
}

/** Minimal structural file (satisfied by DOM File and test fakes). */
export interface DomFileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal structural control (satisfied by DOM form elements). */
export interface DomControlLike {
  readonly name?: string;
  readonly type?: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly files?: ArrayLike<DomFileLike> | null;
  getAttribute?(name: string): string | null;
}

/** Minimal structural form (element list only; action travels separately). */
export interface DomFormLike {
  readonly elements: ArrayLike<DomControlLike>;
}

/** One picked file bound for the S7 intent flow. */
export interface FileLike {
  /** Derivation input name (the picker's data-can-file value). */
  readonly field: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface CollectedForm {
  readonly flat: Record<string, string>;
  readonly files: readonly FileLike[];
}

export interface SubmitFetchHeaders {
  get(name: string): string | null;
}

export interface SubmitFetchResponse {
  readonly status: number;
  readonly headers: SubmitFetchHeaders;
  text(): Promise<string>;
}

export interface SubmitFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array;
}

export type SubmitFetch = (
  url: string,
  init: SubmitFetchInit,
) => Promise<SubmitFetchResponse>;

export type GeneratedSubmitResult =
  | { readonly kind: "committed"; readonly result: MutationResult }
  | {
      readonly kind: "rerender";
      readonly html: string;
      readonly status: number;
      readonly fragment: boolean;
    }
  | { readonly kind: "denied"; readonly error: BusinessError; readonly status: number };

export interface SubmitGeneratedFormInput {
  readonly derived: DerivedOperationInputs;
  readonly mode: FormMode;
  readonly flat: Record<string, string>;
  readonly files?: ReadonlyArray<FileLike>;
  /** Dispatcher-supplied op POST target; never invented here. */
  readonly action: string;
  /** True submits (and expects denials) as an HTMX fragment. */
  readonly fragment: boolean;
  /** Source occurrences retain their own DOM and consume checked JSON errors. */
  readonly denialFormat?: "html" | "json";
  /** Dispatcher-supplied S7 intents URL; required iff files carry bytes. */
  readonly intentsUrl?: string;
  readonly fetchImpl?: SubmitFetch;
  readonly mintUploadId?: () => string;
}

/**
 * Minimal structural document for swap application: fragment lookup
 * plus the full-document replace stream (open/write/close replaces the
 * live document in place — the portable spelling; documentElement
 * outerHTML assignment is rejected by some DOM implementations).
 */
export interface SwapDocumentLike {
  getElementById(id: string): { outerHTML: string } | null;
  open(): void;
  write(html: string): void;
  close(): void;
}

/** Plain-object check for response/draft subtrees. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMember(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new GeneratedSubmitError(
      "usage",
      `collectFormValues: ${what} must be a string`,
      false,
    );
  }
  return value;
}

/**
 * Collect one rendered form element: named controls to the flat string
 * map (native semantics — unchecked boxes/radios omit, duplicate names
 * resolve last-wins, unnamed controls skip), S7 pickers (`data-can-file`)
 * to picked byte payloads. Picker pseudo-paths never enter the map; a
 * named file control carrying bytes fails closed (bytes need the S7
 * picker flow, never a flat text member).
 */
export async function collectFormValues(form: DomFormLike): Promise<CollectedForm> {
  const flat: Record<string, string> = {};
  const files: FileLike[] = [];
  const elements = form.elements;
  for (let index = 0; index < elements.length; index += 1) {
    const control = elements[index];
    if (control === undefined) {
      continue;
    }
    const slot =
      typeof control.getAttribute === "function"
        ? control.getAttribute("data-can-file")
        : null;
    if (slot !== null && slot !== "") {
      const picked = control.files?.[0] ?? null;
      if (picked !== null && picked !== undefined) {
        if (!Number.isSafeInteger(picked.size) || picked.size < 0) {
          throw new GeneratedSubmitError(
            "usage",
            `collectFormValues: picked file for ${JSON.stringify(slot)} needs a safe nonnegative size`,
            false,
          );
        }
        files.push({
          field: slot,
          name: stringMember(picked.name, `picked file name for ${JSON.stringify(slot)}`),
          type: stringMember(picked.type, `picked file type for ${JSON.stringify(slot)}`),
          size: picked.size,
          bytes: new Uint8Array(await picked.arrayBuffer()),
        });
      }
      continue;
    }
    const name = control.name;
    if (name === undefined || name === "") {
      continue;
    }
    const type = (control.type ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (control.checked === true) {
        flat[name] = stringMember(control.value ?? "on", `control ${JSON.stringify(name)}`);
      }
      continue;
    }
    if (type === "file") {
      if ((control.files?.length ?? 0) > 0) {
        throw new GeneratedSubmitError(
          "usage",
          `collectFormValues: named file control ${JSON.stringify(name)} needs the S7 picker flow (data-can-file)`,
          false,
        );
      }
      continue;
    }
    flat[name] = stringMember(control.value, `control ${JSON.stringify(name)}`);
  }
  return { flat, files };
}

function assertFileLike(file: FileLike): void {
  if (typeof file.field !== "string" || file.field === "") {
    throw new GeneratedSubmitError("usage", "submitGeneratedForm: upload file needs its input field", false);
  }
  const what = `upload file for ${JSON.stringify(file.field)}`;
  if (typeof file.name !== "string" || typeof file.type !== "string") {
    throw new GeneratedSubmitError("usage", `submitGeneratedForm: ${what} needs string name/type`, false);
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new GeneratedSubmitError(
      "usage",
      `submitGeneratedForm: ${what} needs a safe nonnegative size`,
      false,
    );
  }
  if (!(file.bytes instanceof Uint8Array)) {
    throw new GeneratedSubmitError(
      "usage",
      `submitGeneratedForm: ${what} needs Uint8Array bytes`,
      false,
    );
  }
}

function mustUploadsUrl(value: string | undefined): string {
  if (typeof value !== "string" || value === "") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: file upload needs its intents URL",
      false,
    );
  }
  return value;
}

function defaultFetch(): SubmitFetch {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: no fetch implementation (pass fetchImpl)",
      false,
    );
  }
  return candidate as SubmitFetch;
}

function defaultMintUploadId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID !== "function") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: file upload needs an upload_id mint (pass mintUploadId)",
      false,
    );
  }
  const id = crypto.randomUUID();
  if (id === "") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: mintUploadId must mint a nonempty upload_id",
      false,
    );
  }
  return id;
}

/** Wrap a projection throw as a correctable submit failure (field when named). */
function projectionError(error: unknown): GeneratedSubmitError {
  const message = error instanceof Error ? error.message : String(error);
  const field = /input "([^"]+)"/.exec(message)?.[1];
  return new GeneratedSubmitError("projection", message, true, field);
}

/** Safe upload-step failure: BusinessError-shaped bodies keep their message. */
function uploadFailure(field: string, step: string, status: number, text: string): GeneratedSubmitError {
  let message = `${step} for ${JSON.stringify(field)} failed (status ${status})`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed["code"] === "string" && typeof parsed["message"] === "string") {
      message = `${step} for ${JSON.stringify(field)} failed: ${parsed["message"]}`;
    }
  } catch {
    // Keep the generic message: raw bodies never surface.
  }
  return new GeneratedSubmitError("upload_failed", message, true);
}

function transportError(step: string, field: string, error: unknown): GeneratedSubmitError {
  const detail = error instanceof Error ? error.message : String(error);
  return new GeneratedSubmitError("transport", `${step} for ${JSON.stringify(field)} failed: ${detail}`, true);
}

/** POST one JSON body; non-2xx becomes a safe step failure, non-JSON a contract break. */
async function postJson(
  fetchImpl: SubmitFetch,
  url: string,
  csrf: string,
  body: unknown,
  field: string,
  step: string,
): Promise<unknown> {
  let response: SubmitFetchResponse;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrf },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw transportError(step, field, error);
  }
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw uploadFailure(field, step, response.status, text);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GeneratedSubmitError(
      "contract",
      `${step} for ${JSON.stringify(field)} answered non-JSON`,
      false,
    );
  }
}

/** PUT picked bytes to the intent's content destination (opaque octets). */
async function putBytes(
  fetchImpl: SubmitFetch,
  url: string,
  csrf: string,
  bytes: Uint8Array,
  field: string,
): Promise<void> {
  let response: SubmitFetchResponse;
  try {
    response = await fetchImpl(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", [CSRF_HEADER]: csrf },
      body: bytes,
    });
  } catch (error) {
    throw transportError("upload", field, error);
  }
  if (response.status < 200 || response.status >= 300) {
    throw uploadFailure(field, "upload", response.status, await response.text());
  }
}

interface CheckedIntent {
  readonly content: string;
  readonly finalize: string;
}

/** Validate the intent grant: opaque identity plus generated destinations. */
function checkedIntent(value: unknown, field: string): CheckedIntent {
  const fail = (): GeneratedSubmitError =>
    new GeneratedSubmitError(
      "contract",
      `intent for ${JSON.stringify(field)} must answer {intent_id, content, finalize, expires_at}`,
      false,
    );
  if (!isRecord(value)) {
    throw fail();
  }
  const content = value["content"];
  const finalize = value["finalize"];
  if (
    typeof value["intent_id"] !== "string" ||
    value["intent_id"] === "" ||
    typeof content !== "string" ||
    content === "" ||
    typeof finalize !== "string" ||
    finalize === "" ||
    typeof value["expires_at"] !== "string" ||
    value["expires_at"] === ""
  ) {
    throw fail();
  }
  return { content, finalize };
}

/** Validate the committed mutation result shape (status + operation identity). */
function checkedMutationResult(body: string, operation: string): MutationResult {
  const fail = (): GeneratedSubmitError =>
    new GeneratedSubmitError(
      "contract",
      `submit for ${JSON.stringify(operation)} answered no mutation result`,
      false,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw fail();
  }
  if (!isRecord(parsed)) {
    throw fail();
  }
  const status = parsed["status"];
  const operationId = parsed["operation_id"];
  if (
    (status !== "committed" && status !== "replayed") ||
    typeof operationId !== "string" ||
    operationId === ""
  ) {
    throw fail();
  }
  // Pinned members validated; optional members pass through opaquely —
  // the dispatcher is their authority, not this client.
  return parsed as unknown as MutationResult;
}

/**
 * Membership in the wire BusinessErrorCode union (deliberate pin; see
 * contracts wire.ts — a dispatcher speaking an unknown code is version
 * skew and fails as a contract break, never a guessed member).
 */
function isBusinessErrorCode(value: string): value is BusinessErrorCode {
  return (
    value === "validation" ||
    value === "forbidden" ||
    value === "not_found" ||
    value === "conflict" ||
    value === "rule_failed" ||
    value === "busy" ||
    value === "limit" ||
    value === "delivery_unknown"
  );
}

/** True for a well-shaped field error (safe strings only, never rendered raw). */
function isFieldErrorShaped(value: unknown): value is FieldError {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["path"] === "string" &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string"
  );
}

/** Validate the JSON denial envelope; misshapen extras never survive. */
function checkedBusinessError(body: string, status: number, operation: string): BusinessError {
  const fail = (): GeneratedSubmitError =>
    new GeneratedSubmitError(
      "contract",
      `denial for ${JSON.stringify(operation)} (status ${status}) carries no business error`,
      false,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw fail();
  }
  if (!isRecord(parsed)) {
    throw fail();
  }
  const code = parsed["code"];
  if (typeof code !== "string" || !isBusinessErrorCode(code)) {
    throw fail();
  }
  if (typeof parsed["message"] !== "string") {
    throw fail();
  }
  const fields = Array.isArray(parsed["fields"])
    ? parsed["fields"].filter(isFieldErrorShaped).map((field) => ({
        path: field.path,
        code: field.code,
        message: field.message,
      }))
    : undefined;
  return {
    code,
    message: parsed["message"],
    ...(typeof parsed["operation_id"] === "string" ? { operation_id: parsed["operation_id"] } : {}),
    ...(fields === undefined ? {} : { fields }),
    ...(typeof parsed["retryable"] === "boolean" ? { retryable: parsed["retryable"] } : {}),
  };
}

/**
 * Submit one generated form: upload picked bytes through S7 intents (in
 * derivation order, each intent seeing the projected non-file arguments
 * plus already-completed file ids, its own slot absent), project the
 * envelope, and POST it as JSON. The envelope carries the derivation's
 * operation (a tampered flat-map `operation` is ignored), the form's
 * rendered idempotency key (retried submits reuse it; the client never
 * mints one), and the projected inputs; CSRF travels as a header.
 * Fragment submits carry HX-Request and receive fragment denials.
 */
export async function submitGeneratedForm(
  input: SubmitGeneratedFormInput,
): Promise<GeneratedSubmitResult> {
  if (typeof input.action !== "string" || input.action === "") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: action must be a nonempty string",
      false,
    );
  }
  for (const [key, value] of Object.entries(input.flat)) {
    if (typeof value !== "string") {
      throw new GeneratedSubmitError(
        "usage",
        `submitGeneratedForm: flat value for ${JSON.stringify(key)} must be a string`,
        false,
      );
    }
  }
  const operationId = input.flat["operation_id"];
  if (typeof operationId !== "string" || operationId === "") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: the form must carry its operation_id",
      false,
    );
  }
  const csrf = input.flat[CSRF_FIELD];
  if (typeof csrf !== "string") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: the form must carry its CSRF field",
      false,
    );
  }
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  const files = input.files ?? [];
  for (const file of files) {
    assertFileLike(file);
  }
  const byField = new Map<string, FileLike>();
  for (const file of files) {
    if (byField.has(file.field)) {
      throw new GeneratedSubmitError(
        "usage",
        `submitGeneratedForm: duplicate upload for ${JSON.stringify(file.field)}`,
        false,
      );
    }
    byField.set(file.field, file);
  }
  const byName = new Map(input.derived.inputs.map((entry) => [entry.name, entry] as const));
  for (const field of byField.keys()) {
    const target = byName.get(field);
    if (target === undefined) {
      throw new GeneratedSubmitError(
        "usage",
        `submitGeneratedForm: unknown file field ${JSON.stringify(field)}`,
        false,
      );
    }
    if (target.kind !== "file") {
      throw new GeneratedSubmitError(
        "usage",
        `submitGeneratedForm: ${JSON.stringify(field)} is not a file input`,
        false,
      );
    }
  }
  const ordered = input.derived.inputs.filter((entry) => byField.has(entry.name));
  const uploadsUrl = ordered.length === 0 ? undefined : mustUploadsUrl(input.intentsUrl);

  let args: ClosedInputs;
  try {
    args = projectGeneratedInputs(input.derived, input.mode, input.flat);
  } catch (error) {
    throw projectionError(error);
  }
  const root = (name: string): string =>
    input.mode === "update" ? `inputs[changes][${name}]` : `inputs[${name}]`;
  const working: Record<string, string> = { ...input.flat };
  const completed: Record<string, unknown> = {};
  const mint = input.mintUploadId ?? defaultMintUploadId;
  for (const target of ordered) {
    const file = byField.get(target.name);
    if (file === undefined) {
      throw new GeneratedSubmitError(
        "usage",
        `submitGeneratedForm: upload for ${JSON.stringify(target.name)} lost its bytes`,
        false,
      );
    }
    const intentArgs: Record<string, unknown> = { ...args };
    for (const pending of ordered) {
      delete intentArgs[pending.name];
    }
    Object.assign(intentArgs, completed);
    const pointer = input.mode === "update" ? `/changes/${target.name}` : `/${target.name}`;
    const uploadId = mint();
    if (typeof uploadId !== "string" || uploadId === "") {
      throw new GeneratedSubmitError(
        "usage",
        "submitGeneratedForm: mintUploadId must mint a nonempty upload_id",
        false,
      );
    }
    const uploadsTarget = uploadsUrl;
    if (uploadsTarget === undefined) {
      throw new GeneratedSubmitError(
        "usage",
        `submitGeneratedForm: upload for ${JSON.stringify(target.name)} lost its intents URL`,
        false,
      );
    }
    const intent = checkedIntent(
      await postJson(
        fetchImpl,
        uploadsTarget,
        csrf,
        {
          upload_id: uploadId,
          operation: input.derived.operation,
          field: pointer,
          arguments: intentArgs,
          name: file.name,
          type: file.type,
          size: String(file.size),
        },
        target.name,
        "intent",
      ),
      target.name,
    );
    await putBytes(fetchImpl, intent.content, csrf, file.bytes, target.name);
    const finalized = await postJson(fetchImpl, intent.finalize, csrf, {}, target.name, "finalize");
    if (!isRecord(finalized) || typeof finalized["file"] !== "string" || finalized["file"] === "") {
      throw new GeneratedSubmitError(
        "contract",
        `finalize for ${JSON.stringify(target.name)} must answer its opaque file id`,
        false,
      );
    }
    completed[target.name] = finalized["file"];
    working[root(target.name)] = finalized["file"];
  }

  let inputs: ClosedInputs;
  try {
    inputs = projectGeneratedInputs(input.derived, input.mode, working);
  } catch (error) {
    throw projectionError(error);
  }
  const envelope: MutationEnvelope = {
    operation: input.derived.operation,
    operation_id: operationId,
    inputs,
  };
  let response: SubmitFetchResponse;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [CSRF_HEADER]: csrf,
      accept: input.denialFormat === "json" ? "application/json" : SUBMIT_ACCEPT,
    };
    if (input.fragment) {
      headers["HX-Request"] = "true";
    }
    response = await fetchImpl(input.action, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    throw transportError("submit", input.derived.operation, error);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const body = await response.text();
  if (response.status >= 200 && response.status < 300) {
    if (!contentType.includes("application/json")) {
      throw new GeneratedSubmitError(
        "contract",
        `submit for ${JSON.stringify(input.derived.operation)} answered success without its JSON result`,
        false,
      );
    }
    return { kind: "committed", result: checkedMutationResult(body, input.derived.operation) };
  }
  if (contentType.includes("text/html")) {
    if (input.denialFormat === "json") {
      throw new GeneratedSubmitError(
        "contract",
        `submit for ${JSON.stringify(input.derived.operation)} answered an HTML denial instead of JSON`,
        false,
      );
    }
    return {
      kind: "rerender",
      html: body,
      status: response.status,
      fragment: input.fragment,
    };
  }
  return {
    kind: "denied",
    error: checkedBusinessError(body, response.status, input.derived.operation),
    status: response.status,
  };
}

/**
 * Swap a fragment denial into its stable `#<idPrefix>-form` target. The
 * server wraps fragments in the same node, so this replaces the node
 * whole; a missing target throws loudly instead of dropping the form.
 */
export function applyFormRerender(
  document: SwapDocumentLike,
  idPrefix: string,
  html: string,
): void {
  const target = document.getElementById(`${idPrefix}-form`);
  if (target === null) {
    throw new Error(`applyFormRerender: missing swap target ${JSON.stringify(`${idPrefix}-form`)}`);
  }
  target.outerHTML = html;
}

/**
 * Swap a full-page denial over the whole document. Full-page client
 * submits never navigate (the envelope needs projecting first), so the
 * denial document replaces the live one in place through the document
 * replace stream.
 */
export function applyDocumentRerender(document: SwapDocumentLike, html: string): void {
  document.open();
  document.write(html);
  document.close();
}
