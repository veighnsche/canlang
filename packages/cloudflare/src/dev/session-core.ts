import { statSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { DevCleanupError } from "./cleanup.js";
import type { DevLifecycle, DevOperation, DevOperationOutcome, DevPhaseReporter, DevSourceResult } from "./observation.js";

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
  /** Synchronous current-generation selection, only at the publication fence. */
  activate?(): void;
  dispose(): Promise<void>;
}

export interface DevSessionHooks<T, P extends DevPreview> {
  capture(): Promise<DevInputs>;
  check(inputs: DevInputs, signal: AbortSignal, reportPhase: DevPhaseReporter): Promise<DevCheck<T>>;
  sourceResult?(check: DevCheck<T>): DevSourceResult;
  /** Prepare a new isolated worker/data scope without changing the serving one. */
  preparePreview(inputs: DevInputs, check: DevCheck<T>, signal: AbortSignal, reportPhase: DevPhaseReporter): Promise<P>;
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
  readonly lifecycle: DevLifecycle;
  readonly sequence: number;
  readonly captureState: "confirmed" | "unconfirmed" | "incomplete";
  readonly cleanupRequired: boolean;
  readonly operation: DevOperation | null;
  readonly lastOutcome: DevOperationOutcome | null;
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
  private readonly pendingCleanup = new Set<{ dispose(): Promise<void> }>();
  private stopping: Promise<void> | null = null;
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
  private lifecycle: DevLifecycle = "running";
  private captureConfirmed = false;
  private sequence = 0;
  private operationSerial = 0;
  private operation: DevOperation | null = null;
  private lastOutcome: DevOperationOutcome | null = null;
  private cleanupRetry: Promise<void> | null = null;
  private readonly onChange: (() => void) | undefined;


