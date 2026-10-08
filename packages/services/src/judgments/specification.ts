/** One source-owned descriptor feeds both the retained specification and provider request. */
import { createHash } from 'node:crypto';
import { normalizeValueTypes, scalarLength, validateValue } from '@canlang/values';
import type {
  Bcp47Tag, CanonicalValueTypes, ChoiceQuestion, JudgmentOption, JudgmentSpec, MessageValue, NoulQuestion, ScoreQuestion,
} from '@canlang/contracts';

export type StaticJudgmentQuestion =
  | { readonly name: string; readonly kind: 'noul'; readonly instructions: MessageValue;
      readonly yes?: MessageValue; readonly no?: MessageValue }
  | { readonly name: string; readonly kind: 'choice'; readonly instructions: MessageValue;
      readonly runtime?: false; readonly options: readonly { readonly id: string; readonly description: MessageValue }[] }
  | { readonly name: string; readonly kind: 'choice'; readonly instructions: MessageValue;
      readonly runtime: true; readonly options?: readonly { readonly id: string; readonly description: MessageValue }[] }
  | { readonly name: string; readonly kind: 'score'; readonly instructions: MessageValue;
      readonly levels: readonly { readonly id: string; readonly description: MessageValue }[] };

export interface StaticJudgmentDescriptor {
  readonly version: bigint;
  readonly questions: readonly StaticJudgmentQuestion[];
  /** Borrow the artifact inventory; never publish a second source schema. */
  readonly valueTypes?: CanonicalValueTypes;
}

/** `order` preserves interleaved source questions; grouped retained arrays share those same frozen values. */
export interface FrozenJudgmentSource {
  readonly specification: JudgmentSpec;
  readonly order: readonly string[];
}

