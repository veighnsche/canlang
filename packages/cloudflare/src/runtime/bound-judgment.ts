/** Exact installed static judgment boundary; provider policy stays Services-owned. */
import type { Bcp47Tag, CanonicalValueTypes, CanValue, OutboxIntent, ReceiptResultContext } from '@canlang/contracts';
import { encodeValue, normalizeValueTypes, scalarLength, validateValue } from '@canlang/values';
import { freezeJudgmentSource } from '@canlang/services';
import type { InstalledJudgment, ResolveInstalledJudgment, StaticJudgmentDescriptor } from '@canlang/services';
import { createJudgmentReceiptContext } from '@canlang/state/receipt/tables';
import type { DispatchProviderOutcome, DispatchReconcileEvidence } from './invoke.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function member(value: unknown, key: string): unknown {
  if (!record(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('Judgment metadata must be own data.');
  return descriptor.value;
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key =>
    Object.hasOwn(value, key) && member(value, key) !== undefined);
}
function sourceFor(definition: unknown, alias: string, target: string) {
  const binding = member(member(definition, 'bindings'), alias);
  const declaration = member(binding, 'judgment');
  const from = member(binding, 'from');
  if (typeof declaration !== 'string' || declaration === '' || target !== `${declaration}.evaluate` ||
      typeof from !== 'string' || from === '') throw new Error('Judgment requires its exact checked binding and target.');
  const descriptor = member(member(definition, 'judgments'), declaration);
  const language = member(descriptor, 'sourceLanguage');
  const version = member(descriptor, 'version');
  const questions = member(descriptor, 'questions');
  if (typeof language !== 'string' || typeof version !== 'bigint' || !Array.isArray(questions)) {
    throw new Error('Judgment source descriptor is unavailable.');
  }
  const source = freezeJudgmentSource(declaration, { version, questions } as StaticJudgmentDescriptor, language as Bcp47Tag);
  return { declaration, from, source };
}

/** Invocation-stage helper: authored inputs contain state only, never source or revision. */
export function freezeBoundJudgmentRequest(input: {
  readonly appDefinition: unknown;
  readonly binding: string;
  readonly target: string;
  readonly arguments: unknown;
}) {
  if (!closed(input.arguments, ['state']) || typeof member(input.arguments, 'state') !== 'string') {
    throw new Error('Static judgment authored arguments must contain only text state.');
  }
  if (scalarLength(member(input.arguments, 'state') as string) > 40000n) {
    throw new Error('Static judgment state exceeds its declared scalar limit.');
  }
  const { from, source } = sourceFor(input.appDefinition, input.binding, input.target);
  return Object.freeze({ binding: input.binding, from,
    arguments: Object.freeze({ state: member(input.arguments, 'state') as string }),
    judgment: Object.freeze({ specification: encodeValue('std.JudgmentSpec', source.specification as unknown as CanValue),
      order: source.order }) });
}

export interface BoundJudgmentOptions {
  readonly appDefinition: unknown;
  readonly valueTypes: CanonicalValueTypes;
  readonly binding: InstalledJudgment['binding'];
  readonly resolveInstalledJudgment: ResolveInstalledJudgment;
}
export interface BoundJudgmentAdapter {
  available(intent: OutboxIntent): boolean;
  resultContext(intent: OutboxIntent): ReceiptResultContext | null;
  callProvider(intent: OutboxIntent): Promise<DispatchProviderOutcome>;
  reconcile(intent: OutboxIntent): Promise<DispatchReconcileEvidence | null>;
}

