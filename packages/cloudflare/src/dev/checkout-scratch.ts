/** Checkout-local test inputs retain package resolution and source-capture ownership. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

export async function createCheckoutScratch(root: string, prefix: string): Promise<string> {
  const directory = join(root, '.can', 'tmp');
  await mkdir(directory, { recursive: true });
  return mkdtemp(join(directory, prefix));
}
