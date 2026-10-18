/** Human observation is additive; existing JSON command results keep their contracts. */
export type DevLifecycle = "starting" | "running" | "stopping" | "shutdown_incomplete" | "stopped";
export type DevCheckPhase = "queued" | "capturing" | "checking_source" | "preparing_preview" | "publishing";
export type DevSourceResult = "valid" | "errors" | "limited" | "incomplete" | "unsupported" | "tool_failure" | "superseded" | "cancelled";

export interface DevOperation {
  readonly id: string;
  readonly revision: string | null;
  readonly phase: DevCheckPhase;
  readonly subphase: string | null;
  readonly startedAt: number;
  readonly phaseStartedAt: number;
}

export interface DevOperationOutcome {
  readonly id: string;
  readonly revision: string | null;
  readonly source: DevSourceResult;
  readonly preview: "ready" | "unavailable" | "failed" | "superseded";
  readonly reason: string | null;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface DevObservation {
  readonly schema: "can.dev.observation.v1";
  readonly session: string;
  readonly sequence: number;
  readonly app: string;
  readonly sourcePath: string;
  readonly mode: "manual" | "automatic";
  readonly lifecycle: DevLifecycle;
  readonly revision: string | null;
  readonly sourceRevision: string | null;
  readonly capture: "confirmed" | "unconfirmed" | "incomplete";
  readonly operation: DevOperation | null;
  readonly lastOutcome: DevOperationOutcome | null;
  readonly preview: {
    readonly availability: "unavailable" | "serving";
    readonly revision: string | null;
    readonly build: string | null;
    readonly origin: string | null;
    readonly freshness: "not_applicable" | "current" | "older" | "unconfirmed";
  };
  readonly admission: {
    readonly check: boolean;
    readonly open: boolean;
    readonly retryCleanup: boolean;
    readonly reasons: readonly ("stopping" | "cleanup_required" | "restart_required")[];
  };
  readonly shutdownError: "CLEANUP_FAILED" | null;
}

/** Call only at actual owner boundaries; stale operation reporters are ignored. */
export type DevPhaseReporter = (subphase: string) => void;
