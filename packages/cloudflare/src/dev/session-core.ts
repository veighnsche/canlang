import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";

/** Immutable identities for one check. The producer hashes the actual inputs. */
export interface DevInputs {
  readonly sourceRevision: string;
  /** Includes source, compiler, catalog, help, packages and profile inputs. */
  readonly inputDigest: string;
}

export interface DevCheck<T> {
  readonly complete: boolean;
  readonly passed: boolean;
  /** The owner's captured result; it must be structured-cloneable. */
  readonly detail: T;
}

export interface DevPreview {
  readonly id: string;
  dispose(): Promise<void>;
}

export interface DevSessionHooks<T, P extends DevPreview> {
  capture(): Promise<DevInputs>;
  check(inputs: DevInputs, signal: AbortSignal): Promise<DevCheck<T>>;
  /** Prepare a new isolated worker/data scope without changing the serving one. */
  preparePreview(inputs: DevInputs, check: DevCheck<T>): Promise<P>;
}

export interface DevSessionStatus {
  readonly revision: string | null;
  readonly sourceRevision: string | null;
  readonly checkRevision: string | null;
  readonly buildRevision: string | null;
  readonly servingRevision: string | null;
  readonly servingBuild: string | null;
  readonly stale: boolean;
  readonly dirty: boolean;
  readonly captureError: string | null;
  readonly previewReset: boolean;
}

export type CheckPublication<T> =
  | { readonly kind: "checked"; readonly revision: string; readonly check: DevCheck<T>; readonly preview: "ready" | "unavailable"; readonly cleanupError?: string }
  | { readonly kind: "build_failed"; readonly revision: string; readonly check: DevCheck<T>; readonly error: string }
  | { readonly kind: "capture_incomplete"; readonly revision: string; readonly error: string }
  | { readonly kind: "superseded"; readonly revision: string; readonly sourceRevision: string };

interface CapturedCheck<T> {
  readonly revision: string;
  readonly sourceRevision: string;
  readonly check: DevCheck<T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DevRevisionConflictError extends Error {
  constructor() {
    super("expected revision is not current");
    this.name = "DevRevisionConflictError";
  }
}

/**
 * Serializes checks and publication for one checkout/app/profile owner.
 * The hooks retain compiler, artifact and runtime semantics. This class only
 * manages revision state, stale serving builds, immutable lookups and cleanup.
 */
export class DevSessionCore<T, P extends DevPreview> {
  private readonly hooks: DevSessionHooks<T, P>;
  private readonly historyLimit: number;
  private readonly debounceMs: number;
  private inputs: DevInputs | null = null;
  private epoch = 0;
  private changeSerial = 0;
  private dirty = true;
  private captureError: string | null = null;
  private checkRevision: string | null = null;
  private buildRevision: string | null = null;
  private serving: { revision: string; preview: P } | null = null;
  private lastPreviewReset = false;
  private readonly history = new Map<string, CapturedCheck<T>>();
  private readonly watchers = new Map<string, { watcher: FSWatcher | null; identity: string | null; retryAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly reconcileMs: number;
  private readonly auditMs: number;
  private lastCaptureAt = 0;
  private captureQueue: Promise<unknown> = Promise.resolve();
  private checkQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly stopChecks = new AbortController();

  constructor(hooks: DevSessionHooks<T, P>, options: { historyLimit?: number; debounceMs?: number; reconcileMs?: number; auditMs?: number } = {}) {
    this.hooks = hooks;
    this.historyLimit = options.historyLimit ?? 32;
    this.debounceMs = options.debounceMs ?? 75;
    this.reconcileMs = options.reconcileMs ?? 2_000;
    this.auditMs = options.auditMs ?? 30_000;
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 1) {
      throw new Error("historyLimit must be a positive integer");
    }
    if (!Number.isInteger(this.debounceMs) || this.debounceMs < 0) {
      throw new Error("debounceMs must be a nonnegative integer");
    }
    if (!Number.isInteger(this.reconcileMs) || this.reconcileMs < 1) {
      throw new Error("reconcileMs must be a positive integer");
    }
    if (!Number.isInteger(this.auditMs) || this.auditMs < 1) {
      throw new Error("auditMs must be a positive integer");
    }
  }

