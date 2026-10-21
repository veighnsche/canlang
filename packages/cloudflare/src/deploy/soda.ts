/** Narrow native target over the canonical descriptor and portable Worker bundle. */
import { createHash } from 'node:crypto';
import type { CompileArtifact, CompatibilityDescriptor, EnvironmentSelection } from '@canlang/contracts';
import { CONTRACTS_VERSION } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { checkCompatibility } from './compat.js';
import { buildDeployBundleWithAssets, assertLinksResolve, assertWorkerdLoadable, bundleMixedSha256, bundleSha256, inventorizeAssets, stageSodaRuntimeModules } from './bundle.js';
import type { PackageDeployBundle } from './bundle.js';
import { RELEASE_VERSION } from '../release/stamp.js';
import { artifactNeedsFiles } from '../runtime/artifact.js';

export const SODA_CAPABILITIES = [
  'canlang.builtins', 'values.decimal', 'values.int64', 'values.money', 'values.temporal',
  'state', 'state.machines', 'state.parameters', 'state.field-validation', 'state.cohorts', 'interfaces.input-choices',
  'cloudflare.runtime-bindings',
  'd1-batch', 'do-alarms',
] as const;

/** This inventory is target support, not equivalence with the managed platform. */
export const SODA_PROVIDER_INVENTORY = {
  d1: { supported: true, persistence: 'sqlite-on-required-mount' },
  files: { supported: true, persistence: 'application-actor-sqlite', maxBytes: DEFAULT_FILE_POLICY.maxBytes },
  scheduledWork: { supported: true, persistence: 'Canlang-D1-occurrences', wakeup: 'durable-object-alarm' },
  r2: { supported: false, reason: 'R2 file lifecycle adapter is not qualified' },
  'durable-object': { supported: false, reason: 'Only the target-owned application actor is installed' },
  queue: { supported: false, reason: 'Pinned Miniflare broker is in-memory' },
  service: { supported: false, reason: 'External service bindings are not configured' },
  'analytics-engine': { supported: false, reason: 'Pinned local Analytics Engine has no durable sink' },
  kv: { supported: false, reason: 'No Canlang KV binding contract is installed' },
  workflows: { supported: false, reason: 'No qualified adapter' },
  ai: { supported: false, reason: 'No qualified adapter' },
  vectorize: { supported: false, reason: 'No qualified adapter' },
} as const;

export function preflightSodaDeployment(artifact: CompileArtifact, descriptor: CompatibilityDescriptor,
  environment: EnvironmentSelection): void {
  const verdict = checkCompatibility(descriptor, environment, { contractsVersion: CONTRACTS_VERSION,
    runtimeVersion: RELEASE_VERSION, capabilities: SODA_CAPABILITIES, knownLanguageVersions: ['1.0'], supportsSchedules: true });
  const failures = verdict.compatible ? [] : verdict.reasons.map(reason => `${reason.code}: ${reason.detail}`);
  if (descriptor.identity.compilerVersion !== RELEASE_VERSION || artifact.tool_version !== RELEASE_VERSION) {
    failures.push('Soda requires the matching installed compiler/runtime release');
  }
  if (descriptor.identity.artifactDigest !== createHash('sha256').update(JSON.stringify(artifact)).digest('hex')) {
    failures.push('Soda descriptor does not identify the exact compiled artifact');
  }
  checkSodaRequires(artifact, failures);
  checkSodaBindings(artifact, descriptor, failures);
  checkSodaOrigin(artifact, environment, failures);
  if (artifact.callables.some(item => item.kind === 'migration')) failures.push('Soda migrations require a qualified upgrade procedure');
  if (failures.length !== 0) throw new Error(failures.join('\n'));
}

function checkSodaRequires(artifact: CompileArtifact, failures: string[]): void {
  for (const required of artifact.requires) {
    const version = required.capability === 'canlang.builtins' ? 0 : 1;
    if (!(SODA_CAPABILITIES as readonly string[]).includes(required.capability) || required.min_version !== version) {
      failures.push(`Soda lacks qualified producer ${required.capability}@${required.min_version}`);
    }
  }
}

