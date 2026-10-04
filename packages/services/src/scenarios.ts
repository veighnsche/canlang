/**
 * L4-authored B2 scenario tables (S9a): serialized provider transport
 * behavior selected by testkit seed refs `<provider>:<scenario>`.
 *
 * Each table scripts TRANSPORT behavior per request (status / headers /
 * body / chunks / delays / hangs / redirects) — the exact vocabulary of
 * the four `node:http` harness scenario types, serialized as JSON-safe
 * data. One generic workerd playback endpoint (L7 machinery) serves a
 * table's script; the real adapters run unmodified on top, so B2
 * evidences real classification/mapping/redaction/streaming instead of
 * stubbed completions.
 *
 * Serving semantics (the harness code is the normative spec):
 * - mail: STATEFUL across requests (idempotency-keyed deliveries map +
 *   send-attempt counter); `flaky-then-accept` fails N sends then
 *   accepts; `hang` records the outcome server-side, never responds,
 *   and serves it from `GET /deliveries/{id}`.
 * - models/judgments: stateless per request; every `POST` replays the
 *   script (stream requests replay all lines; `lineDelayMs` paces
 *   lines, 0 writes at once).
 * - media: stateless per request over keyed `history`/`files` dicts;
 *   `hang-submit` records the prompt id but never responds;
 *   `hang-all` never responds to anything; cancel honors
 *   `cancelStatus` (default 200).
 *
 * Deliberate deviation from L7's `calls[]`/`match` proposal: at the
 * transport level one server-lifetime script handles every request
 * statefully (idempotent accept, flaky counters, hang+reconcile), so
 * per-call matching dissolves — the seed ref selects the whole
 * script. Binary travels as standard base64 (`filesBase64`); strict
 * key allowlists reject typos such as harness-shaped `files`.
 */
import type { ControlledScenario } from './ports.ts';
import type { ControlledOllamaScenario } from './models/harness.ts';
import type { ControlledSystemOneScenario } from './judgments/harness.ts';
import type {
  ControlledComfyScenario,
  ControlledHistoryEntry,
} from './media/harness.ts';

/** Providers with scripted transport scenarios. Files has none (see below). */
export type ScenarioProvider = 'mail' | 'models' | 'judgments' | 'media';

/**
 * One scenario table: provider behavior for a seed ref. `script` is the
 * serialized harness scenario (media uses the `filesBase64` form —
 * decode with {@link decodeMediaScript}).
 */
export interface ScenarioTable {
  readonly provider: ScenarioProvider;
  readonly scenario: string;
  readonly script: unknown;
}

/**
 * Serialized ComfyUI transport script: `ControlledComfyScenario` with
 * `files` carried as standard base64 plus the harness cancel-status
 * option. `Buffer` encodes here (node); workerd playback uses `atob`.
 */
export interface MediaScriptData {
  readonly kind: 'accept' | 'reject-prompt' | 'hang-submit' | 'hang-all';
  readonly history?: Readonly<Record<string, unknown>>;
  readonly filesBase64?: Readonly<Record<string, string>>;
  readonly promptBody?: unknown;
  readonly status?: number;
  readonly body?: unknown;
  readonly cancelStatus?: number;
}

/** Decoded media script: the harness scenario plus its cancel option. */
export interface DecodedMediaScript {
  readonly scenario: ControlledComfyScenario;
  readonly cancelStatus: number | undefined;
}

/** Fail-closed table/script errors; never provider data, only shapes. */
export class ScenarioTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioTableError';
  }
}

// Scenario-name grammar, restated from the testkit authority
// (`packages/testkit/src/fixtures/seeds.ts`): strict lowercase
// kebab-case, letter-start, no leading/trailing/double hyphens.
const SCENARIO_SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const PROVIDERS: ReadonlySet<string> = new Set([
  'mail',
  'models',
  'judgments',
  'media',
]);

