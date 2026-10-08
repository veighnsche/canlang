/**
 * Full-page shell renderer (daisyUI drawer + HTMX-boosted navigation).
 *
 * renderPage wraps already-authorized page children in the canonical app
 * chrome: drawer sidebar, account switcher and settings frame. It never
 * dispatches routes, invokes admit, or invents URLs; full pages require the
 * dispatcher-supplied ShellData and fail closed when it is absent.
 */

import {
  CSRF_FIELD,
  PRESESSION_FIELD,
  TEAM_FIELD,
} from "@canlang/contracts";
import type {
  LoginProps,
  MessageValue,
  NavigationEntry,
  PageChildren,
  PageDescriptor,
  PresentationContext,
  RenderPageFn,
  ShellData,
} from "@canlang/contracts";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  message,
  resolveCaption,
} from "./messages.js";

/**
 * Shell chrome wording, en source + nl variants. Seed of the shared runtime
 * catalog: once the catalog lands, these entries move there and the shell
 * resolves them by key instead of holding inline descriptors.
 */
const CHROME = {
  navIncomplete: message("Navigation is temporarily incomplete.", {
    nl: "De navigatie is tijdelijk onvolledig.",
  }),
  openMenu: message("Open menu", { nl: "Menu openen" }),
  closeMenu: message("Close menu", { nl: "Menu sluiten" }),
  account: message("Account", { nl: "Account" }),
  settings: message("Settings", { nl: "Instellingen" }),
  signOut: message("Sign out", { nl: "Afmelden" }),
  signIn: message("Sign in", { nl: "Aanmelden" }),
  close: message("Close", { nl: "Sluiten" }),
  loginUsername: message("Username", { nl: "Gebruikersnaam" }),
  loginPassword: message("Password", { nl: "Wachtwoord" }),
  loginSubmit: message("Sign in", { nl: "Aanmelden" }),
  loginErrorHeading: message("Sign-in failed", { nl: "Aanmelden mislukt" }),
} as const;

/**
 * Page locale: first valid preferred locale, else the app default. An invalid
 * app default falls back to "en" so the lang attribute is always well-formed.
 */
export function pageLocale(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  const first = preferred[0];
  if (first !== undefined) {
    return first;
  }
  return canonicalDefaultTag(context.appDefaultLocale);
}

/** Writing direction for a locale tag; unknown tags fall back to "ltr". */
export function pageDirection(locale: string): string {
  try {
    // textInfo is runtime ES2022+ but missing from this lib's Intl.Locale
    // typing; read it through a structural view and validate the value.
    const view = new Intl.Locale(locale) as Intl.Locale & {
      readonly textInfo?: { readonly direction?: unknown };
    };
    const direction = view.textInfo?.direction;
    return direction === "rtl" || direction === "ltr" ? direction : "ltr";
  } catch {
    return "ltr";
  }
}

function resolveText(value: MessageValue, context: PresentationContext): string {
  return resolveCaption(value, context);
}

function renderEntry(
  entry: NavigationEntry,
  context: PresentationContext,
): string {
  const title = escapeHtml(resolveText(entry.title, context));
  const href = escapeAttr(safeHref(entry.path));
  if (entry.active) {
    return `<li><a href="${href}" class="menu-active" aria-current="page">${title}</a></li>`;
  }
  return `<li><a href="${href}">${title}</a></li>`;
}

