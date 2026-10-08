/**
 * @canlang/ui public surface for generated code.
 *
 * Generated app JS calls these canonical factories with props/children; the
 * library owns markup/classes and behavior. S1 ships escaping and messages;
 * S2 adds navigation discovery and the page shell; components, forms,
 * collections, htmx, settings and review land in later slices on this surface.
 */
export { csvFormulaProtect, escapeAttr, escapeHtml, isSafeUrl, isolate, safeHref, } from "./escape.js";
export { canonicalDefaultTag, canonicalPreferredTags, formatDecimalExact, formatIntExact, formatMessage, formatMoneyExact, formatScalar, isEnumTypeId, localeNumberSystem, localeSeparators, message, normalizeTag, resolveCaption, resolveMessage, selectPluralCategory, } from "./messages.js";
export { breadcrumbs, buildNavigation, button, dock, megamenu, menu, navbar, pagination, selectDiscoveryCandidates, themeController, } from "./navigation.js";
export { pageDirection, pageLocale, renderLogin, renderPage, } from "./shell.js";
export { card, content, renderState, renderTextValue, rowHeading, text, title, } from "./components.js";
export { board, collectionExportLink, collectionPagination, collectionPrintLink, collectionShareControls, collectionToolbar, controlHref, csvImport, list, table, } from "./collections.js";
export { assertRegionId, fragmentRegion, hxAttrs, pollTrigger, refreshTrigger, staleMarker, validationStatusSwaps, } from "./htmx.js";
export { appearanceClasses } from "./appearance.js";
export { badge, countdown, divider, kbd, link, mockupBrowser, mockupCode, mockupPhone, mockupWindow, status, } from "./leaves.js";
export { avatar, progress, radialProgress, textRotate, } from "./media.js";
export { calendar, checkbox, fileControl, fileInput, filter, input, label, otp, radio, range, rating, select, textarea, toggle, validator, } from "./controls.js";
export { accordion, carousel, collapse, diff, fieldset, footer, hero, join, stack, stat, steps, timeline, } from "./groups.js";
export { alert, aura, chatBubble, drawer, dropdown, fab, hover3d, hoverGallery, indicator, mask, modal, swap, toast, tooltip, } from "./overlays.js";
export { review } from "./review.js";
export { copy, history, tabs } from "./panels.js";
export { renderSettingsPanel } from "./settings.js";
export { action, actions, assertFieldPath, deleteRecord, edit, fieldErrorOutletId, fieldInputId, fieldInputName, form, formatDatetimeLocal, formFragmentWrap, generatedDraftValues, generatedFields, generatedForm, pointerToFieldName, projectGeneratedInputs, } from "./forms.js";
export { applyDocumentRerender, applyFormRerender, collectFormValues, GeneratedSubmitError, submitGeneratedForm, } from "./client.js";
export { LANE05_CATALOG_VERSION, UI_CATALOG } from "./catalog.js";
export { CSRF_FIELD, DEFAULT_THEME, PRESENTATION_CONTRACT_VERSION, TEAM_FIELD, } from "@canlang/contracts";
export { CSV_CSRF_HEADER, CSV_UI_MAX_ROWS, csvReviewForm, digestBusinessError, parseCsvText, } from "./csv/parse.js";
export { csvPreviewSection, parseReviewPayload, submitCsvReview, } from "./csv/preview.js";
export { collectCommitSelections, csvConfirmSection, mintOperationId, parseCommitPayload, submitCsvCommit, } from "./csv/confirm.js";
export { policyPage } from "./policyPage.js";
//# sourceMappingURL=index.js.map