/** Deep JSON-safety: tables must survive a JSON round-trip intact. */
function checkJsonSafe(value: unknown, what: string): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) return;
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(node)) {
          throw new ScenarioTableError(`${what}${path} must be finite JSON.`);
        }
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        throw new ScenarioTableError(`${what}${path} is not JSON-safe.`);
      case 'object': {
        if (seen.has(node)) {
          throw new ScenarioTableError(`${what}${path} is cyclic.`);
        }
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        for (const [key, entry] of Object.entries(node)) {
          visit(entry, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(value, '');
}

function checkRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScenarioTableError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkKind(
  record: Record<string, unknown>,
  what: string,
  kinds: ReadonlySet<string>,
): string {
  if (typeof record['kind'] !== 'string' || !kinds.has(record['kind'])) {
    throw new ScenarioTableError(
      `${what} has an unknown kind ${JSON.stringify(record['kind'])}.`,
    );
  }
  return record['kind'];
}

/** Strict allowlist: unknown keys are typos, never passed through. */
function checkKeys(
  record: Record<string, unknown>,
  what: string,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ScenarioTableError(`${what} has an unknown key ${JSON.stringify(key)}.`);
    }
  }
}

function checkStatus(value: unknown, what: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 100 ||
    value > 599
  ) {
    throw new ScenarioTableError(`${what} must be an integer HTTP status.`);
  }
  return value;
}

function checkDelay(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ScenarioTableError(`${what} must be a finite delay >= 0.`);
  }
  return value;
}

const MAIL_KINDS: ReadonlySet<string> = new Set([
  'accept',
  'reject',
  'flaky-then-accept',
  'invalid-schema',
  'hang',
  'redirect',
  'drip',
]);

const MAIL_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'accept': new Set(['kind']),
  'reject': new Set(['kind', 'status', 'body']),
  'flaky-then-accept': new Set(['kind', 'failures']),
  'invalid-schema': new Set(['kind', 'body']),
  'hang': new Set(['kind', 'reconcile']),
  'redirect': new Set(['kind', 'status', 'location']),
  'drip': new Set(['kind', 'delayMs']),
};

const MAIL_RECONCILE: ReadonlySet<string> = new Set([
  'accepted',
  'rejected',
  'pending',
]);

/** Validate a mail transport script; JSON-safe and harness-identical. */
export function checkMailScript(script: unknown): ControlledScenario {
  const record = checkRecord(script, 'mail script');
  const kind = checkKind(record, 'mail script', MAIL_KINDS);
  checkKeys(record, 'mail script', MAIL_KEYS[kind] ?? new Set(['kind']));
  checkJsonSafe(record, 'mail script');
  switch (kind) {
    case 'reject':
      checkStatus(record['status'], 'mail reject status');
      if (!('body' in record)) {
        throw new ScenarioTableError('mail reject needs a body.');
      }
      break;
    case 'flaky-then-accept': {
      const failures = record['failures'];
      if (
        typeof failures !== 'number' ||
        !Number.isInteger(failures) ||
        failures < 0
      ) {
        throw new ScenarioTableError('mail flaky failures must be an integer >= 0.');
      }
      break;
    }
    case 'invalid-schema':
      if (!('body' in record)) {
        throw new ScenarioTableError('mail invalid-schema needs a body.');
      }
      break;
    case 'hang':
      if (
        typeof record['reconcile'] !== 'string' ||
        !MAIL_RECONCILE.has(record['reconcile'])
      ) {
        throw new ScenarioTableError(
          'mail hang reconcile must be accepted, rejected or pending.',
        );
      }
      break;
    case 'redirect':
      checkStatus(record['status'], 'mail redirect status');
      if (
        typeof record['location'] !== 'string' ||
        record['location'] === ''
      ) {
        throw new ScenarioTableError('mail redirect needs a location.');
      }
      break;
    case 'drip':
      checkDelay(record['delayMs'], 'mail drip delayMs');
      break;
  }
  return record as unknown as ControlledScenario;
}