const RESERVED = new Set(['specification_revision', 'model', 'input_tokens', 'output_tokens']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuse executable/inherited input before the shared schema reads it. */
function assertOptionsData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === 'string') return;
  if (typeof value !== 'object' || depth > 2 || ancestors.has(value)) throw new Error('Invalid judgment options data.');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('Invalid judgment options prototype.');
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new Error('Invalid judgment options array.');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error('Invalid judgment options key.');
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) throw new Error('Invalid judgment options accessor.');
    assertOptionsData(property.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

/** No display locale, provider text or executable message parameter participates in inference. */
export function freezeJudgmentSource(
  declaration: string,
  descriptor: StaticJudgmentDescriptor,
  language: Bcp47Tag,
  runtimeOptions?: unknown,
): FrozenJudgmentSource {
  const fail = (): never => { throw new Error('Invalid static judgment source.'); };
  if (typeof declaration !== 'string' || declaration === '' || typeof language !== 'string' || language === '') fail();
  try { if (Intl.getCanonicalLocales(language)[0] !== language) fail(); } catch { fail(); }
  if (typeof descriptor?.version !== 'bigint' || descriptor.version < 0n || descriptor.version > 9223372036854775807n ||
      !Array.isArray(descriptor.questions) || descriptor.questions.length < 1 || descriptor.questions.length > 32) fail();
  const runtimeQuestions = descriptor.questions.filter((question): question is Extract<StaticJudgmentQuestion, { runtime: true }> =>
    question.kind === 'choice' && question.runtime === true);
  let supplied: Readonly<Record<string, unknown>> | undefined;
  let schema: ReturnType<typeof normalizeValueTypes>['valueSchema'] | undefined;
  if (runtimeQuestions.length === 0) {
    if (runtimeOptions !== undefined) fail();
  } else {
    if (descriptor.valueTypes === undefined || runtimeOptions === undefined) fail();
    try {
      assertOptionsData(runtimeOptions);
      const normalized = normalizeValueTypes(descriptor.valueTypes);
      schema = normalized.valueSchema;
      const contract = normalized.valueTypes.contracts.find(contract => contract.name === `${declaration}.options`);
      if (!contract || contract.fields.length !== runtimeQuestions.length) fail();
      for (const question of runtimeQuestions) {
        const fixed = question.options ?? [];
        if (!Array.isArray(fixed) || question.options !== undefined && fixed.length === 0 || fixed.length > 26) fail();
        const field = contract!.fields.find(field => field.name === question.name);
        const aliasName = `${declaration}.${question.name}.choice`;
        const alias = normalized.valueTypes.aliases?.find(alias => alias.name === aliasName);
        const element = normalized.valueTypes.contracts.find(contract => contract.name === `${declaration}.${question.name}.option`);
        const id = element?.fields.find(field => field.name === 'id');
        const description = element?.fields.find(field => field.name === 'description');
        if (!field || field.type !== `${declaration}.${question.name}.option[]!` ||
            field.min !== Math.max(0, 2 - fixed.length) || field.max !== 26 - fixed.length ||
            field.distinctBy !== 'id' || !field.excludedIds || field.excludedIds.length !== fixed.length ||
            !field.excludedIds.every((id, index) => id === fixed[index]?.id) ||
            !alias || alias.type !== 'text' || alias.min !== 1 || alias.max !== 80 || alias.format !== 'name' ||
            !element || element.fields.length !== 2 || id?.type !== aliasName ||
            description?.type !== 'text' || description.min !== 1 || description.max !== 2000) fail();
        for (const option of fixed) validateValue(schema, aliasName, option.id, 'create');
      }
      supplied = validateValue(schema, `${declaration}.options`, runtimeOptions, 'create') as Readonly<Record<string, unknown>>;
    } catch { fail(); }
  }
  let scalarCount = 0;
  const caption = (value: MessageValue): string => {
    const text = typeof value === 'string' ? value : value?.source;
    if (typeof text !== 'string' || text === '' ||
        (typeof value === 'object' && value !== null && value.params !== undefined && Object.keys(value.params).length !== 0)) fail();
    const length = Number(scalarLength(text));
    scalarCount += length;
    if (length > 2000 || scalarCount > 24000) fail();
    return text;
  };
  const options = (entries: readonly { readonly id: string; readonly description: MessageValue }[], maximum: number): readonly JudgmentOption[] => {
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > maximum) fail();
    const ids = new Set<string>();
    return Object.freeze(entries.map(entry => {
      if (typeof entry?.id !== 'string' || !IDENTIFIER.test(entry.id) || ids.has(entry.id)) fail();
      ids.add(entry.id);
      return Object.freeze({ id: entry.id, description: caption(entry.description) });
    }));
  };
  const noul: NoulQuestion[] = [], choice: ChoiceQuestion[] = [], score: ScoreQuestion[] = [];
  const order: string[] = [];
  const ordered: unknown[] = [];
  for (const entry of descriptor.questions) {
    if (typeof entry?.name !== 'string' || !IDENTIFIER.test(entry.name) || RESERVED.has(entry.name) || order.includes(entry.name)) fail();
    if (Object.hasOwn(entry, 'runtime') && (entry as unknown as Record<string, unknown>)['runtime'] !== false &&
        !(entry.kind === 'choice' && entry.runtime === true)) fail();
    const id = entry.name, instructions = caption(entry.instructions);
    order.push(id);
    switch (entry.kind) {
      case 'noul': {
        if ((entry.yes === undefined) !== (entry.no === undefined)) fail();
        const question = Object.freeze({ id, instructions,
          yes: entry.yes === undefined ? null : caption(entry.yes),
          no: entry.no === undefined ? null : caption(entry.no) });
        noul.push(question); ordered.push(['noul', question]); break;
      }
      case 'choice': {
        const values = entry.runtime === true
          ? [...(entry.options ?? []), ...(supplied![id] as readonly { readonly id: string; readonly description: string }[])]
          : entry.options;
        const question = Object.freeze({ id, instructions, options: options(values, 26) });
        choice.push(question); ordered.push(['choice', question]); break;
      }
      case 'score': {
        const question = Object.freeze({ id, instructions, levels: options(entry.levels, 10) });
        score.push(question); ordered.push(['score', question]); break;
      }
      default: fail();
    }
  }
  const revision = `sha256:${createHash('sha256').update(JSON.stringify([
    'can-static-judgment-v1', declaration, descriptor.version.toString(), language, ordered,
  ]), 'utf8').digest('hex')}`;
  const specification = Object.freeze({ declaration, version: descriptor.version, revision, language,
    noul: Object.freeze(noul), choice: Object.freeze(choice), score: Object.freeze(score) });
  return Object.freeze({ specification, order: Object.freeze(order) });
}
