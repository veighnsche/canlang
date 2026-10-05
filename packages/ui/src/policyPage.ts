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
 *
 * Readable selectors (T08 UI follow-up): the canonical UI-side path
 * resolving policy `fields=` and UI `columns=`/`filter=` leaves through
 * one function (declared fields, the containment `parent` root, safe
 * metadata, money leaves, singular embedded contracts, terminal delivery
 * leaves). Readability carries no fact, permission, or writability
 * (continuation-contract §9; R07/R08).
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

// ---------------------------------------------------------------------------
// Canonical readable selectors (T08 UI follow-up)
// ---------------------------------------------------------------------------

/**
 * Safe record metadata readable through policy `fields=` and UI
 * `columns=`/`filter=` selectors (R07: authorized history/relationship
 * disclosure, e.g. Approve:18). Identity/concurrency metadata (`id`,
 * `version`) is never a readable grant: it names the record for
 * lookup/concurrency, and no draft grants it via `fields=`.
 */
export const SAFE_READABLE_METADATA: readonly string[] = [
  "created",
  "updated",
  "created_by",
  "updated_by",
  "archived_at",
];

/** Whether `name` is safe readable metadata (see `SAFE_READABLE_METADATA`). */
export function isSafeReadableMetadata(name: string): boolean {
  return SAFE_READABLE_METADATA.includes(name);
}

/**
 * Field kinds the canonical readable path distinguishes. Only singular
 * embedded typed values (`contract`, `money`, `delivery` leaves) admit
 * descent; every other kind is terminal or untraversable (DESIGN L310).
 */
export type ReadableFieldKind =
  | "scalar"
  | "money"
  | "contract"
  | "delivery"
  | "reference"
  | "array"
  | "file"
  | "secret"
  | "action";

/** One declared field of a readable model/contract schema. */
export interface ReadableFieldSchema {
  readonly kind: ReadableFieldKind;
  /** Sub-fields for `kind: "contract"`; ignored otherwise. */
  readonly fields?: Record<string, ReadableFieldSchema>;
}

/**
 * Minimal model shape for readable resolution: declared domain fields
 * plus containment. Reserved metadata names never appear in `fields`;
 * they resolve through the safe-metadata root instead.
 */
export interface ReadableModelSchema {
  readonly fields: Record<string, ReadableFieldSchema>;
  /**
   * Containment parent model identity (`Model in Parent`). Presence alone
   * admits the bare `parent` root; descent past `parent` always fails
   * because selectors cannot grant another record's fields (DESIGN L310).
   */
  readonly parent?: string;
}

/**
 * Resolved leaf class: which canonical root accepted the path. `field`
 * is a declared-field terminal (bare root, any kind); `value` is a leaf
 * reached through at least one singular embedded contract.
 */
export type ReadableLeafKind = "field" | "parent" | "metadata" | "money" | "value" | "delivery";

/** Accepted readable selector. Readability carries no fact, grant, or writability. */
export interface ReadableSelectorOk {
  readonly ok: true;
  readonly selector: string;
  readonly leaf: ReadableLeafKind;
  /** Selectors supply no non-null fact (continuation-contract §9). Always null. */
  readonly fact: null;
  /** Readability grants no permission (R07/R08). Always null. */
  readonly permission: null;
  /** Readability never implies writability (R07/R08). Always false. */
  readonly writable: false;
}

/** Rejected readable selector: the path stays unreadable through this route. */
export interface ReadableSelectorError {
  readonly ok: false;
  readonly selector: string;
  readonly reason: string;
}

export type ReadableSelectorResult = ReadableSelectorOk | ReadableSelectorError;

const SELECTOR_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MONEY_LEAVES: readonly string[] = ["minor", "currency"];
const DELIVERY_LEAVES: readonly string[] = ["id", "status", "error", "result"];

function unreadable(selector: string, reason: string): ReadableSelectorError {
  return { ok: false, selector, reason };
}

function readable(selector: string, leaf: ReadableLeafKind): ReadableSelectorOk {
  return { ok: true, selector, leaf, fact: null, permission: null, writable: false };
}

function assertReadableModel(model: ReadableModelSchema): void {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    throw new TypeError("resolveReadableSelector: model must be an object");
  }
  const fields: unknown = (model as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new TypeError("resolveReadableSelector: model.fields must be an object");
  }
}

/**
 * Resolve one policy/UI selector through the single canonical readable
 * path: declared fields first (mirroring ordinary member lookup
 * precedence), then the containment `parent` root, then safe metadata;
 * descent only through singular embedded contracts, money leaves, and
 * terminal delivery leaves. Nullability never blocks resolution: a
 * selector supplies no non-null fact, so nullable intermediates resolve
 * exactly like non-null ones. Every rejection fails closed with a
 * purpose-specific reason; malformed model/selector *types* throw.
 */