function renderAccount(shell: ShellData, context: PresentationContext): string {
  const account = shell.account;
  if (!account.authenticated) {
    const label = escapeHtml(resolveText(CHROME.signIn, context));
    const href = escapeAttr(safeHref(shell.routes.signIn));
    return `<div class="can-account p-4"><a class="btn btn-block" href="${href}">${label}</a></div>`;
  }
  const toggle =
    account.userLabel !== undefined
      ? escapeHtml(account.userLabel)
      : escapeHtml(resolveText(CHROME.account, context));
  const csrfField = escapeAttr(CSRF_FIELD);
  const csrfToken = escapeAttr(context.csrfToken);
  const teamField = escapeAttr(TEAM_FIELD);
  const switchAction = escapeAttr(safeHref(shell.routes.switchTeam));
  const signOutAction = escapeAttr(safeHref(shell.routes.signOut));
  const settingsLabel = escapeHtml(resolveText(CHROME.settings, context));
  const signOutLabel = escapeHtml(resolveText(CHROME.signOut, context));

  const teamItems = account.teams
    .map((team) => {
      const label = escapeHtml(team.label);
      if (
        account.currentTeamId !== undefined &&
        team.id === account.currentTeamId
      ) {
        return `<li><span aria-current="true">${label}</span></li>`;
      }
      const id = escapeAttr(team.id);
      return (
        `<li><form method="POST" action="${switchAction}">` +
        `<input type="hidden" name="${csrfField}" value="${csrfToken}">` +
        `<input type="hidden" name="${teamField}" value="${id}">` +
        `<button type="submit">${label}</button></form></li>`
      );
    })
    .join("");

  return (
    `<div class="can-account dropdown dropdown-top dropdown-end p-4">` +
    `<div tabindex="0" role="button" class="btn btn-block">${toggle}</div>` +
    `<ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box w-64 p-2 shadow">` +
    `<li><label for="can-settings">${settingsLabel}</label></li>` +
    teamItems +
    `<li><form method="POST" action="${signOutAction}">` +
    `<input type="hidden" name="${csrfField}" value="${csrfToken}">` +
    `<button type="submit">${signOutLabel}</button></form></li>` +
    `</ul></div>`
  );
}

function renderSettings(shell: ShellData, context: PresentationContext): string {
  const title = escapeHtml(resolveText(CHROME.settings, context));
  const sections = shell.settings.sections
    .map((section) => {
      const caption = escapeHtml(resolveText(section.caption, context));
      const id = escapeAttr(section.id);
      const current = section.active ? ` aria-current="true"` : "";
      return `<li><button type="button" data-settings-section="${id}"${current}>${caption}</button></li>`;
    })
    .join("");
  // Trust boundary: panelHtml is pre-rendered trusted HTML produced by
  // settings.ts (S6) from canonical descriptors, not from user input; it is
  // passed through verbatim and must never carry raw request data.
  const panel = shell.settings.panelHtml ?? "";
  const closeLabel = escapeAttr(resolveText(CHROME.close, context));
  const activeSection = shell.settings.sections.find(
    (section) => section.active,
  );
  const panelCaption =
    activeSection === undefined ? CHROME.settings : activeSection.caption;
  const panelLabel = ` aria-label="${escapeAttr(resolveText(panelCaption, context))}"`;
  return (
    `<input id="can-settings" type="checkbox" class="modal-toggle">` +
    `<div class="modal"><div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="can-settings-title">` +
    // Plain upstream checkbox-toggle label: no tabindex/role. A focusable
    // label without key handling would add a dead tab stop (and role=button
    // would assert operability this JS-free renderer cannot provide).
    // Keyboard users toggle the native checkbox itself.
    `<label for="can-settings" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="${closeLabel}">✕</label>` +
    `<h2 id="can-settings-title">${title}</h2>` +
    `<section class="can-settings-sidebar"><ul class="menu">${sections}</ul></section>` +
    `<section class="can-settings-panel" role="region"${panelLabel}>${panel}</section>` +
    `</div></div>`
  );
}

async function renderChildren(children: PageChildren): Promise<string> {
  const list = typeof children === "function" ? await children() : children;
  return (await Promise.all(list)).join("");
}

