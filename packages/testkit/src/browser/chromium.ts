import { browserToolsRoot, browserToolsExecutable } from '@canlang/cloudflare/runtime/browser-tools';
/** Optional Node browser producer. Deliberately absent from the portable/root entry. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserType } from "@playwright/test";
import type { AcquireChromiumOptions, ChromiumAvailability, ChromiumProducerIdentity, OwnedChromium } from "@canlang/contracts/browser/chromium";
export type { AcquireChromiumOptions, ChromiumAvailability, ChromiumProducerIdentity, ChromiumProducer, OwnedChromium } from "@canlang/contracts/browser/chromium";

const require = createRequire(import.meta.url);
const DRIVER = "@playwright/test";

export class MissingChromiumProducerError extends Error {
  constructor(readonly availability: Exclude<ChromiumAvailability, { available: true }>) {
    super(`Chromium producer unavailable: ${availability.reason}`);
    this.name = "MissingChromiumProducerError";
  }
}

interface InstalledChromium {
  readonly chromium: BrowserType;
  readonly identity: ChromiumProducerIdentity;
}

async function installedChromium(): Promise<InstalledChromium | null> {
  let driverEntryPath: string;
  const development = browserToolsRoot();
  if (process.env.CAN_INSTALL_ROOT !== undefined && development === null) return null;
  if (development !== null) process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(development, "browsers");
  try {
    driverEntryPath = (development === null ? require : createRequire(join(development, "package.json"))).resolve(DRIVER);
  } catch (error) {
    // Only the absent optional package is unavailable. Broken exports/entries
    // or import-time failures remain producer errors, never a UI success.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
        error.message.split("\n", 1)[0] === `Cannot find module '${DRIVER}'`) return null;
    throw error;
  }
  // Load the same entry we report. Playwright's resolved CommonJS entry
  // assembles its exports dynamically; synthetic ESM named exports are not
  // a producer contract.
  const driver = require(driverEntryPath) as { chromium?: BrowserType };
  const chromium = driver.chromium;
  if (chromium === undefined || typeof chromium.launch !== "function" || typeof chromium.executablePath !== "function") {
    throw new Error("Chromium producer: installed driver has no Chromium API");
  }
  const executablePath = development === null ? chromium.executablePath() : browserToolsExecutable(development);
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    throw new Error("Chromium producer: installed driver has no executable path");
  }
  return { chromium, identity: Object.freeze({ driverEntryPath, executablePath }) };
}

async function availabilityOf(installed: InstalledChromium | null): Promise<ChromiumAvailability> {
  if (installed === null) return { available: false, reason: "driver-not-installed" };
  try {
    if (!(await stat(installed.identity.executablePath)).isFile()) {
      throw new Error("Chromium producer: installed executable is not a file");
    }
    await access(installed.identity.executablePath, constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false, reason: "executable-not-installed", identity: installed.identity };
    }
    throw error;
  }
  return { available: true, identity: installed.identity };
}

/** No launch, download, application lookup or successful UI qualification. */
export async function chromiumAvailability(): Promise<ChromiumAvailability> {
  return availabilityOf(await installedChromium());
}

/**
 * Own one real headless Chromium. Abort closes an acquired browser. During
 * Playwright's bounded launch, cancellation waits for launch to settle, then
 * closes before rejecting; the driver has no launch AbortSignal port.
 */
export async function acquireChromium(options: AcquireChromiumOptions = {}): Promise<OwnedChromium> {
  const { signal, timeoutMs = 30_000 } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Chromium producer: timeoutMs must be positive and finite");
  signal?.throwIfAborted();
  const installed = await installedChromium();
  const availability = await availabilityOf(installed);
  signal?.throwIfAborted();
  if (!availability.available) throw new MissingChromiumProducerError(availability);
  // Availability cannot be positive without the installed driver.
  if (installed === null) throw new Error("Chromium producer: inconsistent driver availability");
  const browser = await installed.chromium.launch({ headless: true,
    executablePath: availability.identity.executablePath, timeout: timeoutMs });
  let closing: Promise<void> | undefined;
  const onAbort = (): void => { void close().catch(() => { /* close() retains the rejection for the owner. */ }); };
  const close = (): Promise<void> => {
    if (closing === undefined) {
      signal?.removeEventListener("abort", onAbort);
      closing = Promise.resolve().then(() => browser.close());
    }
    return closing;
  };
  if (signal?.aborted) {
    await close();
    signal.throwIfAborted();
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  return { browser, identity: availability.identity, close };
}
