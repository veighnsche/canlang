/** Request-local bridge from checked operation inputs to existing UI controls. */
import type {
  FormMode,
  OperationFormPreparer,
  PresentationContext,
  ResolvedIdentity,
  ClosedInputs,
  MutationRef,
} from '@canlang/contracts';
import { generatedFields, message } from '@canlang/ui';
import { encodeValue, makeRecordRef } from '@canlang/values';
import type { InterfacesClock, SchemaCatalog, SourceFormBindings } from '../ports.js';
import { mintOperationId } from './context.js';
import { OPERATIONS_PREFIX } from './routes.js';
import { parseMutationRef } from '../envelope/refs.js';
import { checkBoundArguments } from '../mcp/schemas.js';

const SUBMIT = message('Submit', { nl: 'Verzenden' });

/** No registry or stored authority: each render gets fresh shell identities. */
export function createOperationFormPreparer(
  context: PresentationContext,
  catalog: SchemaCatalog | undefined,
  clock: InterfacesClock,
  protection?: { readonly service: SourceFormBindings; readonly appId: string;
    readonly sessionToken: string; readonly identity: ResolvedIdentity },
): OperationFormPreparer {
  let occurrence = 0;
  return request => {
    if (Object.hasOwn(request, 'occurrence') && (typeof request.occurrence !== 'string' ||
        !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/.test(request.occurrence))) {
      throw new TypeError('Operation form occurrence must be a nonempty well-formed string.');
    }
    const unavailable = (reason: string) => ({ status: 'unavailable' as const, message: reason });
    const derived = catalog?.derivedFor?.(request.operation);
    if (derived === undefined || derived === null) return unavailable('Operation form is unavailable.');
    if (derived.kind !== 'create' && derived.kind !== 'scenario' && derived.kind !== 'update') {
      return unavailable('This operation has no mutation form.');
    }
    const mode: FormMode = derived.kind;
    const bound: ClosedInputs = Object.create(null) as ClosedInputs;
    for (const [name, value] of Object.entries(request.arguments ?? {})) {
      const input = derived.inputs.find(candidate => candidate.name === name);
      // First protected contract: declared singular versioned records only.
      // Copy identity/version, never the surrounding queried row's fields.
      if (input?.kind !== 'ref' || input.versioned !== true || input.array !== undefined ||
          input.model === undefined || typeof value !== 'object' || value === null || Array.isArray(value) ||
          !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'version')) {
        return unavailable('This form binding is not supported.');
      }
      const row = value as Record<string, unknown>;
      let version: unknown = row['version'];
      try { if (typeof version === 'bigint') version = encodeValue('int', version); }
      catch { return unavailable('This form binding is not supported.'); }
      const parsed = parseMutationRef({ id: row['id'], version }, `/${name}`);
      if ('error' in parsed) return unavailable('This form binding is not supported.');
      bound[name] = encodeValue(input.model, makeRecordRef(input.model, parsed.ref.id, BigInt(parsed.ref.version)));
    }
    const hasBindings = Object.keys(bound).length !== 0;
    if (mode === 'update' && !Object.hasOwn(bound, 'record')) {
      return unavailable('Editing through this form requires a protected record.');
    }
    if (hasBindings && protection === undefined) return unavailable('Protected forms are unavailable.');
    if (checkBoundArguments(derived, bound) !== null) return unavailable('This form binding is not supported.');
    const writable = derived.inputs.filter(input => input.kind !== 'delivery' && !Object.hasOwn(bound, input.name));
    const byName = new Map(writable.map(input => [input.name, input]));
    const selected = request.fields ?? writable.map(input => input.name);
    const selectedNames = new Set(selected);
    if (selectedNames.size !== selected.length || selected.some(name => !byName.has(name))) {
      throw new Error('Operation form fields must be unique checked writable inputs.');
    }
    if (writable.some(input => !selectedNames.has(input.name) && input.required && input.default === undefined)) {
      return unavailable('Operation form omits a required input.');
    }
    const recordValues = mode === 'update' ? request.arguments?.['record'] as Record<string, unknown> : undefined;
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of selected) {
      if (recordValues !== undefined && Object.hasOwn(recordValues, name)) values[name] = recordValues[name];
    }
    const fields = generatedFields({ ...derived, inputs: writable.filter(input => selectedNames.has(input.name)) }, mode, {
      ...(request.labels === undefined ? {} : { labels: request.labels }),
      ...(recordValues === undefined ? {} : { values }),
    });
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
    const idPrefix = request.occurrence === undefined ? `operation-form-${++occurrence}` :
      `operation-form-source-${Array.from(new TextEncoder().encode(request.occurrence), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const timeZone = context.team?.timezone ?? 'UTC';
    const renderedFields = authored === undefined ? fields : authored.map(name => generated.get(name)!);
    const prepared = {
      status: 'ready',
      derived,
      props: {
        context, action: `${OPERATIONS_PREFIX}${encodeURIComponent(derived.operation)}`,
        operation: derived.operation, operationId: mintOperationId(clock.nowMs()), mode, derived,
        timeZone, fields: renderedFields, submit: request.submit ?? SUBMIT,
        display: request.display ?? 'drawer', idPrefix,
        ...(mode === 'update' ? { record: bound['record'] as MutationRef } : {}),
      },
      field: (path: string) => {
        const field = generated.get(path);
        if (field === undefined || !renderedNames.has(path)) throw new Error('Control is outside its prepared operation form.');
        return { context, field, mode, idPrefix, timeZone };
      },
    } as const;
    if (!hasBindings || protection === undefined) return prepared;
    return protection.service.seal({ appId: protection.appId, sessionToken: protection.sessionToken,
      identity: protection.identity, derived, operationId: prepared.props.operationId, nowMs: clock.nowMs(),
      ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }) },
      bound, [...renderedNames]).then(proof => ({
        ...prepared, props: { ...prepared.props, sourceBinding: proof.token, sourceBindingIdentity: proof.identity,
          sourceBindingDraftIdentity: proof.draftIdentity },
      }));
  };
}
