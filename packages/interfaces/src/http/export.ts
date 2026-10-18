/**
 * FP.EXPORT server slice: authorized bounded CSV export + the
 * large-output download-descriptor contract.
 *
 * `POST /api/exports` runs one bounded `<model>.list` read under
 * CURRENT grants — fresh session identity plus the T32 liveness
 * re-check per request (team scope re-reads the membership; teamless
 * callers are live by the commit-time session resolution) — and
 * projects the rows to CSV. L3 owns row/field/file grant enforcement
 * inside the read; this layer owns the explicit projection contract:
 *
 * - `id` first (a row without a non-empty string id fails the whole
 *   export closed — unaddressable rows never ship), `version` second
 *   (empty when the row carries none), then the requested columns in
 *   requested order (default: every result column in result order;
 *   unknown columns reject);
 * - file values (`{kind:'file', id}`) export as their opaque id —
 *   possession grants nothing, bytes/URLs never appear in exports;
 * - secret values (`{kind:'secret'}`) fail the whole export closed;
 * - strings verbatim, numbers/booleans via `String`, nulls empty,
 *   other objects canonical JSON (sorted keys);
 * - formula-leading cells (one of `= + - @` after leading whitespace)
 *   take a `'` prefix (spreadsheet neutralization); cells containing
 *   `, " \n \r` quote with `""` escapes.
 *
 * Bounds reuse the DESIGN pins: default page `COLLECTION_MAX_LIMIT`
 * (100), ceiling `PAGE_MAX_RECORDS` (500) — the layer slices even an
 * over-delivering read to the requested limit. The outcome declares
 * completeness (`complete`, `row_count`, `truncated`, `next_cursor`)
 * and currency (`as_of`) explicitly. Truncated exports also carry a
 * download descriptor for the large-output lifecycle: an opaque
 * deterministic handle (`exp-<16 hex>` over principal + operation +
 * canonical args, so replays converge), `pending` status, absolute
 * D-owned `download_url`/`status_url`, guarded 15-minute expiry, and
 * `row_estimate: null` (the estimate is unknown while truncated).
 * DEL-B02 durable backend: truncated exports register a pending record
 * (principal, operation, args, 15-minute expiry) in the injected
 * `ExportDownloadStore`; `GET status/<handle>` reports its live state and
 * `GET download/<handle>` lazily completes it by re-reading the full
 * output under the CURRENT caller and grants, then serves the bytes.
 * Completion snapshots authentic current rows — never stale or invented
 * data. Unknown/expired handles answer `not_found`, wrong-principal and
 * revoked records answer `forbidden`, digest mismatch answers
 * `validation`, and missing bodies or store failures answer the generic
 * internal envelope after an incident-logged journal entry. The
 * descriptor carries no authority: possession alone grants nothing.
 * Without an injected store the POST contract is unchanged and both
 * sub-routes answer `not_found`.
 */
