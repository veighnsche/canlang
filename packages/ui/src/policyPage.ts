/**
 * Company-policy page from compiler output (B3-I5): render a `can policy`
 * JSON dump as page sections feeding `review()` props.
 *
 * Every policy string rendered here originates from the dump (declared
 * `.can` policy/invariant/role/`by=` content via `compiler/src/policy.rs`);
 * this module invents no policy wording. Structural chrome (section shells,
 * `review()` labels, the unavailable presentation) is UI-owned, never
 * policy content. Malformed dumps throw; there is no guessed rendering.
 *
 * Dump-shape contract: mirrors `policy_dump_json` (`version: 1`).
 */

import type {
  MessageValue,
  PresentationContext,
  ReviewPolicyView,
} from "../../contracts/src/presentation.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import { resolveCaption } from "./messages.js";
import { review } from "./review.js";

/** One role entry of the policy dump. */
export interface PolicyDumpRole {
  readonly package: string;
  readonly name: string;
  readonly canonical: string;
  readonly label?: string;
}

/** One `policy Model read=...` entry of the policy dump. */
export interface PolicyDumpPolicy {
  readonly kind: string;
  readonly grantee: string;
  readonly where?: string;
  readonly source: string;
}

/** One `invariant Model: ...` entry of the policy dump. */
export interface PolicyDumpInvariant {
  readonly predicate: string;
  readonly source: string;
}

/** One model's declared policy surface. */
export interface PolicyDumpModel {
  readonly canonical: string;
  readonly policies: ReadonlyArray<PolicyDumpPolicy>;
  readonly invariants: ReadonlyArray<PolicyDumpInvariant>;
}

/** One operation's admission surface (`by=` + `require`). */
export interface PolicyDumpOperation {
  readonly canonical: string;
  readonly kind: string;
  readonly by?: string;
  readonly requires: ReadonlyArray<string>;
  readonly source: string;
}

/** Root of the `can policy --json` dump consumed by this module. */
export interface PolicyDump {
  readonly version: 1;
  readonly roles: ReadonlyArray<PolicyDumpRole>;
  readonly models: ReadonlyArray<PolicyDumpModel>;
  readonly operations: ReadonlyArray<PolicyDumpOperation>;
}

/** One rendered section: a dump-derived heading plus `review()` policies. */
export interface PolicyPageSection {
  readonly heading: string;
  readonly policies: ReadonlyArray<ReviewPolicyView>;
}

function assertDump(dump: PolicyDump): void {
  if (typeof dump !== "object" || dump === null || Array.isArray(dump)) {
    throw new TypeError("policyPage: dump must be an object");
  }
  if (dump.version !== 1) {
    throw new TypeError(`policyPage: unsupported dump version ${JSON.stringify(dump.version)}`);
  }
  for (const key of ["roles", "models", "operations"] as const) {
    if (!Array.isArray(dump[key])) {
      throw new TypeError(`policyPage: dump.${key} must be an array`);
    }
  }
}

function assertText(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`policyPage: dump ${what} must be a string`);
  }
  return value;
}

function modelPolicies(model: PolicyDumpModel): ReviewPolicyView[] {
  const out: ReviewPolicyView[] = [];
  for (const policy of model.policies) {
    const kind = assertText(policy.kind, "policy.kind");
    const grantee = assertText(policy.grantee, "policy.grantee");
    out.push({
      text: assertText(policy.source, "policy.source"),
      decision: `${kind}=${grantee}`,
      rationale: policy.where === undefined ? null : assertText(policy.where, "policy.where"),
      actor: null,
      time: null,
    });
  }
  for (const invariant of model.invariants) {
    out.push({
      text: assertText(invariant.source, "invariant.source"),
      decision: null,
      rationale: assertText(invariant.predicate, "invariant.predicate"),
      actor: null,
      time: null,
    });
  }
  return out;
}

function operationPolicies(operation: PolicyDumpOperation): ReviewPolicyView[] {
  const source = assertText(operation.source, "operation.source");
  const by = operation.by === undefined ? null : assertText(operation.by, "operation.by");
  if (operation.requires.length === 0) {
    return [{ text: source, decision: by, rationale: null, actor: null, time: null }];
  }
  return operation.requires.map((require) => ({
    text: source,
    decision: by,
    rationale: assertText(require, "operation.requires[]"),
    actor: null,
    time: null,
  }));
}

function rolePolicy(role: PolicyDumpRole): ReviewPolicyView {
  return {
    text: role.label === undefined ? assertText(role.name, "role.name") : assertText(role.label, "role.label"),
    decision: assertText(role.canonical, "role.canonical"),
    rationale: null,
    actor: null,
    time: null,
  };
}

/**
 * Map a policy dump to page sections. Pure: headings and every
 * `ReviewPolicyView` slot derive from dump members only. Models first,
 * then operations, then roles, each in dump order.
 */
export function policyDumpSections(dump: PolicyDump): PolicyPageSection[] {
  assertDump(dump);
  const sections: PolicyPageSection[] = [];
  for (const model of dump.models) {
    sections.push({
      heading: assertText(model.canonical, "model.canonical"),
      policies: modelPolicies(model),
    });
  }
  for (const operation of dump.operations) {
    sections.push({
      heading: assertText(operation.canonical, "operation.canonical"),
      policies: operationPolicies(operation),
    });
  }
  for (const role of dump.roles) {
    sections.push({
      heading: assertText(role.canonical, "role.canonical"),
      policies: [rolePolicy(role)],
    });
  }
  return sections;
}

export interface PolicyPageProps {
  readonly context: PresentationContext;
  readonly dump: PolicyDump;
  /** Page caption; UI chrome, never policy content. Defaults to "Policy". */
  readonly caption?: MessageValue;
}

/**
 * Render the policy dump as labelled sections of `review()` entries.
 * Section headings are dump canonical names; every entry renders through
 * `review()` so slot wording stays verbatim-or-unavailable.
 */
export async function policyPage(props: PolicyPageProps): Promise<string> {
  const sections = policyDumpSections(props.dump);
  const name = props.caption === undefined ? "Policy" : props.caption;
  const rendered: string[] = [];
  for (const section of sections) {
    const entries: string[] = [];
    for (const policy of section.policies) {
      entries.push(await review({ context: props.context, policy }));
    }
    rendered.push(
      `<section aria-label="${escapeAttr(section.heading)}">` +
        `<h2>${escapeHtml(section.heading)}</h2>${entries.join("")}</section>`,
    );
  }
  const label = resolveCaption(name, props.context);
  if (label === "") {
    throw new Error("policyPage caption must not be empty");
  }
  return `<section aria-label="${escapeAttr(label)}">${rendered.join("")}</section>`;
}