export const renderPage: RenderPageFn = async (
  context: PresentationContext,
  descriptor: PageDescriptor,
  children: PageChildren,
  shell?: ShellData,
): Promise<string> => {
  let pollAttrs = '';
  const contextKey = context.pollContext ?? JSON.stringify([context.pollUrl ?? context.path, context.csrfToken]);
  const contextAttr = descriptor.poll === undefined ? '' : ` data-can-context="${escapeAttr(contextKey)}"`;
  if (descriptor.poll !== undefined) {
    if (typeof descriptor.poll !== 'bigint' || descriptor.poll < 1000n || descriptor.poll > 3600000n || descriptor.poll % 1000n !== 0n) {
      throw new Error('renderPage: poll must be an integer number of seconds between 1s and 1h.');
    }
    const href = context.pollUrl ?? context.path;
    if (!href.startsWith('/') || href.startsWith('//') || /[\\\s\u0000-\u001f\u007f#]/.test(href) ||
        new URL(href, 'https://can.invalid').origin !== 'https://can.invalid' ||
        /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(href.split('?')[0]!)) {
      throw new Error('renderPage: poll requires a same-app page path.');
    }
    pollAttrs = ` data-can-poll data-can-poll-url="${escapeAttr(href)}" data-can-poll-interval="${descriptor.poll / 1000n}" data-can-poll-context="${escapeAttr(contextKey)}"`;
  }
  const body = await renderChildren(children);
  const main = `<main id="can-main"${contextAttr}${pollAttrs}>${body}</main>`;
  if (context.isPartial) {
    return main;
  }
  if (shell === undefined) {
    throw new Error("renderPage: full page render requires shell data");
  }

  const locale = pageLocale(context);
  const direction = pageDirection(locale);
  const title = resolveText(descriptor.title, context);
  const brand = resolveText(shell.brand, context);
  const headTitle =
    brand !== title
      ? `${escapeHtml(title)} — ${escapeHtml(brand)}`
      : escapeHtml(title);
  const theme = `can-${context.theme.mode}-${context.theme.accent}`;
  const metaDescription =
    descriptor.description === undefined
      ? ""
      : `<meta name="description" content="${escapeAttr(resolveText(descriptor.description, context))}">`;

  const groups = shell.navigation.groups
    .map((group) => {
      const caption = escapeHtml(resolveText(group.caption, context));
      const entries = group.entries
        .map((entry) => renderEntry(entry, context))
        .join("");
      return `<div class="menu-title">${caption}</div><ul class="menu">${entries}</ul>`;
    })
    .join("");
  const incomplete = shell.navigation.incomplete
    ? `<p role="status">${escapeHtml(resolveText(CHROME.navIncomplete, context))}</p>`
    : "";

  const openMenu = escapeHtml(resolveText(CHROME.openMenu, context));
  const closeMenu = escapeAttr(resolveText(CHROME.closeMenu, context));

  return (
    `<!DOCTYPE html>` +
    `<html lang="${escapeAttr(locale)}" dir="${escapeAttr(direction)}" data-theme="${escapeAttr(theme)}">` +
    `<head><meta charset="utf-8">` +
    `<link rel="stylesheet" href="/assets/browser/can-style.css">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    metaDescription +
    `<title>${headTitle}</title></head>` +
    `<body class="density-${escapeAttr(context.theme.density)}"${contextAttr}>` +
    `<div class="drawer drawer-end lg:drawer-open">` +
    `<input id="can-drawer" type="checkbox" class="drawer-toggle">` +
    `<div class="drawer-content">` +
    `<div class="navbar lg:hidden">` +
    `<label for="can-drawer" class="btn btn-square btn-ghost">` +
    `<span class="sr-only">${openMenu}</span>` +
    `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>` +
    `</label></div>` +
    main +
    `</div>` +
    `<div class="drawer-side">` +
    `<label for="can-drawer" class="drawer-overlay" aria-label="${closeMenu}"></label>` +
    `<aside class="w-80 min-h-full bg-base-200 flex flex-col">` +
    `<div class="can-brand px-4 py-3 text-lg font-bold">${escapeHtml(brand)}</div>` +
    `<nav class="flex-1 overflow-y-auto" hx-boost="true" hx-target="#can-main" hx-select="#can-main">` +
    groups +
    incomplete +
    `</nav>` +
    renderAccount(shell, context) +
    `</aside></div></div>` +
    renderSettings(shell, context) +
    '<script type="module" src="/assets/browser/bootstrap.js"></script>' +
    `</body></html>`
  );
};

/**
 * Same-app relative-path guard for login POST targets and redirects: exactly
 * one leading "/", no backslash, no whitespace/control characters (header
 * splitting if L6 reflects the value), no encoded separators (proxies may
 * collapse %2f/%5c into "//"), no single-encoded C0/DEL. Anything else fails
 * closed to `fallback`. Double-encoding and decode-then-reflect stay L6's
 * duty at the redirect site.
 */
function sanitizeAppPath(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  if (value.includes("\\")) {
    return fallback;
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }
  if (/%2f|%5c/i.test(value)) {
    return fallback;
  }
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) {
    return fallback;
  }
  return value;
}

/**
 * Canonical login screen: full document with a centered sign-in card. The
 * form POSTs to the dispatcher-supplied signIn route with CSRF plus the
 * dispatcher-supplied pre-session token; lane 05 renders only and never
 * implements an account flow.
 */
export async function renderLogin(props: LoginProps): Promise<string> {
  const context = props.context;
  const locale = pageLocale(context);
  const direction = pageDirection(locale);
  const brand = resolveText(props.brand, context);
  const theme = `can-${context.theme.mode}-${context.theme.accent}`;
  const action = escapeAttr(sanitizeAppPath(props.action, "#"));
  const csrfField = escapeAttr(CSRF_FIELD);
  const csrfToken = escapeAttr(context.csrfToken);
  const preSession =
    props.preSessionToken === undefined
      ? ""
      : `<input type="hidden" name="${escapeAttr(PRESESSION_FIELD)}" value="${escapeAttr(props.preSessionToken)}">`;
  const next = escapeAttr(sanitizeAppPath(props.next, "/"));
  const usernameId = escapeAttr(`${props.idPrefix}-username`);
  const passwordId = escapeAttr(`${props.idPrefix}-password`);
  const usernameLabel = escapeHtml(
    resolveText(CHROME.loginUsername, context),
  );
  const passwordLabel = escapeHtml(
    resolveText(CHROME.loginPassword, context),
  );
  const submitLabel = escapeHtml(resolveText(CHROME.loginSubmit, context));
  const error =
    props.error === undefined
      ? ""
      : `<div role="alert" class="alert alert-error">` +
        `<p>${escapeHtml(resolveText(CHROME.loginErrorHeading, context))}</p>` +
        `<p>${escapeHtml(resolveText(props.error, context))}</p>` +
        `</div>`;

  return (
    `<!DOCTYPE html>` +
    `<html lang="${escapeAttr(locale)}" dir="${escapeAttr(direction)}" data-theme="${escapeAttr(theme)}">` +
    `<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(brand)}</title></head>` +
    `<body class="density-${escapeAttr(context.theme.density)}">` +
    `<main class="hero"><div class="hero-content">` +
    `<section class="card bg-base-100 shadow"><div class="card-body">` +
    `<h1 class="card-title">${escapeHtml(brand)}</h1>` +
    error +
    `<form method="POST" action="${action}">` +
    `<input type="hidden" name="${csrfField}" value="${csrfToken}">` +
    preSession +
    `<fieldset><label for="${usernameId}" class="label">${usernameLabel}</label>` +
    `<input id="${usernameId}" name="username" type="text" autocomplete="username" required autofocus class="input"></fieldset>` +
    `<fieldset><label for="${passwordId}" class="label">${passwordLabel}</label>` +
    `<input id="${passwordId}" name="password" type="password" autocomplete="current-password" required class="input"></fieldset>` +
    `<input type="hidden" name="next" value="${next}">` +
    `<button type="submit" class="btn btn-primary">${submitLabel}</button>` +
    `</form>` +
    `</div></section></div></main>` +
    `</body></html>`
  );
}
