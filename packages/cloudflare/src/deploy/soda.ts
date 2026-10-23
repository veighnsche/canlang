/** Build-only Soda assembly; serving imports the shared pure contract. */
import type { CompileArtifact, CompatibilityDescriptor, EnvironmentSelection } from '@canlang/contracts';
import { buildDeployBundleWithAssets, assertLinksResolve, assertWorkerdLoadable, bundleMixedSha256, bundleSha256, inventorizeAssets, stageSodaRuntimeModules } from './bundle.js';
import {preflightSodaDeployment,getSodaStorageFingerprint,SODA_CAPABILITIES,type SodaBundle} from './soda-contract.js';
import {RELEASE_VERSION} from '../release/stamp.js';
export * from './soda-contract.js';

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
