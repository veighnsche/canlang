#!/usr/bin/env node
/** Private child entry for the long-lived local development owner. */
import { serveDevDaemonProcess } from "./session-daemon.js";

if (process.argv[2] !== "--serve") {
  process.exitCode = 2;
} else {
  void serveDevDaemonProcess().catch(() => { process.exitCode = 1; });
}
