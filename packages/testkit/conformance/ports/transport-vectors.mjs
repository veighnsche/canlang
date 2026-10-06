/**
 * Transport v0 encoder/decoder conformance vectors (C03.2, lane C-abi).
 *
 * Source of truth: `docs/research/package-subsystem-ports-20261006/
 * evidence/implementation/shared/transport-contracts.json` @ ec81b09
 * (C03.1, accepted). Every vector cites its contract rule. Vectors are
 * language-neutral JSON (non-JSON values use explicit `$tag` escapes);
 * key order and duplicate keys use `entries` arrays since JSON objects
 * cannot carry them.
 *
 * Three harnesses:
 * - `reference-rule`: executable contract rules shipped below
 *   (`gateVersion`, `checkLength`, token-once ledger). The self-check
 *   runs these vectors end to end: bad versions/lengths MUST reject.
 * - `future-codec`: fixtures for encoders/decoders that do not exist
 *   yet (C04.1+). Exported via `runVectors(encoder, decoder)`; the
 *   self-check validates their schema only and never claims codec
 *   behavior. No latest-version or unbuilt-route assertions anywhere.
 * - `must-hold`: declarative corruption/exclusion rules with no
 *   executable fixture at C03.2; cited as negative-evidence
 *   requirements by C03.complete/C04 gates.
 *
 * Run the self-check with `node transport-vectors.mjs --self-check`.
 * Exit 0 prints the vector count; any failure exits 1 with the vector.
 */

export const TRANSPORT_VERSION = 'v0';
export const CONTRACTS_COMMIT = 'ec81b09';
export const CONTRACTS_PATH =
  'docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/transport-contracts.json';

/* ------------------------------------------------------------------ */
/* Reference rules: the contract's executable MUSTs.                   */
/*                                                                     */
/* These are the rules themselves (version gate, length checker,       */
/* token-once ledger), not a port: every native/binding implementation */
/* must reproduce their verdicts byte for byte.                        */
/* ------------------------------------------------------------------ */

/** Known transport versions. Unknown versions never fall through. */
const KNOWN_VERSIONS = new Set(['v0']);

/**
 * Negotiation gate (contract: versioning + negotiation).
 * Accept iff the declared version is known AND the peer profile
 * equals the selected profile AND no mid-call switch is attempted.
 * Refusals happen before any evaluation (stage `negotiation`).
 */
export function gateVersion(input) {
  const { declared, peerProfile, selectedProfile, midCallSwitch } = input ?? {};
  if (typeof declared !== 'string' || !KNOWN_VERSIONS.has(declared)) {
    return { ok: false, stage: 'negotiation', code: 'version/unknown' };
  }
  if (peerProfile !== selectedProfile) {
    return { ok: false, stage: 'negotiation', code: 'version/profile-mismatch' };
  }
  if (midCallSwitch === true) {
    return { ok: false, stage: 'negotiation', code: 'version/mid-call-switch' };
  }
  return { ok: true, stage: 'negotiation', version: declared };
}

/**
 * Declared-length checker (contract: corruption_rules lengths).
 * Both counts are validated BEFORE any conversion (never
 * coerce-then-check): non-integer or negative counts reject, then
 * declared-vs-available decides truncated/oversized/ok. All failures
 * are deterministic transport errors, never semantic results.
 */
export function checkLength(input) {
  const { declared, available } = input ?? {};
  for (const [name, value] of [
    ['declared', declared],
    ['available', available],
  ]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { ok: false, stage: 'transport', code: 'length/invalid-count', member: name };
    }
  }
  if (available < declared) {
    return { ok: false, stage: 'transport', code: 'length/truncated' };
  }
  if (available > declared) {
    return { ok: false, stage: 'transport', code: 'length/oversized' };
  }
  return { ok: true, stage: 'transport', length: declared };
}

