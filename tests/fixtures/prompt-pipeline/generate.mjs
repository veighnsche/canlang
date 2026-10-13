#!/usr/bin/env node
/** Explicit real generation; Playwright consumes saved outputs only. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A prepare no-op reuses saved files; it performs no candidate promotion. */
export async function validateSavedReuse(request, result, call) {
  const envelope = result.envelope;
  if (request.operation !== 'generate' || request.mode !== 'prepare' || result.code !== 0 || envelope.ok !== true ||
      envelope.request_id !== request.request_id || envelope.operation !== request.operation || envelope.state !== 'candidate' ||
      !Array.isArray(envelope.attempts) || envelope.attempts.length !== 0 || !Array.isArray(envelope.skipped) || envelope.skipped.length === 0) return null;
  const units = envelope.skipped.map(unit => unit.unit_id);
  if (new Set(units).size !== units.length || envelope.skipped.some(unit => typeof unit.unit_id !== 'string' || !unit.unit_id ||
      unit.reason !== 'saved output is fresh; prepare reuses it')) return null;
  const checks = [];
  for (const [index, unit_id] of units.entries()) {
    const validation = {version:1,request_id:`${request.request_id}.reuse-${index}`,operation:'validate',root:request.root,unit_id};
    const checked = await call(validation), body = checked.envelope;
    const valid = checked.code === 0 && body.ok === true && body.state === 'validated' && body.unit_id === unit_id &&
      body.request_id === validation.request_id && body.operation === 'validate' &&
      Array.isArray(body.checks) && body.checks.length > 0 && body.checks.every(check => check.ok === true);
    checks.push({unit_id, valid});
    if (!valid) return {units,validated:false,checks};
  }
  return {units,validated:true,checks};
}

async function main() {
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node tests/fixtures/prompt-pipeline/generate.mjs [--retry] [--dry-run]\nDefault: generate prepare + validate + accept through the public can gen command.\n--retry: freshly regenerate every app prompt and accept the complete set.\n--dry-run: validate committed settings and print the request; zero AI calls.');
  process.exit(0);
}
if (args.some(arg => !['--retry', '--dry-run'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Invalid arguments; use --help');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node 22 or newer');
const fixture = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(fixture, '../../..');
const compiler = resolve(workspace, 'compiler/target/debug/can');
const platform = resolve(workspace, 'packages/cloudflare/dist/cli/platform.js');
const { loadSettings, resolveRecipe } = await import(pathToFileURL(resolve(workspace, 'packages/cloudflare/dist/generation/config.js')).href);
const { parseRequest } = await import(pathToFileURL(resolve(workspace, 'packages/cloudflare/dist/generation/protocol.js')).href);
const loaded = await loadSettings(fixture);
const recipes = ['given', 'frontend'].map(category => ({category, ...resolveRecipe(loaded, category, null, {})}));
for (const recipe of recipes) {
  if (recipe.runner !== 'codex' || recipe.model !== 'gpt-6.1-sol' || recipe.native.model_reasoning_effort !== 'medium') {
    throw new Error('This fixture requires the committed Codex gpt-6.1-sol medium recipes');
  }
}
const request = { version: 1, request_id: `prompt-pipeline-${randomUUID()}`, operation: args.includes('--retry') ? 'retry' : 'generate',
  root: fixture, files: ['PromptStudio.can'], accept: true, ...(args.includes('--retry') ? {} : { mode: 'prepare' }) };
parseRequest(JSON.stringify(request));
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ request, settings: resolve(fixture, 'can.gen.toml'),
    recipes: recipes.map(recipe => ({category:recipe.category,runner:recipe.runner,model:recipe.model,reasoning_effort:recipe.native.model_reasoning_effort,
      max_attempts:recipe.max_attempts,timeout_seconds:recipe.timeout_seconds})), generation_started:false }, null, 2));
  process.exit(0);
}
await Promise.all([access(compiler, constants.X_OK), access(platform, constants.X_OK)]);
const call = (command) => {
  parseRequest(JSON.stringify(command));
  return new Promise((done, reject) => {
  const child = spawn(compiler, ['gen'], { cwd: workspace, shell: false, stdio: ['pipe','pipe','pipe'],
    env: {...process.env, CAN_PLATFORM_BIN:platform, CAN_COMPILER_BIN:compiler,
      PATH:[dirname(process.execPath),resolve(workspace,'node_modules/.bin'),process.env.PATH ?? ''].join(delimiter)} });
  let stdout = '', bytes = 0;
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { child.kill('SIGTERM'); reject(new Error('Generation response exceeded its finite size limit')); }
    else stdout += chunk.toString();
  });
  // Native diagnostics can contain credentials. Do not retain or echo stderr.
  child.stderr.resume();
  child.once('error', reject);
  child.once('close', code => {
    try { done({code,envelope:JSON.parse(stdout)}); }
    catch { reject(new Error('Public generation command returned no valid JSON response')); }
  });
  child.stdin.end(JSON.stringify(command));
  });
};
const result = await call(request);
const reuse = await validateSavedReuse(request,result,call);
const envelope = result.envelope;
const report = { reuse, request_id:request.request_id, operation:request.operation, exit:result.code,
  ok:envelope.ok === true, state:envelope.state ?? null, complete:envelope.complete === true, qualified:envelope.qualified === true,
  accepted:envelope.accepted && typeof envelope.accepted === 'object' ? {run:envelope.accepted.run,files:envelope.accepted.files,units:envelope.accepted.units} : false,
  attempts:Array.isArray(envelope.attempts) ? envelope.attempts.map(attempt=>({attempt:attempt.attempt,units:attempt.units,state:attempt.state,exit:attempt.exit,
    submission_complete:attempt.submission_complete,disk_complete:attempt.disk_complete,qualified:attempt.qualified,tries:attempt.tries})) : [],
  error_code:typeof envelope.error?.code === 'string' ? envelope.error.code : null };
const reports = resolve(workspace,'output/prompt-pipeline');
await mkdir(reports,{recursive:true});
const reportPath = resolve(reports,`generation-${request.request_id}.json`);
await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({...report,report:reportPath},null,2));
const promoted = result.code === 0 && envelope.request_id === request.request_id && envelope.operation === request.operation &&
  envelope.ok === true && envelope.state === 'accepted' && envelope.complete === true && envelope.qualified === true && report.accepted;
if (!promoted && reuse?.validated !== true) {
  throw new Error(`Generation was not a complete accepted set (${report.state ?? 'unknown'}; ${report.error_code ?? 'inspect report'}): ${reportPath}`);
}

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