const MODELS_KINDS: ReadonlySet<string> = new Set([
  'final',
  'stream',
  'reject',
  'hang',
  'invalid-schema',
]);

const MODELS_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'final': new Set(['kind', 'body']),
  'stream': new Set(['kind', 'lines', 'lineDelayMs']),
  'reject': new Set(['kind', 'status', 'body']),
  'hang': new Set(['kind']),
  'invalid-schema': new Set(['kind', 'body']),
};

/** Validate a models transport script; JSON-safe and harness-identical. */
export function checkModelsScript(script: unknown): ControlledOllamaScenario {
  const record = checkRecord(script, 'models script');
  const kind = checkKind(record, 'models script', MODELS_KINDS);
  checkKeys(record, 'models script', MODELS_KEYS[kind] ?? new Set(['kind']));
  checkJsonSafe(record, 'models script');
  switch (kind) {
    case 'final':
    case 'invalid-schema':
      if (!('body' in record)) {
        throw new ScenarioTableError(`models ${kind} needs a body.`);
      }
      break;
    case 'stream':
      if (!Array.isArray(record['lines'])) {
        throw new ScenarioTableError('models stream needs a lines array.');
      }
      if (record['lineDelayMs'] !== undefined) {
        checkDelay(record['lineDelayMs'], 'models stream lineDelayMs');
      }
      break;
    case 'reject':
      checkStatus(record['status'], 'models reject status');
      if (!('body' in record)) {
        throw new ScenarioTableError('models reject needs a body.');
      }
      break;
  }
  return record as unknown as ControlledOllamaScenario;
}

const JUDGMENTS_KINDS: ReadonlySet<string> = new Set([
  'accept',
  'reject',
  'hang',
  'invalid-schema',
]);

const JUDGMENTS_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'accept': new Set(['kind', 'body']),
  'reject': new Set(['kind', 'status', 'body']),
  'hang': new Set(['kind']),
  'invalid-schema': new Set(['kind', 'body']),
};

/** Validate a judgments transport script; JSON-safe and harness-identical. */
export function checkJudgmentsScript(
  script: unknown,
): ControlledSystemOneScenario {
  const record = checkRecord(script, 'judgments script');
  const kind = checkKind(record, 'judgments script', JUDGMENTS_KINDS);
  checkKeys(
    record,
    'judgments script',
    JUDGMENTS_KEYS[kind] ?? new Set(['kind']),
  );
  checkJsonSafe(record, 'judgments script');
  if (kind === 'accept' || kind === 'invalid-schema') {
    if (!('body' in record)) {
      throw new ScenarioTableError(`judgments ${kind} needs a body.`);
    }
  }
  if (kind === 'reject') {
    checkStatus(record['status'], 'judgments reject status');
    if (!('body' in record)) {
      throw new ScenarioTableError('judgments reject needs a body.');
    }
  }
  return record as unknown as ControlledSystemOneScenario;
}

const MEDIA_KINDS: ReadonlySet<string> = new Set([
  'accept',
  'reject-prompt',
  'hang-submit',
  'hang-all',
]);

const MEDIA_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'accept': new Set(['kind', 'history', 'filesBase64', 'promptBody', 'cancelStatus']),
  'reject-prompt': new Set(['kind', 'status', 'body', 'cancelStatus']),
  'hang-submit': new Set(['kind', 'history', 'filesBase64', 'cancelStatus']),
  'hang-all': new Set(['kind', 'cancelStatus']),
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard-base64 check with a verified round-trip. */
function decodeBase64File(value: unknown, filename: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0) {
    throw new ScenarioTableError(
      `media filesBase64[${JSON.stringify(filename)}] must be base64.`,
    );
  }
  if (value !== '' && !BASE64_PATTERN.test(value)) {
    throw new ScenarioTableError(
      `media filesBase64[${JSON.stringify(filename)}] must be base64.`,
    );
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== value) {
    throw new ScenarioTableError(
      `media filesBase64[${JSON.stringify(filename)}] must be canonical base64.`,
    );
  }
  return bytes;
}

