/** Trusted host routing to physically isolated D1 stores; never an auth resolver. */
import type { D1Database } from '@cloudflare/workers-types';
import type { FileReferenceStoragePort, FileRetirementAuthority,
  FrameworkFileReferenceProducer, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from './d1.js';
import { checkedFileAuthority, fileGuardCopy, fileGuardEqual } from './file-retirement.js';

/** Selected only after canonical Identity/Work admission resolves the owner. */
export interface D1OwnerScope {
  readonly app: string;
  /** Verified team ID, or the existing app-scope marker. */
  readonly owner: string;
}

/** Trusted host configuration, not request data or a provisioning instruction. */
export interface TrustedD1OwnerBinding extends D1OwnerScope {
  readonly db: D1Database;
  /** Explicit host authorization to assign an independently verified empty DB. */
  readonly initializeFresh?: true;
  /** Original physical State/Files assignment; source tags are not authority. */
  readonly fileRetirementAuthority?: FileRetirementAuthority;
  /** Actual same-load owning exports, captured before database inspection. */
  readonly fileReferenceProducers?: readonly FrameworkFileReferenceProducer[];
}

const PIN_TABLE = 'state_owner_pin';
const PIN_OPERATION = 'storage:owner-pin/v1';
const EMPTY_TABLES = [
  'records', 'receipts', 'history', 'outbox', 'schedules', 'unique_claims',
  'snapshots', 'migration_staging', 'migration_progress', 'migration_outcomes',
  'migration_failures',
  'file_reference_authority', 'file_reference_inventories', 'file_reference_migrations',
  'file_reference_publications', 'file_retirements',
] as const;
// D1 creates its reserved provider metadata table on the first schema write.
// Only that exact provider table is excluded; unknown application tables refuse.
const KNOWN_TABLES = new Set<string>([...EMPTY_TABLES, 'fence', 'fence_log', PIN_TABLE]);
const PIN_SCHEMA = 'CREATE TABLE IF NOT EXISTS state_owner_pin (id INTEGER PRIMARY KEY CHECK(id = 1), app TEXT NOT NULL, owner TEXT NOT NULL)';

type OwnerPin = D1OwnerScope;

function boundStore(db: D1Database, scope: D1OwnerScope,
  authority?: FileRetirementAuthority, producers?: readonly FrameworkFileReferenceProducer[]): StoragePort {
  // The real constructor snapshots authority and complete owning validators
  // synchronously. Later route/configuration changes cannot repin this adapter.
  const store = authority === undefined ? createD1Storage(db, undefined, producers) :
    createD1Storage(db, authority, producers);
  if ('fileRetirementAuthority' in store) {
    const binding = store.fileRetirementAuthority as FileRetirementAuthority;
    if (binding.app !== scope.app || binding.receiver.owner !== scope.owner) {
      throw new Error('owner-storage: File assignment app/owner mismatch');
    }
  }
  const check = (identity: D1OwnerScope): void => {
    if (!matches(identity, scope)) throw new Error('owner-storage: receipt app/owner mismatch');
  };
  const readReceipt = store.readReceipt;
  const commit = store.commit;
  // Keep the constructor-returned object and its private migration binding.
  // A spread wrapper would preserve methods but lose that correspondence.
  store.readReceipt = async identity => {
    check(identity);
    return readReceipt.call(store, identity);
  };
  store.commit = async batch => {
    if (batch.receipt !== null) check(batch.receipt.identity);
    return commit.call(store, batch);
  };
  return store;
}

function checkedScope(scope: D1OwnerScope): D1OwnerScope {
  if (typeof scope !== 'object' || scope === null) {
    throw new Error('owner-storage: app and owner must be non-empty resolved identities');
  }
  const app = scope.app;
  const owner = scope.owner;
  if (typeof app !== 'string' || app === '' || typeof owner !== 'string' || owner === '') {
    throw new Error('owner-storage: app and owner must be non-empty resolved identities');
  }
  return Object.freeze({ app, owner });
}

function matches(left: D1OwnerScope, right: D1OwnerScope): boolean {
  return left.app === right.app && left.owner === right.owner;
}

async function pin(db: D1Database): Promise<OwnerPin | null> {
  return db.prepare('SELECT app, owner FROM state_owner_pin WHERE id = 1').first<OwnerPin>();
}

/** Read-only refusal precedes bootstrap: never initialize unknown legacy state. */
async function inspect(db: D1Database): Promise<{ tables: Set<string>; pin: OwnerPin | null }> {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND name <> '_cf_METADATA'").all<{ name: string }>();
  const tables = new Set(result.results.map(row => row.name));
  // A correctly assigned database can retain its domain/work/migration state.
  const assigned = tables.has(PIN_TABLE) ? await pin(db) : null;
  if (assigned !== null) return { tables, pin: assigned };
  const refuseLegacy = async (evidence: string): Promise<{ tables: Set<string>; pin: OwnerPin | null }> => {
    // Inspection uses separate reads. Another initializer may have assigned the
    // store after our null pin read and written the evidence we just observed.
    // Return that pin through openBinding's exact app/owner check; never treat
    // actual unassigned legacy state or database read failures as an assignment.
    const pinTable = tables.has(PIN_TABLE) || await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_owner_pin'",
    ).first() !== null;
    const current = pinTable ? await pin(db) : null;
    if (current !== null) return { tables, pin: current };
    throw new Error(`owner-storage: unassigned database has ${evidence}`);
  };
  const sequence = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").first();
  if (sequence !== null && await db.prepare('SELECT 1 FROM sqlite_sequence WHERE seq > 0 LIMIT 1').first() !== null) {
    return refuseLegacy('legacy sequence evidence');
  }
  for (const table of tables) {
    if (!KNOWN_TABLES.has(table)) {
      return refuseLegacy('unknown legacy schema');
    }
    if (table === 'fence') {
      const rows = await db.prepare('SELECT id, revision FROM fence').all<{ id: number; revision: number }>();
      if (rows.results.some(row => row.id !== 1 || row.revision !== 0)) {
        return refuseLegacy('legacy revision evidence');
      }
    } else {
      const row = await db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).first();
      if (row !== null) return refuseLegacy('legacy state');
    }
  }
  return { tables, pin: null };
}

