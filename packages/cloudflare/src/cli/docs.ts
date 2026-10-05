/**
 * `can-platform docs`: reference-renderer bridge for `can docs` (D05b).
 *
 * Contract: `can docs` analyzes sources, extracts the frozen reference model
 * v1 (`@canlang/contracts` `ReferenceModel`) and pipes it as JSON through
 * stdin with fixed argv (`docs [--locale=<tag>]`, never a shell). This module
 * reads stdin, resolves the frozen Markdown renderer
 * (`@canlang/interfaces` `renderReferenceMarkdown`, the ONLY locale engine)
 * and writes Markdown to stdout (exit 0).
 *
 * Renderer resolution is a dynamic import by non-literal specifier — the same
 * seam `platform.ts` uses for `@canlang/testkit`, avoiding a static tsc
 * program edge. An unresolvable or drifted renderer is a truthful
 * `missing-renderer` failure, never a second engine and never a silent pass.
 * The workspace dependency that makes it resolvable is `@canlang/interfaces`
 * on this package.
 *
 * Stdout shape differs from the gate commands by design: success is raw
 * Markdown bytes (the reference document), not a JSON envelope. Failures
 * keep the platform envelope on stdout (exit 2) AND a human line on stderr,
 * so both machine callers and `can docs` (which surfaces stderr) stay
 * truthful. Flag-shape errors follow the shared `usage` path in
 * `platform.ts`, which rejects every non-docs flag for this command.
 */

const RENDERER_SPECIFIER: string = "@canlang/interfaces";
const RENDERER_CONTRACT = "renderReferenceMarkdown (ReferenceModel v1 → Markdown)";

/** Stdin cap: reference models are small; anything larger is not one. */
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;

/** Structural seam for the frozen renderer (no static package edge). */
interface ReferenceRenderer {
  renderReferenceMarkdown: (
    model: unknown,
    options?: { readonly locale?: string | null },
  ) => string;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function docsFail(
  code: string,
  detail: string,
  extra?: { producer?: string; contract?: string },
): never {
  process.stderr.write(`can-platform docs: ${detail}\n`);
  emit({
    ok: false,
    command: "docs",
    code,
    detail,
    ...(extra?.producer === undefined ? {} : { producer: extra.producer }),
    ...(extra?.contract === undefined ? {} : { contract: extra.contract }),
  });
  process.exit(2);
}

function missingRenderer(detail: string): never {
  docsFail("missing-renderer", detail, {
    producer: RENDERER_SPECIFIER,
    contract: RENDERER_CONTRACT,
  });
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REFERENCE_BYTES) {
      docsFail(
        "invalid-reference-model",
        `reference model on stdin exceeds ${MAX_REFERENCE_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseReferenceInput(text: string): unknown {
  if (text.trim().length === 0) {
    docsFail(
      "invalid-reference-model",
      "empty reference model on stdin (can docs pipes ReferenceModel v1 JSON)",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    docsFail(
      "invalid-reference-model",
      `reference model on stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadRenderer(): Promise<ReferenceRenderer> {
  let module: Record<string, unknown>;
  try {
    module = (await import(RENDERER_SPECIFIER)) as Record<string, unknown>;
  } catch {
    missingRenderer(
      `reference renderer ${RENDERER_SPECIFIER} is not importable (add the workspace dependency and rebuild)`,
    );
  }
  const render = module["renderReferenceMarkdown"];
  if (typeof render !== "function") {
    missingRenderer(
      `reference renderer ${RENDERER_SPECIFIER} has no renderReferenceMarkdown export (version drift)`,
    );
  }
  return {
    renderReferenceMarkdown: render as ReferenceRenderer["renderReferenceMarkdown"],
  };
}

/**
 * Renders the stdin reference model to stdout Markdown. `locale` null means
 * the model's app default locale (plus source fallback), selected inside the
 * frozen renderer — never here.
 */
export async function runDocs(locale: string | null): Promise<void> {
  const input = await readStdinText();
  const model = parseReferenceInput(input);
  const renderer = await loadRenderer();
  let markdown: string;
  try {
    markdown = renderer.renderReferenceMarkdown(model, locale === null ? {} : { locale });
  } catch (error) {
    docsFail(
      "invalid-reference-model",
      error instanceof Error ? error.message : String(error),
    );
  }
  process.stdout.write(markdown);
}