import {
  COLLECTION_MAX_LIMIT,
  PAGE_MAX_RECORDS,
} from '@canlang/contracts';
import { parseObjectBody } from '../internal/input-admission.js';
import type {
  BusinessError,
  ClosedInputs,
  ColumnMeta,
  ListQueryResult,
  MessageValue,
  ReadEnvelope,
  ResolvedIdentity,
  RowView,
} from '@canlang/contracts';
import { IdentityError, assertAuthorityLive, sha256HexText } from '@canlang/identity';
import { canonicalJson } from './canonical-json.js';
import type { HttpDeps, ExportDownloadRecord, ExportDownloadStore } from '../ports.js';
import { buildBusinessError, fromUnknown, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import {
  CSRF_FIELD,
  CSRF_HEADER,
  assertPostCsrf,
  caughtToBusinessError,
  jsonErrorResponse,
  resolveRequestIdentity,
} from './context.js';
import { OPERATION_NAME_PATTERN } from './operations.js';

const EXPORTS_PATH = '/api/exports';
const LIST_SUFFIX = '.list';

/** Download-descriptor lifetime: 15 minutes, never open-ended. */
const EXPORT_DESCRIPTOR_TTL_SECONDS = 900;

/** One emitted column: result field plus its declared label. */
export interface ExportColumn {
  readonly field: string;
  readonly label: MessageValue;
}

/** Large-output download descriptor (contract only; D fulfills the URLs). */
export interface ExportDescriptor {
  readonly handle: string;
  readonly status: 'pending';
  readonly download_url: string;
  readonly status_url: string;
  readonly expires_at: string;
  readonly row_estimate: null;
  readonly truncated: true;
}

/** Live download status: the emitted descriptor shape with the current lifecycle state. */
export interface ExportDownloadStatus {
  readonly handle: string;
  readonly status: 'pending' | 'ready';
  readonly download_url: string;
  readonly status_url: string;
  readonly expires_at: string;
  readonly row_estimate: null;
  readonly truncated: true;
  readonly row_count?: number;
}

/** Export outcome: completeness + currency + CSV, descriptor when truncated. */
export interface ExportOutcome {
  readonly operation: string;
  readonly as_of: string;
  readonly complete: boolean;
  readonly row_count: number;
  readonly truncated: boolean;
  readonly next_cursor?: string;
  readonly columns: readonly ExportColumn[];
  readonly csv: string;
  readonly descriptor?: ExportDescriptor;
}

/** Validated export page: rows + column metadata + optional cursor. */
export interface ExportPage {
  readonly rows: readonly RowView[];
  readonly columns: readonly ColumnMeta[];
  readonly nextCursor: string | undefined;
}

/** A secret value reached the projection: fail the export closed. */
export class SecretRefusal extends Error {
  override readonly name = 'SecretRefusal';
}

/** True for the contracts file value `{kind:'file', id}` (opaque id ships). */
export function isExportFileValue(value: unknown): value is { readonly kind: 'file'; readonly id: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['kind'] === 'file' && typeof record['id'] === 'string';
}

/** True for the contracts secret value (never serialized, fail closed). */
export function isExportSecretValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)['kind'] === 'secret';
}

/**
 * Project one field value to CSV text: strings verbatim, file values
 * to their opaque id, scalars via `String`, nulls empty, anything else
 * canonical JSON. Secrets throw `SecretRefusal` (fail closed).
 */
export function projectExportCell(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  if (isExportSecretValue(value)) throw new SecretRefusal('Export refuses secret values.');
  if (isExportFileValue(value)) return value.id;
  return canonicalJson(value);
}

/** Spreadsheet neutralization: formula-leading cells take a `'` prefix. */
export function neutralizeFormula(cell: string): string {
  return /^[\s]*[=+\-@]/.test(cell) ? `'${cell}` : cell;
}

