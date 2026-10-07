/**
 * FP.CSV server slice: source-derived CSV intake review + per-row commit
 * at HTTP level.
 *
 * F owns the UI thirds (parse/preview/confirm); this module is the
 * server contract that UI drives: `POST /api/csv/review` evaluates
 * every submitted row against the operation's T19 derived inputs
 * through the real V02.3 runner (`runPreparedHttpPlan`) — framing
 * first, then binding, defaults never applied — and
 * `POST /api/csv/commit` confirms selected rows under a frozen
 * commit-time identity.
 *
 * Cell mapping (the only CSV-owned rules; everything else delegates):
 * an empty cell means the member is ABSENT (optional members omit,
 * required members fail framing — preserved as invalid rows, never
 * dropped); `boolean` columns decode from `true`/`false` text (any
 * other text is a row-level binding mismatch); every other kind binds
 * its cell string verbatim because integers/decimals/datetimes/enums/
 * file ids already travel as strings on the wire, while ref/money/
 * array/object shapes cannot come from a flat cell and fail binding.
 *
 * Review verdicts: `valid` (binds), `invalid` (framing/binding
 * failure or a malformed field count — all preserved with their
 * errors), `duplicate` (byte-identical canonical inputs to an
 * earlier VALID row, pointing at it via `duplicate_of`; a repeat of
 * an invalid row keeps its own invalid verdict instead).
 *
 * Consent: the review mints `{review_id, operation, principal,
 * candidates_digest, candidate_count}` where the digest is sha256
 * over the canonical valid-candidate list and `review_id` derives
 * deterministically from it (`rev-<16 hex>`), so re-reviewing
 * unchanged candidates replays the same consent. The consent needs
 * no signature: commit re-derives the candidates from the echoed CSV
 * and compares digests itself, and the principal must equal the live
 * session user — a forged consent buys nothing. Changed candidates
 * void the consent (`conflict`, renewed review required).
 *
 * Commit: authorized (session + CSRF, like operation POSTs), then
 * consent/selection validation, then — before ANY invocation — the
 * T32 commit-time authority check (team scope: `assertAuthorityLive`
 * re-reads the membership; teamless: the session resolution at
 * commit time is the liveness fact). Revoked authority voids the
 * whole commit. Each selected row then resolves to `committed`
 * (invoked once with its caller-supplied `operation_id` replay key),
 * `failed` (bad replay key or invoker error), `invalid` (kept
 * review error, never invoked), or `duplicate` (points at the
 * committed first occurrence, never invoked). Request-level input
 * failures (unknown row index, duplicate replay keys in one batch)
 * reject before any invocation; row failures are data, so a
 * well-formed commit always answers HTTP 200 with per-row outcomes
 * (partial failure). Replaying an identical commit body re-invokes
 * with byte-identical envelopes — the per-row `operation_id` keys
 * are L3's canonical replay keys.
 */
import type {
  BusinessError,
  ClosedInputs,
  DerivedOperationInputs,
  MutationEnvelope,
} from '@canlang/contracts';
import { IdentityError, assertAuthorityLive, sha256HexText } from '@canlang/identity';
import { CsvGrammarError, parseCsvGrammar } from '@canlang/ui/csv/grammar';
import type { HttpDeps, OperationInputShape } from '../ports.js';
import { validateOperationId } from '../envelope/validate.js';
import { prepareHttpPlan, runPreparedHttpPlan } from '../envelope/prepared.js';
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
import { parseJsonBody } from './limits.js';
import { OPERATION_NAME_PATTERN } from './operations.js';

const REVIEW_PATH = '/api/csv/review';
const COMMIT_PATH = '/api/csv/commit';
const JSON_CONTENT_TYPE = 'application/json';

/** One row's verdict: binds, fails (preserved with error), or repeats a valid row. */
export type CsvRowStatus = 'valid' | 'invalid' | 'duplicate';

/** One preserved row: index into the CSV data rows, verdict, canonical inputs. */
export interface CsvRowReview {
  readonly index: number;
  readonly status: CsvRowStatus;
  readonly inputs: ClosedInputs;
  readonly error?: BusinessError;
  readonly duplicate_of?: number;
}

/** Review consent: digest-bound candidate set + reviewing principal. */
export interface CsvConsent {
  readonly review_id: string;
  readonly operation: string;
  readonly principal: string;
  readonly candidates_digest: string;
  readonly candidate_count: number;
}

/** Full review: every row preserved, consent for the candidate set. */
export interface CsvReview {
  readonly operation: string;
  readonly review_id: string;
  readonly consent: CsvConsent;
  readonly rows: readonly CsvRowReview[];
  readonly counts: { readonly total: number; readonly valid: number; readonly invalid: number; readonly duplicate: number };
}

