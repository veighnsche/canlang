/**
 * Output escaping for server-rendered HTML. Every dynamic string reaching
 * markup, attributes or URLs passes through these sinks. All functions fail
 * closed on non-string input.
 */

const HTML_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
}

/** Escape text content and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  assertString(value, "escapeHtml");
  return value.replace(/[&<>"']/g, (ch) => HTML_REPLACEMENTS[ch] as string);
}

/**
 * Escape a double-quoted attribute value. Same entity set as escapeHtml;
 * kept separate so call sites document their sink.
 */
export function escapeAttr(value: string): string {
  assertString(value, "escapeAttr");
  return value.replace(/[&<>"']/g, (ch) => HTML_REPLACEMENTS[ch] as string);
}

/**
 * True for URLs safe to emit in href/src: relative references, fragments,
 * http(s) and mailto. Rejects javascript:, data:, vbscript:, file: and
 * scheme-smuggling tricks (case, whitespace, control characters). The caller
 * still escapes the accepted value for its sink.
 */
export function isSafeUrl(value: string): boolean {
  assertString(value, "isSafeUrl");
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  // Strip ASCII control characters before scheme inspection so embedded
  // tab/newline cannot hide a dangerous scheme.
  const compact = trimmed.replace(/[\u0000-\u001F\u007F]/g, "").toLowerCase();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  if (schemeMatch === null) {
    // Relative reference or fragment. A leading backslash pair can coerce to
    // an absolute URL in some browsers; reject it.
    return !compact.startsWith("\\\\");
  }
  const scheme = schemeMatch[1] as string;
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

/** Return the URL when safe, otherwise the fallback (default "#"). */
export function safeHref(value: string, fallback = "#"): string {
  assertString(value, "safeHref");
  assertString(fallback, "safeHref fallback");
  return isSafeUrl(value) ? value : fallback;
}

/**
 * Spreadsheet-formula protection for CSV export cells: prefix cells starting
 * with = + - @ or whitespace/control C0 with a single quote, per the shared
 * export contract. Never evaluates input.
 */
export function csvFormulaProtect(cell: string): string {
  assertString(cell, "csvFormulaProtect");
  if (/^[=+\-@\s\u0000-\u001F\u007F]/.test(cell)) {
    return `'${cell}`;
  }
  return cell;
}

/**
 * Bidirectional isolation for interpolated display values, per W3C direction
 * guidance. Components wrap interpolated values so mixed-direction text
 * cannot reorder surrounding markup.
 */
export function isolate(value: string): string {
  assertString(value, "isolate");
  return `\u2068${value}\u2069`;
}
