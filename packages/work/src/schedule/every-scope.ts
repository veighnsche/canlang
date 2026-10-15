/** Portable recurrence scope checks shared by owning Work system commands. */
import type { RecurringScope } from '@canlang/contracts';

/** Typed rejection for non-team/app recurring scopes (notably root). */
export class RootRecurrenceNotSupportedError extends Error {
  readonly code = 'ROOT_RECURRING_UNSUPPORTED' as const;
  readonly scope: string;

  constructor(scope: string) {
    super(
      `work: recurring every() fanout covers team/app scopes only; rejected scope ` +
        `'${scope}' (root recurrence uses explicit record-bound schedule)`,
    );
    this.name = 'RootRecurrenceNotSupportedError';
    this.scope = scope;
  }
}

/** Map key joining one fanout scope to its last admitted slot. */
export function everyScopeKey(scope: RecurringScope, owner: string): string {
  return `${scope}:${owner}`;
}