/** CSV escape: quote cells holding `, " \n \r`, doubling inner quotes. */
export function escapeCsvCell(cell: string): string {
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Export operations are `<model>.list` reads (DESIGN section-10 naming). */
export function checkListOperation(operation: unknown): BusinessError | null {
  if (
    typeof operation !== 'string' ||
    !OPERATION_NAME_PATTERN.test(operation) ||
    !operation.endsWith(LIST_SUFFIX)
  ) {
    return buildBusinessError('validation', 'Export operations are <model>.list reads.');
  }
  return null;
}

/**
 * T32 commit-time authority for export/print reads: team scope
 * re-reads the live membership (revoked mid-flight voids the read);
 * teamless callers are live by the session resolution at request time.
 */
export async function assertExportAuthority(deps: HttpDeps, identity: ResolvedIdentity): Promise<void> {
  if (identity.team !== null && identity.actor !== null) {
    await assertAuthorityLive(deps.identity.store, {
      teamId: identity.team.team_id,
      userId: identity.actor.user_id,
    });
  }
}

/**
 * Run one bounded list read and validate the collection shape: rows +
 * columns arrays (entries checked), optional string cursor. L3 denials
 * pass through; a malformed result throws (internal, journaled).
 */
export async function readExportPage(
  deps: HttpDeps,
  identity: ResolvedIdentity,
  args: { operation: string; inputs: ClosedInputs },
): Promise<ExportPage> {
  const envelope: ReadEnvelope = { operation: args.operation, inputs: args.inputs };
  const outcome = await deps.invoker.invokeRead(envelope, identity);
  if ('error' in outcome) throw outcome.error;
  const result = outcome.result as Partial<ListQueryResult> | null | undefined;
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray(result.rows) ||
    !Array.isArray(result.columns) ||
    (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')
  ) {
    throw new Error(`read ${args.operation} returned a malformed collection result.`);
  }
  for (const column of result.columns) {
    if (typeof column !== 'object' || column === null || typeof (column as ColumnMeta).field !== 'string') {
      throw new Error(`read ${args.operation} returned malformed column metadata.`);
    }
  }
  return { rows: result.rows, columns: result.columns, nextCursor: result.nextCursor };
}

/**
 * Project one validated page to CSV text over the selected fields:
 * `id,version` first, then columns in selection order. Missing row ids
 * and secret values fail closed (`validation`); the header always uses
 * field names (machine-readable), labels ride the outcome declaration.
 */
export function pageToCsv(
  page: ExportPage,
  selection: readonly string[],
): { csv: string; columns: ExportColumn[]; rowCount: number } {
  const byField = new Map(page.columns.map((column) => [column.field, column]));
  const columns: ExportColumn[] = [
    { field: 'id', label: 'ID' },
    { field: 'version', label: 'Version' },
  ];
  for (const field of selection) {
    const meta = byField.get(field);
    if (meta !== undefined) columns.push({ field, label: meta.label });
  }
  const lines = [columns.map((column) => escapeCsvCell(column.field)).join(',')];
  for (const row of page.rows) {
    if (typeof row !== 'object' || row === null || typeof row.id !== 'string' || row.id === '') {
      throw buildBusinessError('validation', 'Export requires row ids.');
    }
    if (typeof row.fields !== 'object' || row.fields === null || Array.isArray(row.fields)) {
      throw new Error('Export read returned a row without a fields record.');
    }
    const version = row.version === undefined || row.version === null ? '' : String(row.version);
    const cells = [row.id, version];
    for (const field of selection) {
      cells.push(projectExportCell((row.fields as Record<string, unknown>)[field]));
    }
    lines.push(cells.map((cell) => escapeCsvCell(neutralizeFormula(cell))).join(','));
  }
  return { csv: `${lines.join('\n')}\n`, columns, rowCount: page.rows.length };
}

function deny(deps: HttpDeps, error: BusinessError, operation: string): Response {
  logBusinessError(deps.logger, error, { route: 'exports', operation });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(body, status);
}

function jsonOk(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}


function parseColumns(value: unknown): { columns: string[] | null; error: BusinessError | null } {
  if (value === undefined) return { columns: null, error: null };
  if (!Array.isArray(value) || value.length === 0) {
    return { columns: null, error: buildBusinessError('validation', 'Invalid export columns.') };
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      return { columns: null, error: buildBusinessError('validation', 'Invalid export columns.') };
    }
    if (seen.has(entry)) {
      return { columns: null, error: buildBusinessError('validation', `Duplicate export column ${JSON.stringify(entry)}.`) };
    }
    seen.add(entry);
    columns.push(entry);
  }
  return { columns, error: null };
}

function parseLimit(value: unknown): { limit: number; error: BusinessError | null } {
  if (value === undefined) return { limit: COLLECTION_MAX_LIMIT, error: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > PAGE_MAX_RECORDS) {
    return { limit: 0, error: buildBusinessError('validation', `Export limit is 1..${PAGE_MAX_RECORDS}.`) };
  }
  return { limit: value, error: null };
}

/**
 * Dispatch one export request. See the module doc for the grant,
 * projection, bounds, and descriptor rules.
 */
