/**
 * C8 settings panel renderer: renderSettingsPanel.
 *
 * Produces the panelHtml consumed by the S2 settings frame in shell.ts: the
 * frame owns the dialog, sidebar and section list; this module renders the
 * active section's panel only. Pure async string builder (no h(), hydration
 * or client state). Props live in the presentation contract.
 *
 * - Base panel: the shared theme/density controls. Theme reuses the
 *   existing themeController factory (imported and called with the caller's
 *   postTo); density is a finite radio pair over the contract ThemeDensity
 *   union POSTing to the same caller path. No endpoint or schema is
 *   invented: targets come from the caller, values from the contract.
 * - Preference panels: caller-declared sections rendered through their
 *   existing self-only save/reset/version path. Controls arrive as trusted
 *   pre-rendered children (the card-children precedent) and are wrapped in
 *   a save form POSTing to the caller's saveTo; reset POSTs to the caller's
 *   resetTo when declared. Sections with omitted controls still render
 *   completely (DESIGN: authors do not need controls to expose declared
 *   preferences) -- the shell, version and save/reset affordances render
 *   with an empty control suite rather than failing.
 *
 * Fail-closed rule (C3 precedent): an unknown active section, a missing
 * POST target, or an undeclared density value throws -- never falls back
 * to a guessed endpoint or default section.
 */

import type {
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
  MessageValue,
  PageChildren,
  PreferenceSection,
  PresentationContext,
  SettingsBaseControls,
  SettingsPanelProps,
  ThemeDensity,
} from "@canlang/contracts";
import { CSRF_FIELD } from "@canlang/contracts";
import { appearanceClasses, type AppearanceOpts } from "./appearance.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { message, resolveCaption } from "./messages.js";
import { themeController } from "./navigation.js";

/** Shared structural captions (ui.settings.*): en source + nl variant. */
const SAVE_LABEL = message("Save", { nl: "Opslaan" });
const RESET_LABEL = message("Reset", { nl: "Opnieuw instellen" });
const VERSION_LABEL = message("Version", { nl: "Versie" });
const COMFORTABLE_LABEL = message("Comfortable", { nl: "Comfortabel" });
const COMPACT_LABEL = message("Compact", { nl: "Compact" });

/** Finite density choices admitted by the contract ThemeDensity union. */
const DENSITIES: ReadonlyArray<{ readonly value: ThemeDensity; readonly label: MessageValue }> = [
  { value: "comfortable", label: COMFORTABLE_LABEL },
  { value: "compact", label: COMPACT_LABEL },
];

/**
 * Collect every appearance key present at runtime (including undeclared
 * extras from JS callers) so appearanceClasses() judges them against the
 * word's admitted matrix: unadmitted tokens throw, never silently drop.
 */
function pickAppearance(props: object): AppearanceOpts {
  const record = props as Record<string, unknown>;
  const opts: {
    tone?: AppearanceTone;
    size?: AppearanceSize;
    variant?: AppearanceVariant;
    orientation?: AppearanceOrientation;
  } = {};
  if (record["tone"] !== undefined) {
    opts.tone = record["tone"] as AppearanceTone;
  }
  if (record["size"] !== undefined) {
    opts.size = record["size"] as AppearanceSize;
  }
  if (record["variant"] !== undefined) {
    opts.variant = record["variant"] as AppearanceVariant;
  }
  if (record["orientation"] !== undefined) {
    opts.orientation = record["orientation"] as AppearanceOrientation;
  }
  return opts;
}

