/** Exact installed std text generation; progress is staged by the caller. */
import { STD_TEXT_GENERATION_V1_VERSION } from '@canlang/contracts';
import type { OutboxIntent, ProviderBinding, TextRequest, TextMessage, ModelRunSnapshot, ReceiptResultContext } from '@canlang/contracts';
import { deliveryResultLeaves } from '@canlang/contracts';
import type { InstalledTextGeneration, ResolveInstalledTextGeneration, ModelRunHandle } from '@canlang/services';
import { encodeValue, normalizeSchema, validateOperationInput } from '@canlang/values';
import type { SchemaDescriptor } from '@canlang/values';
import type { DispatchProviderOutcome, DispatchReconcileEvidence } from './invoke.js';
import type { DispatchImageCorrelation } from '@canlang/work/kernel/tables';
import { isTextRunReceiptPayload } from '@canlang/state/receipt/tables';

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
export interface BoundTextGenerationControlCallOptions {
  /** Actual host clock; the persisted window never starts again on recovery. */
  readonly nowMs: () => number;
  readonly observation: { readonly startedAtMs: number; readonly deadlineMs: number };
  readonly originalScope: { readonly app: string; readonly owner: string; readonly principal: string };
  readonly retainedProgress: TextRunWire | null;
  readonly recovering?: boolean;
  readonly onProgress: (progress: TextRunWire) => Promise<void>;
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
  /** Positive entries are required before the dispatcher may claim a source control. */
  controlCorrelation?(control: OutboxIntent, owner: string): DispatchImageCorrelation | null;
  controlObservation?(control: OutboxIntent, startedAtMs: number): BoundTextGenerationControlCallOptions['observation'] | null;
  observeControl?(control: OutboxIntent, original: OutboxIntent,
    options: BoundTextGenerationControlCallOptions): Promise<DispatchProviderOutcome>;
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
  readonly identity: string;
  handle: ModelRunHandle | null;
  readonly result: Promise<DispatchProviderOutcome>;
  settled: boolean;
  acknowledged: boolean;
}