  private revision(): string | null {
    return this.epoch === 0 ? null : `r${this.epoch}`;
  }

  status(): DevSessionStatus {
    const revision = this.revision();
    const servingRevision = this.serving?.revision ?? null;
    return {
      revision,
      sourceRevision: this.inputs?.sourceRevision ?? null,
      checkRevision: this.checkRevision,
      buildRevision: this.buildRevision,
      servingRevision,
      servingBuild: this.serving?.preview.id ?? null,
      stale: this.serving !== null && (this.dirty || servingRevision !== revision),
      dirty: this.dirty,
      captureError: this.captureError,
      previewReset: this.lastPreviewReset,
    };
  }

  /** An old reference returns only its captured data, never current-file data. */
  detail(revision: string): CapturedCheck<T> | { readonly error: "revision_unavailable" } {
    const found = this.history.get(revision);
    return found === undefined ? { error: "revision_unavailable" } : structuredClone(found);
  }

  /** Watch parent/source and infrastructure directories; events are hints. */
  watchDirectories(directories: readonly string[]): void {
    if (this.stopped) throw new Error("session stopped");
    for (const directory of new Set(directories)) {
      if (this.watchers.has(directory)) continue;
      this.watchers.set(directory, { watcher: null, identity: null, retryAt: 0 });
      this.attachWatcher(directory);
    }
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => { void this.reconcileWatchers(); }, this.reconcileMs);
      this.pollTimer.unref();
    }
  }

  private attachWatcher(directory: string): void {
    const entry = this.watchers.get(directory);
    if (entry === undefined || entry.watcher !== null || this.stopped) return;
    try {
      const watcher = watch(directory, () => this.markDirty());
      entry.watcher = watcher;
      watcher.on("error", () => {
        if (entry.watcher !== watcher) return;
        watcher.close();
        entry.watcher = null;
        entry.identity = null;
        entry.retryAt = Date.now() + this.auditMs;
        this.markDirty();
      });
    } catch {
      // The directory may have vanished between inventory and watch setup.
      // Polling recaptures inputs and attaches when it returns.
      entry.retryAt = Date.now() + this.auditMs;
    }
  }

  private async reconcileWatchers(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const [directory, entry] of this.watchers) {
        let identity: string | null = null;
        try {
          const info = await stat(directory);
          if (info.isDirectory()) identity = `${info.dev}:${info.ino}`;
        } catch { /* A vanished directory is reconciled by capture below. */ }
        if (this.stopped) return;
        if (entry.watcher !== null && (identity === null ||
            (entry.identity !== null && identity !== entry.identity))) {
          entry.watcher?.close();
          entry.watcher = null;
          this.markDirty();
        }
        entry.identity = identity;
        if (identity !== null && entry.watcher === null && Date.now() >= entry.retryAt) {
          this.attachWatcher(directory);
          this.markDirty();
        }
      }
      // Directory identity checks stay cheap and frequent. A slower full
      // audit recovers lost events even when directory identity is unchanged.
      if (Date.now() - this.lastCaptureAt >= this.auditMs) {
        await this.refresh().catch(() => undefined);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Public for the socket owner and tests; a watcher does not certify bytes. */
  markDirty(): void {
    if (this.stopped) return;
    this.changeSerial += 1;
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => {
        // refresh records captureError; an explicit check reports it.
      });
    }, this.debounceMs);
  }

  /** Capture after every explicit check and uncertain watcher event. */
  refresh(): Promise<DevInputs> {
    const work = this.captureQueue.then(async () => {
      if (this.stopped) throw new Error("session stopped");
      let captured: DevInputs;
      try {
        captured = await this.hooks.capture();
        if (
          typeof captured.sourceRevision !== "string" || captured.sourceRevision.length === 0 ||
          typeof captured.inputDigest !== "string" || captured.inputDigest.length === 0
        ) {
          throw new Error("capture returned incomplete input identities");
        }
      } catch (error) {
        const message = errorText(error);
        if (this.captureError !== message) this.epoch += 1;
        this.captureError = message;
        this.inputs = null;
        this.dirty = true;
        throw error;
      } finally {
        this.lastCaptureAt = Date.now();
      }
      if (this.inputs?.inputDigest !== captured.inputDigest || this.captureError !== null) {
        this.epoch += 1;
        this.dirty = true;
      }
      this.captureError = null;
      this.inputs = Object.freeze({
        sourceRevision: captured.sourceRevision,
        inputDigest: captured.inputDigest,
      });
      return this.inputs;
    });
    this.captureQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  check(expectedRevision?: string): Promise<CheckPublication<T>> {
    const work = this.checkQueue.then(() => this.checkOne(expectedRevision));
    this.checkQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  private async checkOne(expectedRevision?: string): Promise<CheckPublication<T>> {
    let inputs: DevInputs;
    try {
      inputs = await this.refresh();
    } catch (error) {
      return { kind: "capture_incomplete", revision: this.revision() ?? "r0", error: errorText(error) };
    }
    const revision = this.revision() as string;
    if (this.stopChecks.signal.aborted) return { kind: "superseded", revision, sourceRevision: inputs.sourceRevision };
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new DevRevisionConflictError();
    }
    const startedSerial = this.changeSerial;
    let check: DevCheck<T>;
    try { check = await this.hooks.check(inputs, this.stopChecks.signal); }
    catch (error) {
      if (this.stopChecks.signal.aborted && error === this.stopChecks.signal.reason) {
        return { kind: "superseded", revision, sourceRevision: inputs.sourceRevision };
      }
      throw error;
    }
    if (!(await this.stillCurrent(inputs, revision, startedSerial))) {
      return { kind: "superseded", revision, sourceRevision: inputs.sourceRevision };
    }
    const captured: DevCheck<T> = structuredClone(check);
    this.checkRevision = revision;
    this.history.set(revision, {
      revision,
      sourceRevision: inputs.sourceRevision,
      check: captured,
    });
    while (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next().value as string;
      this.history.delete(oldest);
    }
    this.dirty = false;
    this.lastPreviewReset = false;
    if (!check.complete || !check.passed) {
      return { kind: "checked", revision, check: structuredClone(captured), preview: "unavailable" };
    }
    if (this.serving?.revision === revision) {
      return { kind: "checked", revision, check: structuredClone(captured), preview: "ready" };
    }

    let prepared: P;
    try {
      prepared = await this.hooks.preparePreview(inputs, check);
    } catch (error) {
      return { kind: "build_failed", revision, check: structuredClone(captured), error: errorText(error) };
    }
    if (!(await this.stillCurrent(inputs, revision, startedSerial))) {
      await prepared.dispose();
      return { kind: "superseded", revision, sourceRevision: inputs.sourceRevision };
    }
    const old = this.serving;
    this.serving = { revision, preview: prepared };
    this.buildRevision = revision;
    this.lastPreviewReset = old !== null;
    let cleanupError: string | undefined;
    if (old !== null) {
      try {
        await old.preview.dispose();
      } catch (error) {
        cleanupError = errorText(error);
      }
    }
    return { kind: "checked", revision, check: structuredClone(captured), preview: "ready",
      ...(cleanupError === undefined ? {} : { cleanupError }) };
  }

  private async stillCurrent(inputs: DevInputs, revision: string, serial: number): Promise<boolean> {
    if (this.stopped || this.changeSerial !== serial) return false;
    try {
      const latest = await this.refresh();
      return !this.stopped && this.changeSerial === serial && this.revision() === revision &&
        latest.inputDigest === inputs.inputDigest && latest.sourceRevision === inputs.sourceRevision;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.changeSerial += 1;
    this.stopChecks.abort(new Error("session stopped"));
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    for (const entry of this.watchers.values()) entry.watcher?.close();
    this.watchers.clear();
    await this.checkQueue;
    await this.captureQueue;
    if (this.serving !== null) {
      const serving = this.serving;
      this.serving = null;
      await serving.preview.dispose();
    }
  }
}