async function dispatchExportDownload(deps: HttpDeps, request: Request, pathname: string): Promise<Response | null> {
  if (pathname === EXPORTS_PATH) return null;
  if (request.method.toUpperCase() === 'GET') {
    const statusMatch = /^\/api\/exports\/status\/([^/]+)$/.exec(pathname);
    if (statusMatch !== null) return await handleDownloadStatus(deps, request, statusMatch[1]!);
    const downloadMatch = /^\/api\/exports\/download\/([^/]+)$/.exec(pathname);
    if (downloadMatch !== null) return await handleDownload(deps, request, downloadMatch[1]!);
  }
  return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
}

type LiveIdentity = ResolvedIdentity & { actor: NonNullable<ResolvedIdentity['actor']> };

async function admitExportCaller(deps: HttpDeps, request: Request, pathname: string): Promise<{
  identity: LiveIdentity; body: Record<string, unknown>;
} | Response> {
  const caller = await resolveRequestIdentity(
    deps.identity.store,
    request,
    { clock: deps.clock },
  );
  const actor = caller.identity.actor;
  if (caller.sessionToken === null || actor === null) {
    return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), pathname);
  }
  const body = await parseObjectBody(request);
  await assertPostCsrf({
    sessionToken: caller.sessionToken,
    headerValue: request.headers.get(CSRF_HEADER),
    fieldValue: body[CSRF_FIELD],
  });
  return { identity: { ...caller.identity, actor }, body };
}

function checkExportArgs(deps: HttpDeps, body: Record<string, unknown>, pathname: string): {
  operation: string; requested: string[] | null; limit: number;
  parent: unknown; filters: unknown; cursor: string | undefined;
} | Response {
  const operation = body['operation'];
  const opError = checkListOperation(operation);
  if (opError !== null || typeof operation !== 'string') {
    return deny(deps, opError ?? buildBusinessError('validation', 'Missing operation.'), pathname);
  }
  const { columns: requested, error: columnsError } = parseColumns(body['columns']);
  if (columnsError !== null) return deny(deps, columnsError, operation);
  const { limit, error: limitError } = parseLimit(body['limit']);
  if (limitError !== null) return deny(deps, limitError, operation);
  const parent = body['parent'];
  if (parent !== undefined) {
    const ref = parent as Record<string, unknown>;
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent) || typeof ref['id'] !== 'string') {
      return deny(deps, buildBusinessError('validation', 'Invalid export parent.'), operation);
    }
  }
  const filters = body['filters'];
  if (filters !== undefined && (typeof filters !== 'object' || filters === null || Array.isArray(filters))) {
    return deny(deps, buildBusinessError('validation', 'Invalid export filters.'), operation);
  }
  const cursor = body['cursor'];
  if (cursor !== undefined && typeof cursor !== 'string') {
    return deny(deps, buildBusinessError('validation', 'Invalid export cursor.'), operation);
  }
  return { operation, requested, limit, parent, filters, cursor };
}

async function loadExportPage(
  deps: HttpDeps,
  identity: LiveIdentity,
  operation: string,
  parent: unknown,
  filters: unknown,
  limit: number,
  cursor: string | undefined,
): Promise<{ page: ExportPage } | Response> {
  try {
    await assertExportAuthority(deps, identity);
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), operation);
    }
    throw err;
  }
  const inputs: ClosedInputs = {
    ...(parent === undefined ? {} : { parent }),
    ...(filters === undefined ? {} : { filters }),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
  let page: ExportPage;
  try {
    page = await readExportPage(deps, identity, { operation, inputs });
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
      return deny(deps, caughtToBusinessError(err), operation);
    }
    throw err;
  }
  return { page };
}

async function selectExportColumns(
  deps: HttpDeps,
  page: ExportPage,
  requested: string[] | null,
  operation: string,
): Promise<string[] | Response> {
  const available = new Set(page.columns.map((column) => column.field));
  const selection = requested ?? page.columns.map((column) => column.field);
  for (const field of selection) {
    if (!available.has(field)) {
      return deny(deps, buildBusinessError('validation', `Unknown export column ${JSON.stringify(field)}.`), operation);
    }
  }
  return selection;
}

