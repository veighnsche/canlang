#!/usr/bin/env node
/** Offline native app packaging/serving using the existing Canlang contracts. */
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSodaStorageFingerprint, preflightSodaDeployment, SODA_PROVIDER_INVENTORY } from '../deploy/soda-contract.js';
import type { SodaBundle } from '../deploy/soda-contract.js';
import { bundleMixedSha256, inventorizeAssets, assertLinksResolve, assertWorkerdLoadable } from '../deploy/bundle-validation.js';
import { provisionSodaStorage, startSodaRuntime } from '../deploy/soda-run.js';
import {startSodaSetup} from '../deploy/soda-setup.js';
import { installWorkerdShutdown, superviseWorkerd } from '../deploy/soda-lifetime.js';

type Options = Map<string, string>;
function required(options: Options, name: string): string {
  const value = options.get(name); if (value === undefined || value === '') throw new Error(`${name} is required`); return value;
}
async function loadBundle(path: string): Promise<SodaBundle> {
  const input = JSON.parse(await readFile(path, 'utf8')) as SodaBundle;
  input.bundle.binaries = Object.fromEntries(Object.entries(input.bundle.binaries)
    .map(([name, bytes]) => [name, Buffer.from(bytes as unknown as string, 'base64')]));
  preflightSodaDeployment(input.artifact, input.descriptor, input.environment);
  if (bundleMixedSha256(input.bundle.mainModule, inventorizeAssets(input.bundle.modules, input.bundle.binaries)) !== input.bundle.mixedSha256) {
    throw new Error('Soda portable bundle identity differs');
  }
  assertLinksResolve(input.bundle.modules, Object.keys(input.bundle.binaries));
  assertWorkerdLoadable(input.bundle.modules);
  // Older unchanged-artifact bundles predate the exported schema fingerprint.
  // prepareStorage still requires exact v1 artifact identity before seeding v2.
  return { ...input, storageFingerprint: input.storageFingerprint ?? getSodaStorageFingerprint(input.artifact) };
}

async function secretFile(path: string): Promise<unknown> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536 || stat.uid !== process.getuid?.()) {
      throw new Error('Credentials must be a private regular file owned by the current account');
    }
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}

async function run(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log(JSON.stringify({ commands: {
      bootstrap: '--bundle FILE --data EXISTING_DIRECTORY --credentials PRIVATE_JSON_FILE',
      member: '--bundle FILE --data EXISTING_DIRECTORY --owner TEAM_ID --credentials PRIVATE_JSON_FILE',
      setup: '--bundle FILE --data EXISTING_DIRECTORY --setup-token-file PRIVATE_JSON_FILE --setup-receipt-file FILE [--host ADDRESS] [--port NUMBER]',
      serve: '--bundle FILE --data EXISTING_DIRECTORY --owner TEAM_ID [--host ADDRESS] [--port NUMBER]',
      inventory: 'reports supported providers and explicit rejections',
    } })); return 0;
  }
  if (command === 'inventory') { console.log(JSON.stringify(SODA_PROVIDER_INVENTORY)); return 0; }
  const { options, child } = parseSodaOptions(command, argv);
  if (['serve','setup'].includes(command) && !child) return superviseWorkerd(fileURLToPath(import.meta.url), [...argv, '--child']);
  let runtime: {origin:string;dispose:()=>Promise<void>} | undefined;
  let started: Promise<void> | undefined;
  if (child) installWorkerdShutdown(async () => { await started; await runtime?.dispose(); });
  if (command === 'bootstrap' || command === 'member') {
    await runSodaMembership(command, options);
    return 0;
  }
  started = (async () => {
    const input = await loadBundle(required(options, '--bundle'));
    const port = Number(options.get('--port') ?? '8080');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Soda port');
    runtime = command==='setup'
      ? await startSodaSetup(input,{dataDir:required(options,'--data'),tokenFile:required(options,'--setup-token-file'),
          receiptFile:required(options,'--setup-receipt-file'),host:options.get('--host')??'127.0.0.1',port})
      : await startSodaRuntime(input, { dataDir: required(options, '--data'), ownerTeam: required(options, '--owner'),
          host: options.get('--host') ?? '127.0.0.1', port });
    console.log(JSON.stringify({ ok: true, command, origin: runtime.origin }));
  })();
  await started; return 0;
}

function parseSodaOptions(command: string, argv: string[]): { options: Options; child: boolean } {
  const options: Options = new Map();
  let child = false;
  const allowed = command === 'bootstrap' ? ['--bundle', '--data', '--credentials']
      : command === 'member' ? ['--bundle', '--data', '--owner', '--credentials']
      : command === 'serve' ? ['--bundle', '--data', '--owner', '--host', '--port']
        : command === 'setup' ? ['--bundle','--data','--host','--port','--setup-token-file','--setup-receipt-file'] : [];
  if (allowed.length === 0) throw new Error('Unknown can-soda command');
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (flag === '--child' && ['serve','setup'].includes(command)) { child = true; i -= 1; continue; }
    const value = argv[i + 1];
    if (!allowed.includes(flag) || options.has(flag) || value === undefined || value.startsWith('--')) throw new Error('Unknown, duplicate or missing can-soda option');
    options.set(flag, value);
  }
  return { options, child };
}

async function runSodaMembership(command: string, options: Options): Promise<void> {
  const input = await loadBundle(required(options, '--bundle'));
  const secret = await secretFile(required(options, '--credentials'));
  const dev = await provisionSodaStorage(input, required(options, '--data'));
  try {
    const response=await dev.dispatchUrl(`https://private.invalid/${command}`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(command==='bootstrap'?secret:{...secret as object,teamId:required(options,'--owner')})});
    if(!response.ok)throw new Error('identity administration failed');
    const owner=await response.json() as object;
    console.log(JSON.stringify({ ok: true, command, ...owner }));
  } finally { await dev.dispose(); }
}

void run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  // Credential and provider errors must not echo secret file contents or SQL binds.
  const detail = ['bootstrap', 'member','setup'].includes(process.argv[2] ?? '') ? 'identity administration failed; check private credentials and Identity storage'
    : error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000) : 'runtime operation failed';
  console.error(`can-soda: ${detail}`);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
