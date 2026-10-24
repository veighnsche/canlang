/** Request-local bridge from checked operation inputs to existing UI controls. */
import type {
  DerivedOperationInputs,
  FormMode,
  OperationFormPreparer,
  PresentationContext,
  ResolvedIdentity,
  ClosedInputs,
  MutationRef,
} from '@canlang/contracts';
import { isGeneratedFormKind } from '@canlang/contracts';
import { generatedFields, message } from '@canlang/ui';
import { encodeValue, makeRecordRef } from '@canlang/values';
import type { InterfacesClock, SchemaCatalog, SourceFormBindings } from '../ports.js';
import { mintOperationId } from './context.js';
import { OPERATIONS_PREFIX } from './routes.js';
import { parseMutationRef } from '../envelope/refs.js';
import { checkBoundArguments } from '../mcp/schemas.js';

const SUBMIT = message('Submit', { nl: 'Verzenden' });

type FormPrepareRequest = Parameters<OperationFormPreparer>[0];

function checkFormOccurrence(request: FormPrepareRequest): void {
  if (Object.hasOwn(request, 'occurrence') && (typeof request.occurrence !== 'string' ||
      !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/.test(request.occurrence))) {
    throw new TypeError('Operation form occurrence must be a nonempty well-formed string.');
  }
}

function checkBoundForm(
  mode: FormMode,
  bound: ClosedInputs,
  hasBindings: boolean,
  protection: { readonly service: SourceFormBindings } | undefined,
  derived: DerivedOperationInputs,
): string | null {
  if (mode === 'update' && !Object.hasOwn(bound, 'record')) {
    return 'Editing through this form requires a protected record.';
  }
  if (hasBindings && protection === undefined) return 'Protected forms are unavailable.';
  if (checkBoundArguments(derived, bound) !== null) return 'This form binding is not supported.';
  return null;
}

function selectRecordValues(
  mode: FormMode,
  request: FormPrepareRequest,
  selected: readonly string[],
): { recordValues: Record<string, unknown> | undefined; values: Record<string, unknown> } {
  const recordValues = mode === 'update' ? request.arguments?.['record'] as Record<string, unknown> : undefined;
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of selected) {
    if (recordValues !== undefined && Object.hasOwn(recordValues, name)) values[name] = recordValues[name];
  }
  return { recordValues, values };
}

