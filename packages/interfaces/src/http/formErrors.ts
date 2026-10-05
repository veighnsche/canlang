/**
 * B3-I5 deny→re-render: failed operation POSTs answered with the submitted
 * form re-rendered with `errors`/`outcome` instead of bare JSON.
 *
 * The dispatcher (`http/operations.ts`) calls here only when the request
 * asks for HTML (an explicit `text/html` Accept entry or the `HX-Request`
 * header) AND a binding is registered for the operation; every other
 * denial stays bare JSON, so the JSON default is unchanged. Re-render
 * failures must never 500 a POST: unrenderable drafts are dropped
 * per-field (the inline error still explains), and a still-failing render
 * falls back to the JSON denial at the call site.
 *
 * Bindings map operations to their base form props. L7 binds compiled
 * form descriptors here at integration; until then callers register
 * hand-built bindings (demos, tests).
 */
import type {
  BusinessError,
  ClosedInputs,
  FormFieldDef,
  FormMode,
  FormOutcome,
  FormProps,
  MutationRef,
  PresentationContext,
} from '@canlang/contracts';
import type { MessageValue } from '@canlang/contracts';
import { escapeAttr, escapeHtml, form } from '@canlang/ui';
import { httpStatusFor } from '../errors/envelope.js';

/** Base form props for one operation; drafts apply per request on top. */
export interface FormErrorBinding {
  /** Canonical operation name, e.g. `expenses.Expense.create`. */
  readonly operation: string;
  /** POST target the form submits to. */
  readonly action: string;
  readonly mode: FormMode;
  /** Field defs WITHOUT values; request drafts fill `value` per render. */
  readonly fields: ReadonlyArray<FormFieldDef>;
  readonly submit: MessageValue;
  readonly cancelHref?: string;
  /** Caller-unique prefix for input ids (also anchors the fragment wrap). */
  readonly idPrefix: string;
  /** Resolved rendering timezone. */
  readonly timeZone: string;
}

const bindings = new Map<string, FormErrorBinding>();

/** Register (or replace) the re-render binding for one operation. */
export function registerFormBinding(binding: FormErrorBinding): void {
  bindings.set(binding.operation, binding);
}

/** Look up the re-render binding for one operation, if any. */
export function formBindingFor(operation: string): FormErrorBinding | undefined {
  return bindings.get(operation);
}

/** Drop all bindings. Test-only: keeps the module registry hermetic. */
export function clearFormBindings(): void {
  bindings.clear();
}

/**
 * True when the request asks for an HTML answer: an explicit `text/html`
 * Accept entry (media-type match, case-insensitive) or the `HX-Request`
 * header. `* / *`, `application/json` and absent Accept stay JSON — the
 * default is unchanged unless HTML is asked for.
 */
export function wantsHtmlRerender(request: Request): boolean {
  if (request.headers.has('HX-Request')) return true;
  const accept = request.headers.get('accept');
  if (accept === null) return false;
  return accept
    .split(',')
    .some((entry) => entry.split(';')[0]?.trim().toLowerCase() === 'text/html');
}

/** Plain-object check for draft subtrees (`changes`, `record`). */
function isRecord(value: unknown): value is ClosedInputs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply submitted drafts onto field defs verbatim. Create/scenario modes
 * read `drafts[path]`; update mode reads `drafts.changes[path]`. Absent
 * keys and explicit `undefined` keep the binding value; anything present
 * (even wrong-typed) is passed through — the resilient render below
 * drops values the widgets reject.
 */
export function applyDrafts(
  fields: ReadonlyArray<FormFieldDef>,
  mode: FormMode,
  drafts: ClosedInputs,
): FormFieldDef[] {
  const changes = drafts['changes'];
  const source: ClosedInputs =
    mode === 'update' && isRecord(changes) ? changes : drafts;
  return fields.map((field) => {
    if (!Object.prototype.hasOwnProperty.call(source, field.path)) return field;
    const value = source[field.path];
    if (value === undefined) return field;
    return { ...field, value };
  });
}

