/**
 * FP.EXPORT Print slice: declared authorized Print views over the same
 * bounded list reads as CSV export.
 *
 * `GET /print/<view>` renders one DECLARED view — name/title/operation/
 * columns from the injected `PrintViewRegistry` (L7 assembles from
 * source; tests inject) — as an HTML table. Callers select nothing:
 * the view declares its `<model>.list` operation and its columns, and
 * undeclared/unknown columns fail closed. Grants match export exactly:
 * session required (safe GET, so no CSRF — mirroring page GETs), fresh
 * identity plus the T32 liveness re-check per request, and the read
 * itself enforces current row/field/file grants inside L3.
 *
 * Projection reuses the export rules (`./export.js`): `id` first (rows
 * without ids fail closed), file values as opaque ids, secrets refuse
 * the whole view, other values as text — with HTML escaping instead of
 * CSV quoting (formula neutralization is CSV-only; HTML needs entity
 * escaping). The render states currency (`as of`) and completeness
 * (row count, explicit truncation note) — a truncated print never
 * passes as complete.
 */
import type { BusinessError, ClosedInputs, MessageValue } from '@canlang/contracts';
import { COLLECTION_MAX_LIMIT, PAGE_MAX_RECORDS } from '@canlang/contracts';
import { IdentityError } from '@canlang/identity';
import type { HttpDeps } from '../ports.js';
import { buildBusinessError, fromUnknown, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import { caughtToBusinessError, jsonErrorResponse, resolveRequestIdentity } from './context.js';
import {
  SecretRefusal,
  assertExportAuthority,
  checkListOperation,
  projectExportCell,
  readExportPage,
} from './export.js';
import type { ExportPage } from './export.js';

const PRINT_PREFIX = '/print/';

/** One declared print column: result field plus its display label. */
export interface PrintColumn {
  readonly field: string;
  readonly label: string;
}

/** One declared print view: name, title, list operation, fixed columns. */
export interface PrintView {
  readonly name: string;
  readonly title: string;
  readonly operation: string;
  readonly columns: readonly PrintColumn[];
}

/** Source-declared print views (L7 binds; tests inject). */
export interface PrintViewRegistry {
  views(): readonly PrintView[];
}

/** HTML escape for text nodes and double-quoted attributes. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Display text for a declared label or result label value. */
function labelText(label: string | MessageValue): string {
  if (typeof label === 'string') return label;
  return label.source;
}

function deny(deps: HttpDeps, error: BusinessError, view: string): Response {
  logBusinessError(deps.logger, error, { route: 'print', view });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(body, status);
}

/**
 * Render one validated page as a print HTML document: escaped title,
 * `id` + declared columns, currency, row count, truncation note.
 */
function renderPrintPage(
  view: PrintView,
  page: ExportPage,
  asOf: string,
  truncated: boolean,
  rowCount: number,
): string {
  const head = [
    '<th>ID</th>',
    ...view.columns.map((column) => `<th>${escapeHtml(labelText(column.label))}</th>`),
  ].join('');
  const body = page.rows.map((row) => {
    if (typeof row !== 'object' || row === null || typeof row.id !== 'string' || row.id === '') {
      throw buildBusinessError('validation', 'Print requires row ids.');
    }
    if (typeof row.fields !== 'object' || row.fields === null || Array.isArray(row.fields)) {
      throw new Error('Print read returned a row without a fields record.');
    }
    const fields = row.fields as Record<string, unknown>;
    const cells = [row.id, ...view.columns.map((column) => projectExportCell(fields[column.field]))];
    return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
  }).join('');
  const completeness = truncated
    ? `<p>Showing ${rowCount} rows; more rows remain (truncated).</p>`
    : `<p>${rowCount} rows, complete.</p>`;
  const title = escapeHtml(view.title);
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body><h1>${title}</h1><p>as of ${escapeHtml(asOf)}</p>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    `${completeness}</body></html>`
  );
}

/**
 * Dispatch one print request. See the module doc for the declaration,
 * grant, projection, and completeness rules.
 */
export async function handlePrintRequest(
  deps: HttpDeps,
  views: PrintViewRegistry,
  request: Request,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = 'unknown';
  }
  if (!pathname.startsWith(PRINT_PREFIX) || request.method.toUpperCase() !== 'GET') {
    return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
  }
  const name = pathname.slice(PRINT_PREFIX.length);
  if (name === '' || name.includes('/')) {
    return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
  }
  try {
    const { identity, sessionToken } = await resolveRequestIdentity(
      deps.identity.store,
      request,
      { clock: deps.clock },
    );
    if (sessionToken === null || identity.actor === null) {
      return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), name);
    }
    const view = views.views().find((candidate) => candidate.name === name) ?? null;
    if (view === null) {
      return deny(deps, buildBusinessError('not_found', 'Unknown print view.'), name);
    }
    const opError = checkListOperation(view.operation);
    if (opError !== null) {
      return deny(deps, opError, name);
    }
    const query = new URL(request.url).searchParams;
    const limitRaw = query.get('limit');
    let limit = COLLECTION_MAX_LIMIT;
    if (limitRaw !== null) {
      if (!/^-?\d+$/.test(limitRaw.trim())) {
        return deny(deps, buildBusinessError('validation', `Print limit is 1..${PAGE_MAX_RECORDS}.`), name);
      }
      const parsed = Number(limitRaw.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > PAGE_MAX_RECORDS) {
        return deny(deps, buildBusinessError('validation', `Print limit is 1..${PAGE_MAX_RECORDS}.`), name);
      }
      limit = parsed;
    }
    const cursor = query.get('cursor');

    try {
      await assertExportAuthority(deps, identity);
    } catch (err) {
      if (err instanceof IdentityError) {
        return deny(deps, caughtToBusinessError(err), name);
      }
      throw err;
    }

    const inputs: ClosedInputs = {
      limit,
      ...(cursor === null ? {} : { cursor }),
    };
    let page: ExportPage;
    try {
      page = await readExportPage(deps, identity, { operation: view.operation, inputs });
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
        return deny(deps, caughtToBusinessError(err), name);
      }
      throw err;
    }
    const available = new Set(page.columns.map((column) => column.field));
    for (const column of view.columns) {
      if (!available.has(column.field)) {
        return deny(deps, buildBusinessError('validation', `Unknown print column ${JSON.stringify(column.field)}.`), name);
      }
    }
    const overDelivered = page.rows.length > limit;
    const bounded: ExportPage = {
      rows: page.rows.slice(0, limit),
      columns: page.columns,
      nextCursor: page.nextCursor,
    };
    const truncated = bounded.nextCursor !== undefined || overDelivered;
    const asOf = new Date(deps.clock.nowMs()).toISOString();
    let html: string;
    try {
      html = renderPrintPage(view, bounded, asOf, truncated, bounded.rows.length);
    } catch (err) {
      if (err instanceof SecretRefusal) {
        return deny(deps, buildBusinessError('validation', 'Print refuses secret values.'), name);
      }
      if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
        return deny(deps, caughtToBusinessError(err), name);
      }
      throw err;
    }
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), name);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'print', tool: pathname });
    void incidentId;
    const error = fromUnknown(err);
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  }
}
