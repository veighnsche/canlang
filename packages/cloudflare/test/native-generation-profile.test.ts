/** Static declaration consumer only; original native validation remains separate. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CompileArtifact, FrameworkOpaqueDeclaration } from '@canlang/contracts';
import { loadArtifactDescriptors } from '@canlang/state/invocation/registry';
import { nativeCapabilityResultDeclarations } from '../src/runtime/file-retirement.js';

const artifact = JSON.parse(readFileSync(new URL('./fixtures/typed-generation-progress.json', import.meta.url), 'utf8')) as CompileArtifact;
const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
const callable = artifact.callables.find(value => value.kind === 'operation' && value.id === 'TypedGenerationProgress.generate')!;
const source = artifact.sources.find(value => artifact.modules.find(module => module.path === callable.module)?.map?.sources.includes(value.path))!;
const caller: Extract<FrameworkOpaqueDeclaration['source'], {kind: 'callable'}> = {
  kind: 'callable', source: {...source, module: callable.module}, callable,
};

describe('original installed Generation profile consumer', () => {
  it('retains the complete original field/result pair without a request instance or control profile', () => {
    const before = JSON.stringify(artifact);
    const profiles = nativeCapabilityResultDeclarations(caller, loaded.models, artifact.models!);
    const generation = profiles.filter(value => value.source.kind === 'delivery' && value.source.context.kind === 'generation-profile');
    expect(generation).toHaveLength(1);
    const original = artifact.models!.find(value => value.name === 'TypedGenerationProgress.Job')!.fields.find(value => value.name === 'request')!;
    const declaration = generation[0]!;
    expect(declaration.source.kind).toBe('delivery');
    if (declaration.source.kind !== 'delivery') throw new Error('Actual delivery profile required');
    expect(declaration.source.source).toEqual(caller.source);
    expect(declaration.source.context).toEqual({kind: 'generation-profile', canonical: original.field, artifact: original.field});
    expect(Object.hasOwn(declaration.source.context, 'request')).toBe(false);
    expect(Object.isFrozen(declaration.source.context)).toBe(true);
    expect(profiles).toHaveLength(1); // Original cancel/reconcile fields are not enrolled.
    expect(JSON.stringify(artifact)).toBe(before);
  });

  it('refuses an incompatible original canonical/artifact pair without changing the input inventory', () => {
    const model = loaded.models.find(value => value.name === 'TypedGenerationProgress.Job')!;
    const fields = {...model.fields};
    const field = fields.request!;
    if (field.delivery === undefined) throw new Error('Actual owning delivery field required');
    if ('judgment' in field.delivery) throw new Error('Original Generation field required');
    fields.request = {...field, delivery: {...field.delivery, version: field.delivery.version + 1}};
    const changed = loaded.models.map(value => value === model ? {...model, fields} : value);
    const before = JSON.stringify(changed);
    expect(() => nativeCapabilityResultDeclarations(caller, changed, artifact.models!)).toThrow(/delivery field declarations disagree/);
    expect(JSON.stringify(changed)).toBe(before);
  });
});