/** Map a denial to the re-rendered form's outcome banner. */
export function errorOutcome(error: BusinessError): FormOutcome {
  return { status: 'failed', error };
}

/** Extract the bound record for update re-renders, if well-shaped. */
function draftRecord(drafts: ClosedInputs): MutationRef | undefined {
  const record = drafts['record'];
  if (!isRecord(record)) return undefined;
  const id = record['id'];
  const version = record['version'];
  if (typeof id !== 'string' || typeof version !== 'string') return undefined;
  return { id, version };
}

/**
 * Field path from a widget value throw (`field "path": ...`), or null
 * when the throw is not a per-field value rejection.
 */
function fieldPathFromThrow(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  return /^field "([^"]+)":/.exec(message)?.[1] ?? null;
}

function stripValue(field: FormFieldDef): FormFieldDef {
  if (!('value' in field)) return field;
  const { value: _dropped, ...rest } = field;
  void _dropped;
  return rest;
}

/**
 * Render through `form()`, dropping one draft per retry when a widget
 * rejects its value. Each retry drops a distinct field, so this always
 * terminates; non-field throws propagate to the JSON fallback.
 */
async function renderResilient(props: FormProps): Promise<string> {
  let current = props;
  const dropped = new Set<string>();
  for (let attempt = 0; attempt <= props.fields.length; attempt += 1) {
    try {
      return await form(current);
    } catch (err) {
      const path = fieldPathFromThrow(err);
      if (path === null || dropped.has(path)) throw err;
      dropped.add(path);
      current = {
        ...current,
        fields: current.fields.map((field) => (field.path === path ? stripValue(field) : field)),
      };
    }
  }
  throw new Error('renderResilient: exhausted field retries');
}

/** Inputs to {@link renderFormError}, all dispatcher-supplied. */
export interface RenderFormErrorInput {
  readonly error: BusinessError;
  /** Business inputs of the failed envelope (`_csrf` already stripped). */
  readonly draftInputs: ClosedInputs;
  /** Idempotency key carried for the retry (may be `''` when missing). */
  readonly operationId: string;
  readonly binding: FormErrorBinding;
  readonly context: PresentationContext;
  /** True for `HX-Request` partials: bare fragment, no document shell. */
  readonly fragment: boolean;
}

/** Rendered denial: HTML plus the error's canonical status. */
export interface RenderedFormError {
  readonly html: string;
  readonly status: number;
}

/**
 * Re-render the failed POST's form with per-field `errors` plus the
 * `failed` outcome banner. Full-page callers get a minimal document;
 * fragment callers get the form in a stable `#<idPrefix>-form` swap
 * target. Throws only when no form can render (caller falls back to
 * JSON); per-field draft failures degrade inside.
 */
export async function renderFormError(input: RenderFormErrorInput): Promise<RenderedFormError> {
  const { binding } = input;
  const record = binding.mode === 'update' ? draftRecord(input.draftInputs) : undefined;
  const props: FormProps = {
    context: input.context,
    action: binding.action,
    operation: binding.operation,
    operationId: input.operationId,
    mode: binding.mode,
    ...(record === undefined ? {} : { record }),
    timeZone: binding.timeZone,
    fields: applyDrafts(binding.fields, binding.mode, input.draftInputs),
    ...(input.error.fields === undefined ? {} : { errors: input.error.fields }),
    outcome: errorOutcome(input.error),
    submit: binding.submit,
    ...(binding.cancelHref === undefined ? {} : { cancelHref: binding.cancelHref }),
    idPrefix: binding.idPrefix,
  };
  const rendered = await renderResilient(props);
  if (input.fragment) {
    return {
      html: `<div id="${escapeAttr(`${binding.idPrefix}-form`)}">${rendered}</div>`,
      status: httpStatusFor(input.error.code),
    };
  }
  return {
    html:
      `<!DOCTYPE html><html lang="${escapeAttr(input.context.appDefaultLocale)}">` +
      `<head><meta charset="utf-8"><title>${escapeHtml(input.error.message)}</title></head>` +
      `<body><main>${rendered}</main></body></html>`,
    status: httpStatusFor(input.error.code),
  };
}
