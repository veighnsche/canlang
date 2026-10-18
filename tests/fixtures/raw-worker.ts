/** Test-owned SDK objects for explicitly supplied raw Worker modules and bindings. */
import { Miniflare, type DispatchFetch } from "miniflare";

export interface LocalDevOptions {
  readonly workerName: string;
  readonly compatibilityDate: string;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly d1Databases?: readonly { readonly binding: string; readonly id: string }[];
  readonly durableObjects?: readonly { readonly binding: string; readonly className: string; readonly useSQLite?: boolean }[];
}
export interface LocalDev {
  readonly dispatch: (path: string, init?: Parameters<DispatchFetch>[1]) => ReturnType<DispatchFetch>;
  readonly getD1Database: Miniflare["getD1Database"];
  readonly getDurableObjectNamespace: Miniflare["getDurableObjectNamespace"];
  readonly dispose: () => Promise<void>;
}

export async function startLocalDev(options: LocalDevOptions): Promise<LocalDev> {
  const paths = [options.mainModule, ...Object.keys(options.modules).filter(path => path !== options.mainModule)];
  const worker = new Miniflare({ name: options.workerName, compatibilityDate: options.compatibilityDate,
    modules: paths.map(path => ({ path, type: "ESModule", contents: options.modules[path]! })),
    d1Databases: Object.fromEntries((options.d1Databases ?? []).map(({ binding, id }) => [binding, id])),
    durableObjects: Object.fromEntries((options.durableObjects ?? []).map(({ binding, ...definition }) => [binding, definition])),
  });
  try { await worker.ready; }
  catch (primary) {
    try { await worker.dispose(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], "raw Worker startup and disposal failed", { cause: primary }); }
    throw primary;
  }
  return {
    dispatch: (path, init) => worker.dispatchFetch(new URL(path, "http://localhost").href, init),
    getD1Database: binding => worker.getD1Database(binding),
    getDurableObjectNamespace: binding => worker.getDurableObjectNamespace(binding),
    dispose: () => worker.dispose(),
  };
}
