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
  MessageValue,
  PageChildren,
  PageDescriptor,
  PreferenceSection,
  PresentationContext,
  SettingsBaseControls,
  SettingsPanelProps,
  ShellData,
  ThemeDensity,
} from "@canlang/contracts";
import { CSRF_FIELD } from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";
import { pickAppearance } from "./internal/appearance-props.js";
import { escapeAttr, escapeHtml, operationPostPath } from "./escape.js";
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
  const postTo = operationPostPath(base.postTo);
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
    `<form action="${escapeAttr(postTo)}" method="post">` +
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
  const saveTo = operationPostPath(section.saveTo);
  const resetTo = section.resetTo === undefined ? undefined : operationPostPath(section.resetTo);
  const body = await renderControls(section.id, section.controls);
  const save = escapeHtml(resolveCaption(SAVE_LABEL, context));
  const version =
    section.version === undefined
      ? ""
      : `<p>${escapeHtml(resolveCaption(VERSION_LABEL, context))}: ${escapeHtml(section.version)}</p>`;
  const saveForm =
    `<form action="${escapeAttr(saveTo)}" method="post">` +
    hidden(CSRF_FIELD, context.csrfToken) +
    (section.version === undefined ? "" : hidden("version", section.version)) +
    (body === "" ? "" : `<div>${body}</div>`) +
    `<div class="flex gap-2"><button type="submit" class="btn btn-primary">${save}</button></div></form>`;
  if (section.resetTo === undefined) {
    return `<section><h3>${escapeHtml(heading)}</h3>${version}${saveForm}</section>`;
  }
  const reset = escapeHtml(resolveCaption(RESET_LABEL, context));
  const resetForm =
    `<form action="${escapeAttr(resetTo!)}" method="post">` +
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

/** Source-owned enum selectors use the existing independently versioned page save. */
export function renderEnumPreferenceSettings(props: {
  readonly context: PresentationContext;
  readonly owner: string;
  readonly caption: MessageValue;
  readonly fields: NonNullable<PageDescriptor['preferenceFields']>;
  readonly postTo: string;
}): ShellData['settings'] {
  // Reference preference leaves carry no save control (storage accepts
  // enum cases only): they keep their filter defaults but no settings
  // panel entry.
  const fields = props.fields.filter(field => field.reference !== true && field.scalarType === undefined);
  if (fields.length === 0) return { sections: [] };
  requireText('renderEnumPreferenceSettings', 'owner', props.owner);
  requireText('renderEnumPreferenceSettings', 'postTo', props.postTo);
  const { context } = props;
  const text = (value: MessageValue) => escapeHtml(resolveCaption(value, context));
  const target = escapeAttr(operationPostPath(props.postTo));
  const panels = fields.map(field => {
    const value = context.preferences?.[props.owner]?.[field.name] ?? null;
    const version = context.preferenceVersions?.[props.owner]?.[field.name] ?? '0';
    const common = hidden(CSRF_FIELD, context.csrfToken) + hidden('_version', version);
    const options = field.options.map(option => `<option value="${escapeAttr(option)}"${option === value ? ' selected' : ''}>${text(field.optionLabels?.[option] ?? option)}</option>`).join('');
    const select = `<label class="fieldset-label">${text(field.caption ?? field.name)}<select class="select w-full" name="${escapeAttr(field.name)}">${value === null ? '<option value="" selected disabled></option>' : ''}${options}</select></label>`;
    const save = `<form action="${target}" method="post" class="can-form" data-can-preference-form="save">${common}${select}<button type="submit" class="btn btn-primary">${text(SAVE_LABEL)}</button></form>`;
    // Storage currently accepts enum cases only; null reset needs its owning lifecycle.
    const reset = field.defaultValue === null ? '' : `<form action="${target}" method="post" class="can-form" data-can-preference-form="reset">${common}${hidden(field.name, field.defaultValue)}<button type="submit" class="btn btn-ghost">${text(RESET_LABEL)}</button></form>`;
    return `<fieldset class="fieldset flex flex-col gap-2" data-can-preference-field="${escapeAttr(field.name)}">${save}${reset}<p role="alert" data-can-preference-error></p></fieldset>`;
  }).join('');
  return {
    sections: [{ id: props.owner, caption: props.caption, active: true }],
    panelHtml: `<section class="flex flex-col gap-4"><h3>${text(props.caption)}</h3>${panels}<button type="button" class="btn btn-ghost" data-can-preference-cancel>${text(message('Cancel', { nl: 'Annuleren' }))}</button></section>`,
  };
}