/** Authoring/testing helper: bytes to canonical standard base64. */
export function encodeMediaBytes(files: Readonly<Record<string, Uint8Array>>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [filename, bytes] of Object.entries(files)) {
    encoded[filename] = Buffer.from(bytes).toString('base64');
  }
  return encoded;
}

/**
 * Validate a media transport script and decode `filesBase64` to the
 * harness `files` form. `cancelStatus` defaults downstream (200).
 */
export function decodeMediaScript(script: unknown): DecodedMediaScript {
  const record = checkRecord(script, 'media script');
  const kind = checkKind(record, 'media script', MEDIA_KINDS);
  checkKeys(record, 'media script', MEDIA_KEYS[kind] ?? new Set(['kind']));
  checkJsonSafe(record, 'media script');
  if (record['history'] !== undefined) {
    checkRecord(record['history'], 'media history');
  }
  let files: Record<string, Uint8Array> | undefined;
  if (record['filesBase64'] !== undefined) {
    const encoded = checkRecord(record['filesBase64'], 'media filesBase64');
    files = {};
    for (const [filename, value] of Object.entries(encoded)) {
      files[filename] = decodeBase64File(value, filename);
    }
  }
  let cancelStatus: number | undefined;
  if (record['cancelStatus'] !== undefined) {
    cancelStatus = checkStatus(record['cancelStatus'], 'media cancelStatus');
  }
  if (kind === 'reject-prompt') {
    checkStatus(record['status'], 'media reject-prompt status');
    if (!('body' in record)) {
      throw new ScenarioTableError('media reject-prompt needs a body.');
    }
    return {
      scenario: {
        kind: 'reject-prompt',
        status: record['status'] as number,
        body: record['body'],
      },
      cancelStatus,
    };
  }
  if (kind === 'hang-submit' || kind === 'accept') {
    const scenario: ControlledComfyScenario =
      kind === 'accept'
        ? {
            kind: 'accept',
            ...(record['history'] !== undefined
              ? {
                  history: record['history'] as Record<
                    string,
                    ControlledHistoryEntry
                  >,
                }
              : {}),
            ...(files !== undefined ? { files } : {}),
            ...(record['promptBody'] !== undefined
              ? { promptBody: record['promptBody'] }
              : {}),
          }
        : {
            kind: 'hang-submit',
            ...(record['history'] !== undefined
              ? {
                  history: record['history'] as Record<
                    string,
                    ControlledHistoryEntry
                  >,
                }
              : {}),
            ...(files !== undefined ? { files } : {}),
          };
    return { scenario, cancelStatus };
  }
  return { scenario: { kind: 'hang-all' }, cancelStatus };
}

/**
 * Validate one scenario table: known provider, kebab scenario name,
 * provider-correct script. Returns the table retyped (media scripts
 * stay serialized — decode with {@link decodeMediaScript}).
 */
export function parseScenarioTable(input: unknown): ScenarioTable {
  const record = checkRecord(input, 'scenario table');
  if (typeof record['provider'] !== 'string' || !PROVIDERS.has(record['provider'])) {
    throw new ScenarioTableError(
      `scenario table has an unknown provider ${JSON.stringify(record['provider'])}.`,
    );
  }
  const provider = record['provider'] as ScenarioProvider;
  if (
    typeof record['scenario'] !== 'string' ||
    !SCENARIO_SEGMENT.test(record['scenario'])
  ) {
    throw new ScenarioTableError(
      `scenario table has an invalid scenario name ${JSON.stringify(record['scenario'])}.`,
    );
  }
  switch (provider) {
    case 'mail':
      checkMailScript(record['script']);
      break;
    case 'models':
      checkModelsScript(record['script']);
      break;
    case 'judgments':
      checkJudgmentsScript(record['script']);
      break;
    case 'media':
      decodeMediaScript(record['script']);
      break;
  }
  return {
    provider,
    scenario: record['scenario'],
    script: record['script'],
  };
}

