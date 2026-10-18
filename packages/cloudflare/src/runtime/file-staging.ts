import type {
  CompileArtifact, DomainWrite, FinalizedFileObservation, FinalizedFileReceiver,
  ModelName, RecordId, ResolvedIdentity, RetainedFinalizedFile, StoragePort, StoredRow,
} from '@canlang/contracts';
import { decodeValue } from '@canlang/values';
import type { FileReferenceOccurrence, FileReferenceProfile } from '@canlang/state/ports/file-reference-profile';
import type { CanonicalExecutionEffects, CanonicalGuardRevalidation } from './invoke.js';

/** Same-loaded State census, bound only to actual stored nominal fields. */
export interface FileStagingCensus {
  readonly fields: ReadonlyMap<string, ReadonlyMap<string, FileReferenceProfile>>;
  readonly occurrences: (profile: FileReferenceProfile, wire: unknown) => readonly FileReferenceOccurrence[];
}

function fileFields(artifact: CompileArtifact, census: FileStagingCensus | undefined, model: string) {
  const declared = artifact.models?.find(candidate => candidate.name === model)?.fields ?? [];
  const profiles = census?.fields.get(model);
  return declared.filter(field => field.field.kind === 'file' || profiles?.has(field.name));
}

function fileRefs(field: ReturnType<typeof fileFields>[number], wire: unknown,
  census: FileStagingCensus | undefined, model: string): readonly string[] {
  if (field.field.kind === 'file') {
    const native = decodeValue(`file${field.array === undefined ? '' : '[]'}`, wire);
    return (Array.isArray(native) ? native : [native]).map(value => (value as { id: string }).id);
  }
  const profile = census?.fields.get(model)?.get(field.name);
  if (profile === undefined) throw new Error('Stored nominal File field lost its owning census.');
  return census!.occurrences(profile, wire).map(occurrence => occurrence.ref);
}

/** The host resolves existing finalized storage; File values carry no authority. */
export interface CanonicalFileBinding {
  validate(ref: string, identity: ResolvedIdentity, app: string): Promise<boolean>;
  retain(ref: string, record: string, identity: ResolvedIdentity, app: string): Promise<void>;
  observe?(ref: string, identity: ResolvedIdentity, app: string): Promise<FinalizedFileObservation | null>;
  revalidate?(saved: RetainedFinalizedFile, receiver: FinalizedFileReceiver): Promise<boolean>;
}

type RetainedFileObserver = (saved: RetainedFinalizedFile, verifySource: () => Promise<void>) =>
  Promise<FinalizedFileObservation | null>;
const retainedFileObservers = new WeakMap<CanonicalFileBinding, RetainedFileObserver>();

/** Host composition only. The real factory pins its kernel and explicit policy;
 * copied bindings cannot acquire retained receiving authority. */
export function registerRetainedCanonicalFileObserver(files: CanonicalFileBinding, observe: RetainedFileObserver): void {
  if (retainedFileObservers.has(files)) throw new Error('Retained File observer is already installed.');
  retainedFileObservers.set(files, observe);
}

/** Call only after the owning retained source/slot/profile checks. A saved
 * receiver is not a normal actor-null attach or disclosure credential. */
export async function observeRetainedCanonicalFile(files: CanonicalFileBinding, saved: RetainedFinalizedFile,
  verifySource: () => Promise<void>): Promise<FinalizedFileObservation | null> {
  const observe = retainedFileObservers.get(files);
  if (observe === undefined) return null;
  await verifySource();
  const observation = await observe(saved, verifySource);
  await verifySource();
  return observation;
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
  readonly census?: FileStagingCensus;
  /** Pin the trusted receiving producer before any actual observation awaits. */
  readonly prepareObservation?: () => void;
  /** Trusted host capture for explicit, checked assignment locators only. */
  readonly observeAssignment?: (input: {
    readonly model: ModelName;
    readonly recordId: RecordId;
    readonly field: string;
    readonly observation: FinalizedFileObservation;
  }) => void;
  readonly refuse: (message: string) => never;
}): Promise<{ readonly guards: CanonicalGuardRevalidation[]; readonly attachments: FileAttachment[] }> {
  const attachments: FileAttachment[] = [];
  const guards: CanonicalGuardRevalidation[] = [];
  const assigned = new Set<string>();
  const observed = new Set<string>();
  const assignmentKey = (model: string, recordId: string, field: string) => JSON.stringify([model, recordId, field]);
  const sink: StagingSink = { guards, attachments, assigned, observed, assignmentKey };
  checkFileAssignments(input, sink);
  for (const effect of input.effects.writes ?? []) {
    if (effect === null || typeof effect !== 'object' || !('kind' in effect) || !('model' in effect)) continue;
    const write = effect as DomainWrite;
    if (write.kind !== 'insert' && write.kind !== 'update') continue;
    const row = write.row;
    if (row === undefined || typeof row.id !== 'string' || row.data === null || typeof row.data !== 'object') continue;
    await stageWriteRefs(input, write, row, sink);
  }
  return { guards, attachments };
}