/** One commit row selection: review row index + caller replay key. */
export interface CsvCommitSelection {
  readonly index: number;
  readonly operation_id: string;
}

/** One committed row: per-row outcome, never a request failure. */
export interface CsvCommitRow {
  readonly index: number;
  readonly operation_id: string;
  readonly status: 'committed' | 'failed' | 'invalid' | 'duplicate';
  readonly result?: unknown;
  readonly error?: BusinessError;
  readonly duplicate_of?: number;
}

/** Commit outcome: frozen principal + per-row results (partial failure is data). */
export interface CsvCommitOutcome {
  readonly operation: string;
  readonly review_id: string;
  readonly principal: { readonly user_id: string; readonly team_id: string | null; readonly admitted_at: string };
  readonly rows: readonly CsvCommitRow[];
}

/** Unparseable CSV text: request-level `validation` with fixed safe messages. */
export class CsvParseError extends Error {
  override readonly name = 'CsvParseError';
}

/** More data rows than the shared grammar ceiling: request-level `limit`. */
export class CsvTooManyRowsError extends Error {
  override readonly name = 'CsvTooManyRowsError';
}

/** One parsed data row: raw cell strings, or a field-count mismatch (preserved). */
export interface CsvDataRow {
  readonly cells: readonly string[];
  readonly malformed: boolean;
}

/** Shared raw CSV grammar; this wrapper preserves authoritative error classes. */
export function parseCsvText(text: string): { header: string[]; rows: CsvDataRow[] } {
  try {
    const parsed = parseCsvGrammar(text);
    return { header: [...parsed.header], rows: [...parsed.rows] };
  } catch (error) {
    if (!(error instanceof CsvGrammarError)) throw error;
    if (error.kind === 'limit') throw new CsvTooManyRowsError(error.message);
    throw new CsvParseError(error.message);
  }
}

/** Canonical JSON: object keys sorted recursively, so digests replay. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Map one data row's cells to business inputs: empty cells omit the
 * member (absent, never null); `boolean` columns decode `true`/
 * `false` text. Returns the mapped inputs plus, for a non-boolean
 * cell, a row-level binding error of its own.
 */
function mapRowCells(
  header: readonly string[],
  cells: readonly string[],
  derived: DerivedOperationInputs,
): { inputs: ClosedInputs; error: BusinessError | null } {
  const inputs: Record<string, unknown> = {};
  const byName = new Map(derived.inputs.map((input) => [input.name, input]));
  for (let i = 0; i < header.length; i += 1) {
    const name = header[i]!;
    const cell = cells[i] ?? '';
    if (cell === '') continue;
    const declared = byName.get(name);
    if (declared?.kind === 'boolean') {
      if (cell === 'true') inputs[name] = true;
      else if (cell === 'false') inputs[name] = false;
      else {
        const message =
          `Invalid value for input ${JSON.stringify(name)}: boolean columns take true/false text ` +
          `(got ${JSON.stringify(cell)}).`;
        return {
          inputs,
          error: buildBusinessError('validation', message, {
            fields: [{ path: `/${name}`, code: 'binding_mismatch', message }],
          }),
        };
      }
      continue;
    }
    inputs[name] = cell;
  }
  return { inputs, error: null };
}

/**
 * Review CSV candidates (pure except the digest hash): parse, map each
 * row's cells, and run the real V02.3 framing+binding evaluation per
 * row — first error wins per row, exactly dispatch order. Duplicate
 * detection runs over canonical input JSON: a repeat of an earlier
 * VALID row becomes `duplicate` (pointing at it); a repeat of an
 * invalid row keeps its own invalid verdict. The consent digest
 * covers the operation plus the valid candidates in index order.
 */
