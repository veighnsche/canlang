import type {
  CompatibilityDescriptor,
  EnvironmentSelection,
  ResourceBindingRequirement,
  ScheduleRequirement,
} from "@canlang/contracts";

/**
 * P-B deploy bundle reference: the self-contained worker the deploy wrote
 * (`src/deploy/bundle.ts`). When present, the bundle IS the deploy `main`.
 */
export interface DeployBundleRef {
  /** Bundle main, e.g. "./teamtasks.deploy/worker/main.js" (relative to the toml). */
  main: string;
  moduleCount: number;
  sha256: string;
}

export interface DeployPlanOptions {
  workerName: string;
  /** Entry script path, e.g. "./dist/worker/entry.js". */
  main: string;
  /** Wrangler `compatibility_date`, supplied by deployment (not authored). */
  compatibilityDate: string;
  /**
   * P-B: when the deploy wrote a bundle, its ref — `wrangler.main` becomes
   * the bundle main. Absent means the legacy `main` above (pre-bundle).
   */
  bundle?: DeployBundleRef;
}

/** Wrangler file config subset this lane generates. Secrets never appear here. */
export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  vars: Record<string, string>;
  d1_databases: { binding: string; database_name: string; database_id: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  queues: { producers: { binding: string; queue: string }[] };
  services: { binding: string; service: string }[];
  analytics_engine_datasets: { binding: string; dataset: string }[];
}

export interface DeployPlan {
  wrangler: WranglerConfig;
  /**
   * Schedules pass through unmapped: DECISIONS OPEN-139 (cron/alarm backend
   * selection) is unresolved, so no cron expression is invented from an
   * interval. Resolved selections join here when the contract lands.
   */
  schedules: readonly ScheduleRequirement[];
  /** P-B: the bundle this plan deploys, or null for a legacy-main plan. */
  bundle: DeployBundleRef | null;
}

function resolveId(
  requirement: ResourceBindingRequirement,
  environment: EnvironmentSelection,
): string {
  const resolved = environment.resources.find(
    (candidate) => candidate.requirement.binding === requirement.binding,
  );
  if (resolved === undefined) {
    throw new Error(`deploy plan needs a selected resource for binding ${requirement.binding}`);
  }
  if (
    resolved.requirement.kind !== requirement.kind ||
    resolved.requirement.logicalName !== requirement.logicalName
  ) {
    throw new Error(`binding ${requirement.binding} resolves to a different requirement`);
  }
  return resolved.resourceId;
}

/**
 * Deterministic deploy-plan generator: same descriptor + selection + options
 * always yields the same plan (descriptor order preserved, fixed keys).
 * Throws on unresolved bindings; the caller runs `checkCompatibility` first.
 */
export function buildDeployPlan(
  descriptor: CompatibilityDescriptor,
  environment: EnvironmentSelection,
  options: DeployPlanOptions,
): DeployPlan {
  const wrangler: WranglerConfig = {
    name: options.workerName,
    // P-B: a supplied bundle IS the deploy main (replaces the legacy entry).
    main: options.bundle?.main ?? options.main,
    compatibility_date: options.compatibilityDate,
    vars: { ...environment.vars },
    d1_databases: [],
    r2_buckets: [],
    durable_objects: { bindings: [] },
    queues: { producers: [] },
    services: [],
    analytics_engine_datasets: [],
  };

  for (const requirement of descriptor.resourceBindings) {
    const id = resolveId(requirement, environment);
    switch (requirement.kind) {
      case "d1":
        wrangler.d1_databases.push({
          binding: requirement.binding,
          database_name: requirement.logicalName,
          database_id: id,
        });
        break;
      case "r2":
        wrangler.r2_buckets.push({
          binding: requirement.binding,
          bucket_name: requirement.logicalName,
        });
        break;
      case "durable-object":
        wrangler.durable_objects.bindings.push({
          name: requirement.binding,
          class_name: requirement.logicalName,
        });
        break;
      case "queue":
        wrangler.queues.producers.push({
          binding: requirement.binding,
          queue: requirement.logicalName,
        });
        break;
      case "service":
        wrangler.services.push({ binding: requirement.binding, service: requirement.logicalName });
        break;
      case "analytics-engine":
        wrangler.analytics_engine_datasets.push({
          binding: requirement.binding,
          dataset: requirement.logicalName,
        });
        break;
      default: {
        const unknownKind: never = requirement.kind;
        throw new Error(`deploy plan has no mapping for resource kind ${String(unknownKind)}`);
      }
    }
  }

  return { wrangler, schedules: [...descriptor.schedules], bundle: options.bundle ?? null };
}
