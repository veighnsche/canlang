/**
 * UI bundle entry — TEST FIXTURE ONLY, never production.
 *
 * These are the exact public rendering APIs imported by teamtasks-worker.mjs.
 * Bundle them from the built UI export with their real Values, Contracts and
 * installed dependency closure for workerd. No producer or codec is replaced;
 * the fixture's existing presentation and query limitations remain unchanged.
 */
export { card, escapeHtml, renderLogin, text, title } from "@canlang/ui";
