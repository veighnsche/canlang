/** Explicit foreground UI. The JSON adapter remains the default command surface. */
import type { Readable, Writable } from "node:stream";
import type { DevControlEnvelope } from "./control-client.js";
import { discoverSessionSocket, type SessionSocketClient, type SessionSocketLookup } from "./session-socket.js";
import type { DevObservation } from "./observation.js";
import { terminalAction, terminalColumns, type TerminalAction, TerminalInput, terminalOutcome, terminalStatus, terminalText } from "./terminal-presenter.js";

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
type Output = Writable & { isTTY?: boolean; columns?: number };
export interface TerminalDependencies {
  readonly cwd?: string;
  readonly input?: Input;
  readonly output?: Output;
  readonly run?: (argv: readonly string[]) => Promise<DevControlEnvelope>;
  readonly connect?: (lookup: SessionSocketLookup) => Promise<SessionSocketClient>;
  readonly now?: () => number;
  readonly pollMs?: number;
  /** Embedders can supply their own interrupt source without touching process handlers. */
  readonly interrupts?: Pick<NodeJS.Process, "on" | "off">;
}

const HELP = "Enter check (c), open/access (o), details (d), status (s), help (h), logs, stop or detach. No shell commands.";
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function quoted(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

function resolveTerminalDeps(argv: readonly string[], dependencies: TerminalDependencies) {
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const cwd = dependencies.cwd ?? process.cwd();
  const run = dependencies.run ?? (async args => (await import("./control-client.js")).runDevControlArgv(args, { cwd }));
  const connect = dependencies.connect ?? discoverSessionSocket;
  const now = dependencies.now ?? Date.now;
  const interrupts = dependencies.interrupts ?? process;
  const plain = argv.includes("--plain") || !input.isTTY || !output.isTTY;
  const args = argv.filter(arg => arg !== "--plain");
  const width = () => Math.max(12, (output.columns ?? 80) - 1);
  return { input, output, cwd, run, connect, now, interrupts, plain, args, width };
}

type DevSessionStart =
  | { ok: false; code: number }
  | { ok: true; owned: boolean; session: string; selection: string[]; recovery: string; lookup: SessionSocketLookup };

async function beginDevSession(
  run: (args: readonly string[]) => Promise<DevControlEnvelope>,
  args: string[],
  cwd: string,
  history: (...lines: string[]) => void,
): Promise<DevSessionStart> {
  let start: DevControlEnvelope;
  try { start = await run([args.includes("--source") ? "start" : "discover", ...args]); }
  catch { history("Control unavailable before connection. Retry can dev terminal with the same selection."); return { ok: false, code: 1 }; }
  if (!start.ok) { history(`${start.code}: ${start.detail}`); return { ok: false, code: start.code === "INVALID_ARGUMENTS" ? 2 : 1 }; }
  const result = record(start.result);
  const root = typeof result.root === "string" ? result.root : cwd;
  if (!start.session) { history("Control returned no verified session identity."); return { ok: false, code: 1 }; }
  const session = start.session;
  return {
    ok: true,
    owned: start.command === "start" && result.attached === false,
    session,
    selection: ["--root", root, "--session", session],
    recovery: `can dev stop --root ${quoted(root)} --session ${quoted(session)}`,
    lookup: { checkoutRoot: root, sessionId: session },
  };
}

export async function runDevTerminal(argv: readonly string[], dependencies: TerminalDependencies = {}): Promise<number> {
  const { input, output, cwd, run, connect, now, interrupts, plain, args, width } = resolveTerminalDeps(argv, dependencies);
  const parser = new TerminalInput();
  let frame: string[] = [];
  let state: DevObservation | null = null;
  let connected = false;
  let finished = false;
  let stopping = false;
  let checking = false;
  let pendingOutcome: string | null = null;
  let owned = false;
  let client: SessionSocketClient;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcomeId: string | null = null;
  let plainStatus = "";
  const lifetime = new AbortController();
  const erase = () => {
    if (!plain && frame.length) {
      const rows = frame.reduce((count, line) => count + Math.max(1, Math.ceil(terminalColumns(line) / (output.columns ?? 80))), 0);
      output.write(`\r\x1b[2K${"\x1b[1A\r\x1b[2K".repeat(rows - 1)}`);
      frame = [];
    }
  };
  const draw = () => {
    if (finished || !state) return;
    const lines = connected ? terminalStatus(state, now(), width()) : ["Control disconnected; reconnecting. Commands wait for a verified snapshot."];
    if (plain) {
      // Timers do not flood redirected output. Structural updates retain their meaning.
      const key = `${connected}:${state.sequence}`;
      if (key !== plainStatus) { output.write(`${lines.join("\n")}\n`); plainStatus = key; }
    } else {
      const prompt = `can> ${terminalText(parser.value, 128)}`;
      const selected = [...lines, Array.from(prompt).slice(-width()).join("")];
      if (selected.join("\n") === frame.join("\n")) return;
      erase();
      output.write(selected.join("\n"));
      frame = selected;
    }
  };
  const history = (...lines: string[]) => {
    if (finished) return;
    erase();
    // Let the terminal wrap durable lines so copied access/recovery commands stay intact.
    for (const line of lines) output.write(`${terminalText(line)}\n`);
    draw();
  };
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)) {
    history("can dev terminal [--source PATH] [--check-mode manual|automatic] [start/selection flags] [--plain]", "With --source: start a session (manual by default). Automatic mode checks initially and after saves. Without --source: attach to the verified selected session.", HELP);
    return 0;
  }
  let startupInterrupts = 0;
  const onStartupInterrupt = () => {
    startupInterrupts++;
    history("Interrupt requested; waiting for a verified owner before stopping or detaching.");
  };
  interrupts.on("SIGINT", onStartupInterrupt);
  const startupExit = (code: number) => { interrupts.off("SIGINT", onStartupInterrupt); return code; };
  history(args.includes("--source") ? "Starting development control. Source and preview have not been checked." : "Attaching to development control.");
  const begun = await beginDevSession(run, args, cwd, history);
  if (!begun.ok) return startupExit(begun.code);
  owned = begun.owned;
  const session = begun.session;
  const selection = begun.selection;
  const recovery = begun.recovery;
  const lookup = begun.lookup;
  // Detach closes only this foreground client's requests, not an accepted owner check.
  const request = (command: string, payload?: unknown) => client.request({ command, ...(payload === undefined ? {} : { payload }) }, lifetime.signal);
  const adopt = (value: unknown) => {
    const observation = value as DevObservation;
    if (observation?.schema !== "can.dev.observation.v1" || observation.session !== session || !Number.isSafeInteger(observation.sequence)) {
      throw new Error("invalid observation");
    }
    if (state && observation.sequence < state.sequence) return;
    state = observation;
    connected = true;
    if (state.operation || (state.lastOutcome?.id ?? null) !== pendingOutcome) checking = false;
    if (state.lastOutcome && state.lastOutcome.id !== outcomeId) {
      outcomeId = state.lastOutcome.id;
      history(...terminalOutcome(state));
      if (state.lastOutcome.source === "errors" && state.lastOutcome.revision) {
        void diagnostics(state.lastOutcome.revision).catch(() => history("Captured diagnostics unavailable; enter details to retry."));
      }
    }
    draw();
  };
  const diagnostics = async (revision: string) => {
    const page = record(await request("diagnostics", { revision, after: -1, limit: 3 }));
    const lines = [`Diagnostics captured at ${revision}${page.current === false ? " (older source)" : ""}:`];
    for (const raw of Array.isArray(page.diagnostics) ? page.diagnostics : []) {
      const item = record(raw), at = record(item.at);
      lines.push(`${item.code}: ${item.message}`, `  ${at.path ?? "source"} bytes ${at.start ?? "?"}..${at.end ?? "?"}`);
    }
    if (page.next_after !== null && page.next_after !== undefined) lines.push("More diagnostics retained; enter details for the first captured diagnostic.");
    const detail = record(await request("diagnostic.detail", { revision, index: 0, presentationOnly: true }));
    const excerpt = record(detail.captured_excerpt);
    if (typeof excerpt.text === "string") {
      lines.push(`Captured excerpt (${revision}):`);
      for (const line of excerpt.text.split(/\r?\n/).slice(0, 12)) lines.push(`  ${line}`);
    } else lines.push("Captured source excerpt unavailable; source on disk may have changed.");
    history(...lines);
  };
  try {
    client = await connect(lookup);
    adopt(await request("observe"));
  } catch {
    history("Control observation unavailable.", ...(owned ? [`Owner may still be running. Recovery: ${recovery}`] : []));
    return startupExit(1);
  }
  history(`Can | ${state!.app} | ${state!.sourcePath}`, `Control connected; ${owned ? "started here (Ctrl+C stops)" : "attached view (Ctrl+C detaches)"}. Mode: ${state!.mode}.`, HELP,
    "Phase timers use owner boundaries. Subphase durations unavailable until reported.");
  const previousRaw = input.isRaw ?? false;
  return await new Promise<number>(resolve => {
    const finish = (code: number, message: string) => {
      if (finished) return;
      erase();
      output.write(`${terminalText(message)}\n`);
      finished = true;
      lifetime.abort();
      if (timer) clearTimeout(timer);
      input.off("data", onData); input.off("end", onEnd);
      output.off("resize", onResize);
      interrupts.off("SIGINT", onInterrupt);
      if (!plain) { output.write("\x1b[?2004l"); input.setRawMode?.(previousRaw); }
      input.pause();
      resolve(code);
    };
    const stop = async (interrupt = false) => {
      if (!owned) { history("Attached view cannot stop this owner. Enter detach to leave."); return; }
      if (stopping) {
        if (interrupt) finish(1, `Detached during cleanup; shutdown is unconfirmed. Recovery: ${recovery}`);
        else history("Already stopping; waiting for resource release. Ctrl+C detaches.");
        return;
      }
      stopping = true;
      history("Stopping owned session; waiting for resource release. Ctrl+C again detaches.");
      try {
        const stopped = await run(["stop", ...selection]);
        if (finished) return;
        if (stopped.ok) finish(0, "Stopped; owned resources released.");
        else { stopping = false; history(`Cleanup not confirmed (${stopped.code}). Retry stop. Recovery: ${recovery}`); }
      } catch { stopping = false; history(`Cleanup not confirmed. Retry stop. Recovery: ${recovery}`); }
    };
    const onInterrupt = () => { if (owned) void stop(true); else finish(0, "Detached; session remains running."); };
    const runCheck = async (): Promise<void> => {
      if (checking || state!.operation) { history("Already checking; duplicate request coalesced."); return; }
      if (!state!.admission.check) { history(`Check unavailable: ${state!.admission.reasons.join(", ") || "owner admission closed"}.`); return; }
      checking = true;
      pendingOutcome = state!.lastOutcome?.id ?? null;
      history("Check requested; waiting for owner progress.");
      const admission = record(await request("check.request"));
      if (admission.accepted === false && admission.alreadyChecking !== true) checking = false;
      if (!finished) adopt(await request("observe"));
    };
    const runOpen = async (): Promise<void> => {
      if (!state!.admission.open) { history("Preview access unavailable; enter check to prepare a preview."); return; }
      const access = record(await request("preview.open"));
      // Only this explicit action exposes Bearer [REDACTED] No shell/browser dispatch.
      if (typeof access.url === "string") history(`Preview access (private): ${access.url}`);
      const actors = record(access.actors);
      for (const [label, actor] of Object.entries(actors).slice(0, 20)) {
        const info = record(actor);
        if (typeof actor === "string") history(`Actor ${label} (private): ${actor}`);
        else if (typeof info.url === "string") history(`Actor ${label} (private): ${info.url}`);
      }
      if (Array.isArray(access.actors)) for (const raw of access.actors.slice(0, 20)) {
        const actor = record(raw);
        if (typeof actor.email === "string" && typeof actor.password === "string") {
          history(`Actor ${actor.label ?? "local"} (private): ${actor.email} / ${actor.password}`);
        }
      }
      if (typeof access.url !== "string") history("Preview access URL unavailable.");
    };
    const runDetails = async (): Promise<void> => {
      const revision = state!.lastOutcome?.revision;
      if (!revision) history("No captured check details yet; enter check.");
      else {
        history(...terminalOutcome(state!));
        await diagnostics(revision);
      }
    };
    const preAction = async (selected: TerminalAction): Promise<boolean> => {
      if (selected === "detach") { finish(0, `Detached; session remains running.${owned ? ` Stop later: ${recovery}` : ""}`); return true; }
      if (selected === "stop") { await stop(); return true; }
      if (selected === "help") { history(HELP); return true; }
      if (selected === "logs") { history("Retained server logs unavailable. Check outcomes and diagnostics remain in this transcript."); return true; }
      if (selected === "status") { if (state) history(...terminalStatus(state, now(), width()), connected ? "Control connected." : "Control disconnected; status is last observed."); return true; }
      if (!connected) { history("Control disconnected. Wait for a verified snapshot before retrying."); return true; }
      if (selected !== "details" && (stopping || state!.lifecycle !== "running")) { history(`Action unavailable while server is ${stopping ? "stopping" : state!.lifecycle}.`); return true; }
      return false;
    };
    const action = async (line: string) => {
      const selected = terminalAction(line);
      if (!line.trim()) return;
      history(`can> ${line}`);
      if (!selected) { history("Unknown command. Enter help for known commands."); return; }
      if (await preAction(selected)) return;
      try {
        if (selected === "check") await runCheck();
        else if (selected === "open") await runOpen();
        else if (selected === "details") await runDetails();
      } catch { checking = false; if (!finished) history("Control action unavailable or retained detail expired. Enter status; retry after connection recovers."); }
    };
    const onData = (chunk: Buffer | string) => {
      const parsed = parser.feed(chunk.toString());
      if (parsed.rejectedPaste) history("Multi-line paste ignored. Type one known command and press Enter.");
      for (let i = 0; i < parsed.interrupts; i++) onInterrupt();
      for (const line of parsed.lines) void action(line);
      if (parsed.eof) finish(0, `Detached; session remains running.${owned ? ` Stop later: ${recovery}` : ""}`);
      draw();
    };
    const onEnd = () => finish(0, `Input closed; detached.${owned ? ` Session remains running. Stop later: ${recovery}` : " Session remains running."}`);
    const onResize = () => draw();
    const poll = async () => {
      if (finished) return;
      try {
        if (!connected) client = await connect(lookup);
        const wasConnected = connected;
        adopt(await request("observe"));
        if (!wasConnected && connected) history("Control reconnected; verified snapshot received.");
        if (state?.lifecycle === "stopped" && !stopping) { finish(0, "Session stopped."); return; }
      } catch {
        if (connected && !stopping) history("Control connection lost. Last status is retained; preview reachability is unknown.");
        connected = false; draw();
      }
      if (!finished) timer = setTimeout(() => { void poll(); }, Math.max(100, dependencies.pollMs ?? 500));
    };
    input.on("data", onData); input.on("end", onEnd);
    output.on("resize", onResize); interrupts.off("SIGINT", onStartupInterrupt); interrupts.on("SIGINT", onInterrupt);
    if (!plain) { input.setRawMode?.(true); output.write("\x1b[?2004h"); }
    input.resume();
    timer = setTimeout(() => { void poll(); }, Math.max(100, dependencies.pollMs ?? 500));
    draw();
    for (let i = 0; i < startupInterrupts && !finished; i++) onInterrupt();
  });
}
