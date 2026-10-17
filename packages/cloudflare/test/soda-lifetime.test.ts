import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lifetime = new URL('../dist/deploy/soda-lifetime.js', import.meta.url).href;

async function waitFor(path: string): Promise<string> {
  const limit = Date.now() + 5000;
  while (Date.now() < limit) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('supervised child did not complete its lifecycle');
}

for (const signal of ['SIGTERM', 'SIGKILL'] as const) test(`worker disposes after supervisor ${signal}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'can-lifetime-'));
  const ready = join(root, 'ready'), retired = join(root, 'retired');
  const childFile = join(root, 'child.mjs'), parentFile = join(root, 'parent.mjs');
  await writeFile(childFile, `import {installWorkerdShutdown} from ${JSON.stringify(lifetime)};
import {writeFile} from 'node:fs/promises';
const timer=setInterval(()=>{},1000);
installWorkerdShutdown(async()=>{clearInterval(timer);await writeFile(${JSON.stringify(retired)},'disposed');});
await writeFile(${JSON.stringify(ready)},String(process.pid));`);
  await writeFile(parentFile, `import {superviseWorkerd} from ${JSON.stringify(lifetime)};
process.exitCode=await superviseWorkerd(${JSON.stringify(childFile)},[]);`);
  const parent = spawn('node', [parentFile], { stdio: ['ignore', 'ignore', 'inherit'] });
  const closed = once(parent, 'close');
  let childPid: number | undefined;
  try {
    childPid = Number(await waitFor(ready));
    parent.kill(signal);
    const [code, actualSignal] = await closed;
    if (signal === 'SIGTERM') { expect(code).toBe(0); expect(actualSignal).toBeNull(); }
    else expect(actualSignal).toBe('SIGKILL');
    expect(await waitFor(retired)).toBe('disposed');
  } finally {
    parent.kill('SIGKILL');
    if (childPid !== undefined) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