interface StagingSink {
  readonly guards: CanonicalGuardRevalidation[];
  readonly attachments: FileAttachment[];
  readonly assigned: Set<string>;
  readonly observed: Set<string>;
  readonly assignmentKey: (model: string, recordId: string, field: string) => string;
}

type StageFileReferencesInput = Parameters<typeof stageFileReferences>[0];
type StagedAssignment = { readonly model: string; readonly recordId: string; readonly field: string };

function checkFileAssignments(input: StageFileReferencesInput, sink: StagingSink): void {
  const { assigned, assignmentKey } = sink;
  if (input.effects.fileAssignments === undefined) return;
  if (!Array.isArray(input.effects.fileAssignments)) input.refuse('File assignment intent must be an internal list.');
  for (const assignment of input.effects.fileAssignments) {
    assertAssignmentShape(input, assignment);
    const declaration = fileFields(input.artifact, input.census, assignment.model)
      .find(field => field.name === assignment.field);
    const targets = findAssignmentTargets(input, assignment);
    if (declaration === undefined || targets.length !== 1) input.refuse('File assignment intent needs its checked field and actual final target row.');
    assigned.add(assignmentKey(assignment.model, assignment.recordId, assignment.field));
  }
}

function assertAssignmentShape(input: StageFileReferencesInput, assignment: StagedAssignment): void {
  if (assignment === null || typeof assignment !== 'object' ||
      Object.keys(assignment).length !== 3 || Object.keys(assignment).some(key => !['model', 'recordId', 'field'].includes(key)) ||
      typeof assignment.model !== 'string' || typeof assignment.recordId !== 'string' || typeof assignment.field !== 'string') {
    input.refuse('File assignment intent must name exactly its model, record and field.');
  }
}

function findAssignmentTargets(input: StageFileReferencesInput, assignment: StagedAssignment): unknown[] {
  return input.effects.writes.filter(effect => {
    if (effect === null || typeof effect !== 'object' || !('kind' in effect) || !('model' in effect)) return false;
    const write = effect as DomainWrite;
    return (write.kind === 'insert' || write.kind === 'update') && write.model === assignment.model &&
      write.row?.id === assignment.recordId && write.row.data !== null && typeof write.row.data === 'object' &&
      Object.hasOwn(write.row.data, assignment.field);
  });
}

async function stageWriteRefs(input: StageFileReferencesInput, write: DomainWrite, row: StoredRow, sink: StagingSink): Promise<void> {
  const fields = fileFields(input.artifact, input.census, write.model);
  if (fields.length === 0) return;
  const previous = write.kind === 'insert' ? null : await input.store.load(write.model, row.id);
  for (const field of fields) {
    await stageFieldRefs(input, write, row, field, previous, sink);
  }
}