/**
 * Token-once ledger (contract: corruption_rules tokens + lifetime).
 * Minimal model: `issue(callId)` mints a token bound to one call;
 * `use(callId, token)` consumes it exactly once; `cancel(callId)`
 * fails the call deterministically at its current stage. Mismatched,
 * replayed, and cross-call tokens fail; cancellation releases.
 */
export function createTokenLedger() {
  const calls = new Map();
  let serial = 0;
  return {
    issue(callId) {
      serial += 1;
      const token = `tok-${serial}`;
      calls.set(callId, { token, consumed: false, cancelled: false, stage: 'start' });
      return token;
    },
    advance(callId, stage) {
      const call = calls.get(callId);
      if (call !== undefined) call.stage = stage;
    },
    use(callId, token) {
      const call = calls.get(callId);
      if (call === undefined || call.token !== token) {
        return { ok: false, stage: 'transport', code: 'lifetime/token-mismatch' };
      }
      if (call.cancelled) {
        return { ok: false, stage: call.stage, code: 'lifetime/cancelled' };
      }
      if (call.consumed) {
        return { ok: false, stage: 'transport', code: 'lifetime/token-replay' };
      }
      call.consumed = true;
      return { ok: true, stage: call.stage, released: false };
    },
    cancel(callId) {
      const call = calls.get(callId);
      if (call === undefined) {
        return { ok: false, stage: 'transport', code: 'lifetime/unknown-call' };
      }
      call.cancelled = true;
      return { ok: false, stage: call.stage, code: 'lifetime/cancelled', released: true };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Vectors. `harness: 'reference-rule'` runs below; `future-codec`    */
/* is fixture data for C04.1+ (schema-checked only, never executed).  */
/* `$tag` escapes keep every vector JSON-serializable: f64 carries    */
/* exact bits, bigint carries decimal digits, text may hold lone      */
/* surrogates, and key order/duplicates use `entries` arrays.         */
/* ------------------------------------------------------------------ */

export const VECTORS = [
  // -- version (contract: versioning + corruption_rules versions) --
  {
    id: 'version/v0-known-profile-accepts', area: 'version', harness: 'reference-rule',
    rule: 'versioning.base_version',
    input: { declared: 'v0', peerProfile: 'values', selectedProfile: 'values' },
    expect: { ok: true, stage: 'negotiation', version: 'v0' },
  },
  {
    id: 'version/unknown-never-falls-through', area: 'version', harness: 'reference-rule',
    rule: 'corruption_rules[0]',
    input: { declared: 'v9', peerProfile: 'values', selectedProfile: 'values' },
    expect: { ok: false, stage: 'negotiation', code: 'version/unknown' },
  },
  {
    id: 'version/missing-declared-rejects', area: 'version', harness: 'reference-rule',
    rule: 'versioning.negotiation',
    input: { peerProfile: 'values', selectedProfile: 'values' },
    expect: { ok: false, stage: 'negotiation', code: 'version/unknown' },
  },
  {
    id: 'version/profile-mismatch-refuses-before-evaluation', area: 'version', harness: 'reference-rule',
    rule: 'versioning.negotiation',
    input: { declared: 'v0', peerProfile: 'values', selectedProfile: 'work' },
    expect: { ok: false, stage: 'negotiation', code: 'version/profile-mismatch' },
  },
  {
    id: 'version/mid-call-switch-refuses', area: 'version', harness: 'reference-rule',
    rule: 'versioning.negotiation',
    input: { declared: 'v0', peerProfile: 'values', selectedProfile: 'values', midCallSwitch: true },
    expect: { ok: false, stage: 'negotiation', code: 'version/mid-call-switch' },
  },
  // -- length (contract: corruption_rules lengths) --
  {
    id: 'length/exact-frame-ok', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[1]',
    input: { declared: 8, available: 8 },
    expect: { ok: true, stage: 'transport', length: 8 },
  },
  {
    id: 'length/empty-frame-ok', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[1]',
    input: { declared: 0, available: 0 },
    expect: { ok: true, stage: 'transport', length: 0 },
  },
  {
    id: 'length/short-frame-truncates', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[1]',
    input: { declared: 8, available: 5 },
    expect: { ok: false, stage: 'transport', code: 'length/truncated' },
  },
  {
    id: 'length/overlong-frame-oversized', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[1]',
    input: { declared: 8, available: 9 },
    expect: { ok: false, stage: 'transport', code: 'length/oversized' },
  },
  {
    id: 'length/fractional-count-rejects-before-conversion', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[2]',
    input: { declared: 8.5, available: 8 },
    expect: { ok: false, stage: 'transport', code: 'length/invalid-count', member: 'declared' },
  },
  {
    id: 'length/negative-count-rejects-before-conversion', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[2]',
    input: { declared: 8, available: -1 },
    expect: { ok: false, stage: 'transport', code: 'length/invalid-count', member: 'available' },
  },
  {
    id: 'length/huge-count-validated-not-coerced', area: 'length', harness: 'reference-rule',
    rule: 'corruption_rules[2]',
    input: { declared: Number.MAX_SAFE_INTEGER, available: 0 },
    expect: { ok: false, stage: 'transport', code: 'length/truncated' },
  },
  // -- scalar f64 (contract: scalars.f64; values-owned semantics) --
  {
    id: 'scalar/f64-negative-zero-bits', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.f64',
    input: { $tag: 'f64', text: '-0', bits: '0x8000000000000000' },
    expect: { ok: true, bits: '0x8000000000000000', negativeZero: true },
  },
  {
    id: 'scalar/f64-infinities-representable', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.f64',
    input: { $tag: 'f64', text: 'Infinity', bits: '0x7ff0000000000000' },
    expect: { ok: true, bits: '0x7ff0000000000000' },
  },
  {
    id: 'scalar/f64-negative-infinity-representable', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.f64',
    input: { $tag: 'f64', text: '-Infinity', bits: '0xfff0000000000000' },
    expect: { ok: true, bits: '0xfff0000000000000' },
  },
  {
    id: 'scalar/f64-overflow-spelling-never-precollapsed', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.f64',
    input: { $tag: 'f64', text: '1e400', bits: '0x7ff0000000000000' },
    expect: { ok: true, bits: '0x7ff0000000000000', note: 'host parse outcome reaches the profile rejection stage' },
  },
  {
    id: 'scalar/f64-huge-json-integer-rounds-per-host', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.f64',
    input: { $tag: 'f64', text: '9007199254740993', bits: '0x4330000000000000' },
    expect: { ok: true, bits: '0x4330000000000000', note: '2^53+1 rounds to 2^53 under host parsing; bits preserved' },
  },
  // -- scalar bigint (contract: scalars.bigint) --
  {
    id: 'scalar/bigint-zero', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.bigint',
    input: { $tag: 'bigint', digits: '0' },
    expect: { ok: true, digits: '0' },
  },
  {
    id: 'scalar/bigint-arbitrary-width-lossless', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.bigint',
    input: { $tag: 'bigint', digits: `1${'0'.repeat(1000)}` },
    expect: { ok: true, digits: `1${'0'.repeat(1000)}`, note: '10^1000 crosses with no narrowing' },
  },
  {
    id: 'scalar/bigint-negative-wide', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.bigint',
    input: { $tag: 'bigint', digits: `-${'9'.repeat(100)}` },
    expect: { ok: true, digits: `-${'9'.repeat(100)}` },
  },
  // -- scalar numeric strings (contract: scalars.numeric_strings) --
  {
    id: 'scalar/numeric-string-stays-text', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.numeric_strings',
    input: { $tag: 'text', value: '007' },
    expect: { ok: true, kind: 'text', value: '007' },
  },
  {
    id: 'scalar/numeric-key-order-preserved', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.numeric_strings',
    input: { $tag: 'entries', entries: [['2', 1], ['10', 2], ['1', 3]] },
    expect: { ok: true, order: ['2', '10', '1'], note: 'observed order preserved exactly as data' },
  },
  {
    id: 'scalar/duplicate-keys-preserved', area: 'scalar', harness: 'future-codec',
    rule: 'scalars.numeric_strings',
    input: { $tag: 'entries', entries: [['a', 1], ['a', 2]] },
    expect: { ok: true, entries: [['a', 1], ['a', 2]] },
  },
  // -- text (contract: text.lossless_utf16 + text.enumeration) --
  {
    id: 'text/lone-surrogate-in-text-preserved', area: 'text', harness: 'future-codec',
    rule: 'text.lossless_utf16',
    input: { $tag: 'text', value: 'A\uDC00B', units: [65, 56320, 66] },
    expect: { ok: true, units: [65, 56320, 66], note: 'lone low surrogate crosses as its code unit; never replaced' },
  },
  {
    id: 'text/lone-surrogate-in-key-preserved', area: 'text', harness: 'future-codec',
    rule: 'text.lossless_utf16',
    input: { $tag: 'entries', entries: [['k\uDC0D', 1]], keyUnits: [[107, 56333]] },
    expect: { ok: true, keyUnits: [[107, 56333]] },
  },
  {
    id: 'text/control-characters-preserved', area: 'text', harness: 'future-codec',
    rule: 'text.lossless_utf16',
    input: { $tag: 'text', value: 'a\u0000b', units: [97, 0, 98] },
    expect: { ok: true, units: [97, 0, 98] },
  },
  {
    id: 'text/own-proto-key-is-data', area: 'text', harness: 'future-codec',
    rule: 'text.enumeration',
    input: { $tag: 'entries', entries: [['__proto__', { polluted: false }]] },
    expect: { ok: true, entries: [['__proto__', { polluted: false }]], note: 'own __proto__ is data, never prototype' },
  },
  {
    id: 'text/js-enumeration-order-preserved', area: 'text', harness: 'future-codec',
    rule: 'text.enumeration',
    input: { $tag: 'entries', entries: [['b', 1], ['2', 2], ['a', 3], ['10', 4]] },
    expect: { ok: true, order: ['b', '2', 'a', '10'], note: 'observed enumeration order preserved exactly as data' },
  },
  // -- presence (contract: presence.rule; profile-owned interpretation) --
  {
    id: 'presence/five-positions-distinct', area: 'presence', harness: 'future-codec',
    rule: 'presence.rule',
    input: {
      $tag: 'presence-object',
      entries: [
        ['ownNull', { $tag: 'presence', kind: 'own-null' }],
        ['ownUndefined', { $tag: 'presence', kind: 'own-undefined' }],
      ],
      missing: ['absent'],
      inherited: [{ key: 'fromProto', proto: { fromProto: 1 } }],
      accessors: [{ key: 'computed', get: 'return 7' }],
    },
    expect: { ok: true, tags: ['missing', 'own-null', 'own-undefined', 'inherited', 'accessor-backed'] },
  },
  {
    id: 'presence/absent-vs-undefined-never-conflated', area: 'presence', harness: 'future-codec',
    rule: 'presence.rule',
    input: {
      $tag: 'presence-object',
      entries: [['u', { $tag: 'presence', kind: 'own-undefined' }]],
      missing: ['m'],
    },
    expect: { ok: true, distinct: [['m', 'missing'], ['u', 'own-undefined']] },
  },
  // -- envelopes (contract: envelopes.*) --
  {
    id: 'envelope/result-carries-profile-token-payload-stage', area: 'envelope', harness: 'future-codec',
    rule: 'envelopes.result_envelope',
    input: {
      $tag: 'result-envelope',
      profile: 'values', token: 'tok-1', stage: 'confirmed',
      payload: { $tag: 'presence', kind: 'own-null' },
    },
    expect: { ok: true, required: ['profile', 'token', 'payload', 'stage'] },
  },
  {
    id: 'envelope/result-missing-token-rejects', area: 'envelope', harness: 'future-codec',
    rule: 'envelopes.result_envelope',
    input: { $tag: 'result-envelope', profile: 'values', stage: 'confirmed', payload: 1 },
    expect: { ok: false, code: 'envelope/missing-member', member: 'token' },
  },
  {
    id: 'envelope/error-ordered-tagged-with-stage', area: 'envelope', harness: 'future-codec',
    rule: 'envelopes.error_envelope',
    input: {
      $tag: 'error-envelope', profile: 'work', code: 'policy/refused',
      reasons: ['first', 'second'], stage: 'semantic', details: { leaf: 'status' },
    },
    expect: { ok: true, ordered: ['first', 'second'], transportError: false },
  },
  {
    id: 'envelope/transport-vs-semantic-distinguishable', area: 'envelope', harness: 'future-codec',
    rule: 'envelopes.error_envelope',
    input: {
      $tag: 'error-envelope', profile: 'values', code: 'length/truncated',
      reasons: ['short frame'], stage: 'transport',
    },
    expect: { ok: true, transportError: true },
  },
  // -- lifetime (contract: lifetime_rules + corruption_rules tokens) --
  // Scripts run against createTokenLedger; `{ref}` names resolve to
  // tokens minted by earlier labeled `issue` steps. The FINAL step's
  // verdict is compared to `expect`.
  {
    id: 'lifetime/issue-use-once-ok', area: 'lifetime', harness: 'reference-rule',
    rule: 'corruption_rules[3]',
    input: { $tag: 'token-script', steps: [
      { op: 'issue', call: 'a', as: 't1' },
      { op: 'use', call: 'a', token: { ref: 't1' } },
    ] },
    expect: { ok: true },
  },
  {
    id: 'lifetime/replay-fails', area: 'lifetime', harness: 'reference-rule',
    rule: 'corruption_rules[3]',
    input: { $tag: 'token-script', steps: [
      { op: 'issue', call: 'a', as: 't1' },
      { op: 'use', call: 'a', token: { ref: 't1' } },
      { op: 'use', call: 'a', token: { ref: 't1' } },
    ] },
    expect: { ok: false, stage: 'transport', code: 'lifetime/token-replay' },
  },
  {
    id: 'lifetime/cross-call-token-fails', area: 'lifetime', harness: 'reference-rule',
    rule: 'corruption_rules[3]',
    input: { $tag: 'token-script', steps: [
      { op: 'issue', call: 'a', as: 't1' },
      { op: 'issue', call: 'b', as: 't2' },
      { op: 'use', call: 'b', token: { ref: 't1' } },
    ] },
    expect: { ok: false, stage: 'transport', code: 'lifetime/token-mismatch' },
  },
  {
    id: 'lifetime/mismatched-token-fails', area: 'lifetime', harness: 'reference-rule',
    rule: 'corruption_rules[3]',
    input: { $tag: 'token-script', steps: [
      { op: 'issue', call: 'a', as: 't1' },
      { op: 'use', call: 'a', token: 'tok-forged' },
    ] },
    expect: { ok: false, stage: 'transport', code: 'lifetime/token-mismatch' },
  },
  {
    id: 'lifetime/cancel-fails-at-current-stage-and-releases', area: 'lifetime', harness: 'reference-rule',
    rule: 'corruption_rules[1]',
    input: { $tag: 'token-script', steps: [
      { op: 'issue', call: 'a', as: 't1' },
      { op: 'advance', call: 'a', stage: 'decode' },
      { op: 'cancel', call: 'a' },
    ] },
    expect: { ok: false, stage: 'decode', code: 'lifetime/cancelled', released: true },
  },
  {
    id: 'lifetime/use-after-cancel-fails', area: 'lifetime', harness: 'reference-rule',
    rule: 'lifetime_rules[1]',
    input: { $tag: 'token-script', steps: [
      { op: 'issue', call: 'a', as: 't1' },
      { op: 'cancel', call: 'a' },
      { op: 'use', call: 'a', token: { ref: 't1' } },
    ] },
    expect: { ok: false, code: 'lifetime/cancelled' },
  },
  // -- corruption must-holds (contract: corruption_rules[4] + exclusions) --
  // Declarative: no executable fixture exists at C03.2. Each MUST hold
  // for every later binding; C03.complete/C04 gates cite them as
  // negative evidence requirements.
  {
    id: 'corruption/serde-never-the-authority', area: 'corruption', harness: 'must-hold',
    rule: 'corruption_rules[4]',
    input: { $tag: 'must-hold' },
    expect: { ok: true },
    statement: 'Serde/metadata renderer errors never substitute for host syntax diagnostics; malformed JSON stays a host parse error at the host stage.',
  },
  {
    id: 'corruption/serializer-output-not-parity', area: 'corruption', harness: 'must-hold',
    rule: 'corruption_rules[4]',
    input: { $tag: 'must-hold' },
    expect: { ok: true },
    statement: 'Generic serializer output is not parity evidence; only profile verdicts over the tagged transport count.',
  },
  {
    id: 'corruption/opaque-json-never-a-request-transport', area: 'corruption', harness: 'must-hold',
    rule: 'transport_exclusions[0]',
    input: { $tag: 'must-hold' },
    expect: { ok: true },
    statement: "Can's number-rejecting opaque json codec is unsuitable as a generic request transport and must never be used as one.",
  },
  {
    id: 'corruption/host-json-parsing-stays-initially', area: 'corruption', harness: 'must-hold',
    rule: 'transport_exclusions[1]',
    input: { $tag: 'must-hold' },
    expect: { ok: true },
    statement: 'Host JSON parsing stays initially to preserve syntax diagnostics and number parsing.',
  },
];

/* ------------------------------------------------------------------ */
/* Consumer runner (for C04.1+ codecs; unexecuted at C03.2).           */
/* `encoder(value)` produces tagged nodes; `decoder(nodes)` restores  */
/* the value. ok:true vectors must round-trip exactly; ok:false       */
/* vectors must throw/reject carrying the expected code.              */
/* ------------------------------------------------------------------ */

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Reflect.has(b, k) && deepEqual(a[k], b[k]));
}

export async function runVectors(encoder, decoder, { areas = null } = {}) {
  const failures = [];
  for (const vector of VECTORS) {
    if (vector.harness !== 'future-codec') continue;
    if (areas !== null && !areas.includes(vector.area)) continue;
    try {
      const nodes = await encoder(vector.input);
      const back = await decoder(nodes);
      if (vector.expect.ok !== true || !deepEqual(back, vector.input)) {
        failures.push({ id: vector.id, reason: 'round-trip mismatch', back });
      }
    } catch (err) {
      const code = err?.code ?? err?.message ?? String(err);
      if (vector.expect.ok !== false || (vector.expect.code !== undefined && code !== vector.expect.code)) {
        failures.push({ id: vector.id, reason: 'unexpected rejection', code });
      }
    }
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/* Self-check (`node transport-vectors.mjs --self-check`).             */
/* Executes every reference-rule vector, JSON-round-trips every       */
/* future-codec vector, pins surrogate/control units byte-exactly,    */
/* and requires reject coverage for versions AND lengths (C03.2 Done). */
/* ------------------------------------------------------------------ */

function runTokenScript(input) {
  const ledger = createTokenLedger();
  const minted = new Map();
  let last = { ok: false, stage: 'transport', code: 'lifetime/empty-script' };
  for (const step of input.steps) {
    if (step.op === 'issue') {
      minted.set(step.as, ledger.issue(step.call));
      last = { ok: true, stage: 'transport' };
    } else if (step.op === 'advance') {
      ledger.advance(step.call, step.stage);
      last = { ok: true, stage: step.stage };
    } else if (step.op === 'use') {
      const token = typeof step.token === 'object' && step.token !== null && 'ref' in step.token
        ? minted.get(step.token.ref)
        : step.token;
      last = ledger.use(step.call, token);
    } else if (step.op === 'cancel') {
      last = ledger.cancel(step.call);
    } else {
      throw new Error(`unknown script op ${JSON.stringify(step.op)}`);
    }
  }
  return last;
}

function expectSubset(actual, expected) {
  return Object.entries(expected).every(([key, value]) => deepEqual(actual?.[key], value));
}

function charCodes(text) {
  return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
}

export function selfCheck() {
  const failures = [];
  const fail = (id, reason, extra) => failures.push({ id, reason, ...extra });
  const seen = new Set();
  for (const vector of VECTORS) {
    if (seen.has(vector.id)) fail(vector.id, 'duplicate id');
    seen.add(vector.id);
    for (const key of ['id', 'area', 'harness', 'rule', 'input', 'expect']) {
      if (!(key in vector)) fail(vector.id, `missing member ${key}`);
    }
  }
  const areas = new Set(VECTORS.map((v) => v.area));
  for (const area of ['version', 'length', 'scalar', 'text', 'presence', 'envelope', 'lifetime', 'corruption']) {
    if (!areas.has(area)) fail('(set)', `area ${area} has no vectors`);
  }
  for (const vector of VECTORS) {
    if (vector.harness === 'reference-rule') {
      let actual;
      try {
        if (vector.area === 'version') actual = gateVersion(vector.input);
        else if (vector.area === 'length') actual = checkLength(vector.input);
        else if (vector.area === 'lifetime') actual = runTokenScript(vector.input);
        else throw new Error(`no reference rule for area ${vector.area}`);
      } catch (err) {
        fail(vector.id, 'reference rule threw', { error: String(err) });
        continue;
      }
      if (!expectSubset(actual, vector.expect)) {
        fail(vector.id, 'reference verdict mismatch', { actual, expected: vector.expect });
      }
    } else if (vector.harness === 'future-codec') {
      let roundTripped;
      try {
        roundTripped = JSON.parse(JSON.stringify(vector));
      } catch (err) {
        fail(vector.id, 'vector is not JSON-serializable', { error: String(err) });
        continue;
      }
      if (!deepEqual(roundTripped, vector)) fail(vector.id, 'JSON round-trip lossy');
    } else if (vector.harness === 'must-hold') {
      if (typeof vector.statement !== 'string' || vector.statement.length === 0) {
        fail(vector.id, 'must-hold without a statement');
      }
    } else {
      fail(vector.id, `unknown harness ${JSON.stringify(vector.harness)}`);
    }
  }
  // Byte-exact text pins: the file must carry the intended code units.
  const textOf = (id) => VECTORS.find((v) => v.id === id);
  const lone = textOf('text/lone-surrogate-in-text-preserved');
  if (!deepEqual(charCodes(lone.input.value), lone.input.units)) {
    fail(lone.id, 'text units do not match the literal', { units: charCodes(lone.input.value) });
  }
  const loneKey = textOf('text/lone-surrogate-in-key-preserved');
  if (!deepEqual(charCodes(loneKey.input.entries[0][0]), loneKey.input.keyUnits[0])) {
    fail(loneKey.id, 'key units do not match the literal');
  }
  const controls = textOf('text/control-characters-preserved');
  if (!deepEqual(charCodes(controls.input.value), controls.input.units)) {
    fail(controls.id, 'control units do not match the literal');
  }
  // C03.2 Done: bad versions AND bad lengths reject.
  for (const area of ['version', 'length']) {
    const rejects = VECTORS.filter((v) => v.area === area && v.expect.ok === false);
    if (rejects.length === 0) fail('(set)', `area ${area} has no rejection vectors`);
  }
  return failures;
}

const invokedAsMain = process.argv[1] !== undefined && import.meta.url.endsWith(
  process.argv[1].split('/').pop(),
);
if (invokedAsMain && process.argv.includes('--self-check')) {
  const failures = selfCheck();
  if (failures.length > 0) {
    for (const failure of failures) console.error(JSON.stringify(failure));
    process.exitCode = 1;
  } else {
    console.log(`transport-vectors self-check: ${VECTORS.length} vectors ok`);
  }
}
