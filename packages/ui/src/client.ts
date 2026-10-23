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

import { CSRF_FIELD, SOURCE_FORM_BINDING_FIELD } from "@canlang/contracts";
import { operationPostPath } from "./escape.js";
import type { FormMode } from "@canlang/contracts";
import type {
  BusinessError,
  BusinessErrorCode,
  ClosedInputs,
  DerivedOperationInputs,
  FieldError,
  FormRetry,
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
  readonly signal?: AbortSignal;
  /** Protected mutation POSTs stay on the current origin and never follow redirects. */
  readonly mode?: "same-origin";
  readonly redirect?: "error";
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
  | { readonly kind: "denied"; readonly error: BusinessError; readonly status: number; readonly retry?: FormRetry };

export interface SubmitGeneratedFormInput {
  readonly derived: DerivedOperationInputs;
  readonly mode: FormMode;
  readonly flat: Record<string, string>;
  /** Exact rendered field paths; omission keeps the legacy full-input projection. */
  readonly renderedInputs?: readonly string[];
  readonly files?: ReadonlyArray<FileLike>;
  /** Dispatcher-supplied op POST target; never invented here. */
  readonly action: string;
  /** True submits (and expects denials) as an HTMX fragment. */
  readonly fragment: boolean;
  /** Source occurrences retain their own DOM and consume checked JSON errors. */
  readonly denialFormat?: "html" | "json";
  /** Request a server-issued next form attempt for an explicitly armed refresh. */
  readonly refresh?: boolean;
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
// Empty slots stay synchronous: the original loop awaited only while file
// bytes were actually read, so later controls were collected without a yield.
function collectFileSlot(files: FileLike[], control: DomControlLike, slot: string): Promise<void> | undefined {
  const picked = control.files?.[0] ?? null;
  if (picked === null || picked === undefined) return undefined;
  if (!Number.isSafeInteger(picked.size) || picked.size < 0) {
    throw new GeneratedSubmitError(
      "usage",
      `collectFormValues: picked file for ${JSON.stringify(slot)} needs a safe nonnegative size`,
      false,
    );
  }
  return (async (): Promise<void> => {
    files.push({
      field: slot,
      name: stringMember(picked.name, `picked file name for ${JSON.stringify(slot)}`),
      type: stringMember(picked.type, `picked file type for ${JSON.stringify(slot)}`),
      size: picked.size,
      bytes: new Uint8Array(await picked.arrayBuffer()),
    });
  })();
}

function collectNamedControl(flat: Record<string, string>, control: DomControlLike, name: string, type: string): void {
  if (type === "checkbox" || type === "radio") {
    if (control.checked === true) {
      Object.defineProperty(flat, name, { value: stringMember(control.value ?? "on", `control ${JSON.stringify(name)}`),
        enumerable: true, writable: true, configurable: true });
    }
    return;
  }
  if (type === "file") {
    if ((control.files?.length ?? 0) > 0) {
      throw new GeneratedSubmitError(
        "usage",
        `collectFormValues: named file control ${JSON.stringify(name)} needs the S7 picker flow (data-can-file)`,
        false,
      );
    }
    return;
  }
  Object.defineProperty(flat, name, { value: stringMember(control.value, `control ${JSON.stringify(name)}`),
    enumerable: true, writable: true, configurable: true });
}

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
      const pending = collectFileSlot(files, control, slot);
      if (pending !== undefined) await pending;
      continue;
    }
    const name = control.name;
    if (name === undefined || name === "") {
      continue;
    }
    const type = (control.type ?? "").toLowerCase();
    collectNamedControl(flat, control, name, type);
  }
  return { flat, files };
}

