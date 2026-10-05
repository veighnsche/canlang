import { ValueError } from "./errors.js";
import {
  isMessageDescriptor,
  renderMessage,
  type MessageDescriptor,
  type MessageParam,
} from "./icu.js";

/**
 * Whole-message locale fallback (DESIGN L854): RFC 4647 lookup, then
 * app-default lookup, then the source variant, skipping absent variants.
 * Plural/format rules always use the selected variant's locale.
 */

/** Canonicalizes one BCP 47 tag; invalid tags fail. */
export function canonicalLocale(tag: string): string {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new ValueError("invalid-construction", "locale must be a non-empty BCP 47 tag");
  }
  try {
    const canonical = Intl.getCanonicalLocales(tag);
    const first = canonical[0];
    if (first === undefined) {
      throw new ValueError("invalid-construction", `invalid BCP 47 tag: ${tag}`);
    }
    return first;
  } catch (err) {
    if (err instanceof ValueError) throw err;
    throw new ValueError("invalid-construction", `invalid BCP 47 tag: ${tag}`);
  }
}

/** RFC 4647 lookup chain: the tag, then each truncation dropping the last subtag. */
export function lookupChain(tag: string): ReadonlyArray<string> {
  const canonical = canonicalLocale(tag);
  const chain: string[] = [canonical];
  let current = canonical;
  for (;;) {
    const dash = current.lastIndexOf("-");
    if (dash < 0) break;
    current = current.slice(0, dash);
    chain.push(current);
  }
  return Object.freeze(chain);
}

export interface ResolvedVariant {
  /** Selected variant locale: the matched tag, or the source tag on fallback. */
  readonly tag: string;
  readonly text: string;
}

interface Candidate {
  readonly tag: string;
  readonly text: string;
}

/**
 * Resolves one complete message: RFC 4647 lookup over the requested tag
 * (the owning source wording participates under its canonical source tag,
 * since .can authors cannot author a variant repeating it), then lookup
 * over the app default across explicit variants only, then the source
 * variant — skipping null variants throughout. Each lookup range admits a
 * variant on an exact tag or a subtag-boundary prefix (`en` admits `en-US`,
 * never `eng`). Variants admitted by one range prefer an exact tag, then a
 * matching app-default tag, then canonical-tag lexical order. A
 * source-tagged variant is an ordinary variant, so an exact source-tag
 * match wins its range; an explicit source-tagged variant keeps that seat
 * and the implicit source wording is not duplicated.
 */
export function resolveVariant(
  descriptor: MessageDescriptor,
  requested: string,
  appDefault: string,
  sourceLang: string,
): ResolvedVariant {
  if (!isMessageDescriptor(descriptor)) {
    throw new ValueError("invalid-construction", "resolveVariant needs a message descriptor");
  }
  const want = canonicalLocale(requested);
  const fallback = canonicalLocale(appDefault);
  const source = canonicalLocale(sourceLang);
  const available: Candidate[] = [];
  for (const [tag, text] of Object.entries(descriptor.variants)) {
    if (text === null) continue;
    const key = canonicalLocale(tag);
    if (available.some((candidate) => candidate.tag === key)) {
      throw new ValueError("invalid-construction", `duplicate canonical message variant tag: ${key}`);
    }
    available.push({ tag: key, text });
  }
  const rank = (tag: string): readonly [number, number, string] => [
    tag === want ? 0 : 1,
    tag === fallback ? 0 : 1,
    tag,
  ];
  const better = (
    a: readonly [number, number, string],
    b: readonly [number, number, string],
  ): boolean => {
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return a[2] < b[2];
  };
  const search = (
    chain: ReadonlyArray<string>,
    candidates: ReadonlyArray<Candidate>,
  ): Candidate | null => {
    for (const range of chain) {
      let best: Candidate | null = null;
      let bestRank: readonly [number, number, string] | null = null;
      for (const candidate of candidates) {
        if (candidate.tag !== range && !candidate.tag.startsWith(`${range}-`)) continue;
        const current = rank(candidate.tag);
        if (best === null || bestRank === null || better(current, bestRank)) {
          best = candidate;
          bestRank = current;
        }
      }
      if (best !== null) return best;
    }
    return null;
  };
  // The owning source wording joins requested lookup only, under its
  // canonical source tag; an explicit variant already holding that tag wins.
  const requestedCandidates: ReadonlyArray<Candidate> = available.some(
    (candidate) => candidate.tag === source,
  )
    ? available
    : [...available, { tag: source, text: descriptor.source }];
  const requestedMatch = search(lookupChain(want), requestedCandidates);
  if (requestedMatch !== null) {
    return Object.freeze({ tag: requestedMatch.tag, text: requestedMatch.text });
  }
  const defaultMatch = search(lookupChain(fallback), available);
  if (defaultMatch !== null) {
    return Object.freeze({ tag: defaultMatch.tag, text: defaultMatch.text });
  }
  return Object.freeze({ tag: source, text: descriptor.source });
}

export interface FormatMessageOptions {
  /**
   * Explicit target locale; null selects the app default, never the
   * initiating viewer. The key itself is required at this boundary.
   */
  readonly locale: string | null;
  readonly appDefault: string;
  /** Authored source language; pinned "en" unless the owner header says otherwise. */
  readonly sourceLang?: string;
  /** Business/team zone for datetimes; UTC without a team. */
  readonly timeZone?: string;
}

export interface FormattedMessage {
  readonly text: string;
  /** Selected variant locale, retained for delivery/audit freezing. */
  readonly locale: string;
}

/**
 * Localized `format(descriptor, locale=target)` overload: resolves the whole
 * message under RFC 4647 fallback, then renders with the SELECTED variant
 * locale's plural/format rules. Returns final text plus the selected locale.
 */
export function formatMessage(
  descriptor: MessageDescriptor,
  options: FormatMessageOptions,
): FormattedMessage {
  if (!isMessageDescriptor(descriptor)) {
    throw new ValueError("invalid-construction", "formatMessage needs a message descriptor");
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ValueError("invalid-construction", "formatMessage needs an options object");
  }
  if (!Object.hasOwn(options, "locale")) {
    throw new ValueError("invalid-construction", "formatMessage requires an explicit locale=");
  }
  const locale = options.locale;
  if (locale !== null && typeof locale !== "string") {
    throw new ValueError("invalid-construction", "formatMessage locale must be text or null");
  }
  const appDefault = options.appDefault;
  if (typeof appDefault !== "string") {
    throw new ValueError("invalid-construction", "formatMessage appDefault must be text");
  }
  if (options.sourceLang !== undefined && typeof options.sourceLang !== "string") {
    throw new ValueError("invalid-construction", "formatMessage sourceLang must be text");
  }
  const sourceLang = options.sourceLang ?? "en";
  const requested = locale ?? appDefault;
  const resolved = resolveVariant(descriptor, requested, appDefault, sourceLang);
  const params: Readonly<Record<string, MessageParam>> = descriptor.params ?? {};
  const text =
    options.timeZone === undefined
      ? renderMessage(resolved.text, params, resolved.tag)
      : renderMessage(resolved.text, params, resolved.tag, { timeZone: options.timeZone });
  return Object.freeze({ text, locale: resolved.tag });
}