export function createBoundJudgmentAdapter(options: BoundJudgmentOptions): BoundJudgmentAdapter {
  const { appDefinition, resolveInstalledJudgment } = options;
  const expected = Object.freeze({ ...options.binding });
  const { valueTypes, valueSchema: schema } = normalizeValueTypes(options.valueTypes);
  const resolve = (intent: OutboxIntent) => {
    try {
      const carrier = intent.arguments;
      if (!closed(carrier, ['binding', 'from', 'arguments', 'judgment']) || typeof carrier.binding !== 'string' ||
          !closed(carrier.arguments, ['state']) || typeof carrier.arguments.state !== 'string' ||
          !closed(carrier.judgment, ['specification', 'order'])) return null;
      if (scalarLength(carrier.arguments.state) > 40000n) return null;
      const checked = sourceFor(appDefinition, carrier.binding, intent.target);
      if (checked.declaration !== expected.judgment || checked.from !== expected.deployment || carrier.from !== checked.from ||
          checked.source.specification.version !== expected.version || typeof expected.version !== 'bigint' ||
          expected.account === '' || expected.deployment === '') return null;
      const original = encodeValue('std.JudgmentSpec', checked.source.specification as unknown as CanValue);
      if (JSON.stringify(carrier.judgment.specification) !== JSON.stringify(original) ||
          JSON.stringify(carrier.judgment.order) !== JSON.stringify(checked.source.order)) return null;
      const leaves = valueTypes.contracts.find(contract => contract.name === checked.declaration)?.fields;
      if (leaves === undefined) return null;
      if (leaves.length === 0) return null;
      validateValue(schema, 'std.JudgmentSpec', carrier.judgment.specification, 'create');
      const installed = resolveInstalledJudgment(expected.deployment);
      if (installed === null || installed.binding.judgment !== expected.judgment || installed.binding.version !== expected.version ||
          installed.binding.deployment !== expected.deployment || installed.binding.account !== expected.account ||
          installed.profile.model === '' || installed.profile.provider === '' || installed.profile.inputTokenization !== 'deployment' ||
          !Number.isSafeInteger(installed.profile.maxInputTokens) || installed.profile.maxInputTokens < 1) return null;
      const context = createJudgmentReceiptContext({ kind: 'delivery', judgment: true,
        capability: checked.declaration, operation: 'evaluate', version: expected.version.toString(),
        result: { name: checked.declaration, fields: leaves } }, checked.source.specification, valueTypes);
      return { installed, source: checked.source, state: carrier.arguments.state, schema, context };
    } catch { return null; }
  };
  const completion = (value: unknown, intent: OutboxIntent, resolved: NonNullable<ReturnType<typeof resolve>>): DispatchReconcileEvidence | null => {
    if (!record(value) || value.delivery_id !== intent.intentId) return null;
    if (value.status === 'succeeded') {
      const result = value.result;
      if (!record(result) || result.specification_revision !== resolved.source.specification.revision ||
          result.model !== resolved.installed.profile.model) return null;
      const wire = encodeValue(resolved.context.declaredResult.name, result as unknown as CanValue);
      validateValue(resolved.schema, resolved.context.declaredResult.name, wire, 'create');
      return { kind: 'delivered', result: wire };
    }
    if (value.status === 'failed' && value.result === null && record(value.error) &&
        typeof value.error.code === 'string' && typeof value.error.message === 'string') {
      return { kind: 'failed', code: value.error.code, message: value.error.message };
    }
    return null;
  };
  return Object.freeze({ available: (intent: OutboxIntent) => resolve(intent) !== null,
    resultContext: (intent: OutboxIntent) => resolve(intent)?.context ?? null,
    async callProvider(intent: OutboxIntent): Promise<DispatchProviderOutcome> {
      const resolved = resolve(intent);
      if (resolved === null) return { kind: 'uncertain' };
      try {
        const evidence = completion(await resolved.installed.judgment.evaluate({ source: resolved.source, state: resolved.state },
          { deliveryId: intent.intentId }), intent, resolved);
        if (evidence?.kind === 'delivered') return evidence;
        if (evidence?.kind === 'failed') return { kind: 'failed', cause: { kind: 'permanent', code: evidence.code, message: evidence.message } };
      } catch { /* A thrown provider result is not decisive completion. */ }
      return { kind: 'uncertain' };
    },
    async reconcile(intent: OutboxIntent): Promise<DispatchReconcileEvidence | null> {
      const resolved = resolve(intent);
      if (resolved === null) return null;
      try { return completion(await resolved.installed.judgment.reconcile(intent.intentId), intent, resolved); }
      catch { return null; }
    },
  });
}