async function buildExportDescriptor(
  deps: HttpDeps,
  request: Request,
  identity: LiveIdentity,
  operation: string,
  args: { parent: unknown; filters: unknown; requested: string[] | null; limit: number; cursor: string | undefined },
): Promise<ExportDescriptor> {
  const normalized = {
    parent: args.parent ?? null,
    filters: args.filters ?? null,
    columns: args.requested,
    limit: args.limit,
    cursor: args.cursor ?? null,
  };
  const digest = await sha256HexText(canonicalJson({
    appId: deps.app.appId,
    teamId: identity.team?.team_id ?? null,
    principal: identity.actor.user_id,
    operation,
    args: normalized,
  }));
  const handle = `exp-${digest.slice(0, 16)}`;
  const origin = new URL(request.url).origin;
  let expires_at = new Date(deps.clock.nowMs() + EXPORT_DESCRIPTOR_TTL_SECONDS * 1000).toISOString();
  const store = deps.exportDownloads;
  if (store !== undefined) {
    const nowIso = new Date(deps.clock.nowMs()).toISOString();
    const record: ExportDownloadRecord = {
      handle,
      appId: deps.app.appId,
      teamId: identity.team?.team_id ?? null,
      principal: identity.actor.user_id,
      operation,
      args: normalized,
      createdAt: nowIso,
      expiresAt: expires_at,
      status: 'pending',
      digest: '',
    };
    const { digest: _empty, ...unsigned } = record;
    const registered: ExportDownloadRecord = { ...record, digest: await downloadRecordDigest(unsigned) };
    if (!await store.save(registered, null)) {
      const existing = await store.read(handle);
      if (existing === null || !sameDownloadIdentity(existing, registered)) {
        throw buildBusinessError('conflict', 'Export registration changed.');
      }
      // Replay convergence: keep the original record (and expiry) untouched.
      expires_at = existing.expiresAt;
    }
  }
  return {
    handle,
    status: 'pending',
    download_url: `${origin}/api/exports/download/${handle}`,
    status_url: `${origin}/api/exports/status/${handle}`,
    expires_at,
    row_estimate: null,
    truncated: true,
  };
}

export async function handleExportRequest(deps: HttpDeps, request: Request): Promise<Response> {
  const pathname = requestPath(request.url);
  try {
    const downloaded = await dispatchExportDownload(deps, request, pathname);
    if (downloaded !== null) return downloaded;
    if (request.method.toUpperCase() !== 'POST') {
      return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
    }
    const admitted = await admitExportCaller(deps, request, pathname);
    if (admitted instanceof Response) return admitted;
    const { identity, body } = admitted;

    const checked = checkExportArgs(deps, body, pathname);
    if (checked instanceof Response) return checked;
    const { operation, requested, limit, parent, filters, cursor } = checked;

    const loaded = await loadExportPage(deps, identity, operation, parent, filters, limit, cursor);
    if (loaded instanceof Response) return loaded;
    const selected = await selectExportColumns(deps, loaded.page, requested, operation);
    if (selected instanceof Response) return selected;
    const page = loaded.page;
    const selection = selected;
    /* Enforce the requested bound even when the read over-delivers. */
    const overDelivered = page.rows.length > limit;
    const bounded: ExportPage = {
      rows: page.rows.slice(0, limit),
      columns: page.columns,
      nextCursor: page.nextCursor,
    };
    const truncated = bounded.nextCursor !== undefined || overDelivered;
    let projected: { csv: string; columns: ExportColumn[]; rowCount: number };
    try {
      projected = pageToCsv(bounded, selection);
    } catch (err) {
      if (err instanceof SecretRefusal) {
        return deny(deps, buildBusinessError('validation', 'Export refuses secret values.'), operation);
      }
      if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
        return deny(deps, caughtToBusinessError(err), operation);
      }
      throw err;
    }

    const asOf = new Date(deps.clock.nowMs()).toISOString();
    const descriptor = truncated ? await buildExportDescriptor(deps, request, identity, operation,
      { parent, filters, requested, limit, cursor }) : undefined;
    const outcome: ExportOutcome = {
      operation,
      as_of: asOf,
      complete: !truncated,
      row_count: projected.rowCount,
      truncated,
      ...(bounded.nextCursor === undefined ? {} : { next_cursor: bounded.nextCursor }),
      columns: projected.columns,
      csv: projected.csv,
      ...(descriptor === undefined ? {} : { descriptor }),
    };
    return jsonOk(outcome);
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'exports', tool: pathname });
    void incidentId;
    const error = fromUnknown(err);
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  }
}

