/**
 * Identity bundle entry — TEST FIXTURE ONLY, never production.
 *
 * Bundle the public built Identity API and the real fixture store together.
 * Bun's browser target follows installed package exports/imports, including
 * Identity's Worker comparison implementation, and includes dependencies
 * such as @scure/base and cookie. No dependency is replaced or aliased.
 * The loader stages this once; its testing facade re-exports the same store
 * function, preserving a single Identity module instance for the worker.
 */
export * from "@canlang/identity";
export { createMemoryIdentityStore } from "@canlang/identity/testing";