async function stageFieldRefs(input: StageFileReferencesInput, write: DomainWrite, row: StoredRow,
  field: ReturnType<typeof fileFields>[number], previous: Awaited<ReturnType<StageFileReferencesInput['store']['load']>>,
  sink: StagingSink): Promise<void> {
  const { guards, attachments, assigned, assignmentKey } = sink;
  const wire = (row.data as Record<string, unknown>)[field.name];
  if (wire === null || wire === undefined) return;
  const key = assignmentKey(write.model, row.id, field.name);
  if (!assigned.has(key) && JSON.stringify(previous?.data[field.name]) === JSON.stringify(wire)) return;
  const refs = fileRefs(field, wire, input.census, write.model);
  if (field.field.kind !== 'file' && refs.length !== 0 && input.observeAssignment !== undefined && !assigned.has(key)) {
    input.refuse('Saved nominal File assignment requires genuine State receipt observation.');
  }
  for (const ref of refs) {
    if (input.files === undefined || !await input.files.validate(ref, input.identity, input.app)) {
      input.refuse('A file reference must be finalized and owned by the receiving caller.');
    }
    const files = input.files;
    if (input.observeAssignment !== undefined && assigned.has(key)) {
      await observeStagedRef(input, sink, files, write.model, row.id, field.name, ref);
    }
    guards.push({ name: 'file.finalized', evaluate: () => files.validate(ref, input.identity, input.app) });
    attachments.push({ ref, record: `${write.model}/${row.id}/${field.name}` });
  }
}

async function observeStagedRef(input: StageFileReferencesInput, sink: StagingSink, files: CanonicalFileBinding,
  model: string, recordId: string, fieldName: string, ref: string): Promise<void> {
  const { observed } = sink;
  const key = JSON.stringify([model, recordId, fieldName, ref]);
  if (observed.has(key)) return;
  if (files.observe === undefined || files.revalidate === undefined) {
    input.refuse('Saved file assignment requires its installed receiving observer and revalidator.');
  }
  input.prepareObservation?.();
  const observation = await files.observe(ref, input.identity, input.app);
  if (observation === null) input.refuse('Saved file assignment requires a genuine live receiving File observation.');
  input.observeAssignment!({ model: model as ModelName, recordId: recordId as RecordId, field: fieldName, observation });
  observed.add(key);
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
  /** Checked scenarios retain only their actual validated assignment effects. */
  readonly stagedOnly?: boolean;
  readonly census?: FileStagingCensus;
  readonly store: StoragePort;
  readonly files: CanonicalFileBinding;
  readonly identity: ResolvedIdentity;
  readonly app: string;
}): Promise<void> {
  const attachments = new Map(input.attachments.map(attachment => [`${attachment.record}\0${attachment.ref}`, attachment]));
  for (const locator of collectRetainLocators(input)) {
    await collectLocatorAttachments(input, locator, attachments);
  }
  for (const attachment of attachments.values()) {
    // An already expired/collected reference stays unavailable on replay.
    if (await input.files.validate(attachment.ref, input.identity, input.app)) {
      await input.files.retain(attachment.ref, attachment.record, input.identity, input.app);
    }
  }
}

type RetainCommittedInput = Parameters<typeof retainCommittedFiles>[0];
type RetainLocator = { model: string; id: string };

function collectRetainLocators(input: RetainCommittedInput): RetainLocator[] {
  const operation = input.artifact.operations?.find(candidate => candidate.name === input.operation);
  const locators: RetainLocator[] = [];
  for (const field of input.stagedOnly === true ? [] : operation?.inputs.fields ?? []) {
    if (field.field.kind !== 'ref') continue;
    const value = input.inputs[field.name];
    if (value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      locators.push({ model: field.field.model, id: value.id });
    }
  }
  if (input.stagedOnly !== true && operation?.kind === 'create' && input.result !== null && typeof input.result === 'object' &&
      'id' in input.result && typeof input.result.id === 'string') {
    const model = input.artifact.models?.find(candidate => `${candidate.name}.create` === input.operation);
    if (model !== undefined) locators.push({ model: model.name, id: input.result.id });
  }
  return locators;
}

async function collectLocatorAttachments(input: RetainCommittedInput, locator: RetainLocator,
  attachments: Map<string, FileAttachment>): Promise<void> {
  const fields = fileFields(input.artifact, input.census, locator.model);
  if (fields.length === 0) return;
  const row = await input.store.load(locator.model as import('@canlang/contracts').ModelName,
    locator.id as import('@canlang/contracts').RecordId);
  if (row === null || row.archivedAt !== null) return;
  for (const field of fields) {
    const wire = row.data[field.name];
    if (wire === null || wire === undefined) continue;
    for (const ref of fileRefs(field, wire, input.census, locator.model)) {
      const attachment = { ref, record: `${locator.model}/${row.id}/${field.name}` };
      attachments.set(`${attachment.record}\0${attachment.ref}`, attachment);
    }
  }
}
