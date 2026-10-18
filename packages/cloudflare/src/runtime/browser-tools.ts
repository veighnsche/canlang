/** Explicitly installed browser development tools, outside the production installation. */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const BROWSER_TOOLS_VERSION = '1.63.0';

/** Discovery never downloads or installs anything. Broken explicit selections fail closed. */
export function browserToolsRoot(): string | null {
  const explicit = process.env.CAN_BROWSER_TOOLS_ROOT;
  const selected = explicit ?? join(homedir(), '.local/share/can/development/browser', BROWSER_TOOLS_VERSION);
  let root: string;
  try { root = realpathSync(resolve(selected)); }
  catch (error) {
    if (explicit === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name?: unknown; version?: unknown; devDependencies?: Record<string, unknown>;
  };
  if (manifest.name !== 'can-browser-development-tools' || manifest.version !== BROWSER_TOOLS_VERSION ||
      manifest.devDependencies?.['@playwright/test'] !== BROWSER_TOOLS_VERSION) {
    throw new Error('Invalid browser development tools; use the separate browser-tools installer.');
  }
  return root;
}

/** The opt-in installer records its pinned headless executable inside its own tree. */
export function browserToolsExecutable(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { canDevelopment?: { browserExecutable?: unknown } };
  const relative = manifest.canDevelopment?.browserExecutable;
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.split(/[\\/]/).some(part => part === '..' || part === '')) {
    throw new Error('Browser development installation is incomplete; rerun its separate installer.');
  }
  const executable = realpathSync(join(root, relative));
  if (!executable.startsWith(root + '/')) throw new Error('Browser development executable escapes its installation.');
  return executable;
}