const DOWNLOAD_HANDLE_PATTERN = /^exp-[0-9a-f]{16}$/;

/** Integrity digest over every record member except itself. */
async function downloadRecordDigest(record: Omit<ExportDownloadRecord, 'digest'>): Promise<string> {
  return sha256HexText(canonicalJson(record));
}

/** Same export identity: principal, operation and request arguments. */
function sameDownloadIdentity(left: ExportDownloadRecord, right: ExportDownloadRecord): boolean {
  return left.handle === right.handle && left.appId === right.appId && left.teamId === right.teamId &&
    left.principal === right.principal && left.operation === right.operation &&
    canonicalJson(left.args) === canonicalJson(right.args);
}

/** Re-resolve the original credential; a stored handle grants no app/owner authority. */
async function authorizeDownload(
  deps: HttpDeps, request: Request, record: ExportDownloadRecord,
): Promise<ResolvedIdentity> {
  const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
  if (sessionToken === null || identity.actor === null || identity.actor.user_id !== record.principal ||
      deps.app.appId !== record.appId || (identity.team?.team_id ?? null) !== record.teamId) {
    throw buildBusinessError('forbidden', 'Not authorized for this download.');
  }
  await assertExportAuthority(deps, identity);
  if (deps.clock.nowMs() >= Date.parse(record.expiresAt)) {
    throw buildBusinessError('not_found', 'Not found.');
  }
  return identity;
}

interface CheckedDownload {
  readonly record: ExportDownloadRecord;
  readonly identity: ResolvedIdentity;
}

function checkDownloadRecordShape(record: ExportDownloadRecord, handle: string): BusinessError | null {
  if (record.handle !== handle || checkListOperation(record.operation) !== null ||
      typeof record.args !== 'object' || record.args === null ||
      !Number.isInteger(record.args.limit) || record.args.limit < 1 || record.args.limit > PAGE_MAX_RECORDS ||
      (record.args.cursor !== null && typeof record.args.cursor !== 'string') ||
      (record.args.columns !== null && (!Array.isArray(record.args.columns) ||
        record.args.columns.some((field) => typeof field !== 'string' || field === ''))) ||
      (record.status !== 'pending' && record.status !== 'ready')) {
    return buildBusinessError('validation', 'Stored download record is malformed.');
  }
  return null;
}

/** Shared status/download admission: store presence, shape, expiry, caller, revocation, integrity. */
async function checkDownloadAccess(
  deps: HttpDeps, request: Request, handle: string, pathname: string,
): Promise<{ response: Response } | { checked: CheckedDownload }> {
  if (!DOWNLOAD_HANDLE_PATTERN.test(handle)) {
    return { response: deny(deps, buildBusinessError('not_found', 'Not found.'), pathname) };
  }
  const store: ExportDownloadStore | undefined = deps.exportDownloads;
  if (store === undefined) {
    return { response: deny(deps, buildBusinessError('not_found', 'Not found.'), pathname) };
  }
  const record: ExportDownloadRecord | null = await store.read(handle);
  if (record === null) {
    return { response: deny(deps, buildBusinessError('not_found', 'Not found.'), pathname) };
  }
  if (typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt)) ||
      deps.clock.nowMs() >= Date.parse(record.expiresAt)) {
    return { response: deny(deps, buildBusinessError('not_found', 'Not found.'), pathname) };
  }
  const identity = await authorizeDownload(deps, request, record);
  if (record.status === 'revoked') {
    return { response: deny(deps, buildBusinessError('forbidden', 'This download was revoked.'), pathname) };
  }
  const shapeError = checkDownloadRecordShape(record, handle);
  if (shapeError !== null) {
    return { response: deny(deps, shapeError, pathname) };
  }
  const { digest: _stored, ...rest } = record;
  if (await downloadRecordDigest(rest) !== record.digest) {
    return { response: deny(deps, buildBusinessError('validation', 'Stored download failed integrity verification.'), pathname) };
  }
  return { checked: { record, identity } };
}

