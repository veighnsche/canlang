/**
 * B5-J3 deploy review: diff-vs-previous, preview print, confirm gate.
 *
 * `diffPlans` projects both plans to canonical lines and diffs BY KEY
 * (worker identity, each var, each binding): `+` added, `-` removed,
 * `~ old -> new` changed. `loadPreviousPlan` reads the stored canonical
 * JSON (absent file = first deploy, null). `formatPreview` prints the
 * human-reviewable plan + diff. `requireYes` is the confirm gate: the
 * CLI writes nothing without `--yes`, and `--preview` never writes.
 */
import { readFileSync } from "node:fs";
import type { DeployPlan } from "./plan.js";
import { renderWranglerToml } from "./render.js";

export interface PlanDiff {
  changed: boolean;
  lines: string[];
}

interface ProjectedLine {
  key: string;
  line: string;
}

/** Canonical line projection: fixed order, one line per plan fact. */
function project(plan: DeployPlan): ProjectedLine[] {
  const wrangler = plan.wrangler;
  const out: ProjectedLine[] = [
    {
      key: "worker",
      line: `worker ${wrangler.name} main=${wrangler.main} compat=${wrangler.compatibility_date}`,
    },
  ];
  for (const name of Object.keys(wrangler.vars).sort()) {
    out.push({ key: `var:${name}`, line: `var ${name}=${JSON.stringify(wrangler.vars[name])}` });
  }
  for (const db of wrangler.d1_databases) {
    out.push({
      key: `d1:${db.binding}`,
      line: `d1 ${db.binding} name=${db.database_name} id=${db.database_id}`,
    });
  }
  for (const bucket of wrangler.r2_buckets) {
    out.push({ key: `r2:${bucket.binding}`, line: `r2 ${bucket.binding} name=${bucket.bucket_name}` });
  }
  for (const binding of wrangler.durable_objects.bindings) {
    out.push({
      key: `do:${binding.name}`,
      line: `do ${binding.name} class=${binding.class_name}`,
    });
  }
  for (const producer of wrangler.queues.producers) {
    out.push({
      key: `queue:${producer.binding}`,
      line: `queue ${producer.binding} queue=${producer.queue}`,
    });
  }
  for (const service of wrangler.services) {
    out.push({
      key: `service:${service.binding}`,
      line: `service ${service.binding} service=${service.service}`,
    });
  }
  for (const dataset of wrangler.analytics_engine_datasets) {
    out.push({
      key: `ae:${dataset.binding}`,
      line: `ae ${dataset.binding} dataset=${dataset.dataset}`,
    });
  }
  for (const schedule of plan.schedules) {
    out.push({ key: `schedule:${schedule.handler}`, line: `schedule ${schedule.handler} (unmapped OPEN-139)` });
  }
  return out;
}

/**
 * Diff `next` against `previous` (null = first deploy: every line `+`).
 * Deterministic: next-plan order for `+`/`~`, previous-plan order for `-`.
 */
export function diffPlans(previous: DeployPlan | null, next: DeployPlan): PlanDiff {
  const nextLines = project(next);
  if (previous === null) {
    return { changed: nextLines.length > 0, lines: nextLines.map((entry) => `+ ${entry.line}`) };
  }
  const prevLines = project(previous);
  const prevByKey = new Map(prevLines.map((entry) => [entry.key, entry.line]));
  const nextKeys = new Set(nextLines.map((entry) => entry.key));
  const lines: string[] = [];
  for (const entry of nextLines) {
    const old = prevByKey.get(entry.key);
    if (old === undefined) {
      lines.push(`+ ${entry.line}`);
    } else if (old !== entry.line) {
      lines.push(`~ ${entry.key}: ${old} -> ${entry.line}`);
    }
  }
  for (const entry of prevLines) {
    if (!nextKeys.has(entry.key)) lines.push(`- ${entry.line}`);
  }
  return { changed: lines.length > 0, lines };
}

function isDeployPlan(value: unknown): value is DeployPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (typeof root["wrangler"] !== "object" || root["wrangler"] === null) return false;
  return Array.isArray(root["schedules"]);
}

/**
 * Load the previously stored canonical plan JSON. Absent file -> null
 * (first deploy). Present-but-invalid -> loud throw naming the file.
 */
export function loadPreviousPlan(path: string): DeployPlan | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `deploy review: cannot read previous plan ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `deploy review: previous plan ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isDeployPlan(parsed)) {
    throw new Error(`deploy review: previous plan ${path} is not a DeployPlan (want { wrangler, schedules })`);
  }
  return parsed;
}

/**
 * Confirm gate: throws unless `--yes` was passed. The message names the
 * review path so a bare invocation teaches the safe flow.
 */
export function requireYes(yes: boolean, what: string): void {
  if (!yes) {
    throw new Error(`refusing to ${what} without --yes: pass --preview to review, --yes to confirm (nothing was written)`);
  }
}

/** Human-reviewable preview: the rendered plan followed by the diff. */
export function formatPreview(plan: DeployPlan, diff: PlanDiff): string {
  const header = diff.changed
    ? `deploy preview: ${diff.lines.length} change(s) vs previous plan`
    : "deploy preview: no changes vs previous plan";
  const body = diff.changed ? diff.lines.join("\n") : "(identical)";
  return `${header}\n\n${renderWranglerToml(plan)}\nchanges:\n${body}\n`;
}
