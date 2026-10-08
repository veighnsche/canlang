/** One source-owned static descriptor feeds both the retained specification and provider request. */
import { createHash } from 'node:crypto';
import { scalarLength } from '@canlang/values';
import type {
  Bcp47Tag, ChoiceQuestion, JudgmentOption, JudgmentSpec, MessageValue, NoulQuestion, ScoreQuestion,
} from '@canlang/contracts';

export type StaticJudgmentQuestion =
  | { readonly name: string; readonly kind: 'noul'; readonly instructions: MessageValue;
      readonly yes?: MessageValue; readonly no?: MessageValue }
  | { readonly name: string; readonly kind: 'choice'; readonly instructions: MessageValue;
      readonly options: readonly { readonly id: string; readonly description: MessageValue }[] }
  | { readonly name: string; readonly kind: 'score'; readonly instructions: MessageValue;
      readonly levels: readonly { readonly id: string; readonly description: MessageValue }[] };

export interface StaticJudgmentDescriptor {
  readonly version: bigint;
  readonly questions: readonly StaticJudgmentQuestion[];
}

/** `order` preserves interleaved source questions; grouped retained arrays share those same frozen values. */
export interface FrozenJudgmentSource {
  readonly specification: JudgmentSpec;
  readonly order: readonly string[];
}

const RESERVED = new Set(['specification_revision', 'model', 'input_tokens', 'output_tokens']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** No display locale, provider text or executable message parameter participates in inference. */
export function freezeJudgmentSource(
  declaration: string,
  descriptor: StaticJudgmentDescriptor,
  language: Bcp47Tag,
): FrozenJudgmentSource {
  const fail = (): never => { throw new Error('Invalid static judgment source.'); };
  if (typeof declaration !== 'string' || declaration === '' || typeof language !== 'string' || language === '') fail();
  try { if (Intl.getCanonicalLocales(language)[0] !== language) fail(); } catch { fail(); }
  if (typeof descriptor?.version !== 'bigint' || descriptor.version < 0n || descriptor.version > 9223372036854775807n ||
      !Array.isArray(descriptor.questions) || descriptor.questions.length < 1 || descriptor.questions.length > 32) fail();
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
        const question = Object.freeze({ id, instructions, options: options(entry.options, 26) });
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