function captureFileLike(file: FileLike): FileLike {
  const field = file.field;
  if (typeof field !== "string" || field === "") {
    throw new GeneratedSubmitError("usage", "submitGeneratedForm: upload file needs its input field", false);
  }
  const what = `upload file for ${JSON.stringify(field)}`;
  const name = file.name;
  const type = typeof name === "string" ? file.type : undefined;
  if (typeof name !== "string" || typeof type !== "string") {
    throw new GeneratedSubmitError("usage", `submitGeneratedForm: ${what} needs string name/type`, false);
  }
  const size = file.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new GeneratedSubmitError(
      "usage",
      `submitGeneratedForm: ${what} needs a safe nonnegative size`,
      false,
    );
  }
  const bytes = file.bytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new GeneratedSubmitError(
      "usage",
      `submitGeneratedForm: ${what} needs Uint8Array bytes`,
      false,
    );
  }
  return { field, name, type, size, bytes: new Uint8Array(bytes) };
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
      headers: { "content-type": "application/octet-stream", "upload-offset": "0", [CSRF_HEADER]: csrf },
      body: new Uint8Array(bytes),
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
function checkedMutationResult(body: string, operation: string, expectedId: string, bound: boolean): MutationResult {
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
    operationId !== expectedId
  ) {
    throw fail();
  }
  const next = parsed['refresh'];
  if (next !== undefined && (!isRecord(next) || Object.keys(next).some(key => key !== 'operation_id' && key !== 'form_binding') ||
      typeof next['operation_id'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(next['operation_id']) ||
      next['operation_id'].toLowerCase() === expectedId.toLowerCase() ||
      (bound ? typeof next['form_binding'] !== 'string' || next['form_binding'] === '' : next['form_binding'] !== undefined))) throw fail();
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
function checkedBusinessError(body: string, status: number, operation: string,
  flat: Record<string, string>): { error: BusinessError; retry?: FormRetry } {
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
  const envelope = parsed;
  const wrapped = Object.hasOwn(envelope, "error");
  const details = wrapped ? envelope["error"] : envelope;
  if (!isRecord(details)) throw fail();
  const code = details["code"];
  if (typeof code !== "string" || !isBusinessErrorCode(code)) {
    throw fail();
  }
  if (typeof details["message"] !== "string") {
    throw fail();
  }
  const fields = Array.isArray(details["fields"])
    ? details["fields"].filter(isFieldErrorShaped).map((field) => ({
        path: field.path,
        code: field.code,
        message: field.message,
      }))
    : undefined;
  const error: BusinessError = {
    code,
    message: details["message"],
    ...(typeof details["operation_id"] === "string" ? { operation_id: details["operation_id"] } : {}),
    ...(fields === undefined ? {} : { fields }),
    ...(typeof details["retryable"] === "boolean" ? { retryable: details["retryable"] } : {}),
  };
  if (!Object.hasOwn(envelope, "retry")) return { error };
  return { error, retry: checkedBusinessRetry(fail, error, envelope["retry"], wrapped, flat) };
}

/** Validate the retry binding against the rendered flat map; invalid retries fail closed. */
function checkedBusinessRetry(
  fail: () => GeneratedSubmitError,
  error: BusinessError,
  value: unknown,
  wrapped: boolean,
  flat: Record<string, string>,
): FormRetry {
  const retry = value;
  const bound = Object.hasOwn(flat, SOURCE_FORM_BINDING_FIELD);
  if (!wrapped || !isRecord(retry) || error.operation_id !== flat["operation_id"] ||
      Object.keys(retry).some(key => key !== "operation_id" && key !== SOURCE_FORM_BINDING_FIELD) ||
      typeof retry["operation_id"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retry["operation_id"]) ||
      retry["operation_id"].toLowerCase() === flat["operation_id"]!.toLowerCase() ||
      Object.hasOwn(retry, SOURCE_FORM_BINDING_FIELD) !== bound ||
      bound && (typeof retry[SOURCE_FORM_BINDING_FIELD] !== "string" || retry[SOURCE_FORM_BINDING_FIELD] === "")) {
    throw fail();
  }
  return { operation_id: retry["operation_id"],
    ...(bound ? { form_binding: retry[SOURCE_FORM_BINDING_FIELD] as string } : {}) };
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
function checkSubmitEnvelope(input: SubmitGeneratedFormInput): { action: string; csrf: string } {
  if (typeof input.action !== "string" || input.action === "") {
    throw new GeneratedSubmitError(
      "usage",
      "submitGeneratedForm: action must be a nonempty string",
      false,
    );
  }
  let action: string;
  try {
    action = operationPostPath(input.action);
  } catch (error) {
    throw new GeneratedSubmitError("usage", error instanceof Error ? error.message : String(error), false);
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
  return { action, csrf };
}

function checkSubmitFileFields(derived: DerivedOperationInputs, files: readonly FileLike[]): Map<string, FileLike> {
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
  const byName = new Map(derived.inputs.map((entry) => [entry.name, entry] as const));
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
  return byField;
}

export async function submitGeneratedForm(
  input: SubmitGeneratedFormInput,
): Promise<GeneratedSubmitResult> {
  const { action, csrf } = checkSubmitEnvelope(input);
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  const files: FileLike[] = [];
  for (const file of input.files ?? []) files.push(captureFileLike(file));
  const byField = checkSubmitFileFields(input.derived, files);
  const ordered = input.derived.inputs.filter((entry) => byField.has(entry.name) &&
    (input.renderedInputs === undefined || input.renderedInputs.includes(entry.name)));
  const uploadsUrl = ordered.length === 0 ? undefined : mustUploadsUrl(input.intentsUrl);

  let args: ClosedInputs;
  try {
    args = projectGeneratedInputs(input.derived, input.mode, input.flat, input.renderedInputs);
  } catch (error) {
    throw projectionError(error);
  }
  const root = (name: string): string =>
    input.mode === "update" ? `inputs[changes][${name}]` : `inputs[${name}]`;
  const working: Record<string, string> = { ...input.flat };
  const completed: Record<string, unknown> = {};
  const mint = input.mintUploadId ?? defaultMintUploadId;
  for (const target of ordered) {
    await uploadSubmitFile(target, byField, ordered, fetchImpl, csrf, uploadsUrl,
      args, input.derived.operation, mint, root, working, completed);
  }

  let inputs: ClosedInputs;
  try {
    inputs = projectGeneratedInputs(input.derived, input.mode, working, input.renderedInputs);
  } catch (error) {
    throw projectionError(error);
  }
  return submitMutationRequest(input.derived.operation, input.flat, action, inputs, fetchImpl, input.fragment, input.denialFormat, input.refresh);
}

async function uploadSubmitFile(
  target: { readonly name: string },
  byField: Map<string, FileLike>,
  ordered: readonly { readonly name: string }[],
  fetchImpl: SubmitFetch,
  csrf: string,
  uploadsUrl: string | undefined,
  args: ClosedInputs,
  operation: string,
  mint: () => string,
  root: (name: string) => string,
  working: Record<string, string>,
  completed: Record<string, unknown>,
): Promise<void> {
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
  // Canonical operation inputs are flat; changes is only DOM control notation.
  const pointer = `/${target.name}`;
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
        operation,
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
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(file.bytes).buffer);
  const bytesDigest = "sha256:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const finalized = await postJson(fetchImpl, intent.finalize, csrf,
    { upload_id: uploadId, bytes_digest: bytesDigest }, target.name, "finalize");
  if (!isRecord(finalized) || typeof finalized["file"] !== "string" || finalized["file"] === "") {
    throw new GeneratedSubmitError(
      "contract",
      `finalize for ${JSON.stringify(target.name)} must answer its opaque file id`,
      false,
    );
  }
  completed[target.name] = { id: finalized["file"] };
  working[root(target.name)] = finalized["file"];
}

/** Submit the canonical delete card using its existing native URL-encoded fields. */
export async function submitDeleteForm(input: {
  readonly operation: string;
  readonly flat: Record<string, string>;
  readonly action: string;
  readonly fetchImpl: SubmitFetch;
}): Promise<GeneratedSubmitResult> {
  const id = input.flat['inputs[record][id]'];
  const version = input.flat['inputs[record][version]'];
  if (typeof input.operation !== 'string' || input.operation === '' ||
      typeof id !== 'string' || id === '' || typeof version !== 'string' || version === '' ||
      !input.flat['operation_id'] || !input.flat[CSRF_FIELD]) {
    throw new GeneratedSubmitError('usage', 'Delete form request metadata is unavailable.', false);
  }
  return submitMutationRequest(input.operation, input.flat, operationPostPath(input.action),
    undefined, input.fetchImpl, false, 'json');
}

async function submitMutationRequest(operation: string, flat: Record<string, string>, action: string,
  inputs: ClosedInputs | undefined, fetchImpl: SubmitFetch, fragment: boolean, denialFormat: 'html' | 'json' | undefined, refresh = false,
): Promise<GeneratedSubmitResult> {
  const operationId = flat['operation_id']!;
  const csrf = flat[CSRF_FIELD]!;
  const envelope: MutationEnvelope & { readonly form_binding?: string } = {
    operation,
    operation_id: operationId,
    inputs: inputs ?? {},
    ...(flat[SOURCE_FORM_BINDING_FIELD] === undefined ? {} : {
      [SOURCE_FORM_BINDING_FIELD]: flat[SOURCE_FORM_BINDING_FIELD],
    }),
  };
  let response: SubmitFetchResponse;
  try {
    const headers: Record<string, string> = {
      ...(refresh ? { 'X-Can-Refresh': 'true' } : {}),
      "content-type": inputs === undefined ? "application/x-www-form-urlencoded" : "application/json",
      [CSRF_HEADER]: csrf,
      accept: denialFormat === "json" ? "application/json" : SUBMIT_ACCEPT,
    };
    if (fragment) {
      headers["HX-Request"] = "true";
    }
    response = await fetchImpl(action, {
      method: "POST",
      mode: "same-origin",
      redirect: "error",
      headers,
      body: inputs === undefined ? new URLSearchParams(flat).toString() : JSON.stringify(envelope),
    });
  } catch (error) {
    throw transportError("submit", operation, error);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const body = await response.text();
  if (response.status >= 200 && response.status < 300) {
    if (!contentType.includes("application/json")) {
      throw new GeneratedSubmitError(
        "contract",
        `submit for ${JSON.stringify(operation)} answered success without its JSON result`,
        false,
      );
    }
    return { kind: "committed", result: checkedMutationResult(body, operation, operationId, Object.hasOwn(flat, SOURCE_FORM_BINDING_FIELD)) };
  }
  if (contentType.includes("text/html")) {
    if (denialFormat === "json") {
      throw new GeneratedSubmitError(
        "contract",
        `submit for ${JSON.stringify(operation)} answered an HTML denial instead of JSON`,
        false,
      );
    }
    return {
      kind: "rerender",
      html: body,
      status: response.status,
      fragment,
    };
  }
  return {
    kind: "denied",
    ...checkedBusinessError(body, response.status, operation, flat),
    status: response.status,
  };
}

/** Focusable control for draft/focus retention across re-renders. */
export interface FocusableControlLike {
  readonly id: string;
  focus(): void;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
  setSelectionRange?(start: number, end: number): void;
}

/** Document surface for focus-preserving fragment swaps. */
export interface FocusSwapDocumentLike {
  readonly activeElement: FocusableControlLike | null;
  getElementById(id: string): (FocusableControlLike & { outerHTML: string }) | null;
}

/**
 * BGI-09 validation re-render that retains drafts and focus: the server
 * HTML already carries the submitted drafts (see `generatedDraftValues`),
 * so this records the focused control id plus its text selection, swaps
 * the stable `#<idPrefix>-form` target whole, then restores focus and
 * selection onto the same control id. A control id missing after the swap
 * keeps the fresh markup without focus rather than throwing.
 */
export function rerenderFormPreservingFocus(
  document: FocusSwapDocumentLike,
  idPrefix: string,
  html: string,
): void {
  const active = document.activeElement;
  const focusId = active === null ? null : active.id;
  const selection =
    active === null
      ? null
      : {
          start: active.selectionStart ?? null,
          end: active.selectionEnd ?? null,
        };
  const target = document.getElementById(`${idPrefix}-form`);
  if (target === null) {
    throw new Error(`rerenderFormPreservingFocus: missing swap target ${JSON.stringify(`${idPrefix}-form`)}`);
  }
  target.outerHTML = html;
  if (focusId === null || focusId === "") {
    return;
  }
  const restored = document.getElementById(focusId);
  if (restored === null) {
    return;
  }
  restored.focus();
  if (
    selection !== null &&
    selection.start !== null &&
    selection.end !== null &&
    typeof restored.setSelectionRange === "function"
  ) {
    try {
      restored.setSelectionRange(selection.start, selection.end);
    } catch {
      /* A control that rejects selection keeps plain focus. */
    }
  }
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
