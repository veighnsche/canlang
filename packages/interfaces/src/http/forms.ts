/** Request-local bridge from checked operation inputs to existing UI controls. */
import type {
  FormMode,
  OperationFormPreparer,
  PresentationContext,
} from '@canlang/contracts';
import { generatedFields, message } from '@canlang/ui';
import type { InterfacesClock, SchemaCatalog } from '../ports.js';
import { mintOperationId } from './context.js';
import { OPERATIONS_PREFIX } from './routes.js';

const SUBMIT = message('Submit', { nl: 'Verzenden' });

/** No registry or stored authority: each render gets fresh shell identities. */
export function createOperationFormPreparer(
  context: PresentationContext,
  catalog: SchemaCatalog | undefined,
  clock: InterfacesClock,
): OperationFormPreparer {
  let occurrence = 0;
  return request => {
    const unavailable = (reason: string) => ({ status: 'unavailable' as const, message: reason });
    const derived = catalog?.derivedFor?.(request.operation);
    if (derived === undefined || derived === null) return unavailable('Operation form is unavailable.');
    if (request.arguments !== undefined && Object.keys(request.arguments).length !== 0) {
      return unavailable('Bound forms are not available yet.');
    }
    if (derived.kind === 'update') return unavailable('Editing through this form is not available yet.');
    if (derived.kind !== 'create' && derived.kind !== 'scenario') {
      return unavailable('This operation has no mutation form.');
    }
    const mode: FormMode = derived.kind;
    const writable = derived.inputs.filter(input => input.kind !== 'delivery');
    const byName = new Map(writable.map(input => [input.name, input]));
    const selected = request.fields ?? writable.map(input => input.name);
    const selectedNames = new Set(selected);
    if (selectedNames.size !== selected.length || selected.some(name => !byName.has(name))) {
      throw new Error('Operation form fields must be unique checked writable inputs.');
    }
    if (writable.some(input => !selectedNames.has(input.name) && input.required && input.default === undefined)) {
      return unavailable('Operation form omits a required input.');
    }
    const fields = generatedFields({ ...derived, inputs: writable.filter(input => selectedNames.has(input.name)) }, mode,
      request.labels === undefined ? {} : { labels: request.labels });
    const generated = new Map(fields.map(field => [field.path, field]));
    const authored = request.authoredFields;
    if (authored !== undefined && (new Set(authored).size !== authored.length || authored.some(name => !selectedNames.has(name)))) {
      throw new Error('Authored form controls must be unique selected writable inputs.');
    }
    if (authored !== undefined && fields.some(field => !selectedNames.has(field.path))) {
      return unavailable("This form's field types are not supported yet.");
    }
    const renderedNames = authored === undefined ? selectedNames : new Set(authored);
    if (writable.some(input => selectedNames.has(input.name) && !renderedNames.has(input.name) && input.required && input.default === undefined)) {
      return unavailable('Authored form omits a required control.');
    }
    const idPrefix = `operation-form-${++occurrence}`;
    const timeZone = context.team?.timezone ?? 'UTC';
    const renderedFields = authored === undefined ? fields : authored.map(name => generated.get(name)!);
    return {
      status: 'ready',
      derived,
      props: {
        context, action: `${OPERATIONS_PREFIX}${encodeURIComponent(derived.operation)}`,
        operation: derived.operation, operationId: mintOperationId(clock.nowMs()), mode,
        timeZone, fields: renderedFields, submit: request.submit ?? SUBMIT,
        display: request.display ?? 'drawer', idPrefix,
      },
      field: path => {
        const field = generated.get(path);
        if (field === undefined || !renderedNames.has(path)) throw new Error('Control is outside its prepared operation form.');
        return { context, field, mode, idPrefix, timeZone };
      },
    };
  };
}
