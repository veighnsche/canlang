import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DevObservation } from "../src/dev/observation.js";
import type { DevControlEnvelope } from "../src/dev/control-client.js";
import { SESSION_SOCKET_PROTOCOL, type SessionSocketClient } from "../src/dev/session-socket.js";
import { TerminalInput, safeOrigin, terminalAction, terminalOutcome, terminalStatus, terminalText } from "../src/dev/terminal-presenter.js";
import { runDevTerminal } from "../src/dev/terminal.js";

const observation = (changes: Partial<DevObservation> = {}): DevObservation => ({
  schema: "can.dev.observation.v1", session: "s1", sequence: 1, app: "Office", sourcePath: "Office.can",
  mode: "manual", lifecycle: "running", revision: null, sourceRevision: null, capture: "confirmed", operation: null,
  lastOutcome: null, preview: { availability: "unavailable", revision: null, build: null, origin: null, freshness: "not_applicable" },
  admission: { check: true, open: false, retryCleanup: false, reasons: [] }, shutdownError: null, ...changes,
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("foreground terminal presentation and input", () => {
  it("separates control startup, source result and last-good preview at 80 and 44 columns", () => {
    expect(terminalStatus(observation(), 4000).join("\n")).toContain("not checked; enter check");
    const failed = observation({
      revision: "r2", sourceRevision: "r2",
      lastOutcome: { id: "c2", revision: "r2", source: "errors", preview: "unavailable", reason: null, startedAt: 1000, finishedAt: 3000 },
      preview: { availability: "serving", revision: "r1", build: "b1", origin: "http://127.0.0.1:3210/private?token=secret", freshness: "older" },
    });
    for (const width of [80, 44]) {
      const lines = terminalStatus(failed, 5000, width);
      expect(lines.every(line => Array.from(line).length <= width)).toBe(true);
      expect(lines.join(" ")).toContain("last good; older source");
      expect(lines.join(" ")).toContain("r2: errors");
      expect(lines.join(" ")).toContain("Source r2");
      expect(lines.join("")).not.toContain("token");
    }
    expect(terminalOutcome(failed).join(" ")).toContain("Last good preview remains available at r1");
  });

  it("uses owner phase times and discloses missing preview and cleanup", () => {
    const building = observation({ operation: { id: "c1", revision: "r1", phase: "preparing_preview", subphase: "bundle", startedAt: 1000, phaseStartedAt: 3000 } });
    expect(terminalStatus(building, 5500).join(" ")).toContain("2.5s phase; 4.5s total");
    expect(terminalStatus(building, 5500).join(" ")).toContain("Preview unavailable");
    expect(terminalStatus(observation({ lifecycle: "shutdown_incomplete", shutdownError: "CLEANUP_FAILED" }), 1).join(" ")).toContain("Cleanup incomplete");
    expect(terminalOutcome(observation({ lastOutcome: { id: "c2", revision: "r2", source: "superseded", preview: "superseded", reason: null, startedAt: 1, finishedAt: 2 } })).join(" ")).toContain("superseded");
  });

  it("strips control instructions and exposes only safe routine origins", () => {
    expect(terminalText("bad\x1b[2J\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\u202e")).toBe("badlink ");
    expect(safeOrigin("http://user:secret@localhost:3456/access?q=private")).toBe("http://localhost:3456");
    expect(safeOrigin("javascript:alert(1)")).toBeNull();
    expect(terminalAction("C")).toBe("check");
    expect(terminalAction("check && rm -rf .")).toBeNull();
  });

  it("requires Enter, bounds input and rejects multiline paste across chunks", () => {
    const input = new TerminalInput();
    expect(input.feed("check").lines).toEqual([]);
    expect(input.feed("\r").lines).toEqual(["check"]);
    expect(input.feed("\x1b[20").lines).toEqual([]);
    expect(input.feed("0~check\n").rejectedPaste).toBe(true);
    expect(input.feed("stop\x1b[201~\r").lines).toEqual([""]);
    expect(input.feed("\x1b[200~\x03\x04\x1b[201~")).toMatchObject({ interrupts: 0, eof: false });
    expect(input.feed("check\nstop\n").rejectedPaste).toBe(true);
    input.feed("x".repeat(1000)); expect(input.value.length).toBe(128);
    expect(input.feed("\x03").interrupts).toBe(1);
    expect(input.value).toBe("");
  });
});

function fixture(owned: boolean, options: { snapshot?: DevObservation; observe?: () => unknown; stop?: () => Promise<DevControlEnvelope>; request?: SessionSocketClient["request"] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const control: string[][] = [];
  const requests: string[] = [];
  let text = "";
  output.on("data", chunk => { text += String(chunk); });
  let snapshot = options.snapshot ?? observation();
  const client: SessionSocketClient = {
    identity: { protocol: SESSION_SOCKET_PROTOCOL, root: "/repo", app: "Office", profile: "local-single-file", sessionId: "s1", pid: 1, uid: 1, processStart: "p1", socketPath: "/private/s1" },
    request: async command => {
      requests.push(command.command);
      if (command.command === "observe") return options.observe ? options.observe() : snapshot;
      if (options.request) return options.request(command);
      if (command.command === "check.request") return { accepted: true, alreadyChecking: false };
      if (command.command === "preview.open") return { url: "http://localhost:3456/access?token=private" };
      return {};
    },
  };
  const run = async (argv: readonly string[]): Promise<DevControlEnvelope> => {
    control.push([...argv]);
    if (argv[0] === "stop" && options.stop) return options.stop();
    return { ok: true, command: argv[0]!, session: "s1", result: argv[0] === "stop" ? { stopped: true } : { root: "/repo", attached: !owned } };
  };
  const done = runDevTerminal(owned ? ["--source", "Office.can"] : [], { input, output, run, connect: async () => client, interrupts: signals as unknown as NodeJS.Process, pollMs: 100 });
  return { input, output, signals, control, requests, done, text: () => text, snapshot: (value: DevObservation) => { snapshot = value; } };
}

describe("foreground ownership and commands", () => {
  it("attaches read-only for lifecycle ownership and coalesces check aliases without a queue", async () => {
    const f = fixture(false);
    await turn();
    expect(f.text()).toContain("attached view (Ctrl+C detaches)");
    f.input.write("check\n"); f.input.write("c\n"); await turn();
    expect(f.requests.filter(command => command === "check.request")).toHaveLength(1);
    expect(f.text()).toContain("duplicate request coalesced");
    f.input.write("stop\n"); await turn();
    expect(f.control.map(command => command[0])).toEqual(["discover"]);
    expect(f.text()).toContain("Attached view cannot stop");
    f.signals.emit("SIGINT");
    expect(await f.done).toBe(0);
    expect(f.text()).not.toContain("\x1b");
    expect(f.requests).not.toContain("preview.open");
  });

  it("stops the started owner and waits for cleanup acknowledgement", async () => {
    let complete!: (value: DevControlEnvelope) => void;
    const f = fixture(true, { stop: () => new Promise(resolve => { complete = resolve; }) });
    await turn(); f.signals.emit("SIGINT"); await turn();
    expect(f.text()).toContain("waiting for resource release");
    expect(f.text()).not.toContain("Stopped; owned resources released");
    expect(f.control[1]).toEqual(["stop", "--root", "/repo", "--session", "s1"]);
    complete({ ok: true, command: "stop", session: "s1", result: { stopped: true } });
    expect(await f.done).toBe(0);
    expect(f.text()).toContain("Stopped; owned resources released");
  });

  it("detaches on a second cleanup interrupt with the exact scoped recovery command", async () => {
    const f = fixture(true, { stop: () => new Promise(() => undefined) });
    await turn(); f.signals.emit("SIGINT"); await turn(); f.signals.emit("SIGINT");
    expect(await f.done).toBe(1);
    expect(f.text().replace(/\n/g, "")).toContain("can dev stop --root '/repo' --session 's1'");
    expect(f.text()).not.toContain("Stopped; owned resources released");
  });

  it("only explicit open issues private access and restored snapshots precede action", async () => {
    const f = fixture(false, { snapshot: observation({ admission: { check: true, open: true, retryCleanup: false, reasons: [] } }) });
    await turn(); expect(f.text()).not.toContain("token=private");
    f.input.write("open\n"); await turn();
    expect(f.requests).toContain("preview.open"); expect(f.text()).toContain("token=private");
    f.input.write("detach\n"); expect(await f.done).toBe(0);
  });

  it("retains last observation on disconnect and gates actions until a verified snapshot", async () => {
    let disconnected = false;
    const f = fixture(false, { observe: () => {
      if (disconnected) throw new Error("lost socket");
      return observation();
    } });
    await turn(); disconnected = true;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(f.text()).toContain("Control connection lost");
    f.input.write("check\n"); await turn();
    expect(f.text()).toContain("Wait for a verified snapshot");
    expect(f.requests).not.toContain("check.request");
    disconnected = false;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(f.text()).toContain("verified snapshot received");
    f.signals.emit("SIGINT"); expect(await f.done).toBe(0);
  });
});
