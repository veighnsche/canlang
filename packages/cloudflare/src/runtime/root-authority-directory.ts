/** Eventual root discovery contains identities only; business records stay in their DO. */
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, ModelName, OperationId, OperationName, RecordId, StoragePort } from '@canlang/contracts';
import type { RootScope } from './root-authority.js';

const TARGET = 'can.runtime.root-directory';
export interface RootDirectoryEntry {
  readonly app: string; readonly owner: string; readonly binding: string; readonly model: string;
  readonly rootId: string; readonly revision: number; readonly available: boolean;
}
export interface RootDirectory {
  publish(entry: RootDirectoryEntry): Promise<void>;
  list(scope: Pick<RootDirectoryEntry, 'app' | 'owner' | 'binding' | 'model'>,
    page: { readonly limit: number; readonly after?: string }): Promise<readonly RootDirectoryEntry[]>;
}

export function enqueueRootDirectoryUpdate(batch: CommitBatch, scope: RootScope, models: ReadonlySet<string>): CommitBatch {
  if (!batch.writes.some(write => models.has(write.model))) return batch;
  const receipt = batch.receipt?.identity;
  if (receipt === undefined) throw new Error('Root business writes require their original atomic receipt and directory work.');
  const revision = Number(batch.expectedRevision) + 1;
  return { ...batch, outbox: [...batch.outbox, {
    intentId: `root-directory:${scope.rootId}:${revision}`,
    operation: receipt.operation as OperationName, operationId: receipt.operationId as OperationId,
    target: TARGET, occurrenceIndex: 0,
    arguments: { app: scope.app, owner: scope.owner, binding: scope.binding, model: scope.model, rootId: scope.rootId },
  }] };
}

/** At-least-once projection. Index outage leaves committed owner work pending. */
export async function projectRootDirectoryUpdates(store: StoragePort, scope: RootScope, directory: RootDirectory): Promise<void> {
  for (const intent of await store.outboxPending()) {
    if (intent.target !== TARGET) continue;
    const expected = { app: scope.app, owner: scope.owner, binding: scope.binding, model: scope.model, rootId: scope.rootId };
    if (Object.keys(intent.arguments).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => intent.arguments[key] !== value)) throw new Error('Directory work lost its original root authority.');
    const retained = await store.outboxGet(intent.intentId);
    if (retained?.originalCommit === null || retained?.originalCommit === undefined) throw new Error('Directory publication requires committed owner work.');
    const revision = await store.readRevision();
    const root = await store.load(scope.model as ModelName, scope.rootId as RecordId);
    if (await store.readRevision() !== revision) continue;
    await directory.publish({ ...expected, revision, available: root !== null && root.archivedAt === null });
    // The fence binds acknowledgement to this actual root observation. A
    // concurrent mutation leaves the event pending for another projection.
    await store.commit({ expectedRevision: revision, writes: [], history: [], receipt: null,
      outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], outboxAck: [intent.intentId] });
  }
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS can_root_directory (
  app TEXT NOT NULL, owner TEXT NOT NULL, binding TEXT NOT NULL, model TEXT NOT NULL,
  root_id TEXT NOT NULL, revision INTEGER NOT NULL, available INTEGER NOT NULL,
  PRIMARY KEY(app,owner,binding,model,root_id)
)`;

function checkedScope(scope: Pick<RootDirectoryEntry, 'app' | 'owner' | 'binding' | 'model'>): void {
  if ([scope.app, scope.owner, scope.binding, scope.model].some(value => typeof value !== 'string' || value === '')) throw new Error('Root discovery requires its authenticated app/team and checked binding.');
}

/** D1 is an eventual listing index, never the existence/access/record authority. */
export function createD1RootDirectory(db: D1Database): RootDirectory {
  let ready: Promise<unknown> | undefined;
  const schema = () => ready ??= db.prepare(SCHEMA).run();
  return {
    async publish(entry) {
      checkedScope(entry);
      if (!Number.isSafeInteger(entry.revision) || entry.revision < 0 || typeof entry.rootId !== 'string' || entry.rootId === '' || typeof entry.available !== 'boolean') throw new Error('Invalid committed root directory entry.');
      await schema();
      await db.prepare(`INSERT INTO can_root_directory(app,owner,binding,model,root_id,revision,available) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(app,owner,binding,model,root_id) DO UPDATE SET revision=excluded.revision,available=excluded.available
        WHERE excluded.revision >= can_root_directory.revision`).bind(entry.app, entry.owner, entry.binding, entry.model, entry.rootId, entry.revision, entry.available ? 1 : 0).run();
    },
    async list(scope, page) {
      checkedScope(scope);
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 || page.after !== undefined && (typeof page.after !== 'string' || page.after.length > 200)) throw new Error('Root discovery requires a bounded page of 1..100 roots.');
      await schema();
      const rows = await db.prepare(`SELECT root_id, revision FROM can_root_directory
        WHERE app=? AND owner=? AND binding=? AND model=? AND available=1 AND root_id>? ORDER BY root_id LIMIT ?`)
        .bind(scope.app, scope.owner, scope.binding, scope.model, page.after ?? '', page.limit).all<{ root_id: string; revision: number }>();
      return rows.results.map(row => ({ ...scope, rootId: row.root_id, revision: row.revision, available: true }));
    },
  };
}

/** Bounded eventual discovery always loads current authorized owner data. */
export async function browseRootAuthorities<Value>(input: {
  readonly directory: RootDirectory;
  readonly scope: Pick<RootDirectoryEntry, 'app' | 'owner' | 'binding' | 'model'>;
  readonly page: { readonly limit: number; readonly after?: string };
  /** Null means stale index entry or an owner read that discloses no record. */
  readonly loadAuthorizedRoot: (entry: RootDirectoryEntry) => Promise<Value | null>;
}): Promise<{ readonly values: readonly Value[]; readonly after: string | null }> {
  const entries = await input.directory.list(input.scope, input.page);
  const values: Value[] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const loaded = await Promise.all(entries.slice(offset, offset + 4).map(entry => input.loadAuthorizedRoot(entry)));
    for (const value of loaded) if (value !== null) values.push(value);
  }
  return { values, after: entries.length === input.page.limit ? entries.at(-1)!.rootId : null };
}