export function createBoundTextGenerationAdapter(options: BoundTextGenerationOptions): BoundTextGenerationAdapter {
  const expected = Object.freeze({ ...options.binding });
  const runs = new Map<string, LiveRun>();
  const resolveControl = (intent: OutboxIntent) => {
    try {
      if (![`${CAPABILITY}.cancel`, `${CAPABILITY}.reconcile`].includes(intent.target) || intent.intentId === '' ||
          !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier['binding'] !== 'string' || carrier['from'] !== expected.deployment ||
          !closed(carrier['arguments'], ['source', 'revision'])) return null;
      const app = member(options.appDefinition, 'id');
      const binding = member(member(options.appDefinition, 'bindings'), carrier['binding']);
      const capability = member(member(options.appDefinition, 'capabilities'), CAPABILITY);
      const version = member(capability, 'version');
      const operation = member(member(capability, 'operations'), intent.target.slice(`${CAPABILITY}.`.length));
      const inputs = member(operation, 'inputs');
      const contracts = member(options.appDefinition, 'contracts');
      const enums = member(options.appDefinition, 'enums') ?? {};
      const leaves = deliveryResultLeaves('TextRun');
      const fields = member(member(contracts, 'TextRun'), 'fields');
      if (typeof app !== 'string' || app === '' ||
          member(member(options.appDefinition, 'operations'), intent.operation) === undefined ||
          member(binding, 'capability') !== CAPABILITY || member(binding, 'from') !== carrier['from'] ||
          expected.capability !== CAPABILITY || expected.capabilityVersion !== STD_TEXT_GENERATION_V1_VERSION ||
          expected.account === '' || expected.deployment === '' ||
          (version !== STD_TEXT_GENERATION_V1_VERSION && version !== BigInt(STD_TEXT_GENERATION_V1_VERSION)) ||
          member(member(operation, 'result'), 'type') !== 'TextRun' || !record(inputs) ||
          Object.keys(inputs).length !== 2 || member(member(inputs, 'source'), 'type') !== 'text' ||
          member(member(inputs, 'revision'), 'type') !== 'int' || !record(contracts) || !record(enums) ||
          leaves === null || !record(fields) || Object.keys(fields).length !== leaves.length ||
          !leaves.every(leaf => member(member(fields, leaf.name), 'type') === leaf.type)) return null;
      const schema = normalizeSchema({ contracts, enums, operations: { [intent.target]: { inputs } } } as SchemaDescriptor);
      const checked = validateOperationInput(schema, intent.target, carrier['arguments']);
      if (typeof checked['source'] !== 'string' || checked['source'] === '') return null;
      const revision = encodeValue('int', BigInt(safeInt(checked['revision'], 0))) as string;
      const installed = options.resolveInstalledTextGeneration(expected.deployment);
      if (installed === null || installed.binding.deployment !== expected.deployment || installed.binding.account !== expected.account ||
          installed.binding.capability !== CAPABILITY || installed.binding.capabilityVersion !== expected.capabilityVersion) return null;
      const profile = installed.profile;
      if ([profile.name, profile.policyRevision, profile.provider, profile.model].some(value => typeof value !== 'string' || value === '') ||
          profile.inputTokenization !== 'deployment' || profile.attachments !== 'unsupported' ||
          !Number.isSafeInteger(profile.maxInputTokens) || profile.maxInputTokens <= 0 ||
          !Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0 ||
          !Number.isSafeInteger(profile.maxDurationMs) || profile.maxDurationMs <= 0 ||
          typeof installed.text.generateStream !== 'function' || typeof installed.text.reconcile !== 'function') return null;
      return { app, binding: carrier['binding'], from: carrier['from'], installed,
        context: Object.freeze({ source: intent.target, declaredResult: Object.freeze({ name: 'TextRun', fields: leaves }),
          request: Object.freeze({ source: checked['source'], revision }) }) satisfies ReceiptResultContext };
    } catch { return null; }
  };
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
  const identity = (intent: OutboxIntent, resolved: Resolved): string => JSON.stringify({
    intentId: intent.intentId, operationId: intent.operationId, operation: intent.operation,
    occurrenceIndex: intent.occurrenceIndex, dispatchGuard: intent.dispatchGuard ?? null,
    binding: intent.arguments['binding'], from: intent.arguments['from'],
    input: { ...resolved.input, max_duration: String(resolved.input.max_duration) },
    profile: { name: resolved.installed.profile.name, policyRevision: resolved.installed.profile.policyRevision,
      provider: resolved.installed.profile.provider, model: resolved.installed.profile.model,
      maxInputTokens: resolved.installed.profile.maxInputTokens, maxOutputTokens: resolved.installed.profile.maxOutputTokens,
      maxDurationMs: resolved.installed.profile.maxDurationMs },
  });
  return {
    available: intent => resolve(intent) !== null || resolveControl(intent) !== null,
    resultContext: intent => resolve(intent)?.context ?? resolveControl(intent)?.context ?? null,
    controlCorrelation(control, owner) {
      const resolved = resolveControl(control);
      if (resolved === null || typeof owner !== 'string' || owner === '') return null;
      return Object.freeze({ requestSource: resolved.context.request!.source, requestRevision: resolved.context.request!.revision,
        requestBinding: resolved.binding, requestFrom: resolved.from, requestApp: resolved.app, requestOwner: owner });
    },
    controlObservation(control, startedAtMs) {
      const resolved = resolveControl(control);
      if (resolved === null) return null;
      const deadlineMs = startedAtMs + resolved.installed.profile.maxDurationMs;
      return Number.isSafeInteger(startedAtMs) && startedAtMs >= 0 && Number.isSafeInteger(deadlineMs)
        ? Object.freeze({ startedAtMs, deadlineMs }) : null;
    },
    async observeControl(control, original, call) {
      if (!record(call) || !closed(call.observation, ['startedAtMs', 'deadlineMs']) ||
          !closed(call.originalScope, ['app', 'owner', 'principal']) ||
          (call.retainedProgress !== null && !record(call.retainedProgress))) return { kind: 'uncertain' };
      const invocation = resolveControl(control), resolved = resolve(original);
      if (invocation === null || resolved === null || control.intentId === original.intentId ||
          call.originalScope.app !== invocation.app || typeof call.originalScope.owner !== 'string' || call.originalScope.owner === '' ||
          typeof call.originalScope.principal !== 'string' || call.originalScope.principal === '' ||
          member(member(options.appDefinition, 'operations'), original.operation) === undefined ||
          invocation.context.request!.source !== resolved.context.request!.source ||
          invocation.context.request!.revision !== resolved.context.request!.revision ||
          control.arguments['binding'] !== original.arguments['binding'] || control.arguments['from'] !== original.arguments['from'] ||
          typeof call.nowMs !== 'function' || typeof call.onProgress !== 'function') return { kind: 'uncertain' };
      const { startedAtMs, deadlineMs } = call.observation;
      const span = deadlineMs - startedAtMs;
      let now: number;
      try { now = call.nowMs(); } catch { return { kind: 'uncertain' }; }
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(deadlineMs) ||
          !Number.isSafeInteger(span) || span <= 0 || span > invocation.installed.profile.maxDurationMs ||
          !Number.isSafeInteger(now) || now < startedAtMs || now >= deadlineMs) return { kind: 'uncertain' };
      const retained = call.retainedProgress;
      if (retained !== null && !isTextRunReceiptPayload(retained.state === 'queued' || retained.state === 'running' ? 'pending'
        : retained.state === 'unknown' ? 'unknown' : 'succeeded', retained, null, resolved.context)) return { kind: 'uncertain' };
      const run = runs.get(original.intentId);
      if (run !== undefined && run.identity !== identity(original, resolved)) return { kind: 'uncertain' };
      // This fixed remaining budget includes cancel, the original run's durable
      // progress, and the control callback. Timing out never aborts that run.
      return new Promise<DispatchProviderOutcome>(finish => {
        let expired = false, settled = false;
        let remainingBudget = 0, monotonicStart = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (outcome: DispatchProviderOutcome) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          finish(outcome);
        };
        const remaining = (): number => {
          const elapsed = performance.now() - monotonicStart;
          return Number.isFinite(elapsed) && elapsed >= 0 ? remainingBudget - elapsed : 0;
        };
        const arm = () => {
          const left = remaining();
          if (left <= 0) { expired = true; done({ kind: 'uncertain' }); return; }
          const delay = Math.max(1, Math.min(left, 2_147_483_647));
          timer = setTimeout(() => {
            // Recompute actual elapsed time, including event-loop delay;
            // neither chunking nor a fixed host epoch clock renews the budget.
            arm();
          }, delay);
        };
        const current = (): boolean => {
          try { const time = call.nowMs(); return !expired && remaining() > 0 &&
            Number.isSafeInteger(time) && time >= startedAtMs && time < deadlineMs; }
          catch { return false; }
        };
        let timerNow: number;
        try { timerNow = call.nowMs(); } catch { done({ kind: 'uncertain' }); return; }
        if (!Number.isSafeInteger(timerNow) || timerNow < startedAtMs || timerNow >= deadlineMs) {
          done({ kind: 'uncertain' }); return;
        }
        remainingBudget = Math.min(deadlineMs - now, deadlineMs - timerNow);
        monotonicStart = performance.now();
        arm();
        const observe = async (): Promise<DispatchProviderOutcome> => {
          if (!current()) return { kind: 'uncertain' };
          if (retained !== null && ['succeeded', 'failed', 'cancelled'].includes(retained.state)) {
            return { kind: 'delivered', result: retained };
          }
          const handle = run?.handle;
          if (handle !== undefined && handle !== null && run !== undefined) {
            if (handle.deliveryId !== original.intentId) return { kind: 'uncertain' };
            if (control.target === `${CAPABILITY}.cancel` && call.recovering !== true && !run.settled && !handle.cancelRequested) {
              await handle.cancel();
              if (!current()) return { kind: 'uncertain' };
            }
            const outcome = await run.result;
            if (!current()) return { kind: 'uncertain' };
            if (outcome.kind === 'delivered') {
              await call.onProgress(outcome.result as TextRunWire);
              if (!current()) return { kind: 'uncertain' };
            }
            return outcome;
          }
          const completion = await resolved.installed.text.reconcile(original.intentId);
          if (!current() || completion.delivery_id !== original.intentId || completion.status !== 'unknown' ||
              completion.result !== null || completion.error?.code !== 'no_run_resume') return { kind: 'uncertain' };
          // No-resume is an absence of evidence, not an ordered progress
          // observation. Preserve the original retained content and usage.
          return { kind: 'uncertain' };
        };
        void observe().then(outcome => done(current() ? outcome : { kind: 'uncertain' }), () => done({ kind: 'uncertain' }));
      });
    },
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
      const run: LiveRun = { identity: identity(intent, resolved), get handle() { return handle; }, result, settled: false, acknowledged: false };
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
