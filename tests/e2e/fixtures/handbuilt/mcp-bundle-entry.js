/**
 * MCP bundle entry — TEST FIXTURE ONLY, never production.
 *
 * The ONE import seam the e2e loader bundles (`bun build --target=browser
 * --format=esm`, see `../artifact-loader.ts`) into the `vendor/mcp/bundle.js`
 * workerd module. Every export is a REAL producer function from a built dist:
 *
 * - `createMcpHandler`: the real S5 MCP protocol server
 *   (`packages/interfaces/dist`, from `interfaces/src/mcp/server.ts`),
 *   with its real closure (SDK server + Streamable-HTTP transport,
 *   discovery, schemas, envelope validation, safe-error projection).
 * - `createArtifactRegistry` / `createArtifactCatalog`: the real P2
 *   artifact adapters (`packages/cloudflare/dist`, from
 *   `cloudflare/src/runtime/mcp-registry.ts`).
 *
 * Everything (including `@canlang/contracts`, `@canlang/identity`, the MCP
 * SDK, zod, ajv, and content-type) bundles into one self-contained ESM file
 * because two transitive SDK deps (ajv, content-type) ship CJS only and
 * cannot load as workerd ESModules. Duplicating the identity code beside the
 * worker's `vendor/identity` tree is safe: the identity store object is
 * created once by the worker and passed through `McpDeps.identity.store`,
 * and every `instanceof IdentityError` check runs inside the copy that
 * threw it. No producer is stubbed: a missing dist or dependency fails the
 * bundle build loud in the loader, naming the fix.
 */
export { createMcpHandler } from "@canlang/interfaces/mcp/server";
export {
  createArtifactCatalog,
  createArtifactRegistry,
} from "@canlang/cloudflare/runtime/mcp-registry";