function downloadUrls(request: Request, handle: string): { download_url: string; status_url: string } {
  const origin = new URL(request.url).origin;
  return {
    download_url: `${origin}/api/exports/download/${handle}`,
    status_url: `${origin}/api/exports/status/${handle}`,
  };
}

async function handleDownloadStatus(deps: HttpDeps, request: Request, handle: string): Promise<Response> {
  const pathname = requestPath(request.url);
  try {
    const admitted = await checkDownloadAccess(deps, request, handle, pathname);
    if ('response' in admitted) return admitted.response;
    const original = admitted.checked.record;
    const body = await completeExportBody(deps, admitted.checked.identity, original);
    const final = await recheckDownloadDisclosure(deps, request, handle, pathname, original, body);
    if ('response' in final) return final.response;
    const { record } = final.checked;
    if (record.status !== 'pending' && record.status !== 'ready') {
      return deny(deps, buildBusinessError('validation', 'Stored download has an unknown status.'), pathname);
    }
    const status: ExportDownloadStatus = {
      handle: record.handle,
      status: record.status,
      ...downloadUrls(request, record.handle),
      expires_at: record.expiresAt,
      row_estimate: null,
      truncated: true,
      ...(record.rowCount === undefined ? {} : { row_count: record.rowCount }),
    };
    return jsonOk(status);
  } catch (err) {
    if (err instanceof IdentityError) return deny(deps, caughtToBusinessError(err), pathname);
    if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    throw err;
  }
}

