/** Exact installed std text generation; progress is staged by the caller. */
import { STD_TEXT_GENERATION_V1_VERSION } from '@canlang/contracts';
import type { OutboxIntent, ProviderBinding, TextRequest, TextMessage, ModelRunSnapshot, ReceiptResultContext } from '@canlang/contracts';
import { deliveryResultLeaves } from '@canlang/contracts';
import type { InstalledTextGeneration, ResolveInstalledTextGeneration, ModelRunHandle } from '@canlang/services';
import { encodeValue, normalizeSchema, validateOperationInput } from '@canlang/values';
import type { SchemaDescriptor } from '@canlang/values';
import type { DispatchProviderOutcome, DispatchReconcileEvidence } from './invoke.js';

const CAPABILITY = 'std.TextGenerationV1';
const TARGET = `${CAPABILITY}.generate`;
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled']);
export interface TextRunWire {
  readonly source: string;
  readonly revision: string;
  readonly sequence: string;
  readonly state: string;
  readonly content: string;
  readonly used_tokens: string | null;
  readonly detail: string | null;
}
export interface BoundTextGenerationOptions {
  readonly appDefinition: unknown;
  readonly binding: ProviderBinding;
  readonly resolveInstalledTextGeneration: ResolveInstalledTextGeneration;
}
export interface BoundTextGenerationCallOptions {
  /** Required to start transport: the host queue observation must commit first. */
  readonly onProgress?: (progress: TextRunWire) => Promise<void>;
}
export interface BoundTextGenerationAdapter {
  available(intent: OutboxIntent): boolean;
  resultContext(intent: OutboxIntent): ReceiptResultContext | null;
  /** Pending originals only; the dispatcher must never re-drive an acknowledged intent. */
  callProvider(intent: OutboxIntent, options?: BoundTextGenerationCallOptions): Promise<DispatchProviderOutcome>;
  /** Call only after an actual Work commit removes this original from the outbox. */
  releaseAcknowledged(intent: OutboxIntent): void;
  /** Only the retained real live handle can request cancellation. */
  cancel(intent: OutboxIntent): Promise<DispatchProviderOutcome | null>;
  reconcile(intent: OutboxIntent): Promise<DispatchReconcileEvidence | null>;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function member(value: unknown, key: string): unknown {
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function safeInt(value: unknown, min: number): number {
  if (typeof value !== 'bigint' || value < BigInt(min) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Text generation integer is outside the installed safe range.');
  }
  return Number(value);
}
interface Resolved {
  readonly installed: InstalledTextGeneration;
  readonly input: TextRequest;
  readonly context: ReceiptResultContext;
}
interface LiveRun {
  handle: ModelRunHandle | null;
  readonly result: Promise<DispatchProviderOutcome>;
  settled: boolean;
  acknowledged: boolean;
}

export function createBoundTextGenerationAdapter(options: BoundTextGenerationOptions): BoundTextGenerationAdapter {
  const expected = Object.freeze({ ...options.binding });
  const runs = new Map<string, LiveRun>();
  const resolve = (intent: OutboxIntent): Resolved | null => {
    try {
      if (intent.target !== TARGET || intent.intentId === '' || !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier['binding'] !== 'string' || carrier['from'] !== expected.deployment || !record(carrier['arguments'])) return null;
      const declared = member(member(options.appDefinition, 'bindings'), carrier['binding']);
      if (member(declared, 'capability') !== CAPABILITY || member(declared, 'from') !== carrier['from'] ||
          expected.capability !== CAPABILITY || expected.capabilityVersion !== STD_TEXT_GENERATION_V1_VERSION ||
          expected.account === '' || expected.deployment === '') return null;
      const capability = member(member(options.appDefinition, 'capabilities'), CAPABILITY);
      const version = member(capability, 'version');
      if (version !== STD_TEXT_GENERATION_V1_VERSION && version !== BigInt(STD_TEXT_GENERATION_V1_VERSION)) return null;
      const operation = member(member(capability, 'operations'), 'generate');
      if (member(member(operation, 'result'), 'type') !== 'TextRun') return null;
      const inputs = member(operation, 'inputs');
      const contracts = member(options.appDefinition, 'contracts');
      const enums = member(options.appDefinition, 'enums') ?? {};
      if (!record(inputs) || !record(contracts) || !record(enums)) return null;
      const leaves = deliveryResultLeaves('TextRun');
      const resultFields = member(member(contracts, 'TextRun'), 'fields');
      if (leaves === null || !record(resultFields) || Object.keys(resultFields).length !== leaves.length ||
          !leaves.every(leaf => member(member(resultFields, leaf.name), 'type') === leaf.type)) return null;
      const schema = normalizeSchema({ contracts, enums, operations: { [TARGET]: { inputs } } } as SchemaDescriptor);
      const checked = validateOperationInput(schema, TARGET, carrier['arguments']);
      const value = checked['value'];
      if (!record(value) || typeof value['source'] !== 'string' || value['source'] === '' ||
          typeof value['profile'] !== 'string' || typeof value['policy_revision'] !== 'string' ||
          !Array.isArray(value['messages']) || value['messages'].length === 0) return null;
      const messages: TextMessage[] = value['messages'].map(message => {
        if (!record(message) || !['system', 'user', 'assistant'].includes(String(message['role'])) ||
            typeof message['content'] !== 'string' || !Array.isArray(message['attachments']) || message['attachments'].length !== 0) {
          throw new Error('Text generation requires supported messages without attachments.');
        }
        return { role: message['role'] as TextMessage['role'], content: message['content'], attachments: [] };
      });
      const duration = value['max_duration'];
      if (typeof duration !== 'bigint' || duration <= 0n) return null;
      const input: TextRequest = { source: value['source'], revision: safeInt(value['revision'], 0),
        profile: value['profile'], policy_revision: value['policy_revision'], messages,
        max_input_tokens: safeInt(value['max_input_tokens'], 1), max_output_tokens: safeInt(value['max_output_tokens'], 1),
        max_duration: duration };
      const installed = options.resolveInstalledTextGeneration(expected.deployment);
      if (installed === null || installed.binding.deployment !== expected.deployment || installed.binding.capability !== CAPABILITY ||
          installed.binding.capabilityVersion !== expected.capabilityVersion || installed.binding.account !== expected.account) return null;
      const profile = installed.profile;
      if (profile.name !== input.profile || profile.policyRevision !== input.policy_revision || profile.model === '' || profile.provider === '' ||
          profile.inputTokenization !== 'deployment' || profile.attachments !== 'unsupported' ||
          !Number.isSafeInteger(profile.maxInputTokens) || !Number.isSafeInteger(profile.maxOutputTokens) ||
          !Number.isSafeInteger(profile.maxDurationMs) || input.max_input_tokens > profile.maxInputTokens ||
          input.max_output_tokens > profile.maxOutputTokens || duration > BigInt(profile.maxDurationMs) ||
          typeof installed.text.generateStream !== 'function' || typeof installed.text.reconcile !== 'function') return null;
      const context: ReceiptResultContext = Object.freeze({ source: TARGET,
        declaredResult: Object.freeze({ name: 'TextRun', fields: leaves }),
        request: Object.freeze({ source: input.source, revision: encodeValue('int', BigInt(input.revision)) as string }) });
      return { installed, input, context };
    } catch { return null; }
  };
  return {
    available: intent => resolve(intent) !== null,
    resultContext: intent => resolve(intent)?.context ?? null,
    async callProvider(intent, callOptions = {}) {
      const retained = runs.get(intent.intentId);
      if (retained !== undefined) return retained.result;
      const resolved = resolve(intent);
      if (resolved === null) return { kind: 'uncertain' };
      let handle: ModelRunHandle | null = null;
      let last: TextRunWire | null = null;
      const latest = (): TextRunWire | null => last;
      const terminal: { snapshot: ModelRunSnapshot | null } = { snapshot: null };
      let queue = Promise.resolve();
      let progressFailure: unknown;
      const emit = (snapshot: ModelRunSnapshot, used: number | null = null, detail: string | null = null) => {
        queue = queue.then(async () => {
          if (progressFailure !== undefined) return;
          if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !STATES.has(snapshot.state) || typeof snapshot.content !== 'string' ||
              (last !== null && BigInt(snapshot.sequence) <= BigInt(last.sequence))) throw new Error('Invalid ordered text snapshot.');
          const progress: TextRunWire = Object.freeze({ source: resolved.input.source,
            revision: encodeValue('int', BigInt(resolved.input.revision)) as string,
            sequence: encodeValue('int', BigInt(snapshot.sequence)) as string, state: snapshot.state,
            content: snapshot.content, used_tokens: used === null ? null : encodeValue('int', BigInt(used)) as string, detail });
          await callOptions.onProgress?.(progress);
          last = progress;
        }).catch(error => { progressFailure ??= error; });
      };
      const result: Promise<DispatchProviderOutcome> = (async () => {
        try {
          // Queue is host request state, not provider acceptance. Persist it
          // before the synchronous Services port can start any HTTP bytes.
          if (callOptions.onProgress === undefined) return { kind: 'uncertain' };
          emit({ sequence: 0, state: 'queued', content: '' });
          await queue;
          if (progressFailure !== undefined) throw progressFailure;
          handle = resolved.installed.text.generateStream(resolved.input, { deliveryId: intent.intentId, onSnapshot: snapshot => {
            // Reserve sequence zero for the durable host queue observation;
            // retain the ordering of every actual provider snapshot thereafter.
            if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || snapshot.sequence >= Number.MAX_SAFE_INTEGER) {
              progressFailure ??= new Error('Invalid provider text snapshot sequence.');
              return;
            }
            const ordered = Object.freeze({ ...snapshot, sequence: snapshot.sequence + 1 });
            // An actual terminal observation is published only with its final
            // completion; provider failure is the run state, not a rewrite of
            // an already terminal rich receipt into a strict failed envelope.
            if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
              if (terminal.snapshot !== null) {
                progressFailure ??= new Error('Text stream emitted multiple terminal snapshots.');
                return;
              }
              terminal.snapshot = ordered;
            } else {
              if (terminal.snapshot !== null) {
                progressFailure ??= new Error('Text stream emitted progress after its terminal snapshot.');
                return;
              }
              emit(ordered);
            }
          } });
          const completion = await handle.done();
          await queue;
          if (progressFailure !== undefined) throw progressFailure;
          if (completion.delivery_id !== intent.intentId) return { kind: 'uncertain' };
          if (completion.status === 'succeeded' && completion.error === null && completion.result !== null) {
            const reply = completion.result;
            const snapshot = terminal.snapshot;
            if (reply.model !== resolved.installed.profile.model || snapshot === null || snapshot.state !== 'succeeded' || snapshot.content !== reply.content) {
              return { kind: 'uncertain' };
            }
            let used: number | null = null;
            if (reply.inputTokens !== null && reply.outputTokens !== null) {
              if (!Number.isSafeInteger(reply.inputTokens) || reply.inputTokens < 0 || !Number.isSafeInteger(reply.outputTokens) || reply.outputTokens < 0 ||
                  !Number.isSafeInteger(reply.inputTokens + reply.outputTokens)) return { kind: 'uncertain' };
              used = reply.inputTokens + reply.outputTokens;
            }
            emit(snapshot);
            await queue;
            if (progressFailure !== undefined) throw progressFailure;
            if (used !== null) {
              emit({ sequence: snapshot.sequence + 1, state: 'succeeded', content: snapshot.content }, used);
              await queue;
              if (progressFailure !== undefined) throw progressFailure;
            }
            return { kind: 'delivered', result: latest() };
          }
          if (completion.status === 'failed' && completion.result === null && completion.error !== null) {
            const snapshot = terminal.snapshot;
            if (snapshot !== null && (snapshot.state === 'failed' || snapshot.state === 'cancelled')) {
              emit(snapshot, null, snapshot.state === 'cancelled'
                ? 'Installed text generation cancelled.' : 'Installed text generation failed.');
              await queue;
              if (progressFailure !== undefined) throw progressFailure;
              return { kind: 'delivered', result: latest() };
            }
            if (snapshot !== null) return { kind: 'uncertain' };
            return { kind: 'failed', cause: { kind: 'permanent', code: completion.error.code,
              message: 'Installed text generation failed.' } };
          }
          return { kind: 'uncertain' };
        } catch (error) {
          if (progressFailure !== undefined) throw progressFailure;
          return { kind: 'uncertain' };
        }
      })();
      const run: LiveRun = { get handle() { return handle; }, result, settled: false, acknowledged: false };
      runs.set(intent.intentId, run);
      // Both outcomes finish the live run, including a rejected durable callback.
      // Uncertain results remain cached until definitive Work acknowledgement.
      const settled = () => {
        run.settled = true;
        if (run.acknowledged && runs.get(intent.intentId) === run) runs.delete(intent.intentId);
      };
      void result.then(settled, settled);
      return result;
    },
    releaseAcknowledged(intent) {
      if (intent.target !== TARGET) return;
      const run = runs.get(intent.intentId);
      if (run === undefined) return;
      run.acknowledged = true;
      if (run.settled) runs.delete(intent.intentId);
    },
    async cancel(intent) {
      if (resolve(intent) === null) return null;
      const run = runs.get(intent.intentId);
      if (run?.handle === null || run === undefined) return null;
      await run.handle.cancel();
      return run.result;
    },
    async reconcile(intent) {
      const resolved = resolve(intent);
      if (resolved === null) return null;
      const run = runs.get(intent.intentId);
      if (run !== undefined) {
        let outcome: DispatchProviderOutcome;
        try { outcome = await run.result; }
        catch { return null; }
        if (outcome.kind === 'delivered') return outcome;
        if (outcome.kind === 'failed') return { kind: 'failed', code: outcome.cause.kind === 'handler-require-false'
          ? 'require-false' : outcome.cause.code, message: 'Installed text generation failed.' };
        return null;
      }
      // The installed Ollama port honestly returns unknown without a durable lookup.
      await resolved.installed.text.reconcile(intent.intentId);
      return null;
    },
  };
}