export async function reviewCsvCandidates(input: {
  operation: string;
  shape: OperationInputShape;
  derived: DerivedOperationInputs;
  principal: string;
  header: readonly string[];
  rows: readonly CsvDataRow[];
}): Promise<CsvReview> {
  const plan = prepareHttpPlan(input.operation, input.shape, input.derived);
  const firstValid = new Map<string, number>();
  const rows: CsvRowReview[] = [];
  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  for (let index = 0; index < input.rows.length; index += 1) {
    const data = input.rows[index]!;
    let row: CsvRowReview;
    if (data.malformed) {
      const message =
        `Row ${index} has ${data.cells.length} fields; header has ${input.header.length}.`;
      row = {
        index,
        status: 'invalid',
        inputs: {},
        error: buildBusinessError('validation', message, {
          fields: [{ path: `/rows/${index}`, code: 'malformed', message }],
        }),
      };
    } else {
      const mapped = mapRowCells(input.header, data.cells, input.derived);
      const key = canonicalJson(mapped.inputs);
      const bound = mapped.error === null ? runPreparedHttpPlan(plan, mapped.inputs) : null;
      const rowError = mapped.error ?? (bound !== null && bound.ok === false ? bound.error : null);
      if (rowError === null && firstValid.has(key)) {
        const first = firstValid.get(key)!;
        row = { index, status: 'duplicate', inputs: mapped.inputs, duplicate_of: first };
      } else if (rowError !== null) {
        row = { index, status: 'invalid', inputs: mapped.inputs, error: rowError };
      } else {
        row = { index, status: 'valid', inputs: mapped.inputs };
        firstValid.set(key, index);
      }
    }
    if (row.status === 'valid') valid += 1;
    else if (row.status === 'duplicate') duplicate += 1;
    else invalid += 1;
    rows.push(row);
  }
  const candidates = rows.filter((row) => row.status === 'valid').map((row) => row.inputs);
  const digest = await sha256HexText(canonicalJson({ operation: input.operation, candidates }));
  const review_id = `rev-${digest.slice(0, 16)}`;
  return {
    operation: input.operation,
    review_id,
    consent: {
      review_id,
      operation: input.operation,
      principal: input.principal,
      candidates_digest: digest,
      candidate_count: candidates.length,
    },
    rows,
    counts: { total: rows.length, valid, invalid, duplicate },
  };
}

function deny(deps: HttpDeps, error: BusinessError, operation: string): Response {
  logBusinessError(deps.logger, error, { route: 'csv', operation });
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

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== JSON_CONTENT_TYPE) {
    throw new IdentityError('validation', 'Unsupported content type.');
  }
  const body = await parseJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new IdentityError('validation', 'Invalid request body.');
  }
  return body as Record<string, unknown>;
}

function checkHeader(header: readonly string[]): BusinessError | null {
  for (const name of header) {
    if (name === '') {
      return buildBusinessError('validation', 'CSV header has an empty column name.');
    }
  }
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) {
      return buildBusinessError('validation', `CSV header repeats column ${JSON.stringify(name)}.`);
    }
    seen.add(name);
  }
  return null;
}

function isCsvConsent(value: unknown): value is CsvConsent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['review_id'] === 'string' &&
    typeof record['operation'] === 'string' &&
    typeof record['principal'] === 'string' &&
    typeof record['candidates_digest'] === 'string' &&
    typeof record['candidate_count'] === 'number'
  );
}

function parseSelections(value: unknown): { selections: CsvCommitSelection[]; error: BusinessError | null } {
  if (!Array.isArray(value) || value.length === 0) {
    return { selections: [], error: buildBusinessError('validation', 'Commit selects no rows.') };
  }
  const selections: CsvCommitSelection[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { selections: [], error: buildBusinessError('validation', 'Invalid commit row selection.') };
    }
    const record = entry as Record<string, unknown>;
    const index = record['index'];
    const operation_id = record['operation_id'];
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return { selections: [], error: buildBusinessError('validation', 'Invalid commit row selection.') };
    }
    if (typeof operation_id !== 'string' || operation_id === '') {
      return { selections: [], error: buildBusinessError('validation', 'Invalid commit row selection.') };
    }
    selections.push({ index, operation_id });
  }
  const indexes = new Set<number>();
  for (const selection of selections) {
    if (indexes.has(selection.index)) {
      return { selections: [], error: buildBusinessError('validation', `Duplicate row index ${selection.index} in commit batch.`) };
    }
    indexes.add(selection.index);
  }
  const ids = new Set<string>();
  for (const selection of selections) {
    if (ids.has(selection.operation_id)) {
      return { selections: [], error: buildBusinessError('validation', 'Duplicate operation_id in commit batch.') };
    }
    ids.add(selection.operation_id);
  }
  return { selections, error: null };
}

/**
 * Dispatch one CSV review/commit request. See the module doc for the
 * cell mapping, consent, authority, and outcome rules.
 */
