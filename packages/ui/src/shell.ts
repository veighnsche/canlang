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
  TEAM_FIELD,
} from "../../contracts/src/presentation.js";
import type {
  MessageValue,
  NavigationEntry,
  PageChildren,
  PageDescriptor,
  PresentationContext,
  RenderPageFn,
  ShellData,
} from "../../contracts/src/presentation.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { message, normalizeTag, resolveMessage } from "./messages.js";

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
} as const;

/** Canonical preferred locales, skipping invalid tags. */
function validPreferred(context: PresentationContext): string[] {
  const out: string[] = [];
  for (const tag of context.preferredLocales) {
    try {
      out.push(normalizeTag(tag));
    } catch {
      // Skip invalid viewer preferences; resolution falls through.
    }
  }
  return out;
}

/**
 * Page locale: first valid preferred locale, else the app default. An invalid
 * app default falls back to "en" so the lang attribute is always well-formed.
 */
export function pageLocale(context: PresentationContext): string {
  const preferred = validPreferred(context);
  const first = preferred[0];
  if (first !== undefined) {
    return first;
  }
  try {
    return normalizeTag(context.appDefaultLocale);
  } catch {
    return "en";
  }
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
  const descriptor = typeof value === "string" ? message(value) : value;
  return resolveMessage(descriptor, {
    preferredLocales: validPreferred(context),
    appDefaultLocale: context.appDefaultLocale,
  }).text;
}

function renderEntry(
  entry: NavigationEntry,
  context: PresentationContext,
): string {
  const title = escapeHtml(resolveText(entry.title, context));
  const href = escapeAttr(safeHref(entry.path));
  if (entry.active) {
    return `<li><a href="${href}" class="active" aria-current="page">${title}</a></li>`;
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
    `<div class="can-account dropdown dropdown-top p-4">` +
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
  return (
    `<input id="can-settings" type="checkbox" class="modal-toggle">` +
    `<div class="modal"><div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="can-settings-title">` +
    `<label for="can-settings" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="${closeLabel}">✕</label>` +
    `<h2 id="can-settings-title">${title}</h2>` +
    `<section class="can-settings-sidebar"><ul class="menu">${sections}</ul></section>` +
    `<section class="can-settings-panel">${panel}</section>` +
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
  const body = await renderChildren(children);
  if (context.isPartial) {
    return `<main id="can-main">${body}</main>`;
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
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${headTitle}</title></head>` +
    `<body class="density-${escapeAttr(context.theme.density)}">` +
    `<div class="drawer lg:drawer-open">` +
    `<input id="can-drawer" type="checkbox" class="drawer-toggle">` +
    `<div class="drawer-content">` +
    `<div class="navbar lg:hidden">` +
    `<label for="can-drawer" class="btn btn-square btn-ghost">` +
    `<span class="sr-only">${openMenu}</span>` +
    `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>` +
    `</label></div>` +
    `<main id="can-main">${body}</main>` +
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
    `</body></html>`
  );
};
