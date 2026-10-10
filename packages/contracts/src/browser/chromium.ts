/** Node-only browser types shared by the optional producer and its consumers. */
import type { Browser } from "@playwright/test";

export interface ChromiumProducerIdentity {
  /** Actual declared driver entry; the consumer captures its installed closure. */
  readonly driverEntryPath: string;
  /** Exact locked driver's executable, never a system-browser fallback. */
  readonly executablePath: string;
}

export type ChromiumAvailability =
  | { readonly available: true; readonly identity: ChromiumProducerIdentity }
  | { readonly available: false; readonly reason: "driver-not-installed" }
  | { readonly available: false; readonly reason: "executable-not-installed";
      readonly identity: ChromiumProducerIdentity };

export interface AcquireChromiumOptions {
  readonly signal?: AbortSignal;
  /** Positive finite launch bound; defaults to thirty seconds. */
  readonly timeoutMs?: number;
}

export interface OwnedChromium {
  readonly browser: Browser;
  readonly identity: ChromiumProducerIdentity;
  /** Idempotent, awaited release. Call in finally even after signal cancellation. */
  close(): Promise<void>;
}

/** The real producer is installed/resolved by the invoking Node application. */
export interface ChromiumProducer {
  chromiumAvailability(): Promise<ChromiumAvailability>;
  acquireChromium(options?: AcquireChromiumOptions): Promise<OwnedChromium>;
}
