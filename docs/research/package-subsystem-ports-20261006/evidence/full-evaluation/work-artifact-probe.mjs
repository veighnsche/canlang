// Run from the repository root with Bun. These check current TS behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeEverySlot, deriveRecurringOccurrenceId } from '../../../../../packages/work/src/schedule/every.ts';
import { computeBackoff, recordOutcome } from '../../../../../packages/work/src/receipt/index.ts';
import { planRecoveryScan } from '../../../../../packages/work/src/recovery/index.ts';
import { parseArtifactText } from '../../../../../packages/cloudflare/src/runtime/artifact.ts';

const observations = {};
assert.deepEqual(computeEverySlot(1000.5, 1000), { slot: 1, slotStartMs: 1000 });
observations.fractionalClockAccepted = true;
let randomCalls = 0;
const backoffInput = { attempt: 1, nowMs: 1000.5, firstAttemptAtMs: 0,
  policy: { maxAttempts: 2, horizonMs: 10000 },
  random: { nextUnit() { randomCalls++; return NaN; } } };
assert.deepEqual(computeBackoff(backoffInput), { exhausted: false, delayMs: 500, notBeforeMs: 1500.5 });
assert.equal(randomCalls, 1);
assert.deepEqual(computeBackoff({ ...backoffInput, attempt: 2 }), { exhausted: true, delayMs: 0, notBeforeMs: 1000.5 });
assert.equal(randomCalls, 1);
assert.throws(() => computeBackoff({ ...backoffInput, attempt: -1 }), RangeError);
assert.equal(randomCalls, 1);
observations.randomCallsAfterValidationAndExhaustionChecks = randomCalls;

const item = (id, state) => ({ id, state, attempts: 0, operationId: 'op', source: 'S.send', occurrenceIndex: 0, request: {}, originOccurrence: null });
const visited = [];
const rows = [item('z', 'uncertain'), item('p', 'pending'), item('a', 'uncertain')]
  .map(item => ({ item, guardVerdict: null, firstAttemptAtMs: null, retryClass: null }));
const plan = planRecoveryScan({ rows, claims: [], nowMs: 1000.5, maxClaimAgeMs: 100,
  evidence(id) { visited.push(id); return null; } });
assert.deepEqual(visited, ['z', 'a']);
assert.deepEqual(plan.awaiting, ['a', 'z']);
observations.evidenceAccessOrder = visited;
observations.outputOrder = plan.awaiting;
const freshLast = [{ outboxId: 'c', claimId: 'old', claimedAt: 0 }, { outboxId: 'c', claimId: 'new', claimedAt: 1000 }];
const claimedInput = { rows: [{ item: item('c', 'claimed'), guardVerdict: null, firstAttemptAtMs: null, retryClass: null }],
  claims: freshLast, nowMs: 1000.5, maxClaimAgeMs: 100, evidence() { throw new Error('must not run'); } };
assert.deepEqual(planRecoveryScan(claimedInput).resume, []);
assert.deepEqual(planRecoveryScan({ ...claimedInput, claims: [...freshLast].reverse() }).resume, ['c']);
observations.duplicateClaimsLastWins = true;

const result = { hostValue: Symbol('opaque') };
assert.equal(recordOutcome({ item: item('x', 'claimed'), outcome: { kind: 'delivered', result },
  nowMs: 1000.5, firstAttemptAtMs: 0 }).result, result);
observations.deliveredResultIdentity = true;
const app = String.fromCharCode(0xd800);
const slot = 1e21;
const expected = createHash('sha256').update(`can-work/every-id/v1\0${app}\0H\0team\0o\0${slot}`, 'utf8').digest('hex');
assert.equal(deriveRecurringOccurrenceId(app, 'H', 'team', 'o', slot), `evr_${expected}`);
observations.idForSurrogateAndExponentSlot = `evr_${expected}`;

const artifact = { artifact_version: 1, language_version: '1.0', tool_version: '0.1',
  sources: [{ path: 'app.can', sha256: 'a'.repeat(64) }],
  modules: [{ path: 'app.js', js: app, map: { version: 3 } }],
  callables: [], pages: [], requires: [], tests: [], extra: { [app]: app } };
const loaded = parseArtifactText(JSON.stringify(artifact), 'probe.json');
assert.equal(loaded.artifact.modules[0].js.charCodeAt(0), 0xd800);
assert.equal(loaded.artifact.extra[app], app);
observations.artifactSurrogatesAndAdditionalMetadata = true;
assert.throws(() => parseArtifactText(JSON.stringify({ ...artifact, artifact_version: 9, language_version: '' }), 'probe.json'), /unsupported artifact_version/);
let hostMessage;
try { JSON.parse('{bad'); } catch (error) { hostMessage = error.message; }
assert.throws(() => parseArtifactText('{bad', 'probe.json'), error => error.message.includes(hostMessage));
observations.artifactFirstErrorAndHostJsonDiagnostic = true;
console.log(JSON.stringify(observations, null, 2));