export function resolveReadableSelector(
  model: ReadableModelSchema,
  selector: string,
): ReadableSelectorResult {
  assertReadableModel(model);
  if (typeof selector !== "string") {
    throw new TypeError("resolveReadableSelector: selector must be a string");
  }
  const segments = selector.split(".");
  const [root, ...rest] = segments;
  if (root === undefined || segments.some((segment) => !SELECTOR_SEGMENT_RE.test(segment))) {
    return unreadable(
      selector,
      `invalid readable selector ${JSON.stringify(selector)}: dot-separated identifiers only`,
    );
  }
  const declared = model.fields[root];
  if (declared !== undefined) {
    return resolveFieldPath(selector, root, declared, rest);
  }
  if (root === "parent") {
    if (model.parent === undefined) {
      return unreadable(selector, "unknown member 'parent': model is not contained");
    }
    if (rest.length > 0) {
      return unreadable(
        selector,
        `selector ${JSON.stringify(selector)} traverses 'parent': ` +
          `selectors cannot grant another record's fields`,
      );
    }
    return readable(selector, "parent");
  }
  if (isSafeReadableMetadata(root)) {
    if (rest.length > 0) {
      return unreadable(
        selector,
        `selector ${JSON.stringify(selector)} descends past terminal metadata '${root}'`,
      );
    }
    return readable(selector, "metadata");
  }
  if (root === "id" || root === "version") {
    return unreadable(selector, `reserved identity metadata '${root}' is never a readable grant`);
  }
  return unreadable(selector, `unknown member '${root}'`);
}

/**
 * Resolve the remainder of a declared-field path. Only singular embedded
 * values admit descent; references, arrays, files, secrets, actions, and
 * terminal scalars/leaves all fail closed.
 */
function resolveFieldPath(
  selector: string,
  root: string,
  field: ReadableFieldSchema,
  rest: readonly string[],
): ReadableSelectorResult {
  if (rest.length === 0) {
    return readable(selector, "field");
  }
  let current = field;
  let holder = root;
  let descended = false;
  for (const [index, segment] of rest.entries()) {
    const last = index === rest.length - 1;
    if (current.kind === "contract") {
      const next = current.fields?.[segment];
      if (next === undefined) {
        return unreadable(
          selector,
          `unknown member '${segment}' in selector ${JSON.stringify(selector)}`,
        );
      }
      current = next;
      holder = segment;
      descended = true;
      continue;
    }
    if (current.kind === "money") {
      if (!MONEY_LEAVES.includes(segment)) {
        return unreadable(
          selector,
          `unknown member '${segment}' on money in selector ${JSON.stringify(selector)}`,
        );
      }
      if (!last) {
        return unreadable(
          selector,
          `selector ${JSON.stringify(selector)} descends past terminal money leaf '${segment}'`,
        );
      }
      return readable(selector, "money");
    }
    if (current.kind === "delivery") {
      if (segment === "progress") {
        return unreadable(
          selector,
          `selector ${JSON.stringify(selector)} addresses delivery progress: ` +
            `nested progress needs receipt-observation authorization, not a T08 readable leaf`,
        );
      }
      if (!DELIVERY_LEAVES.includes(segment)) {
        return unreadable(
          selector,
          `unknown member '${segment}' on delivery in selector ${JSON.stringify(selector)}`,
        );
      }
      if (!last) {
        return unreadable(
          selector,
          `selector ${JSON.stringify(selector)} descends past terminal delivery leaf '${segment}'`,
        );
      }
      return readable(selector, "delivery");
    }
    if (current.kind === "reference") {
      return unreadable(
        selector,
        `selector ${JSON.stringify(selector)} traverses reference '${holder}': ` +
          `selectors cannot grant another record's fields`,
      );
    }
    if (current.kind === "array") {
      return unreadable(
        selector,
        `selector ${JSON.stringify(selector)} traverses array '${holder}': ` +
          `selectors never descend through arrays`,
      );
    }
    if (current.kind === "file" || current.kind === "secret" || current.kind === "action") {
      return unreadable(
        selector,
        `selector ${JSON.stringify(selector)} traverses ${current.kind} '${holder}': ` +
          `selectors never descend through ${current.kind} values`,
      );
    }
    return unreadable(
      selector,
      `selector ${JSON.stringify(selector)} descends past terminal '${holder}'`,
    );
  }
  return readable(selector, descended ? "value" : "field");
}

/** One policy `fields=` / UI `columns=`/`filter=` list resolved leaf by leaf. */
export interface ReadableLeafSelection {
  readonly resolved: ReadonlyArray<ReadableSelectorOk>;
  readonly failed: ReadonlyArray<ReadableSelectorError>;
}

/**
 * Resolve a selector list through the canonical path. Matching grants
 * union paths (DESIGN L310): the result holds exactly the valid inputs —
 * a leaf never expands to its container or siblings, so naming
 * `amount.currency` resolves only that leaf, never `amount`/`minor`.
 */
export function selectReadableLeaves(
  model: ReadableModelSchema,
  selectors: ReadonlyArray<string>,
): ReadableLeafSelection {
  assertReadableModel(model);
  if (!Array.isArray(selectors)) {
    throw new TypeError("selectReadableLeaves: selectors must be an array");
  }
  const resolved: ReadableSelectorOk[] = [];
  const failed: ReadableSelectorError[] = [];
  for (const selector of selectors) {
    const result = resolveReadableSelector(model, selector);
    if (result.ok) {
      resolved.push(result);
    } else {
      failed.push(result);
    }
  }
  return { resolved, failed };
}

/** Whether `selector` resolves through the canonical readable path. */
export function isReadableSelector(model: ReadableModelSchema, selector: string): boolean {
  return resolveReadableSelector(model, selector).ok;
}
