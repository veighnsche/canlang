import type { FieldMachine } from '@canlang/contracts';

/** Shared boundary validation; callers choose their own error taxonomy. */
export function checkFieldMachine(value: unknown): FieldMachine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('machine must be an object');
  }
  const raw = value as Record<string, unknown>;
  const states = raw['states'];
  const initial = raw['initial'];
  if (!Array.isArray(states) || states.length === 0 ||
      !states.every((state) => typeof state === 'string' && state !== '') ||
      new Set(states).size !== states.length || typeof initial !== 'string' || !states.includes(initial)) {
    throw new Error('machine requires distinct non-empty states containing its initial state');
  }
  if (!Array.isArray(raw['transitions'])) throw new Error('machine transitions must be an array');
  const transitions = raw['transitions'].map((edge: unknown) => {
    if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) throw new Error('machine edge must be an object');
    const site = edge as Record<string, unknown>;
    if (typeof site['from'] !== 'string' || !states.includes(site['from']) ||
        typeof site['to'] !== 'string' || !states.includes(site['to']) ||
        typeof site['operation'] !== 'string' || site['operation'] === '') {
      throw new Error('machine edge requires declared endpoints and a non-empty operation');
    }
    return { from: site['from'], to: site['to'], operation: site['operation'] };
  });
  return { initial, states: [...states] as string[], transitions };
}