function finishOperationPreparation<Field extends { readonly path: string }>(
  context: PresentationContext,
  clock: InterfacesClock,
  protection: { readonly service: SourceFormBindings; readonly appId: string;
    readonly sessionToken: string; readonly identity: ResolvedIdentity } | undefined,
  derived: DerivedOperationInputs,
  mode: FormMode,
  bound: ClosedInputs,
  renderedFields: Field[],
  generated: ReadonlyMap<string, Field>,
  request: FormPrepareRequest,
  idPrefix: string,
  timeZone: string,
  labelNames: ReadonlySet<string>,
  validatorNames: ReadonlySet<string>,
  authored: string[] | undefined,
  authoredLabels: readonly string[] | undefined,
  authoredValidators: readonly string[] | undefined,
  renderedNames: ReadonlySet<string>,
  hasBindings: boolean,
) {
  const props = {
    context, action: `${OPERATIONS_PREFIX}${encodeURIComponent(derived.operation)}`,
    operation: derived.operation, operationId: mintOperationId(clock.nowMs()), mode, derived,
    timeZone, fields: renderedFields, submit: request.submit ?? SUBMIT,
    ...(request.controlLabel === undefined ? {} : { controlLabel: request.controlLabel }),
    ...(request.authoredSubmit === undefined ? {} : { authoredSubmit: request.authoredSubmit }),
    ...(authored === undefined ? {} : { authoredFields: authored }),
    ...(authoredLabels === undefined ? {} : { authoredLabels }),
    ...(authoredValidators === undefined ? {} : { authoredValidators }),
    display: request.display ?? 'drawer', idPrefix,
    ...(mode === 'update' ? { record: bound['record'] as MutationRef } : {}),
  };
  const prepared = {
    status: 'ready',
    derived,
    props,
    field: (path: string) => {
      const field = generated.get(path);
      if (field === undefined || !renderedNames.has(path)) throw new Error('Control is outside its prepared operation form.');
      return { context, field, mode, idPrefix, timeZone,
        ...(labelNames.has(path) ? { authoredLabel: true } : {}),
        ...(validatorNames.has(path) ? { authoredValidator: true } : {}),
      };
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
}

function bindOperationRefs(
  derived: DerivedOperationInputs,
  args: FormPrepareRequest['arguments'],
): ClosedInputs | null {
  const bound: ClosedInputs = Object.create(null) as ClosedInputs;
  for (const [name, value] of Object.entries(args ?? {})) {
    const input = derived.inputs.find(candidate => candidate.name === name);
    // Bind declared singular records only, retaining the observed version
    // even when the operation also accepts unversioned linkage inputs.
    // Copy identity/version, never the surrounding queried row's fields.
    if (input?.kind !== 'ref' || input.array !== undefined ||
        input.model === undefined || typeof value !== 'object' || value === null || Array.isArray(value) ||
        !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'version')) {
      return null;
    }
    const row = value as Record<string, unknown>;
    let version: unknown = row['version'];
    try { if (typeof version === 'bigint') version = encodeValue('int', version); }
    catch { return null; }
    const parsed = parseMutationRef({ id: row['id'], version }, `/${name}`);
    if ('error' in parsed) return null;
    bound[name] = encodeValue(input.model, makeRecordRef(input.model, parsed.ref.id, BigInt(parsed.ref.version)));
  }
  return bound;
}

function selectOperationFields(
  derived: DerivedOperationInputs,
  bound: ClosedInputs,
  fields: FormPrepareRequest['fields'],
): {
  writable: DerivedOperationInputs['inputs']; selected: readonly string[]; selectedNames: Set<string>;
} | { reason: string } {
  const writable = derived.inputs.filter(input => input.kind !== 'delivery' && !Object.hasOwn(bound, input.name));
  const byName = new Map(writable.map(input => [input.name, input]));
  const selected = fields ?? writable.map(input => input.name);
  const selectedNames = new Set(selected);
  if (selectedNames.size !== selected.length || selected.some(name => !byName.has(name))) {
    throw new Error('Operation form fields must be unique checked writable inputs.');
  }
  if (writable.some(input => !selectedNames.has(input.name) && input.required && input.default === undefined)) {
    return { reason: 'Operation form omits a required input.' };
  }
  return { writable, selected, selectedNames };
}

function placeOperationAuthored<Field extends { readonly path: string }>(
  request: FormPrepareRequest,
  fields: Field[],
  generated: ReadonlyMap<string, Field>,
  selectedNames: ReadonlySet<string>,
  writable: readonly { readonly name: string; readonly nullable?: boolean }[],
): {
  authoredLabels: readonly string[] | undefined;
  authoredValidators: readonly string[] | undefined;
  labelNames: ReadonlySet<string>;
  validatorNames: ReadonlySet<string>;
  authored: string[] | undefined;
  renderedFields: Field[];
} | { reason: string } {
  const placements = (paths: readonly string[] | undefined, kind: string): readonly string[] | undefined => {
    if (paths === undefined) return undefined;
    if (!Array.isArray(paths) || new Set(paths).size !== paths.length || paths.some(path => !selectedNames.has(path))) {
      throw new Error(`Authored form ${kind} must be unique selected writable inputs.`);
    }
    return Object.freeze([...paths]);
  };
  const authoredLabels = placements(request.authoredLabels, 'labels');
  const authoredValidators = placements(request.authoredValidators, 'validators');
  const labelNames = new Set(authoredLabels);
  const validatorNames = new Set(authoredValidators);
  const authored = request.authoredFields === undefined
    ? (authoredLabels === undefined && authoredValidators === undefined ? undefined : [])
    : [...request.authoredFields];
  if (authored !== undefined && (new Set(authored).size !== authored.length || authored.some(name => !selectedNames.has(name)))) {
    throw new Error('Authored form controls must be unique selected writable inputs.');
  }
  // An authored scalar may omit its optional explicit-null checkbox.
  // Other companions must accompany their base. Unplaced generated inputs
  // retain their complete existing companion set in the automatic remainder.
  const authoredNames = new Set(authored);
  const authoredCompanion = (path: string) => authored?.some(name =>
    path === `${name}__null` || path === `${name}__version` ||
    path === `${name}__currency` || path === `${name}__fold`) === true;
  if (fields.some(field => authoredCompanion(field.path) &&
      !writable.some(input => input.nullable === true && field.path === `${input.name}__null`))) {
    return { reason: "This form's field types are not supported yet." };
  }
  const renderedFields = authored === undefined ? fields : [
    ...authored.map(name => generated.get(name)!),
    ...fields.filter(field => !authoredNames.has(field.path) && !authoredCompanion(field.path)),
  ];
  return { authoredLabels, authoredValidators, labelNames, validatorNames, authored, renderedFields };
}

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
    checkFormOccurrence(request);
    const unavailable = (reason: string) => ({ status: 'unavailable' as const, message: reason });
    const derived = catalog?.derivedFor?.(request.operation);
    if (derived === undefined || derived === null) return unavailable('Operation form is unavailable.');
    if (!isGeneratedFormKind(derived.kind)) {
      return unavailable('This operation has no mutation form.');
    }
    const mode: FormMode = derived.kind;
    const bound = bindOperationRefs(derived, request.arguments);
    if (bound === null) return unavailable('This form binding is not supported.');
    const hasBindings = Object.keys(bound).length !== 0;
    const boundReason = checkBoundForm(mode, bound, hasBindings, protection, derived);
    if (boundReason !== null) return unavailable(boundReason);
    const fieldSelection = selectOperationFields(derived, bound, request.fields);
    if ('reason' in fieldSelection) return unavailable(fieldSelection.reason);
    const { writable, selected, selectedNames } = fieldSelection;
    const { recordValues, values } = selectRecordValues(mode, request, selected);
    const fields = generatedFields({ ...derived, inputs: writable.filter(input => selectedNames.has(input.name)) }, mode, {
      ...(request.labels === undefined ? {} : { labels: request.labels }),
      ...(recordValues === undefined ? {} : { values }),
    });
    const generated = new Map(fields.map(field => [field.path, field]));
    const placed = placeOperationAuthored(request, fields, generated, selectedNames, writable);
    if ('reason' in placed) return unavailable(placed.reason);
    const { authoredLabels, authoredValidators, labelNames, validatorNames, authored, renderedFields } = placed;
    const renderedNames = selectedNames;
    const idPrefix = request.occurrence === undefined ? `operation-form-${++occurrence}` :
      `operation-form-source-${Array.from(new TextEncoder().encode(request.occurrence), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const timeZone = context.team?.timezone ?? 'UTC';
    return finishOperationPreparation(context, clock, protection, derived, mode, bound,
      renderedFields, generated, request, idPrefix, timeZone, labelNames, validatorNames,
      authored, authoredLabels, authoredValidators, renderedNames, hasBindings);
  };
}