function checkSodaBindings(artifact: CompileArtifact, descriptor: CompatibilityDescriptor, failures: string[]): void {
  for (const binding of artifact.runtimeBindings ?? []) {
    if (binding.kind !== 'r2' || binding.implicit !== true || binding.binding !== 'FILES') {
      failures.push(`Soda does not support source ${binding.kind} binding ${binding.binding}`);
    }
  }
  for (const requirement of descriptor.resourceBindings) {
    if (requirement.kind !== 'd1') failures.push(`Soda does not support required ${requirement.kind} binding ${requirement.binding}`);
  }
  if (descriptor.secrets.some(secret => !secret.optional)) failures.push('Soda has no qualified external secret/provider adapter');
  if (!descriptor.resourceBindings.some(item => item.binding === 'DB' && item.kind === 'd1')) {
    failures.push('Soda requires declared Identity D1 binding DB');
  }
  if (!descriptor.resourceBindings.some(item => item.binding === 'STATE_DB' && item.kind === 'd1')) {
    failures.push('Soda requires declared separate State D1 binding STATE_DB');
  }
  if (artifact.models?.some(model => model.scope === 'app')) failures.push('Soda currently supports a single bootstrapped team; app-global and mixed owner storage are not qualified');
}

function checkSodaOrigin(artifact: CompileArtifact, environment: EnvironmentSelection, failures: string[]): void {
  const origin = environment.vars.CAN_AUTH_ORIGIN;
  try {
    if (typeof origin !== 'string' || !['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) {
      failures.push('Soda requires a canonical explicit CAN_AUTH_ORIGIN');
    } else if (artifactNeedsFiles(artifact) && new URL(origin).protocol !== 'https:') {
      failures.push('Soda File receivers require an HTTPS application origin');
    }
  } catch { failures.push('Soda requires a canonical explicit CAN_AUTH_ORIGIN'); }
}

/** Storage declarations belong to the compiler artifact, independently of page/module bytes.
 * Keep this versioned fingerprint shared by retained storage and native image labels. */
export function getSodaStorageFingerprint(artifact: CompileArtifact): string {
  return createHash('sha256').update(JSON.stringify({ schema: 'canlang.soda.layout.v1',
    models: artifact.models ?? [], valueTypes: artifact.valueTypes ?? null })).digest('hex');
}

export interface SodaBundle {
  readonly storageFingerprint: string;
  readonly artifact: CompileArtifact;
  readonly descriptor: CompatibilityDescriptor;
  readonly environment: EnvironmentSelection;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly bundle: PackageDeployBundle;
}

/** Assemble inactive bytes. The application actor runs real activation before serving. */
export function buildSodaBundle(artifact: CompileArtifact, descriptor: CompatibilityDescriptor,
  environment: EnvironmentSelection, compatibilityDate: string, compatibilityFlags: readonly string[] = []): SodaBundle {
  preflightSodaDeployment(artifact, descriptor, environment);
  const bundle = buildDeployBundleWithAssets(artifact, {
    verdict: { active: false, reasons: [{ code: 'activation-incomplete', detail: 'Soda requires actual mounted runtime admission' }] },
    assets: { browser: true, valuesWasm: artifact.requires.some(item => item.capability.startsWith('values.')) },
  });
  Object.assign(bundle.modules, stageSodaRuntimeModules(bundle.modules));
  bundle.modules['worker/soda.js'] = `
import {createSodaApplicationClass} from '../runtime/soda-application.js';
import * as staged from './artifact.js';
export const SodaApplication = createSodaApplicationClass({staged,
  descriptor:${JSON.stringify(descriptor)},environment:${JSON.stringify(environment)},
  capabilities:${JSON.stringify(SODA_CAPABILITIES)},runtimeVersion:${JSON.stringify(RELEASE_VERSION)}});
export default {fetch(request,env) { return env.SODA_APPLICATION.get(env.SODA_APPLICATION.idFromName(${JSON.stringify(descriptor.identity.appName)})).fetch(request); }};
`;
  bundle.mainModule = 'worker/soda.js';
  bundle.moduleCount = Object.keys(bundle.modules).length;
  bundle.sha256 = bundleSha256(bundle.mainModule, bundle.modules);
  bundle.mixedSha256 = bundleMixedSha256(bundle.mainModule, inventorizeAssets(bundle.modules, bundle.binaries));
  assertLinksResolve(bundle.modules, Object.keys(bundle.binaries));
  assertWorkerdLoadable(bundle.modules);
  return { artifact, descriptor, environment, compatibilityDate, compatibilityFlags, bundle,
    storageFingerprint: getSodaStorageFingerprint(artifact) };
}