/**
 * Mail scenario tables. Bodies lifted from `mail-adapter.test.ts`; the
 * redirect-refused location is a fixed foreign URL (the adapter
 * refuses cross-origin targets before any second request, so no live
 * second server is needed — pinned by the equivalence test).
 */
export const MAIL_SCENARIO_TABLES: readonly ScenarioTable[] = [
  { provider: 'mail', scenario: 'send-ok', script: { kind: 'accept' } },
  {
    provider: 'mail',
    scenario: 'send-reject',
    script: { kind: 'reject', status: 400, body: { error: 'No mailbox here' } },
  },
  {
    provider: 'mail',
    scenario: 'send-rate-limited',
    script: { kind: 'reject', status: 429, body: { error: 'slow down' } },
  },
  {
    provider: 'mail',
    scenario: 'send-client-timeout',
    script: { kind: 'reject', status: 408, body: { error: 'slow down' } },
  },
  {
    provider: 'mail',
    scenario: 'send-retry-success',
    script: { kind: 'flaky-then-accept', failures: 1 },
  },
  {
    provider: 'mail',
    scenario: 'send-unknown-accepted',
    script: { kind: 'hang', reconcile: 'accepted' },
  },
  {
    provider: 'mail',
    scenario: 'send-unknown-rejected',
    script: { kind: 'hang', reconcile: 'rejected' },
  },
  {
    provider: 'mail',
    scenario: 'send-unknown-pending',
    script: { kind: 'hang', reconcile: 'pending' },
  },
  {
    provider: 'mail',
    scenario: 'send-invalid-schema',
    script: { kind: 'invalid-schema', body: { wrong: true } },
  },
  {
    provider: 'mail',
    scenario: 'send-redirect-refused',
    script: {
      kind: 'redirect',
      status: 302,
      location: 'https://elsewhere.example.test/send',
    },
  },
  {
    provider: 'mail',
    scenario: 'send-redirect-loop',
    script: { kind: 'redirect', status: 307, location: '/send' },
  },
];

const MODELS_MODEL = 'llama-test';