  constructor(hooks: DevSessionHooks<T, P>, options: { historyLimit?: number; debounceMs?: number; reconcileMs?: number; auditMs?: number; onChange?: () => void } = {}) {
    this.hooks = hooks;
    this.onChange = options.onChange;
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

  private changed(): void { this.sequence += 1; this.onChange?.(); }

  private phase(id: string, phase: DevOperation["phase"], subphase: string | null = null): void {
    if (this.operation?.id !== id || this.stopped) return;
    this.operation = { ...this.operation, revision: this.revision(), phase, subphase, phaseStartedAt: Date.now() };
    this.changed();
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
      lifecycle: this.lifecycle, sequence: this.sequence,
      captureState: this.captureError !== null ? "incomplete" : this.captureConfirmed ? "confirmed" : "unconfirmed",
      cleanupRequired: this.pendingCleanup.size > 0,
      operation: this.operation === null ? null : { ...this.operation },
      lastOutcome: this.lastOutcome === null ? null : { ...this.lastOutcome },
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
      // Pin the directory before attachment: the first poll must distinguish
      // a replacement from the inode still held by this native watcher.
      const identity = statSync(directory);
      if (!identity.isDirectory()) throw new Error("watch target is not a directory");
      entry.identity = `${identity.dev}:${identity.ino}`;
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
    this.captureConfirmed = false;
    this.changed();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => {
        // refresh records captureError; an explicit check reports it.
      });
    }, this.debounceMs);
  }

  /** Capture after every explicit check and uncertain watcher event. */
  refresh(signal?: AbortSignal): Promise<DevInputs> {
    const work = this.captureQueue.then(async () => {
      if (this.stopped) throw new Error("session stopped");
      // A request may be canceled while its capture waits behind another one.
      // Refuse outside the capture try/finally: no identities or audit clock move.
      signal?.throwIfAborted();
      const captureSerial = this.changeSerial;
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
        this.captureConfirmed = false;
        this.inputs = null;
        this.changed();
        this.dirty = true;
        throw error;
      } finally {
        this.lastCaptureAt = Date.now();
      }
      const identical = this.inputs?.inputDigest === captured.inputDigest && this.captureError === null;
      if (!identical) {
        this.epoch += 1;
        this.dirty = true;
      }
      this.captureError = null;
      this.captureConfirmed = captureSerial === this.changeSerial;
      if (identical && this.captureConfirmed) this.dirty = false;
      this.inputs = Object.freeze({
        sourceRevision: captured.sourceRevision,
        inputDigest: captured.inputDigest,
      });
      this.changed();
      return this.inputs;
    });
    this.captureQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  check(expectedRevision?: string, requestSignal?: AbortSignal): Promise<CheckPublication<T>> {
    if (this.stopped) return Promise.reject(new Error("session stopped"));
    const signal = requestSignal === undefined ? this.stopChecks.signal
      : AbortSignal.any([this.stopChecks.signal, requestSignal]);
    const id = `check-${++this.operationSerial}`;
    const startedAt = Date.now();
    if (this.operation === null) {
      this.operation = { id, revision: this.revision(), phase: "queued", subphase: null, startedAt, phaseStartedAt: startedAt };
      this.changed();
    }
    const work = this.checkQueue.then(async () => {
      this.operation = { id, revision: this.revision(), phase: "capturing", subphase: null, startedAt, phaseStartedAt: Date.now() };
      this.changed();
      try {
        const result = await this.checkOne(expectedRevision, signal, id);
        const source = result.kind === "superseded" ? "superseded" : result.kind === "capture_incomplete" ? "incomplete"
          : this.hooks.sourceResult?.(result.check) ?? (result.check.passed ? "valid" : result.check.complete ? "errors" : "incomplete");
        this.lastOutcome = { id, revision: result.revision, source,
          preview: result.kind === "superseded" ? "superseded" : result.kind === "build_failed" ? "failed" : result.kind === "checked" ? result.preview : "unavailable",
          reason: result.kind === "build_failed" || result.kind === "capture_incomplete" ? errorText(result.error) : null,
          startedAt, finishedAt: Date.now() };
        return result;
      } catch (error) {
        if (!(error instanceof DevRevisionConflictError)) this.lastOutcome = { id, revision: this.revision(), source: signal.aborted ? "cancelled" : "tool_failure",
          preview: "unavailable", reason: errorText(error), startedAt, finishedAt: Date.now() };
        throw error;
      } finally {
        if (this.operation?.id === id) this.operation = null;
        this.changed();
      }
    });
    this.checkQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  private async captureCheckInputs(expectedRevision: string | undefined,
    signal: AbortSignal): Promise<{ inputs: DevInputs; revision: string } | { incomplete: CheckPublication<T> }> {
    if (!this.stopChecks.signal.aborted) signal.throwIfAborted();
    // Never grow the runtime set while a previous build still needs release.
    await this.cleanupPending();
    let inputs: DevInputs;
    try {
      inputs = await this.refresh(signal);
    } catch (error) {
      if (!this.stopChecks.signal.aborted) signal.throwIfAborted();
      return { incomplete: { kind: "capture_incomplete", revision: this.revision() ?? "r0", error: errorText(error) } };
    }
    const revision = this.revision() as string;
    if (this.stopChecks.signal.aborted) {
      return { incomplete: { kind: "superseded", revision, sourceRevision: inputs.sourceRevision } };
    }
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new DevRevisionConflictError();
    }
    signal.throwIfAborted();
    return { inputs, revision };
  }

  private async runSourceCheck(inputs: DevInputs, revision: string,
    operationId: string, signal: AbortSignal): Promise<{ check: DevCheck<T> } | { superseded: CheckPublication<T> }> {
    // A currently serving, successful check already owns this exact full-input
    // epoch. Reuse its immutable result after recapture; the ordinary final
    // currency fence below still runs. Failed/unserved/superseded checks miss.
    const retained = this.serving?.revision === revision ? this.history.get(revision) : undefined;
    const reusable = retained?.check.complete === true && retained.check.passed;
    this.phase(operationId, "checking_source", reusable ? "reusing_unchanged_check" : null);
    try {
      const check = reusable ? structuredClone(retained.check)
        : await this.hooks.check(inputs, signal, subphase => this.phase(operationId, "checking_source", subphase));
      return { check };
    }
    catch (error) {
      if (this.stopChecks.signal.aborted && error === this.stopChecks.signal.reason) {
        return { superseded: { kind: "superseded", revision, sourceRevision: inputs.sourceRevision } };
      }
      throw error;
    }
  }

  private recordCheckedRevision(inputs: DevInputs, revision: string, check: DevCheck<T>): DevCheck<T> {
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
    return captured;
  }

  private async checkOne(expectedRevision: string | undefined, signal: AbortSignal, operationId: string): Promise<CheckPublication<T>> {
    const captured = await this.captureCheckInputs(expectedRevision, signal);
    if ("incomplete" in captured) return captured.incomplete;
    const { inputs, revision } = captured;
    const ran = await this.runSourceCheck(inputs, revision, operationId, signal);
    if ("superseded" in ran) return ran.superseded;
    const check = ran.check;
    if (!this.stopChecks.signal.aborted) signal.throwIfAborted();
    if (!(await this.stillCurrent(inputs, revision, signal))) {
      if (!this.stopChecks.signal.aborted) signal.throwIfAborted();
      return { kind: "superseded", revision, sourceRevision: inputs.sourceRevision };
    }
    signal.throwIfAborted();
    const recorded = this.recordCheckedRevision(inputs, revision, check);
    if (!check.complete || !check.passed) {
      return { kind: "checked", revision, check: structuredClone(recorded), preview: "unavailable" };
    }
    if (this.serving?.revision === revision) {
      return { kind: "checked", revision, check: structuredClone(recorded), preview: "ready" };
    }

    return this.publishPreparedPreview(inputs, revision, check, recorded, operationId, signal);
  }

  private async publishPreparedPreview(inputs: DevInputs, revision: string, check: DevCheck<T>,
    recorded: DevCheck<T>, operationId: string, signal: AbortSignal): Promise<CheckPublication<T>> {
    let prepared: P;
    try {
      this.phase(operationId, "preparing_preview");
      prepared = await this.hooks.preparePreview(inputs, check, signal, subphase => this.phase(operationId, "preparing_preview", subphase));
    } catch (error) {
      if (error instanceof DevCleanupError) this.pendingCleanup.add(error);
      signal.throwIfAborted();
      return { kind: "build_failed", revision, check: structuredClone(recorded), error: errorText(error) };
    }
    const current = !signal.aborted && await this.stillCurrent(inputs, revision, signal);
    if (!current || signal.aborted) {
      this.pendingCleanup.add(prepared);
      await this.cleanupPending();
      if (!this.stopChecks.signal.aborted) signal.throwIfAborted();
      return { kind: "superseded", revision, sourceRevision: inputs.sourceRevision };
    }
    this.phase(operationId, "publishing");
    try { prepared.activate?.(); }
    catch (error) {
      this.pendingCleanup.add(prepared);
      try { await this.cleanupPending(); } catch { /* retained cleanup blocks later allocation */ }
      return { kind: "build_failed", revision, check: structuredClone(recorded), error: errorText(error) };
    }
    const old = this.serving;
    // A hint during preparation may have recaptured identical inputs.
    this.dirty = false;
    this.serving = { revision, preview: prepared };
    this.buildRevision = revision;
    this.lastPreviewReset = old !== null;
    let cleanupError: string | undefined;
    if (old !== null) {
      this.pendingCleanup.add(old.preview);
      try {
        await this.cleanupPending();
      } catch (error) {
        cleanupError = errorText(error);
      }
    }
    return { kind: "checked", revision, check: structuredClone(recorded), preview: "ready",
      ...(cleanupError === undefined ? {} : { cleanupError }) };
  }

  private async stillCurrent(inputs: DevInputs, revision: string, signal: AbortSignal): Promise<boolean> {
    try {
      while (!this.stopped) {
        signal.throwIfAborted();
        // Directory events are hints, including writes to unconsumed siblings.
        // Reconcile earlier hints, but never trust a capture overlapped by a
        // newer event: an already-read input may have changed during capture.
        const serial = this.changeSerial;
        const latest = await this.refresh(signal);
        signal.throwIfAborted();
        if (this.stopped || this.revision() !== revision ||
            latest.inputDigest !== inputs.inputDigest || latest.sourceRevision !== inputs.sourceRevision) return false;
        if (this.changeSerial === serial) return true;
        // Continued events must not starve request cancellation or stop.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch {
      return false;
    }
    return false;
  }

  private async cleanupPending(): Promise<void> {
    const errors: unknown[] = [];
    for (const preview of this.pendingCleanup) {
      try { await preview.dispose(); this.pendingCleanup.delete(preview); }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "preview cleanup failed");
  }

  /** Retry retained retired/candidate handles without allocating another runtime. */
  retryCleanup(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("session shutdown has begun"));
    if (this.cleanupRetry !== null) return this.cleanupRetry;
    if (this.operation !== null) return Promise.reject(new Error("a check is already active"));
    const work = this.checkQueue.then(() => this.cleanupPending());
    this.checkQueue = work.catch(() => undefined);
    this.cleanupRetry = work.finally(() => { this.cleanupRetry = null; this.changed(); });
    return this.cleanupRetry;
  }

  /** Close admission and cancel work synchronously, before transport acknowledgement. */
  beginStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycle = "stopping";
    this.changed();
    this.changeSerial += 1;
    this.stopChecks.abort(new Error("session stopped"));
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    for (const entry of this.watchers.values()) entry.watcher?.close();
    this.watchers.clear();
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.beginStop();
    this.lifecycle = "stopping";
    this.changed();
    this.stopping = (async () => {
      await this.checkQueue;
      await this.captureQueue;
      if (this.serving !== null) {
        this.pendingCleanup.add(this.serving.preview);
        this.serving = null;
      }
      await this.cleanupPending();
      this.lifecycle = "stopped";
      this.changed();
    })().catch(error => { this.lifecycle = "shutdown_incomplete"; this.changed(); this.stopping = null; throw error; });
    return this.stopping;
  }
}