/** Non-empty string guard for section ids and POST targets. */
function requireText(factory: string, field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${factory} needs a non-empty ${field}`);
  }
  return value;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}

/**
 * Await trusted pre-rendered controls. Unlike renderKids elsewhere, an
 * omitted suite renders as empty: DESIGN requires omitted controls to
 * still render completely, so absence is shell-only, not an error. A
 * provided-but-empty suite is a caller contract error and still throws.
 */
async function renderControls(section: string, controls: PageChildren | undefined): Promise<string> {
  if (controls === undefined) {
    return "";
  }
  const kids = typeof controls === "function" ? await controls() : controls;
  if (kids.length === 0) {
    throw new Error(`renderSettingsPanel section ${JSON.stringify(section)} needs a nonempty controls suite`);
  }
  return (await Promise.all(kids)).join("");
}

async function renderBase(base: SettingsBaseControls, context: PresentationContext): Promise<string> {
  requireText("renderSettingsPanel base", "postTo", base.postTo);
  const heading = resolveCaption(base.caption, context);
  if (heading === "") {
    throw new Error("renderSettingsPanel base caption must not be empty");
  }
  if (base.currentDensity !== undefined && base.currentDensity !== "comfortable" && base.currentDensity !== "compact") {
    throw new Error(`renderSettingsPanel unknown density ${JSON.stringify(base.currentDensity)}`);
  }
  const theme = await themeController({
    context,
    label: base.themeLabel,
    postTo: base.postTo,
    themes: base.themes,
    ...(base.currentTheme === undefined ? {} : { current: base.currentTheme }),
  });
  const densityText =
    base.densityLabel === undefined ? null : resolveCaption(base.densityLabel, context);
  if (densityText !== null && densityText === "") {
    throw new Error("renderSettingsPanel density label must not be empty");
  }
  // No default selection: an absent current density leaves all radios
  // unchecked (the theme side behaves the same), never presented as set.
  // A present-but-undeclared value throws above instead.
  const radios = DENSITIES.map(
    (option) =>
      `<label><input type="radio" class="radio" name="density" value="${option.value}"` +
      (option.value === base.currentDensity ? " checked" : "") +
      `>${escapeHtml(resolveCaption(option.label, context))}</label>`,
  ).join("");
  const save = escapeHtml(resolveCaption(SAVE_LABEL, context));
  const reset = escapeHtml(resolveCaption(RESET_LABEL, context));
  const density =
    `<form action="${escapeAttr(safeHref(base.postTo))}" method="post">` +
    hidden(CSRF_FIELD, context.csrfToken) +
    `<fieldset>` +
    (densityText === null ? "" : `<legend>${escapeHtml(densityText)}</legend>`) +
    `<div class="flex flex-col gap-2">${radios}</div></fieldset>` +
    `<div class="flex gap-2"><button type="submit" class="btn btn-primary">${save}</button>` +
    `<button type="reset" class="btn btn-ghost">${reset}</button></div></form>`;
  return `<section><h3>${escapeHtml(heading)}</h3>${theme}${density}</section>`;
}

async function renderPreference(
  section: PreferenceSection,
  context: PresentationContext,
): Promise<string> {
  requireText("renderSettingsPanel", "section id", section.id);
  requireText("renderSettingsPanel", "saveTo", section.saveTo);
  if (section.resetTo !== undefined) {
    requireText("renderSettingsPanel", "resetTo", section.resetTo);
  }
  const heading = resolveCaption(section.caption, context);
  if (heading === "") {
    throw new Error(`renderSettingsPanel section ${JSON.stringify(section.id)} caption must not be empty`);
  }
  const body = await renderControls(section.id, section.controls);
  const save = escapeHtml(resolveCaption(SAVE_LABEL, context));
  const version =
    section.version === undefined
      ? ""
      : `<p>${escapeHtml(resolveCaption(VERSION_LABEL, context))}: ${escapeHtml(section.version)}</p>`;
  const saveForm =
    `<form action="${escapeAttr(safeHref(section.saveTo))}" method="post">` +
    hidden(CSRF_FIELD, context.csrfToken) +
    (section.version === undefined ? "" : hidden("version", section.version)) +
    (body === "" ? "" : `<div>${body}</div>`) +
    `<div class="flex gap-2"><button type="submit" class="btn btn-primary">${save}</button></div></form>`;
  if (section.resetTo === undefined) {
    return `<section><h3>${escapeHtml(heading)}</h3>${version}${saveForm}</section>`;
  }
  const reset = escapeHtml(resolveCaption(RESET_LABEL, context));
  const resetForm =
    `<form action="${escapeAttr(safeHref(section.resetTo))}" method="post">` +
    hidden(CSRF_FIELD, context.csrfToken) +
    `<div class="flex gap-2"><button type="submit" class="btn btn-ghost">${reset}</button></div></form>`;
  return `<section><h3>${escapeHtml(heading)}</h3>${version}${saveForm}${resetForm}</section>`;
}

/**
 * Render the active settings section panel for the S2 frame. The base id
 * (default "base") selects the shared theme/density panel; any other id
 * must match a caller-declared preference section, else the render throws.
 */
export async function renderSettingsPanel(props: SettingsPanelProps): Promise<string> {
  // settings admits no appearance matrix: any runtime appearance key throws.
  appearanceClasses("settings", "settings", pickAppearance(props));
  requireText("renderSettingsPanel", "sectionId", props.sectionId);
  const baseId = props.baseId ?? "base";
  requireText("renderSettingsPanel", "baseId", baseId);
  if (props.sectionId === baseId) {
    if (props.base === undefined) {
      throw new Error("renderSettingsPanel needs base controls for the base section");
    }
    return renderBase(props.base, props.context);
  }
  const section = (props.preferences ?? []).find((candidate) => candidate.id === props.sectionId);
  if (section === undefined) {
    throw new Error(`renderSettingsPanel unknown section ${JSON.stringify(props.sectionId)}`);
  }
  return renderPreference(section, props.context);
}
