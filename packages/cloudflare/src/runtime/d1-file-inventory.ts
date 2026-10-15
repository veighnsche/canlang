/** Bind the actual already-selected D1 owner to its original source inventory. */
import type { D1Database } from '@cloudflare/workers-types';
import type { FileRetirementAuthority, WorkScope } from '@canlang/contracts';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';

export const runtimeFileReferenceProducers = Object.freeze([STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);

/** Caller first selects/pins this physical owner with the normal State router.
 * The first inventory installation atomically persists a newly allocated ID.
 * Reopen uses that physical assignment, never a source tag as its identity. */
export async function d1FileAuthority(db: D1Database, scope: WorkScope, fileStoreId: string): Promise<FileRetirementAuthority> {
  const saved = await db.prepare('SELECT authority FROM file_reference_authority WHERE id=1').first<{ authority: string }>();
  if (saved !== null) {
    const authority = JSON.parse(saved.authority) as FileRetirementAuthority;
    if (authority.app !== scope.app || authority.receiver.app !== scope.app || authority.receiver.team !== scope.owner ||
        authority.receiver.owner !== scope.owner || authority.fileStoreId !== fileStoreId || typeof authority.stateStoreId !== 'string' || authority.stateStoreId === '') {
      throw new Error('The physical State/Files assignment differs from this configured owner.');
    }
    return authority;
  }
  return Object.freeze({ app: scope.app, stateOwner: scope.ownerPackage,
    stateStoreId: `d1:${crypto.randomUUID()}`, fileStoreId,
    receiver: Object.freeze({ app: scope.app, team: scope.owner, owner: scope.owner }) });
}
