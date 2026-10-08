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
import { escapeAttr, escapeHtml } from "./escape.js";
import { resolveCaption } from "./messages.js";
import { review } from "./review.js";
function assertDump(dump) {
    if (typeof dump !== "object" || dump === null || Array.isArray(dump)) {
        throw new TypeError("policyPage: dump must be an object");
    }
    if (dump.version !== 1) {
        throw new TypeError(`policyPage: unsupported dump version ${JSON.stringify(dump.version)}`);
    }
    for (const key of ["roles", "models", "operations"]) {
        if (!Array.isArray(dump[key])) {
            throw new TypeError(`policyPage: dump.${key} must be an array`);
        }
    }
}
function assertText(value, what) {
    if (typeof value !== "string") {
        throw new TypeError(`policyPage: dump ${what} must be a string`);
    }
    return value;
}
function modelPolicies(model) {
    const out = [];
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
function operationPolicies(operation) {
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
function rolePolicy(role) {
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
export function policyDumpSections(dump) {
    assertDump(dump);
    const sections = [];
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
/**
 * Render the policy dump as labelled sections of `review()` entries.
 * Section headings are dump canonical names; every entry renders through
 * `review()` so slot wording stays verbatim-or-unavailable.
 */
export async function policyPage(props) {
    const sections = policyDumpSections(props.dump);
    const name = props.caption === undefined ? "Policy" : props.caption;
    const rendered = [];
    for (const section of sections) {
        const entries = [];
        for (const policy of section.policies) {
            entries.push(await review({ context: props.context, policy }));
        }
        rendered.push(`<section aria-label="${escapeAttr(section.heading)}">` +
            `<h2>${escapeHtml(section.heading)}</h2>${entries.join("")}</section>`);
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
 * disclosure, e.g. Approve:18). Identity/concurrency roots (`id`,
 * `version`) are terminal readable grants (A5/S1: `draft/CanEvent.can`
 * grants bare `id,version` via `fields=`, so authored draft grants beat
 * the stricter pre-A5 rule; reading one's own row identity discloses
 * nothing new since IDs/versions already circulate as opaque locators
 * and concurrency tokens per DESIGN §5). Like all safe metadata they
 * admit no descent and confer no fact, permission, or writability.
 */
export const SAFE_READABLE_METADATA = [
    "created",
    "updated",
    "created_by",
    "updated_by",
    "archived_at",
    "id",
    "version",
];
/** Whether `name` is safe readable metadata (see `SAFE_READABLE_METADATA`). */
export function isSafeReadableMetadata(name) {
    return SAFE_READABLE_METADATA.includes(name);
}
const SELECTOR_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MONEY_LEAVES = ["minor", "currency"];
const DELIVERY_LEAVES = ["id", "status", "error", "result"];
function unreadable(selector, reason) {
    return { ok: false, selector, reason };
}
function readable(selector, leaf) {
    return { ok: true, selector, leaf, fact: null, permission: null, writable: false };
}
function assertReadableModel(model) {
    if (typeof model !== "object" || model === null || Array.isArray(model)) {
        throw new TypeError("resolveReadableSelector: model must be an object");
    }
    const fields = model.fields;
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
        throw new TypeError("resolveReadableSelector: model.fields must be an object");
    }
}
/**
 * Resolve one policy/UI selector through the single canonical readable
 * path: declared fields first (mirroring ordinary member lookup
 * precedence), then the containment `parent` root, then safe metadata;
 * descent only through singular embedded contracts, money leaves, and
 * terminal delivery leaves. `context` selects the projection
 * (`fields=`/`columns=`) or predicate (`filter=`/`search=`) read
 * context; delivery leaves resolve only in projections (A5/S2).
 * Nullability never blocks resolution: a selector supplies no non-null
 * fact, so nullable intermediates resolve exactly like non-null ones.
 * Unavailable-schema (opaque) bases defer — accepted with leaf
 * `"deferred"` — instead of failing (A5/S3). Every other rejection
 * fails closed with a purpose-specific reason; malformed
 * model/selector/context *types* throw.
 */
export function resolveReadableSelector(model, selector, context = "projection") {
    assertReadableModel(model);
    if (typeof selector !== "string") {
        throw new TypeError("resolveReadableSelector: selector must be a string");
    }
    if (context !== "projection" && context !== "predicate") {
        throw new TypeError("resolveReadableSelector: context must be 'projection' or 'predicate'");
    }
    const segments = selector.split(".");
    const [root, ...rest] = segments;
    if (root === undefined || segments.some((segment) => !SELECTOR_SEGMENT_RE.test(segment))) {
        return unreadable(selector, `invalid readable selector ${JSON.stringify(selector)}: dot-separated identifiers only`);
    }
    const declared = model.fields[root];
    if (declared !== undefined) {
        return resolveFieldPath(selector, root, declared, rest, context);
    }
    if (root === "parent") {
        if (model.parent === undefined) {
            return unreadable(selector, "unknown member 'parent': model is not contained");
        }
        if (rest.length > 0) {
            return unreadable(selector, `selector ${JSON.stringify(selector)} traverses 'parent': ` +
                `selectors cannot grant another record's fields`);
        }
        return readable(selector, "parent");
    }
    if (isSafeReadableMetadata(root)) {
        if (rest.length > 0) {
            return unreadable(selector, `selector ${JSON.stringify(selector)} descends past terminal metadata '${root}'`);
        }
        return readable(selector, "metadata");
    }
    if (model.opaque === true) {
        return readable(selector, "deferred");
    }
    return unreadable(selector, `unknown member '${root}'`);
}
/**
 * Resolve the remainder of a declared-field path. Unavailable-schema
 * (opaque) holders defer (A5/S3); otherwise only singular embedded
 * values admit descent, delivery leaves resolve only in projections
 * (A5/S2), and references, arrays, files, secrets, actions, and
 * terminal scalars/leaves all fail closed.
 */
function resolveFieldPath(selector, root, field, rest, context) {
    if (rest.length === 0) {
        return readable(selector, "field");
    }
    let current = field;
    let holder = root;
    let descended = false;
    for (const [index, segment] of rest.entries()) {
        const last = index === rest.length - 1;
        if (current.opaque === true) {
            // Known delivery-observation leaves stay terminal on opaque
            // deliveries too (A5-N1: mirrors A's E2013 pin on the Opaque
            // "external delivery target" arm — descent past id/status/
            // error/result fails even when the schema is unavailable).
            if (current.kind === "delivery" && DELIVERY_LEAVES.includes(segment) && !last) {
                return unreadable(selector, `selector ${JSON.stringify(selector)} descends past terminal delivery leaf '${segment}'`);
            }
            return readable(selector, "deferred");
        }
        if (current.kind === "contract") {
            const next = current.fields?.[segment];
            if (next === undefined) {
                return unreadable(selector, `unknown member '${segment}' in selector ${JSON.stringify(selector)}`);
            }
            current = next;
            holder = segment;
            descended = true;
            continue;
        }
        if (current.kind === "money") {
            if (!MONEY_LEAVES.includes(segment)) {
                return unreadable(selector, `unknown member '${segment}' on money in selector ${JSON.stringify(selector)}`);
            }
            if (!last) {
                return unreadable(selector, `selector ${JSON.stringify(selector)} descends past terminal money leaf '${segment}'`);
            }
            return readable(selector, "money");
        }
        if (current.kind === "delivery") {
            if (context === "predicate") {
                return unreadable(selector, `selector ${JSON.stringify(selector)} addresses delivery '${holder}' in a predicate: ` +
                    `delivery leaves resolve only in projections, never in filter=/search=`);
            }
            if (segment === "progress") {
                return unreadable(selector, `selector ${JSON.stringify(selector)} addresses delivery progress: ` +
                    `nested progress needs receipt-observation authorization, not a T08 readable leaf`);
            }
            if (!DELIVERY_LEAVES.includes(segment)) {
                return unreadable(selector, `unknown member '${segment}' on delivery in selector ${JSON.stringify(selector)}`);
            }
            if (!last) {
                return unreadable(selector, `selector ${JSON.stringify(selector)} descends past terminal delivery leaf '${segment}'`);
            }
            return readable(selector, "delivery");
        }
        if (current.kind === "reference") {
            return unreadable(selector, `selector ${JSON.stringify(selector)} traverses reference '${holder}': ` +
                `selectors cannot grant another record's fields`);
        }
        if (current.kind === "array") {
            return unreadable(selector, `selector ${JSON.stringify(selector)} traverses array '${holder}': ` +
                `selectors never descend through arrays`);
        }
        if (current.kind === "file" || current.kind === "secret" || current.kind === "action") {
            return unreadable(selector, `selector ${JSON.stringify(selector)} traverses ${current.kind} '${holder}': ` +
                `selectors never descend through ${current.kind} values`);
        }
        return unreadable(selector, `selector ${JSON.stringify(selector)} descends past terminal '${holder}'`);
    }
    return readable(selector, descended ? "value" : "field");
}
/**
 * Resolve a selector list through the canonical path. Matching grants
 * union paths (DESIGN L310): the result holds exactly the valid inputs —
 * a leaf never expands to its container or siblings, so naming
 * `amount.currency` resolves only that leaf, never `amount`/`minor`.
 * `context` applies to every entry: projection for `fields=`/`columns=`
 * lists, predicate for `filter=`/`search=` lists (A5/S2).
 */
export function selectReadableLeaves(model, selectors, context = "projection") {
    assertReadableModel(model);
    if (!Array.isArray(selectors)) {
        throw new TypeError("selectReadableLeaves: selectors must be an array");
    }
    const resolved = [];
    const failed = [];
    for (const selector of selectors) {
        const result = resolveReadableSelector(model, selector, context);
        if (result.ok) {
            resolved.push(result);
        }
        else {
            failed.push(result);
        }
    }
    return { resolved, failed };
}
/**
 * Whether `selector` resolves through the canonical readable path in
 * the given read context (projection by default; A5/S2).
 */
export function isReadableSelector(model, selector, context = "projection") {
    return resolveReadableSelector(model, selector, context).ok;
}
//# sourceMappingURL=policyPage.js.map