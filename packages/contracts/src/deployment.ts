/**
 * Deployment boundary (lane 07): artifact/runtime compatibility, binding and
 * secret references, environment selection, and staged activation/upgrade
 * state. Types and version constants only; no execution engine.
 *
 * Resource needs are derived from Can by the compiler (lane 1) into binding
 * requirements. Deployment supplies only environment inputs: which resources
 * back each requirement, secret values by reference, and plain vars.
 * Secret VALUES never appear in any type in this module.
 */
export const DEPLOYMENT_CONTRACT_VERSION = 1;

/** Language version pinned by the release (e.g. "1.0.0"). Exact format owned by lane 1. */
export type LanguageVersion = string;
/** Compiler release that emitted the artifact. */
export type CompilerVersion = string;
/** Runtime release installed at the deployment target. */
export type RuntimeVersion = string;
/** Hex digest of a compiler-emitted artifact or canonical snapshot. */
export type ArtifactDigest = string;

/**
 * Identifies one selected app build: which source, checked by which compiler.
 * Compatibility-view reference only; lane 1 owns the canonical artifact
 * identity in `artifact.ts` and reconciles this shape when it lands.
 */
export interface ArtifactIdentity {
  /** Declared app identity from `.can` source (e.g. "TeamTasks"). */
  appName: string;
  /** Git SHA (or equivalent VCS revision) of the compiled source. */
  sourceRevision: string;
  languageVersion: LanguageVersion;
  compilerVersion: CompilerVersion;
  /** Value of `CONTRACTS_VERSION` the artifact was built against. */
  contractsVersion: number;
  /** Digest of the emitted artifact bytes. */
  artifactDigest: ArtifactDigest;
}

/**
 * Capability IDs required by the artifact (e.g. "d1-batch", "do-alarms").
 * The vocabulary is authored by runtime producers; this lane only checks
 * presence against the installed runtime. Unknown IDs fail closed.
 */
export type CapabilityId = string;

/** Provisioned Cloudflare resources a Can deployment may require. Closed set; additions are additive. */
export type ResourceKind =
  | "d1"
  | "r2"
  | "durable-object"
  | "queue"
  | "service"
  | "analytics-engine";

/**
 * One provisioned binding the Worker needs. `binding` is the key on the
 * Worker `env`; `logicalName` is the provisioned resource name (database,
 * bucket, queue, service, dataset) or Durable Object class name.
 */
export interface ResourceBindingRequirement {
  binding: string;
  kind: ResourceKind;
  logicalName: string;
}

/** A secret the deployment must supply. Values stay in the secret store; plans carry names only. */
export interface SecretReference {
  binding: string;
  /** When false, a missing secret blocks activation. */
  optional: boolean;
}

/**
 * Scheduled-handler need derived from `on=every(duration)` declarations.
 * Milliseconds are a decimal string so the value survives JSON transport;
 * never a JS Number (DESIGN §13 exact-BigInt rule).
 */
export interface ScheduleRequirement {
  /** Canonical handler identity. */
  handler: string;
  everyMilliseconds: string;
}

/** Everything the artifact needs from its host, before environment mapping. */
export interface CompatibilityDescriptor {
  identity: ArtifactIdentity;
  requiredCapabilities: readonly CapabilityId[];
  resourceBindings: readonly ResourceBindingRequirement[];
  secrets: readonly SecretReference[];
  schedules: readonly ScheduleRequirement[];
}

/** One deployed resource backing a requirement. IDs only, no credentials. */
export interface ResolvedResource {
  requirement: ResourceBindingRequirement;
  /** Provider resource ID actually bound. */
  resourceId: string;
}

/**
 * Deployment-side inputs for one environment. Distinct from authored app
 * semantics: these select resources, never behavior.
 */
export interface EnvironmentSelection {
  environment: string;
  resources: readonly ResolvedResource[];
  /** Names of secrets present in the environment secret store. */
  secretsPresent: readonly string[];
  /** Non-secret plain vars. */
  vars: Readonly<Record<string, string>>;
}

export type CompatibilityFailureCode =
  | "unknown-language-version"
  | "unknown-capability"
  | "missing-capability"
  | "missing-binding"
  | "missing-secret"
  | "unsupported-schedule"
  | "contracts-mismatch";

export interface CompatibilityFailure {
  code: CompatibilityFailureCode;
  detail: string;
}

export type CompatibilityVerdict =
  | { compatible: true }
  | { compatible: false; reasons: readonly CompatibilityFailure[] };

/** One logical schema owner pinned to its exact installed snapshot (DESIGN §11.1). */
export interface OwnerSnapshotRef {
  owner: string;
  snapshotId: string;
}

/** Disposition of inventoried old async work before activation (DESIGN §11.3). */
export interface PendingWorkDisposition {
  /** Pinned predecessor handler contract ID; name alone is insufficient. */
  handlerContract: string;
  disposition: "drain" | "invalidate" | "retain-compatible";
}

/** Reviewable upgrade plan. Compilation produces it; deployment executes it. */
export interface UpgradePlan {
  from: readonly OwnerSnapshotRef[];
  to: ArtifactIdentity;
  pendingWork: readonly PendingWorkDisposition[];
}

/**
 * Staged activation state (DESIGN §11.3). Preparation failure leaves the
 * previous release selected; partial activation keeps access closed until
 * resumed. No zero-downtime or automatic destructive rollback is promised.
 */
export type UpgradeStage =
  | "proposed"
  | "admissions-closed"
  | "staging"
  | "staged"
  | "activating"
  | "active"
  | "staging-failed"
  | "activation-failed"
  | "recovered-previous";

export interface UpgradeProgress {
  stagedOwners: number;
  totalOwners: number;
}

export interface UpgradeState {
  stage: UpgradeStage;
  plan: UpgradePlan;
  progress: UpgradeProgress;
  /** Present exactly when the stage is `staging-failed` or `activation-failed`. */
  failure?: {
    reason: string;
    /** False means an operator decision is required before any retry. */
    recoverable: boolean;
  };
}

/**
 * Activation gate failure codes (B3-I6, additive). Gate 1 reuses the
 * compatibility codes verbatim (including the known-vs-installed
 * `unknown-capability`/`missing-capability` split); the remaining codes
 * are activation-only.
 */
export type ActivationFailureCode =
  | CompatibilityFailureCode
  | "digest-mismatch"
  | "blocked-work"
  | "activation-check-failed"
  | "activation-incomplete";

/** One activation gate failure. `detail` never carries secrets. */
export interface ActivationFailure {
  code: ActivationFailureCode;
  detail: string;
}

/**
 * Activation verdict: whether the artifact may serve. `active: true`
 * carries no payload (the checks that passed are not individually
 * interesting); `active: false` carries every gate failure in
 * deterministic gate order (compat, requires, digest, inventory).
 */
export type ActivationVerdict =
  | { active: true }
  | { active: false; reasons: readonly ActivationFailure[] };
