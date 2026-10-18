/** Portable recurrence scope checks shared by owning Work system commands. */
import type { RecurringScope } from '@canlang/contracts';

/**
 * Shared rejection constructor: the defining class lives in
 * `@canlang/work-kernel/every` (the same constructor the selected
 * kernel throws across the transport boundary), re-exported here so
 * the Work every-scope surface keeps one error identity end to end.
 */
export { RootRecurrenceNotSupportedError } from '@canlang/work-kernel/every';

/** Map key joining one fanout scope to its last admitted slot. */
export function everyScopeKey(scope: RecurringScope, owner: string): string {
  return `${scope}:${owner}`;
}