/** Complete a pending download by re-reading the full output under the current caller and grants. */
async function completeExportBody(
  deps: HttpDeps, identity: ResolvedIdentity, record: ExportDownloadRecord,
): Promise<{ csv: string; rowCount: number }> {
  const inputsBase = {
    ...(record.args.parent === undefined || record.args.parent === null ? {} : { parent: record.args.parent }),
    ...(record.args.filters === undefined || record.args.filters === null ? {} : { filters: record.args.filters }),
    limit: record.args.limit,
  };
  const allRows: ExportPage['rows'][number][] = [];
  let columns: ExportPage['columns'] | undefined;
  let cursor = record.args.cursor ?? undefined;
  const visited = new Set<string | undefined>();
  for (;;) {
    if (visited.has(cursor)) throw buildBusinessError('validation', 'Export cursor did not advance.');
    visited.add(cursor);
    const page = await readExportPage(deps, identity, {
      operation: record.operation,
      inputs: { ...inputsBase, ...(cursor === undefined ? {} : { cursor }) },
    });
    if (page.rows.length > record.args.limit) {
      throw buildBusinessError('validation', 'Export read exceeded its page bound.');
    }
    if (columns === undefined) {
      columns = page.columns;
    } else if (JSON.stringify(page.columns) !== JSON.stringify(columns)) {
      throw buildBusinessError('validation', 'Export schema changed during download completion.');
    }
    allRows.push(...page.rows);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return projectCompletedExport(columns, record.args.columns, allRows);
}

function projectCompletedExport(
  columns: ExportPage['columns'] | undefined,
  requested: readonly string[] | null,
  allRows: ExportPage['rows'],
): { csv: string; rowCount: number } {
  const selection = requested ?? (columns ?? []).map((column) => column.field);
  const available = new Set((columns ?? []).map((column) => column.field));
  for (const field of selection) {
    if (!available.has(field)) {
      throw buildBusinessError('validation', `Unknown export column ${JSON.stringify(field)}.`);
    }
  }
  try {
    const projected = pageToCsv({ rows: allRows, columns: columns ?? [], nextCursor: undefined }, selection);
    return { csv: projected.csv, rowCount: projected.rowCount };
  } catch (err) {
    if (err instanceof SecretRefusal) {
      throw buildBusinessError('validation', 'Export refuses secret values.');
    }
    throw err;
  }
}

/** Admission ends at this fresh record/caller check, before response publication.
 * Canonical current reads, rather than the cached CSV/digest, authorize disclosure. */
async function recheckDownloadDisclosure(
  deps: HttpDeps, request: Request, handle: string, pathname: string,
  original: ExportDownloadRecord, body: { csv: string; rowCount: number },
): Promise<{ response: Response } | { checked: CheckedDownload }> {
  const final = await checkDownloadAccess(deps, request, handle, pathname);
  if ('response' in final) return final;
  const { record } = final.checked;
  if (!sameDownloadIdentity(original, record)) {
    throw buildBusinessError('forbidden', 'Export identity changed.');
  }
  if (record.status === 'ready') {
    if (typeof record.csv !== 'string') throw new Error('Ready download record carries no body.');
    if (record.csv !== body.csv || record.rowCount !== body.rowCount) {
      throw buildBusinessError('forbidden', 'Download no longer matches the current authorized output.');
    }
  }
  // Digest computation and storage lookup may await; recheck the original browser caller and expiry.
  await authorizeDownload(deps, request, record);
  const current = await deps.exportDownloads!.read(handle);
  if (current === null || current.status === 'revoked') {
    throw buildBusinessError('forbidden', 'This download was revoked.');
  }
  if (current.digest !== record.digest || current.status !== record.status ||
      canonicalJson(current) !== canonicalJson(record)) {
    throw buildBusinessError('conflict', 'Export changed before disclosure.');
  }
  // This last store snapshot is the disclosure admission boundary. No further
  // credential/query/digest await may reopen a revocation window before return.
  if (deps.clock.nowMs() >= Date.parse(record.expiresAt)) throw buildBusinessError('not_found', 'Not found.');
  return final;
}

async function handleDownload(deps: HttpDeps, request: Request, handle: string): Promise<Response> {
  const pathname = requestPath(request.url);
  const store = deps.exportDownloads;
  try {
    const admitted = await checkDownloadAccess(deps, request, handle, pathname);
    if ('response' in admitted) return admitted.response;
    const { record, identity } = admitted.checked;
    if (store === undefined) {
      return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
    }
    let ready = record;
    if (record.status === 'pending') {
      const body = await completeExportBody(deps, identity, record);
      const completed: ExportDownloadRecord = { ...record, status: 'ready', csv: body.csv, rowCount: body.rowCount, digest: '' };
      const { digest: _prior, ...rest } = completed;
      const finished: ExportDownloadRecord = { ...completed, digest: await downloadRecordDigest(rest) };
      await authorizeDownload(deps, request, record);
      // The store owns the atomic pending->ready transition. A losing writer
      // must use and reauthorize the actual winner; it cannot return its draft.
      await store.save(finished, record.digest);
      const winner = await checkDownloadAccess(deps, request, handle, pathname);
      if ('response' in winner) return winner.response;
      ready = winner.checked.record;
    }
    if (ready.status !== 'ready' || typeof ready.csv !== 'string') {
      const incidentId = logInternalError(deps.logger,
        new Error('Ready download record carries no body.'), { route: 'exports', tool: pathname });
      void incidentId;
      throw new Error('Ready download record carries no body.');
    }
    const currentBody = await completeExportBody(deps, await authorizeDownload(deps, request, ready), ready);
    const final = await recheckDownloadDisclosure(deps, request, handle, pathname, record, currentBody);
    if ('response' in final) return final.response;
    ready = final.checked.record;
    return new Response(ready.csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="export-${ready.handle}.csv"`,
      },
    });
  } catch (err) {
    if (err instanceof IdentityError) return deny(deps, caughtToBusinessError(err), pathname);
    if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    throw err;
  }
}