function modelsFinalBody(): Record<string, unknown> {
  return {
    model: MODELS_MODEL,
    message: { role: 'assistant', content: 'Hi there' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 4,
  };
}

function modelsDoneLine(): Record<string, unknown> {
  return {
    model: MODELS_MODEL,
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 4,
  };
}

function modelsDelta(content: string): Record<string, unknown> {
  return {
    model: MODELS_MODEL,
    message: { role: 'assistant', content },
    done: false,
  };
}

/** Models scenario tables. Bodies lifted from `models-ollama.test.ts`. */
export const MODELS_SCENARIO_TABLES: readonly ScenarioTable[] = [
  {
    provider: 'models',
    scenario: 'generate-ok',
    script: { kind: 'final', body: modelsFinalBody() },
  },
  {
    provider: 'models',
    scenario: 'generate-reject',
    script: { kind: 'reject', status: 400, body: { error: 'bad request' } },
  },
  {
    provider: 'models',
    scenario: 'generate-transient',
    script: { kind: 'reject', status: 500, body: { error: 'boom' } },
  },
  {
    provider: 'models',
    scenario: 'generate-rate-limited',
    script: { kind: 'reject', status: 429, body: { error: 'slow down' } },
  },
  {
    provider: 'models',
    scenario: 'generate-timeout-unknown',
    script: { kind: 'hang' },
  },
  {
    provider: 'models',
    scenario: 'generate-invalid-schema',
    script: { kind: 'final', body: { unexpected: 'shape' } },
  },
  {
    provider: 'models',
    scenario: 'stream-ok',
    script: {
      kind: 'stream',
      lines: [modelsDelta('Hi'), modelsDelta(' there'), modelsDoneLine()],
    },
  },
  {
    provider: 'models',
    scenario: 'stream-mid-error',
    script: {
      kind: 'stream',
      lines: [modelsDelta('Hi'), { error: 'model overloaded, try again' }],
    },
  },
  {
    provider: 'models',
    scenario: 'stream-truncated',
    script: { kind: 'stream', lines: [modelsDelta('Hi')] },
  },
  {
    provider: 'models',
    scenario: 'stream-cancel',
    script: {
      kind: 'stream',
      lines: [
        modelsDelta('a'),
        modelsDelta('b'),
        modelsDelta('c'),
        modelsDoneLine(),
      ],
      lineDelayMs: 50,
    },
  },
];

const JUDGMENTS_MODEL = 'jev-1.13.0';

function judgmentsAcceptBody(): Record<string, unknown> {
  return {
    model: JUDGMENTS_MODEL,
    answers: {
      human: { type: 'noul', noul: 0.92 },
      route: {
        type: 'choice',
        choice: 'technical',
        probabilities: { billing: 0.08, technical: 0.85, other: 0.07 },
        confidence: 0.82,
      },
      severity: {
        type: 'score',
        score: 1.05,
        legend: {
          '0': 'Routine follow-up',
          '1': 'Same-day attention',
          '2': 'Immediate disruption',
        },
        probabilities: { '0': 0.0, '1': 0.95, '2': 0.05 },
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 304, output_tokens: 18 },
  };
}

function judgmentsMissingAnswerBody(): Record<string, unknown> {
  return {
    model: JUDGMENTS_MODEL,
    answers: {
      route: {
        type: 'choice',
        choice: 'technical',
        probabilities: { billing: 0.08, technical: 0.85, other: 0.07 },
        confidence: 0.82,
      },
      severity: {
        type: 'score',
        score: 1.05,
        legend: {
          '0': 'Routine follow-up',
          '1': 'Same-day attention',
          '2': 'Immediate disruption',
        },
        probabilities: { '0': 0.0, '1': 0.95, '2': 0.05 },
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 304, output_tokens: 18 },
  };
}

/**
 * Judgments scenario tables. Bodies lifted from
 * `judgments-systemone.test.ts`.
 */
export const JUDGMENTS_SCENARIO_TABLES: readonly ScenarioTable[] = [
  {
    provider: 'judgments',
    scenario: 'evaluate-ok',
    script: { kind: 'accept', body: judgmentsAcceptBody() },
  },
  {
    provider: 'judgments',
    scenario: 'evaluate-reject',
    script: { kind: 'reject', status: 422, body: { error: 'nope' } },
  },
  {
    provider: 'judgments',
    scenario: 'evaluate-unauthorized',
    script: { kind: 'reject', status: 401, body: { error: 'nope' } },
  },
  {
    provider: 'judgments',
    scenario: 'evaluate-rate-limited',
    script: { kind: 'reject', status: 429, body: { error: 'nope' } },
  },
  {
    provider: 'judgments',
    scenario: 'evaluate-transient',
    script: { kind: 'reject', status: 500, body: { error: 'nope' } },
  },
  {
    provider: 'judgments',
    scenario: 'evaluate-timeout-unknown',
    script: { kind: 'hang' },
  },
  {
    provider: 'judgments',
    scenario: 'evaluate-invalid-schema',
    script: { kind: 'accept', body: judgmentsMissingAnswerBody() },
  },
];

// Nine-byte PNG-magic fixtures, canonical base64 (see `encodeMediaBytes`):
// PNG_A ends 0x41, PNG_B ends 0x42. Decoded bytes are pinned by test.
const PNG_A_BASE64 = 'iVBORw0KGgpB';
const PNG_B_BASE64 = 'iVBORw0KGgpC';

function mediaSuccessEntry(
  images: ReadonlyArray<{ filename: string; subfolder: string; type: string }>,
): Record<string, unknown> {
  return {
    status: { status_str: 'success', completed: true },
    outputs: { '9': { images: [...images] } },
  };
}

function mediaImage(filename: string): { filename: string; subfolder: string; type: string } {
  return { filename, subfolder: '', type: 'output' };
}

/**
 * Media scenario tables. Entries lifted from `media-comfyui.test.ts`;
 * image bytes travel as base64 and decode to the exact PNG fixtures.
 */
export const MEDIA_SCENARIO_TABLES: readonly ScenarioTable[] = [
  { provider: 'media', scenario: 'submit-ok', script: { kind: 'accept' } },
  {
    provider: 'media',
    scenario: 'submit-reject',
    script: {
      kind: 'reject-prompt',
      status: 400,
      body: { error: 'bad prompt', node_errors: { '6': ['no text'] } },
    },
  },
  {
    provider: 'media',
    scenario: 'submit-transient',
    script: { kind: 'reject-prompt', status: 500, body: { error: 'boom' } },
  },
  {
    provider: 'media',
    scenario: 'submit-unknown-recover',
    script: {
      kind: 'hang-submit',
      history: { job_7: mediaSuccessEntry([mediaImage('a.png')]) },
      filesBase64: { 'a.png': PNG_A_BASE64 },
    },
  },
  {
    provider: 'media',
    scenario: 'run-succeeded',
    script: {
      kind: 'accept',
      history: {
        job_1: mediaSuccessEntry([mediaImage('a.png'), mediaImage('b.png')]),
      },
      filesBase64: { 'a.png': PNG_A_BASE64, 'b.png': PNG_B_BASE64 },
    },
  },
  {
    provider: 'media',
    scenario: 'run-running',
    script: {
      kind: 'accept',
      history: {
        job_1: {
          status: { status_str: 'executing', completed: false },
          outputs: {},
        },
      },
    },
  },
  {
    provider: 'media',
    scenario: 'run-queued-unknown',
    script: { kind: 'accept' },
  },
  {
    provider: 'media',
    scenario: 'run-failed-partial',
    script: {
      kind: 'accept',
      history: {
        job_1: {
          status: {
            status_str: 'error',
            completed: false,
            messages: ['VAE decode failed'],
          },
          outputs: { '9': { images: [mediaImage('a.png')] } },
        },
      },
      filesBase64: { 'a.png': PNG_A_BASE64 },
    },
  },
  {
    provider: 'media',
    scenario: 'run-failed-detail',
    script: {
      kind: 'accept',
      history: {
        job_1: {
          status: { status_str: 'error', completed: false },
          outputs: {},
        },
      },
    },
  },
  {
    provider: 'media',
    scenario: 'run-malformed',
    script: {
      kind: 'accept',
      history: {
        job_1: { status: { status_str: 'mystery' }, outputs: {} },
      },
    },
  },
  {
    provider: 'media',
    scenario: 'run-bytes-missing',
    script: {
      kind: 'accept',
      history: {
        job_1: mediaSuccessEntry([mediaImage('a.png'), mediaImage('gone.png')]),
      },
      filesBase64: { 'a.png': PNG_A_BASE64 },
    },
  },
  {
    provider: 'media',
    scenario: 'poll-timeout',
    script: { kind: 'hang-all' },
  },
  {
    provider: 'media',
    scenario: 'cancel-observed',
    script: {
      kind: 'accept',
      history: { job_1: mediaSuccessEntry([mediaImage('a.png')]) },
      filesBase64: { 'a.png': PNG_A_BASE64 },
    },
  },
];

/** Every authored table: 11 mail + 10 models + 7 judgments + 13 media. */
export const SCENARIO_TABLES: readonly ScenarioTable[] = [
  ...MAIL_SCENARIO_TABLES,
  ...MODELS_SCENARIO_TABLES,
  ...JUDGMENTS_SCENARIO_TABLES,
  ...MEDIA_SCENARIO_TABLES,
];

/** Look up one table by seed-ref segments; null when unlisted. */
export function findScenarioTable(
  provider: string,
  scenario: string,
): ScenarioTable | null {
  for (const table of SCENARIO_TABLES) {
    if (table.provider === provider && table.scenario === scenario) {
      return table;
    }
  }
  return null;
}
