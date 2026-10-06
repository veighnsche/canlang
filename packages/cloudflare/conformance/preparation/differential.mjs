#!/usr/bin/env node
/**
 * Preparation differential (P02.3): run workloads against a CLI backend
 * and compare two runs byte-for-byte (minus timing/host metadata).
 *
 *   node differential.mjs --run --cli <dist/cli/platform.js> --backend prepared-ts --out prepared.json
 *   node differential.mjs --compare <a.json> <b.json>
 *
 * P02.3 compares prepared-ts against the P01.2 baseline vectors;
 * P08.2/P10.1 reuse --run with `--backend native`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runAll } from "./workloads.mjs";

function usage() {
  console.log(
    "usage:\n  differential.mjs --run --cli <path> --backend <name> --out <file>\n  differential.mjs --compare <a.json> <b.json>",
  );
  process.exit(2);
}

function normalize(results) {
  return {
    backend: results.backend,
    workloads: results.workloads.map((w) => ({
      id: w.id,
      ok: w.ok,
      notes: w.notes,
      fixtureSha: w.fixtureSha,
      runs: w.runs.map((r) => ({
        args: r.args,
        exit: r.exit,
        stdout: r.stdout,
        stderr: r.stderr,
        stdoutBytes: r.stdoutBytes,
        stderrBytes: r.stderrBytes,
        envelope: r.envelope,
        identicalStdoutToRun: r.identicalStdoutToRun ?? null,
        stdoutIdentical: r.stdoutIdentical ?? null,
      })),
    })),
    allOk: results.allOk,
  };
}

async function cmdRun(argv) {
  const cli = argv[argv.indexOf("--cli") + 1];
  const backend = argv[argv.indexOf("--backend") + 1];
  const out = argv[argv.indexOf("--out") + 1];
  if (!cli || !backend || !out || cli.startsWith("--") || backend.startsWith("--") || out.startsWith("--")) {
    usage();
  }
  const results = await runAll(cli, backend);
  writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
  const failed = results.workloads.filter((w) => !w.ok).map((w) => w.id);
  console.log(
    `backend=${backend} workloads=${results.workloads.length} ok=${results.workloads.length - failed.length}` +
      (failed.length > 0 ? ` FAILED=${failed.join(",")}` : ""),
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

function cmdCompare(aPath, bPath) {
  const a = normalize(JSON.parse(readFileSync(aPath, "utf8")));
  const b = normalize(JSON.parse(readFileSync(bPath, "utf8")));
  const diffs = [];
  if (a.workloads.length !== b.workloads.length) {
    diffs.push(`workload count ${a.workloads.length} != ${b.workloads.length}`);
  }
  for (let i = 0; i < Math.max(a.workloads.length, b.workloads.length); i++) {
    const wa = a.workloads[i];
    const wb = b.workloads[i];
    if (!wa || !wb) continue;
    if (wa.id !== wb.id) {
      diffs.push(`workload[${i}] id ${wa.id} != ${wb.id}`);
      continue;
    }
    for (const key of ["ok", "notes", "fixtureSha"]) {
      if (JSON.stringify(wa[key]) !== JSON.stringify(wb[key])) {
        diffs.push(`${wa.id}.${key}: ${JSON.stringify(wa[key])} != ${JSON.stringify(wb[key])}`);
      }
    }
    if (wa.runs.length !== wb.runs.length) {
      diffs.push(`${wa.id}: run count ${wa.runs.length} != ${wb.runs.length}`);
      continue;
    }
    for (let r = 0; r < wa.runs.length; r++) {
      const ra = wa.runs[r];
      const rb = wb.runs[r];
      for (const key of Object.keys(ra)) {
        if (JSON.stringify(ra[key]) !== JSON.stringify(rb[key])) {
          const sa = JSON.stringify(ra[key]);
          const sb = JSON.stringify(rb[key]);
          const sameLen = sa.length === sb.length ? ` (both ${sa.length} chars)` : ` (${sa.length} vs ${sb.length} chars)`;
          diffs.push(`${wa.id}.run${r}.${key} differs${sameLen}`);
        }
      }
    }
  }
  if (diffs.length === 0) {
    console.log(`IDENTICAL (${a.backend} vs ${b.backend}, ${a.workloads.length} workloads)`);
    process.exit(0);
  }
  console.log(`DIFFERENT (${a.backend} vs ${b.backend}):`);
  for (const d of diffs) console.log(`  - ${d}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv[0] === "--run") {
  await cmdRun(argv);
} else if (argv[0] === "--compare" && argv[1] && argv[2]) {
  cmdCompare(argv[1], argv[2]);
} else {
  usage();
}
