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
 * BOUNDARY: the durable status/expiry backend behind those URLs is
 * D-domain follow-up — this module defines the contract + handle
 * shape only, and the descriptor carries no authority (possession
 * alone grants nothing; download re-authorizes).
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
import type { HttpDeps } from '../ports.js';
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
export async function handleExportRequest(deps: HttpDeps, request: Request): Promise<Response> {
  const pathname = requestPath(request.url);
  if (pathname !== EXPORTS_PATH || request.method.toUpperCase() !== 'POST') {
    return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
  }
  try {
    const { identity, sessionToken } = await resolveRequestIdentity(
      deps.identity.store,
      request,
      { clock: deps.clock },
    );
    if (sessionToken === null || identity.actor === null) {
      return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), pathname);
    }
    const body = await parseObjectBody(request);
    await assertPostCsrf({
      sessionToken,
      headerValue: request.headers.get(CSRF_HEADER),
      fieldValue: body[CSRF_FIELD],
    });

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
    const available = new Set(page.columns.map((column) => column.field));
    const selection = requested ?? page.columns.map((column) => column.field);
    for (const field of selection) {
      if (!available.has(field)) {
        return deny(deps, buildBusinessError('validation', `Unknown export column ${JSON.stringify(field)}.`), operation);
      }
    }
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
    let descriptor: ExportDescriptor | undefined;
    if (truncated) {
      const digest = await sha256HexText(canonicalJson({
        principal: identity.actor.user_id,
        operation,
        args: { parent: parent ?? null, filters: filters ?? null, columns: requested, limit, cursor: cursor ?? null },
      }));
      const handle = `exp-${digest.slice(0, 16)}`;
      const origin = new URL(request.url).origin;
      const expires_at = new Date(deps.clock.nowMs() + EXPORT_DESCRIPTOR_TTL_SECONDS * 1000).toISOString();
      descriptor = {
        handle,
        status: 'pending',
        download_url: `${origin}/api/exports/download/${handle}`,
        status_url: `${origin}/api/exports/status/${handle}`,
        expires_at,
        row_estimate: null,
        truncated: true,
      };
    }
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