export async function handleCsvRequest(deps: HttpDeps, request: Request): Promise<Response> {
  const pathname = requestPath(request.url);
  const method = request.method.toUpperCase();
  const kind = pathname === REVIEW_PATH && method === 'POST'
    ? 'review'
    : pathname === COMMIT_PATH && method === 'POST'
      ? 'commit'
      : null;
  if (kind === null) {
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
    if (typeof operation !== 'string' || operation === '') {
      return deny(deps, buildBusinessError('validation', 'Missing operation.'), pathname);
    }
    if (!OPERATION_NAME_PATTERN.test(operation)) {
      return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
    }
    const shape = deps.catalog.shapeFor(operation);
    if (shape === null) {
      return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
    }
    const derived = deps.catalog.derivedFor?.(operation) ?? null;
    if (derived === null) {
      return deny(deps, buildBusinessError('validation', 'CSV review is unavailable for this operation.'), operation);
    }
    const csv = body['csv'];
    if (typeof csv !== 'string' || csv === '') {
      return deny(deps, buildBusinessError('validation', 'Missing CSV text.'), operation);
    }
    let parsed: { header: string[]; rows: CsvDataRow[] };
    try {
      parsed = parseCsvText(csv);
    } catch (err) {
      if (err instanceof CsvTooManyRowsError) {
        return deny(deps, buildBusinessError('limit', err.message), operation);
      }
      if (err instanceof CsvParseError) {
        return deny(deps, buildBusinessError('validation', err.message), operation);
      }
      throw err;
    }
    const headerError = checkHeader(parsed.header);
    if (headerError !== null) {
      return deny(deps, headerError, operation);
    }
    const review = await reviewCsvCandidates({
      operation,
      shape,
      derived,
      principal: identity.actor.user_id,
      header: parsed.header,
      rows: parsed.rows,
    });
    if (kind === 'review') {
      return jsonOk(review);
    }

    /* Commit: consent + selection validation, then T32 BEFORE any invocation. */
    const consent = body['consent'];
    if (!isCsvConsent(consent)) {
      return deny(deps, buildBusinessError('validation', 'Invalid consent.'), operation);
    }
    if (
      consent.operation !== operation ||
      consent.review_id !== review.review_id ||
      consent.candidates_digest !== review.consent.candidates_digest ||
      consent.candidate_count !== review.consent.candidate_count
    ) {
      return deny(
        deps,
        buildBusinessError('conflict', 'Candidates changed since review; renewed consent required.'),
        operation,
      );
    }
    if (consent.principal !== identity.actor.user_id) {
      return deny(deps, buildBusinessError('forbidden', 'Consent was issued to a different principal.'), operation);
    }
    const { selections, error: selectionError } = parseSelections(body['rows']);
    if (selectionError !== null) {
      return deny(deps, selectionError, operation);
    }
    for (const selection of selections) {
      if (selection.index >= review.rows.length) {
        return deny(deps, buildBusinessError('validation', `Unknown row index ${selection.index}.`), operation);
      }
    }
    /* T32 commit-time authority liveness: team scope re-reads the live
     * membership (revoked mid-flight voids the commit); teamless callers
     * are live by the session resolution above, at commit time. */
    if (identity.team !== null) {
      try {
        await assertAuthorityLive(deps.identity.store, {
          teamId: identity.team.team_id,
          userId: identity.actor.user_id,
        });
      } catch (err) {
        if (err instanceof IdentityError) {
          return deny(deps, caughtToBusinessError(err), operation);
        }
        throw err;
      }
    }

    const frozen = {
      user_id: identity.actor.user_id,
      team_id: identity.team?.team_id ?? null,
      admitted_at: identity.admitted_at,
    };
    const rows: CsvCommitRow[] = [];
    for (const selection of selections) {
      const verdict = review.rows[selection.index]!;
      if (verdict.status === 'invalid') {
        rows.push({
          index: selection.index,
          operation_id: selection.operation_id,
          status: 'invalid',
          ...(verdict.error === undefined ? {} : { error: verdict.error }),
        });
        continue;
      }
      if (verdict.status === 'duplicate') {
        rows.push({
          index: selection.index,
          operation_id: selection.operation_id,
          status: 'duplicate',
          ...(verdict.duplicate_of === undefined ? {} : { duplicate_of: verdict.duplicate_of }),
        });
        continue;
      }
      const idError = validateOperationId(selection.operation_id, deps.clock);
      if (idError !== null) {
        rows.push({ index: selection.index, operation_id: selection.operation_id, status: 'failed', error: idError });
        continue;
      }
      const envelope: MutationEnvelope = {
        operation,
        operation_id: selection.operation_id,
        inputs: verdict.inputs,
      };
      const outcome = await deps.invoker.invokeMutation(envelope, identity);
      if ('error' in outcome) {
        rows.push({ index: selection.index, operation_id: selection.operation_id, status: 'failed', error: outcome.error });
      } else {
        rows.push({ index: selection.index, operation_id: selection.operation_id, status: 'committed', result: outcome.result });
      }
    }
    const outcome: CsvCommitOutcome = { operation, review_id: review.review_id, principal: frozen, rows };
    return jsonOk(outcome);
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'csv', tool: pathname });
    void incidentId;
    const error = fromUnknown(err);
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  }
}
