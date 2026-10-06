/**
 * FP.BROWSER-ASSETS.1 browser asset serving: `GET`/`HEAD /assets/{key}`.
 *
 * Serves an immutable finite injected asset table (exact public keys,
 * bytes, MIME, explicit cache policy) with byte-exact bodies. Unknown
 * methods, unknown paths, and encoded traversal answer the authored
 * `not_found` envelope (no 405/400 oracle). `HEAD` returns the `GET`
 * headers with no body. No filesystem or network reads, no session
 * reads: the same bytes serve every caller (asset content is never
 * session-dependent).
 *
 * Shared boundary with F's browser bootstrap/polling outputs (frozen
 * via coordinator): E owns this handler + the table type + serving
 * semantics; F owns the byte content of its rows and proposes exact
 * key strings. Symbolic keys stand until F's bytes land; only frozen
 * keys ever enter the mounted table.
 */
import { buildBusinessError } from '../errors/envelope.js';
import { jsonErrorResponse } from './context.js';

/** Asset mount prefix: the remainder is the exact table key. */
export const ASSETS_PREFIX = '/assets/';

/** Exact MIME values the table admits (byte-exact JS/CSS only). */
export const ASSET_MIME_JAVASCRIPT = 'application/javascript';
export const ASSET_MIME_CSS = 'text/css';

const ADMITTED_MIME = new Set([ASSET_MIME_JAVASCRIPT, ASSET_MIME_CSS]);

/** Explicit per-row cache policy: max age plus immutability. */
export interface AssetCachePolicy {
  readonly maxAgeSeconds: number;
  readonly immutable: boolean;
}

/** One servable asset: exact key, bytes, MIME, cache policy. */
export interface AssetRow {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly cache: AssetCachePolicy;
}

/** Frozen lookup over validated rows. */
export interface AssetTable {
  get(key: string): AssetRow | null;
}

/**
 * Validate and freeze asset rows. Throws on any violation (wiring
 * time, host-fatal): duplicate/empty keys, keys with empty or
 * dot-segments (traversal-shaped keys never enter the table),
 * non-admitted MIME, or negative/non-integer max age. Served bodies
 * are per-request copies, so later caller mutation of the input
 * bytes cannot change served content.
 */
export function createAssetTable(rows: readonly AssetRow[]): AssetTable {
  const seen = new Set<string>();
  const frozen = rows.map((row) => {
    if (typeof row.key !== 'string' || row.key === '') {
      throw new Error('asset table: key must be a non-empty string.');
    }
    const segments = row.key.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`asset table: key ${JSON.stringify(row.key)} is traversal-shaped.`);
    }
    if (seen.has(row.key)) {
      throw new Error(`asset table: duplicate key ${JSON.stringify(row.key)}.`);
    }
    seen.add(row.key);
    if (!(row.bytes instanceof Uint8Array)) {
      throw new Error(`asset table: key ${JSON.stringify(row.key)} bytes must be a Uint8Array.`);
    }
    if (!ADMITTED_MIME.has(row.mime)) {
      throw new Error(`asset table: key ${JSON.stringify(row.key)} has non-admitted MIME.`);
    }
    if (!Number.isInteger(row.cache.maxAgeSeconds) || row.cache.maxAgeSeconds < 0) {
      throw new Error(`asset table: key ${JSON.stringify(row.key)} has an invalid max age.`);
    }
    if (typeof row.cache.immutable !== 'boolean') {
      throw new Error(`asset table: key ${JSON.stringify(row.key)} has a non-boolean immutable flag.`);
    }
    return Object.freeze({
      key: row.key,
      bytes: row.bytes.slice(),
      mime: row.mime,
      cache: Object.freeze({ ...row.cache }),
    });
  });
  const byKey = new Map(frozen.map((row) => [row.key, row] as const));
  return {
    get(key: string): AssetRow | null {
      return byKey.get(key) ?? null;
    },
  };
}

/** Authored unknown response: `not_found`, never a 405/400 oracle. */
function notFoundResponse(): Response {
  return jsonErrorResponse(buildBusinessError('not_found', 'Not found.'), 404);
}

function cacheControl(cache: AssetCachePolicy): string {
  return `public, max-age=${cache.maxAgeSeconds}${cache.immutable ? ', immutable' : ''}`;
}

/**
 * Serve one asset request from the injected table: exact-key match
 * only. `GET` serves a byte-exact copy; `HEAD` serves the same
 * headers with no body. Reads no session, filesystem, or network.
 */
export function handleAssetsRequest(table: AssetTable, request: Request): Response {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return notFoundResponse();
  }
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return notFoundResponse();
  }
  if (!pathname.startsWith(ASSETS_PREFIX)) {
    return notFoundResponse();
  }
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(ASSETS_PREFIX.length));
  } catch {
    return notFoundResponse();
  }
  if (key === '' || key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return notFoundResponse();
  }
  const row = table.get(key);
  if (row === null) {
    return notFoundResponse();
  }
  const headers = {
    'content-type': row.mime,
    'content-length': String(row.bytes.length),
    'cache-control': cacheControl(row.cache),
  };
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(row.bytes.slice(), { status: 200, headers });
}
