import type { CompileArtifact, DomainWrite, ResolvedIdentity, StoragePort } from '@canlang/contracts';
import { decodeValue } from '@canlang/values';
import type { CanonicalExecutionEffects, CanonicalGuardRevalidation } from './invoke.js';

/** The host resolves existing finalized storage; File values carry no authority. */
export interface CanonicalFileBinding {
  validate(ref: string, identity: ResolvedIdentity, app: string): Promise<boolean>;
  retain(ref: string, record: string, identity: ResolvedIdentity, app: string): Promise<void>;
}

export interface FileAttachment {
  readonly ref: string;
  readonly record: string;
}

export async function stageFileReferences(input: {
  readonly artifact: CompileArtifact;
  readonly effects: CanonicalExecutionEffects;
  readonly store: StoragePort;
  readonly identity: ResolvedIdentity;
  readonly app: string;
  readonly files?: CanonicalFileBinding;
  readonly refuse: (message: string) => never;
}): Promise<{ readonly guards: CanonicalGuardRevalidation[]; readonly attachments: FileAttachment[] }> {
  const attachments: FileAttachment[] = [];
  const guards: CanonicalGuardRevalidation[] = [];
  const assigned = new Set<string>();
  const assignmentKey = (model: string, recordId: string, field: string) => JSON.stringify([model, recordId, field]);
  if (input.effects.fileAssignments !== undefined) {
    if (!Array.isArray(input.effects.fileAssignments)) input.refuse('File assignment intent must be an internal list.');
    for (const assignment of input.effects.fileAssignments) {
      if (assignment === null || typeof assignment !== 'object' ||
          Object.keys(assignment).length !== 3 || Object.keys(assignment).some(key => !['model', 'recordId', 'field'].includes(key)) ||
          typeof assignment.model !== 'string' || typeof assignment.recordId !== 'string' || typeof assignment.field !== 'string') {
        input.refuse('File assignment intent must name exactly its model, record and field.');
      }
      const declaration = input.artifact.models?.find(model => model.name === assignment.model)?.fields
        .find(field => field.name === assignment.field && field.field.kind === 'file');
      const targets = input.effects.writes.filter(effect => {
        if (effect === null || typeof effect !== 'object' || !('kind' in effect) || !('model' in effect)) return false;
        const write = effect as DomainWrite;
        return (write.kind === 'insert' || write.kind === 'update') && write.model === assignment.model &&
          write.row?.id === assignment.recordId && write.row.data !== null && typeof write.row.data === 'object' &&
          Object.hasOwn(write.row.data, assignment.field);
      });
      if (declaration === undefined || targets.length !== 1) input.refuse('File assignment intent needs its checked field and actual final target row.');
      assigned.add(assignmentKey(assignment.model, assignment.recordId, assignment.field));
    }
  }
  for (const effect of input.effects.writes ?? []) {
    if (effect === null || typeof effect !== 'object' || !('kind' in effect) || !('model' in effect)) continue;
    const write = effect as DomainWrite;
    if (write.kind !== 'insert' && write.kind !== 'update') continue;
    const row = write.row;
    if (row === undefined || typeof row.id !== 'string' || row.data === null || typeof row.data !== 'object') continue;
    const model = input.artifact.models?.find(candidate => candidate.name === write.model);
    const fields = model?.fields.filter(field => field.field.kind === 'file') ?? [];
    if (fields.length === 0) continue;
    const previous = write.kind === 'insert' ? null : await input.store.load(write.model, row.id);
    for (const field of fields) {
      const wire = (row.data as Record<string, unknown>)[field.name];
      if (wire === null || wire === undefined) continue;
      if (!assigned.has(assignmentKey(write.model, row.id, field.name)) &&
          JSON.stringify(previous?.data[field.name]) === JSON.stringify(wire)) continue;
      const native = decodeValue(`file${field.array === undefined ? '' : '[]'}`, wire);
      const values = Array.isArray(native) ? native : [native];
      for (const value of values) {
        const ref = (value as { id: string }).id;
        if (input.files === undefined || !await input.files.validate(ref, input.identity, input.app)) {
          input.refuse('A file reference must be finalized and owned by the receiving caller.');
        }
        const files = input.files;
        guards.push({ name: 'file.finalized', evaluate: () => files.validate(ref, input.identity, input.app) });
        attachments.push({ ref, record: `${write.model}/${row.id}/${field.name}` });
      }
    }
  }
  return { guards, attachments };
}

/** Repair a lost postcommit attachment response using declared record inputs.
 * State has already admitted/replayed the original closed operation envelope.
 * These reads retain bytes; they never grant download access or change domain rows.
 */
export async function retainCommittedFiles(input: {
  readonly artifact: CompileArtifact;
  readonly operation: string;
  readonly inputs: Record<string, unknown>;
  readonly result: unknown;
  readonly attachments: readonly FileAttachment[];
  readonly store: StoragePort;
  readonly files: CanonicalFileBinding;
  readonly identity: ResolvedIdentity;
  readonly app: string;
}): Promise<void> {
  const attachments = new Map(input.attachments.map(attachment => [`${attachment.record}\0${attachment.ref}`, attachment]));
  const operation = input.artifact.operations?.find(candidate => candidate.name === input.operation);
  const locators: { model: string; id: string }[] = [];
  for (const field of operation?.inputs.fields ?? []) {
    if (field.field.kind !== 'ref') continue;
    const value = input.inputs[field.name];
    if (value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      locators.push({ model: field.field.model, id: value.id });
    }
  }
  if (operation?.kind === 'create' && input.result !== null && typeof input.result === 'object' &&
      'id' in input.result && typeof input.result.id === 'string') {
    const model = input.artifact.models?.find(candidate => `${candidate.name}.create` === input.operation);
    if (model !== undefined) locators.push({ model: model.name, id: input.result.id });
  }
  for (const locator of locators) {
    const model = input.artifact.models?.find(candidate => candidate.name === locator.model);
    const fields = model?.fields.filter(field => field.field.kind === 'file') ?? [];
    if (fields.length === 0) continue;
    const row = await input.store.load(locator.model as import('@canlang/contracts').ModelName,
      locator.id as import('@canlang/contracts').RecordId);
    if (row === null || row.archivedAt !== null) continue;
    for (const field of fields) {
      const wire = row.data[field.name];
      if (wire === null || wire === undefined) continue;
      const native = decodeValue(`file${field.array === undefined ? '' : '[]'}`, wire);
      for (const value of Array.isArray(native) ? native : [native]) {
        const attachment = { ref: (value as { id: string }).id, record: `${model!.name}/${row.id}/${field.name}` };
        attachments.set(`${attachment.record}\0${attachment.ref}`, attachment);
      }
    }
  }
  for (const attachment of attachments.values()) {
    // An already expired/collected reference stays unavailable on replay.
    if (await input.files.validate(attachment.ref, input.identity, input.app)) {
      await input.files.retain(attachment.ref, attachment.record, input.identity, input.app);
    }
  }
}
