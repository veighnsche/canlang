/**
 * BGI-09 generated-view page/module join: load one view unit's saved
 * module and render a row-bound instance through the UI factory.
 *
 * The caller (page dispatch) evaluates the `show` row argument once and
 * pre-renders the declared canonical controls through the existing
 * factories; this join only admits the saved `render({row, bindings, ui})`
 * export and arranges one instance. Saved modules live under the unit's
 * `can.generated/<id>/` directory; `implementation.js` is the required
 * primary output and an optional `mount` export feeds the browser join.
 * Emission wiring of `show` sites to this join lands with BGI-11; the
 * join itself is final.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGeneratedViewRender } from '@canlang/contracts';
import type {
  GeneratedViewBinding,
  GeneratedViewDescriptor,
  GeneratedViewMount,
  GeneratedViewRender,
  PresentationContext,
  RowView,
} from '@canlang/contracts';
import { generatedViewInstance } from '@canlang/ui';

/** Saved view module shape: required `render`, optional browser `mount`. */
export interface SavedViewModule {
  readonly render: GeneratedViewRender;
  readonly mount?: GeneratedViewMount;
}

/** One instance render request: the evaluated row plus bindings. */
export interface RenderGeneratedViewInput {
  /** Unit directory (`can.generated/<id>/`) holding `implementation.js`. */
  readonly unitDir: string;
  readonly context: PresentationContext;
  readonly descriptor: GeneratedViewDescriptor;
  /** Separate `can-view-m..-f..-s..` identity per `show` use. */
  readonly useId: string;
  /** Row value, evaluated exactly once by the caller. */
  readonly row: RowView;
  /** Pre-rendered canonical controls; refused fields already absent. */
  readonly bindings: ReadonlyArray<GeneratedViewBinding>;
}

/**
 * Admit one unit's saved view module. Anything but a function `render`
 * export refuses; a non-function `mount` export refuses rather than
 * half-loading browser enhancement.
 */
export function assertSavedViewModule(view: string, module: Record<string, unknown>): SavedViewModule {
  assertGeneratedViewRender(view, module['render']);
  const mount = module['mount'];
  if (mount !== undefined && typeof mount !== 'function') {
    throw new Error(`generated view ${JSON.stringify(view)}: saved module exports a non-function mount`);
  }
  return mount === undefined
    ? { render: module['render'] as GeneratedViewRender }
    : { render: module['render'] as GeneratedViewRender, mount: mount as GeneratedViewMount };
}

/** Load and admit `implementation.js` from one unit directory. */
export async function loadSavedViewModule(unitDir: string, view: string): Promise<SavedViewModule> {
  const entry = join(unitDir, 'implementation.js');
  const found = await stat(entry).then(() => true, () => false);
  if (!found) {
    throw new Error(`generated view ${JSON.stringify(view)}: missing saved implementation at ${JSON.stringify(entry)}`);
  }
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (typeof loaded !== 'object' || loaded === null) {
    throw new Error(`generated view ${JSON.stringify(view)}: saved module has no exports`);
  }
  return assertSavedViewModule(view, loaded as Record<string, unknown>);
}

/**
 * Render one row-bound instance: load the saved module, admit its
 * `render`, and arrange the caller's bindings through the UI factory.
 * The saved renderer runs exactly once per call; repeated instances are
 * repeated calls with separate use ids.
 */
export async function renderGeneratedView(input: RenderGeneratedViewInput): Promise<string> {
  const saved = await loadSavedViewModule(input.unitDir, input.descriptor.view);
  return generatedViewInstance({
    context: input.context,
    descriptor: input.descriptor,
    useId: input.useId,
    row: input.row,
    bindings: input.bindings,
    render: saved.render,
  });
}

/** Read one unit's saved scoped CSS, when the unit owns a style. */
export async function readSavedViewStyle(unitDir: string): Promise<string | null> {
  const entry = join(unitDir, 'style.css');
  const found = await stat(entry).then(() => true, () => false);
  if (!found) {
    return null;
  }
  return readFile(entry, 'utf8');
}
