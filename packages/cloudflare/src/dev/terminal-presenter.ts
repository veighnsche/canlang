import type { DevObservation } from "./observation.js";

/** Strip terminal instructions, including OSC hyperlinks and bidi controls. */
export function terminalText(value: unknown, limit = 2000): string {
  return String(value ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, limit);
}

function cellWidth(char: string): number {
  const code = char.codePointAt(0)!;
  if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) return 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000) ? 2 : 1;
}
export function terminalColumns(value: string): number {
  return Array.from(value).reduce((width, char) => width + cellWidth(char), 0);
}

export function terminalWrap(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const chars = Array.from(terminalText(value));
  const lines: string[] = [];
  let line = "", cells = 0;
  for (const char of chars) {
    const size = cellWidth(char);
    if (cells + size > width && line) {
      const space = line.lastIndexOf(" ");
      if (space > 0) { lines.push(line.slice(0, space)); line = line.slice(space + 1); cells = terminalColumns(line); }
      else { lines.push(line); line = ""; cells = 0; }
    }
    line += char; cells += size;
  }
  lines.push(line);
  return lines;
}

const phaseLabels = {
  queued: "waiting for check", capturing: "capturing inputs", checking_source: "checking source",
  preparing_preview: "preparing preview", publishing: "publishing preview",
} as const;

function seconds(ms: number): string { return `${(Math.max(0, ms) / 1000).toFixed(1)}s`; }

export function terminalStatus(state: DevObservation, now: number, columns = 80): string[] {
  const operation = state.operation;
  const check = operation
    ? `${phaseLabels[operation.phase]}${operation.subphase ? ` / ${terminalText(operation.subphase, 100)}` : ""} (${seconds(now - operation.phaseStartedAt)} phase; ${seconds(now - operation.startedAt)} total)`
    : state.lastOutcome ? `${state.lastOutcome.revision ?? "uncaptured"}: ${state.lastOutcome.source} (${seconds(state.lastOutcome.finishedAt - state.lastOutcome.startedAt)})`
    : state.mode === "automatic" ? "initial check pending" : "not checked; enter check";
  const preview = state.preview.availability === "serving"
    ? `serving ${state.preview.revision ?? "unknown revision"} (${state.preview.freshness === "older" ? "last good; older source" : state.preview.freshness})${state.preview.origin ? ` ${safeOrigin(state.preview.origin) ?? "origin unavailable"}` : ""}`
    : "unavailable";
  return [
    ...terminalWrap(`Server ${state.lifecycle} | ${state.mode}`, columns),
    ...terminalWrap(`Source ${state.sourceRevision ?? "uncaptured"} | capture ${state.capture}`, columns),
    ...terminalWrap(`Check ${check}`, columns),
    ...terminalWrap(`Preview ${preview}`, columns),
    ...(state.shutdownError ? terminalWrap("Cleanup incomplete; retry through the owning session.", columns) : []),
  ];
}

/** Routine output may contain the origin, never access paths, query or credentials. */
export function safeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return /^(http:|https:)$/.test(url.protocol) ? url.origin : null;
  } catch { return null; }
}

export function terminalOutcome(state: DevObservation): string[] {
  const outcome = state.lastOutcome;
  if (!outcome) return [];
  const lines = [`${outcome.revision ?? "Uncaptured check"}: source ${outcome.source}; preview ${outcome.preview}. ${seconds(outcome.finishedAt - outcome.startedAt)} total.`];
  if (outcome.reason) lines.push(terminalText(outcome.reason));
  if (state.preview.availability === "serving" && state.preview.freshness !== "current") {
    lines.push(`Last good preview remains available at ${state.preview.revision ?? "unknown revision"} (${state.preview.freshness}).`);
  }
  return lines;
}

export type TerminalAction = "check" | "open" | "details" | "status" | "help" | "logs" | "stop" | "detach";
const aliases: Readonly<Record<string, TerminalAction>> = {
  check: "check", c: "check", open: "open", o: "open", access: "open", details: "details", d: "details",
  status: "status", s: "status", help: "help", h: "help", "?": "help", logs: "logs", l: "logs",
  stop: "stop", detach: "detach", quit: "detach",
};
export function terminalAction(line: string): TerminalAction | null {
  return aliases[line.trim().toLowerCase()] ?? null;
}

/** Raw input is bounded; a pasted block cannot silently execute multiple commands. */
export class TerminalInput {
  value = "";
  private paste = false;
  private rejected = false;
  private pending = "";
  feed(chunk: string): { lines: string[]; interrupts: number; rejectedPaste: boolean; eof: boolean } {
    const result = { lines: [] as string[], interrupts: 0, rejectedPaste: false, eof: false };
    this.pending += chunk;
    // Canonical/non-TTY input also passes here; treat a multi-line batch as pasted text.
    const breaks = this.pending.match(/\r\n|\r|\n/g)?.length ?? 0;
    if (!this.paste && !this.pending.includes("\x1b[200~") && breaks > 1) {
      this.pending = ""; this.value = ""; result.rejectedPaste = true; return result;
    }
    while (this.pending.length) {
      if (this.pending.startsWith("\x1b[200~")) { this.paste = true; this.rejected = false; this.pending = this.pending.slice(6); continue; }
      if (this.pending.startsWith("\x1b[201~")) { this.paste = false; if (this.rejected) this.value = ""; this.rejected = false; this.pending = this.pending.slice(6); continue; }
      if (this.pending.startsWith("\x1b")) {
        if (/^\x1b\[(?:2(?:0[01]?)?)?$/.test(this.pending) || this.pending === "\x1b") break;
        const escape = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending);
        this.pending = this.pending.slice(escape?.[0].length ?? 1); continue;
      }
      const char = this.pending[0]!;
      this.pending = this.pending.slice(1);
      if (char === "\x03") { if (!this.paste) { result.interrupts++; this.value = ""; } }
      else if (char === "\x04") { if (!this.paste) result.eof = true; }
      else if (char === "\r" || char === "\n") {
        if (char === "\r" && this.pending.startsWith("\n")) this.pending = this.pending.slice(1);
        if (this.paste) { result.rejectedPaste = true; this.rejected = true; this.value = ""; }
        else { result.lines.push(this.value); this.value = ""; }
      } else if (char === "\x7f" || char === "\b") this.value = this.value.slice(0, -1);
      else if (!this.rejected && /^[\x20-\x7e]$/.test(char) && this.value.length < 128) this.value += char;
    }
    // A rejected pasted line must also discard its final unterminated segment.
    if (result.rejectedPaste) this.value = "";
    return result;
  }
}
