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

/** Exact MIME values admitted by the defining asset table. */
export const ASSET_MIME_JAVASCRIPT = 'application/javascript';
export const ASSET_MIME_CSS = 'text/css';

const ADMITTED_MIME = new Set([ASSET_MIME_JAVASCRIPT, ASSET_MIME_CSS,
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml",
  "font/woff", "font/woff2", "font/ttf", "font/otf"]);

/** Finite owned CSS-asset MIME admission, including MCP's opaque asset.bin. */
export function assetContentType(path: string, bytes: Uint8Array): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "css") return ASSET_MIME_CSS;
  if (extension === "js" || extension === "mjs") return ASSET_MIME_JAVASCRIPT;
  const starts = (signature: readonly number[]): boolean => signature.every((byte,index) => bytes[index] === byte);
  const ascii = (offset:number, length:number): string => String.fromCharCode(...bytes.slice(offset,offset+length));
  let detected: string | undefined;
  if (starts([137,80,78,71,13,10,26,10])) detected = "image/png";
  else if (starts([255,216,255])) detected = "image/jpeg";
  else if (["GIF87a","GIF89a"].includes(ascii(0,6))) detected = "image/gif";
  else if (ascii(0,4) === "RIFF" && ascii(8,4) === "WEBP") detected = "image/webp";
  else if (ascii(4,4) === "ftyp" && ["avif","avis"].includes(ascii(8,4))) detected = "image/avif";
  else if (ascii(0,4) === "wOFF") detected = "font/woff";
  else if (ascii(0,4) === "wOF2") detected = "font/woff2";
  else if (starts([0,1,0,0])) detected = "font/ttf";
  else if (ascii(0,4) === "OTTO") detected = "font/otf";
  else {
    const prefix = new TextDecoder().decode(bytes.slice(0,512)).replace(/^\uFEFF/, "").trimStart()
      .replace(/^<\?xml[\s\S]*?\?>\s*/, "");
    if (/^<svg(?:\s|>)/i.test(prefix)) detected = "image/svg+xml";
  }
  const extensions: Record<string,string> = {png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",avif:"image/avif",svg:"image/svg+xml",
    woff:"font/woff",woff2:"font/woff2",ttf:"font/ttf",otf:"font/otf"};
  if (detected !== undefined && (extension === "bin" || extensions[extension] === detected)) return detected;
  throw new Error(`asset table: unsupported or mismatched owned asset type for ${JSON.stringify(path)}.`);
}

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
 * bytes cannot change served content. Each field is captured once, with bytes
 * copied before later getters, and the validated scalars are stored unchanged.
 * The lookup is frozen and each
 * returned row exposes a defensive byte copy of the registered content.
 */
export function createAssetTable(rows: readonly AssetRow[]): AssetTable {
  const seen = new Set<string>();
  const frozen = rows.map((row) => {
    const key = row.key;
    if (typeof key !== 'string' || key === '') {
      throw new Error('asset table: key must be a non-empty string.');
    }
    const segments = key.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`asset table: key ${JSON.stringify(key)} is traversal-shaped.`);
    }
    if (seen.has(key)) {
      throw new Error(`asset table: duplicate key ${JSON.stringify(key)}.`);
    }
    seen.add(key);
    const inputBytes = row.bytes;
    if (!(inputBytes instanceof Uint8Array)) {
      throw new Error(`asset table: key ${JSON.stringify(key)} bytes must be a Uint8Array.`);
    }
    const bytes = new Uint8Array(inputBytes);
    const mime = row.mime;
    if (!ADMITTED_MIME.has(mime)) {
      throw new Error(`asset table: key ${JSON.stringify(key)} has non-admitted MIME.`);
    }
    const cache = row.cache;
    const maxAgeSeconds = cache.maxAgeSeconds;
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
      throw new Error(`asset table: key ${JSON.stringify(key)} has an invalid max age.`);
    }
    const immutable = cache.immutable;
    if (typeof immutable !== 'boolean') {
      throw new Error(`asset table: key ${JSON.stringify(key)} has a non-boolean immutable flag.`);
    }
    return Object.freeze({
      key,
      bytes,
      mime,
      cache: Object.freeze({ maxAgeSeconds, immutable }),
    });
  });
  const byKey = new Map(frozen.map((row) => [row.key, row] as const));
  return Object.freeze({
    get(key: string): AssetRow | null {
      const row = byKey.get(key);
      return row === undefined ? null : Object.freeze({ ...row, bytes: new Uint8Array(row.bytes) });
    },
  });
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