async function openBinding(binding: Pick<TrustedD1OwnerBinding, 'db' | 'initializeFresh'>,
  scope: D1OwnerScope, store: StoragePort): Promise<StoragePort> {
  const db = binding.db;
  const inspected = await inspect(db);
  if (inspected.pin !== null) {
    if (!matches(inspected.pin, scope)) throw new Error('owner-storage: persisted app/owner pin mismatch');
    return store;
  }
  if (binding.initializeFresh !== true) {
    throw new Error('owner-storage: unassigned database requires explicit verified fresh assignment');
  }
  await ensureSchema(db);
  await db.exec(PIN_SCHEMA);
  // The first normal fence assertion serializes assignment with every existing
  // state writer. The CHECK fails the entire batch if any legacy evidence was
  // added after inspection; there is no conditional-success/zero-row loophole.
  const empty = EMPTY_TABLES.map(table => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ');
  try {
    await db.batch([
      db.prepare('INSERT INTO fence_log(revision, at, operation) VALUES (1, ?, ?)').bind(Date.now(), PIN_OPERATION),
      db.prepare(
        `INSERT INTO state_owner_pin(id, app, owner) SELECT CASE WHEN ${empty} ` +
        'AND (SELECT revision FROM fence WHERE id = 1) = 0 ' +
        'AND (SELECT COUNT(*) FROM fence_log) = 1 ' +
        'AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE seq > 0) ' +
        "AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND name <> '_cf_METADATA' AND name NOT IN (" +
        [...KNOWN_TABLES].map(table => `'${table}'`).join(', ') + ')) THEN 1 ELSE 0 END, ?, ?',
      ).bind(scope.app, scope.owner),
      db.prepare('UPDATE fence SET revision = 1 WHERE id = 1'),
    ]);
  } catch (error) {
    // Concurrent same-owner initialization is idempotent. Another owner's pin
    // must refuse even when two distinct JS handles alias one physical DB.
    const assigned = await pin(db);
    if (assigned !== null && matches(assigned, scope)) return store;
    throw new Error('owner-storage: fresh assignment failed or database belongs to another owner', { cause: error });
  }
  const assigned = await pin(db);
  if (assigned === null || !matches(assigned, scope)) throw new Error('owner-storage: persisted app/owner pin mismatch');
  return store;
}

type RouterInput<Binding extends TrustedD1OwnerBinding> = {
  readonly resolveBinding: (scope: D1OwnerScope) => Binding | null | Promise<Binding | null>;
};
type OwnerRouter<Port extends StoragePort> = {
  readonly ownerScopedStoragePort: (scope: D1OwnerScope) => Promise<Port>;
};

/** Detach declaration data but retain the actual owning receiver/functions. */
function producerConfiguration(producers: readonly FrameworkFileReferenceProducer[] | undefined) {
  if (producers === undefined) return [];
  if (!Array.isArray(producers) || producers.length > 200) throw new Error('owner-storage: bounded framework producers required');
  return [...producers].map(producer => {
    const models = Object.getOwnPropertyDescriptor(producer, 'models');
    const validate = Object.getOwnPropertyDescriptor(producer, 'validateRow');
    const resolve = Object.getOwnPropertyDescriptor(producer, 'resolveOpaqueField');
    if (models === undefined || !('value' in models) || validate === undefined || !('value' in validate) ||
        typeof validate.value !== 'function' || resolve !== undefined && (!('value' in resolve) || typeof resolve.value !== 'function') ||
        resolve === undefined && 'resolveOpaqueField' in producer) throw new Error('owner-storage: actual own framework export required');
    return { producer, models: fileGuardCopy(models.value), validate: validate.value as unknown,
      resolve: resolve?.value as unknown };
  });
}

/**
 * No global fallback, allocation, repinning or cached route authorization.
 * Adapter identity is retained only for the same physical handle/scope and
 * captured File configuration; routing and persisted pin checks run every time.
 * The host must retain the exact binding; raw/global adapter access to routed
 * databases is privileged and cannot be exposed as another tenant's route.
 * Returned ports preserve the existing adapter's rows, receipts and errors.
 */
export function createD1OwnerRouter(input: RouterInput<TrustedD1OwnerBinding & {
  readonly fileRetirementAuthority: FileRetirementAuthority;
}>): OwnerRouter<FileReferenceStoragePort>;
export function createD1OwnerRouter(input: RouterInput<TrustedD1OwnerBinding>): OwnerRouter<StoragePort>;
export function createD1OwnerRouter(input: RouterInput<TrustedD1OwnerBinding>): OwnerRouter<StoragePort> {
  type Producers = ReturnType<typeof producerConfiguration>;
  const adapters = new WeakMap<D1Database, Map<string, {
    authority: FileRetirementAuthority | undefined; producers: Producers; store: StoragePort;
  }>>();
  return Object.freeze({
    async ownerScopedStoragePort(requested: D1OwnerScope): Promise<StoragePort> {
      const scope = checkedScope(requested);
      const route = await input.resolveBinding(scope);
      if (route === null) throw new Error('owner-storage: no trusted binding for resolved app/owner');
      if (!matches(checkedScope(route), scope)) throw new Error('owner-storage: trusted route app/owner mismatch');
      const authority = Object.getOwnPropertyDescriptor(route, 'fileRetirementAuthority');
      const producers = Object.getOwnPropertyDescriptor(route, 'fileReferenceProducers');
      if ((authority !== undefined && !('value' in authority)) ||
          (producers !== undefined && !('value' in producers)) ||
          ('fileRetirementAuthority' in route && authority === undefined) ||
          ('fileReferenceProducers' in route && producers === undefined)) {
        throw new Error('owner-storage: File binding requires own configuration data');
      }
      // Copy the route before awaiting: configuration mutation cannot repin it.
      const binding = { db: route.db, ...(route.initializeFresh === true ? { initializeFresh: true as const } : {}) };
      const configuredAuthority = authority?.value === undefined ? undefined : checkedFileAuthority(authority.value as FileRetirementAuthority);
      const configuredProducers = producers?.value as readonly FrameworkFileReferenceProducer[] | undefined;
      const capturedProducers = producerConfiguration(configuredProducers);
      let ports = adapters.get(binding.db);
      if (ports === undefined) { ports = new Map(); adapters.set(binding.db, ports); }
      const key = JSON.stringify([scope.app, scope.owner]);
      let retained = ports.get(key);
      if (retained === undefined || !fileGuardEqual(retained.authority ?? null, configuredAuthority ?? null) ||
          retained.producers.length !== capturedProducers.length || capturedProducers.some((producer, index) => {
            const previous = retained!.producers[index]!;
            return previous.producer !== producer.producer || previous.validate !== producer.validate ||
              previous.resolve !== producer.resolve || !fileGuardEqual(previous.models, producer.models);
          })) {
        retained = { authority: configuredAuthority, producers: capturedProducers,
          store: boundStore(binding.db, scope, configuredAuthority, capturedProducers.map(producer => producer.producer)) };
        // Synchronous publication precedes inspection, including concurrent opens.
        ports.set(key, retained);
      }
      return openBinding(binding, scope, retained.store);
    },
  });
}
