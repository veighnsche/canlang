import { watch, type FSWatcher } from "node:fs";

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
  check(inputs: DevInputs): Promise<DevCheck<T>>;
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
  private readonly watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private captureQueue: Promise<unknown> = Promise.resolve();
  private checkQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(hooks: DevSessionHooks<T, P>, options: { historyLimit?: number; debounceMs?: number } = {}) {
    this.hooks = hooks;
    this.historyLimit = options.historyLimit ?? 32;
    this.debounceMs = options.debounceMs ?? 75;
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 1) {
      throw new Error("historyLimit must be a positive integer");
    }
    if (!Number.isInteger(this.debounceMs) || this.debounceMs < 0) {
      throw new Error("debounceMs must be a nonnegative integer");
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
      const watcher = watch(directory, () => this.markDirty());
      watcher.on("error", () => this.markDirty());
      this.watchers.push(watcher);
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
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new DevRevisionConflictError();
    }
    const startedSerial = this.changeSerial;
    const check = await this.hooks.check(inputs);
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
    if (this.timer !== null) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    await this.checkQueue;
    if (this.serving !== null) {
      const serving = this.serving;
      this.serving = null;
      await serving.preview.dispose();
    }
  }
}
