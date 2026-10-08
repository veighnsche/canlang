/**
 * Canonical `PresentationContext` construction for page rendering (F2).
 *
 * Both page-dispatch paths (partial + full) build through
 * {@link buildPresentationContext}; no inline literals elsewhere. Field
 * sources: locales from the request `Accept-Language` header (up to 10
 * tags, `;` params stripped, empties dropped), the app default locale
 * and CSRF token from the dispatcher (the token is derived before the
 * call and stays `''` when anonymous, failing POSTs closed), the
 * resolved identity as both `principal` and `invocation` (opaque
 * pass-through), and the dispatcher-bound row-query runner. `theme`
 * stays `DEFAULT_THEME` until a preference store exists, and
 * `currencyScales` stays absent until the lane-2 table is importable —
 * money rendering fails loudly without it rather than guessing.
 */
import { DEFAULT_THEME } from '@canlang/contracts';
import { makeUserRef } from '@canlang/values';
import { createOperationFormPreparer } from './forms.js';
import { systemInterfacesClock } from '../ports.js';
import type { InterfacesClock, SchemaCatalog, SourceFormBindings } from '../ports.js';
import type {
  PageSourceContext,
  PageDeliveryObserver,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
} from '@canlang/contracts';

/** Inputs to {@link buildPresentationContext}, all dispatcher-supplied. */
export interface BuildPresentationContextInput {
  /** Request carrying the `Accept-Language` header. */
  readonly request: Request;
  /** Already-normalized pathname. */
  readonly pathname: string;
  /** From `isPartialRequest` (HTMX header). */
  readonly isPartial: boolean;
  /** Owning app default locale ("en" unless declared). */
  readonly appDefaultLocale: string;
  /** Derived before the call; `''` when anonymous. */
  readonly csrfToken: string;
  /** Resolved identity; also passed through as `invocation`. */
  readonly principal: ResolvedIdentity;
  /** Source facts shared with admission and discovery for this request. */
  readonly source?: PageSourceContext;
  readonly catalog?: SchemaCatalog;
  readonly clock?: InterfacesClock;
  readonly formBindings?: SourceFormBindings;
  readonly appId?: string;
  readonly sessionToken?: string | null;
  /** Row-query runner bound before the call. */
  readonly query: RowQueryRunner;
  readonly observeDelivery?: PageDeliveryObserver;
}

/** Project verified identity facts into the generated page callable contract. */
export function buildPageSourceContext(identity: ResolvedIdentity): PageSourceContext {
  const { actor, team, membership } = identity;
  const active = actor !== null && team !== null && membership !== null
    && membership.status === 'active' && membership.user_id === actor.user_id
    && membership.team_id === team.team_id;
  const builtinRoles = ['public', ...(actor === null ? [] : ['authenticated']),
    ...(active ? ['members', ...(membership.is_owner ? ['owner'] : [])] : [])];
  return Object.freeze({
    actor: actor === null ? null : makeUserRef(actor.user_id),
    actorFacts: actor === null ? null : Object.freeze({ email: actor.email, email_verified: actor.email_verified }),
    team: team === null ? null : Object.freeze({ id: team.team_id, timezone: team.timezone }),
    memberships: Object.freeze(active ? membership.roles.map(grant => grant.role) : []),
    canonical: Object.freeze({ builtinRoles: Object.freeze(builtinRoles) }),
  });
}

/**
 * Parse Accept-Language: split on ',', take up to 10 tags, strip `;`
 * params, drop empties. Invalid tags pass through here; the renderer
 * skips them during locale resolution.
 */
function parseAcceptLanguage(header: string | null): readonly string[] {
  if (header === null) return [];
  return header
    .split(',', 10)
    .map((part) => {
      const semi = part.indexOf(';');
      return (semi === -1 ? part : part.slice(0, semi)).trim();
    })
    .filter((tag) => tag.length > 0);
}

/**
 * Build the presentation context for one page render. Pure: every
 * authority-bearing input (identity, CSRF token, query runner) arrives
 * already resolved; this function only shapes them for the renderer.
 */
export function buildPresentationContext(
  input: BuildPresentationContextInput,
): PresentationContext {
  const source = input.source ?? buildPageSourceContext(input.principal);
  const context: PresentationContext = {
    ...source,
    canonical: input.observeDelivery === undefined ? source.canonical : Object.freeze({
      ...source.canonical, observeDelivery: input.observeDelivery,
    }),
    preferredLocales: parseAcceptLanguage(input.request.headers.get('accept-language')),
    appDefaultLocale: input.appDefaultLocale,
    theme: DEFAULT_THEME,
    path: input.pathname,
    pollUrl: input.pathname + new URL(input.request.url).search,
    isPartial: input.isPartial,
    csrfToken: input.csrfToken,
    // A comparison key for the active browser view, never an authority grant.
    // Only already-client-visible session protection and this caller's own
    // selected identity participate; no email, grants or private records.
    pollContext: JSON.stringify([new URL(input.request.url).origin, input.pathname + new URL(input.request.url).search,
      input.csrfToken, input.principal.actor?.user_id ?? null,
      input.principal.team?.team_id ?? null]),
    principal: input.principal,
    invocation: input.principal,
    query: input.query,
  };
  return input.catalog === undefined ? context : {
    ...context,
    prepareForm: createOperationFormPreparer(context, input.catalog, input.clock ?? systemInterfacesClock,
      input.formBindings === undefined || input.appId === undefined || input.sessionToken == null ? undefined : {
        service: input.formBindings, appId: input.appId, sessionToken: input.sessionToken, identity: input.principal,
      }),
  };
}
