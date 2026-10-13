/**
 * BGI-08 Given computed-key seam join (workerd-safe): resolve checked
 * `state.unique-key@1` bindings against assembled artifact modules and
 * build the pipeline rules the model table carries.
 *
 * Resolution is fingerprint-verified: the binding's SHA-256 must match
 * the artifact module bytes exactly, or the seam refuses with an explicit
 * changed-code outcome (re-validate and activate; never run changed code
 * silently, never regenerate). One import per saved unit/export pair: a
 * second compatible application reuses the resolved evaluator with zero
 * additional loading. The evaluator receives projected text only — no
 * record handles, no store, no registry, no commit.
 */

import { sha256HexText } from '@canlang/identity';
import type { CompileArtifact, ModelName, StateUniqueKeyProducerBinding } from '@canlang/contracts';
import type { GivenUniqueKeyRule } from '@canlang/state/effects/staging';
import {
  AssemblyCorrespondenceError,
  importVerifiedAssemblyModule,
} from './assembly-verification.js';
import type { AssembledModules } from './modules.js';

/**
 * BGI-08 artifact module path for one saved Given unit. The BGI-11 packing
 * join writes saved `server.js` here; fingerprint verification keeps any
 * layout drift loud (unknown unit), never silent.
 */
export function givenUnitModulePath(unitId: string): string {
  return `can.generated/${unitId}/server.js`;
}

/**
 * BGI-08 resolve one checked binding to its saved evaluator: the unit
 * module must exist, its bytes must match the checked fingerprint, and
 * the named export must be a function. Every refusal names the rule and
 * the failed join step; nothing falls back to another module, export,
 * or implementation.
 */
export async function resolveGivenKeywordExport(
  asm: AssembledModules,
  artifact: CompileArtifact,
  binding: StateUniqueKeyProducerBinding,
): Promise<GivenUniqueKeyRule['evaluate']> {
  const where = `Computed-key rule ${JSON.stringify(binding.rule)}`;
  const { unit, export: exportName, fingerprint } = binding.implementation;
  const path = givenUnitModulePath(unit);
  const module = artifact.modules.find((candidate) => candidate.path === path);
  if (module === undefined) {
    throw new AssemblyCorrespondenceError(
      `${where} names unknown saved unit ${JSON.stringify(unit)}: expected module ${JSON.stringify(path)}.`,
    );
  }
  const actual = await sha256HexText(module.js);
  if (actual !== fingerprint) {
    throw new AssemblyCorrespondenceError(
      `${where} saved implementation changed (unit ${JSON.stringify(unit)} fingerprint mismatch): ` +
        're-validate and activate before use; refusing to run changed code silently.',
    );
  }
  const imported: unknown = await importVerifiedAssemblyModule(asm, path, artifact);
  if (typeof imported !== 'object' || imported === null || !Object.hasOwn(imported, exportName)) {
    throw new AssemblyCorrespondenceError(
      `${where} saved unit ${JSON.stringify(unit)} has no export ${JSON.stringify(exportName)}.`,
    );
  }
  const candidate = (imported as Record<string, unknown>)[exportName];
  if (typeof candidate !== 'function') {
    throw new AssemblyCorrespondenceError(
      `${where} saved export ${JSON.stringify(exportName)} is not a function.`,
    );
  }
  return candidate as GivenUniqueKeyRule['evaluate'];
}

/**
 * BGI-08 resolve every checked binding into per-model pipeline rules,
 * sharing one evaluator per saved unit/export/fingerprint triple. Empty
 * bindings resolve to an empty map (artifacts without keyword rules keep
 * their exact prior posture).
 */
export async function joinGivenUniqueKeys(
  asm: AssembledModules,
  artifact: CompileArtifact,
  bindings: ReadonlyArray<StateUniqueKeyProducerBinding>,
): Promise<ReadonlyMap<ModelName, ReadonlyArray<GivenUniqueKeyRule>>> {
  const byModel = new Map<ModelName, GivenUniqueKeyRule[]>();
  if (bindings.length === 0) return byModel;
  const resolved = new Map<string, GivenUniqueKeyRule['evaluate']>();
  for (const binding of bindings) {
    const identity = JSON.stringify([
      binding.implementation.unit,
      binding.implementation.export,
      binding.implementation.fingerprint,
    ]);
    let evaluate = resolved.get(identity);
    if (evaluate === undefined) {
      evaluate = await resolveGivenKeywordExport(asm, artifact, binding);
      resolved.set(identity, evaluate);
    }
    const rules = byModel.get(binding.model);
    const rule: GivenUniqueKeyRule = { rule: binding.rule, field: binding.field, evaluate };
    if (rules === undefined) byModel.set(binding.model, [rule]);
    else rules.push(rule);
  }
  return byModel;
}
