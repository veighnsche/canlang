/** Installed Playwright children may use the bundled runner from external apps. */
import { lstatSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundledOwner = process.env.CAN_BROWSER_TOOLS_ROOT
  ? pathToFileURL(join(process.env.CAN_BROWSER_TOOLS_ROOT, 'package.json')).href
  : new URL('../package.json', import.meta.url).href;
const bundledRequire = createRequire(bundledOwner);
const packages = new Set(['@playwright/test', 'playwright', 'playwright-core']);
let resolvingBundled = false;

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function localPackage(name, parentURL) {
  let directory = dirname(fileURLToPath(parentURL));
  for (;;) {
    // A present but broken package must keep its original resolution error.
    try { lstatSync(join(directory, 'node_modules', name)); return true; }
    catch (error) { if (error.code !== 'ENOENT') return true; }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      const name = packageName(specifier);
      if (resolvingBundled || !packages.has(name) || !context.parentURL?.startsWith('file:')) throw error;
      const message = error.message?.split('\n', 1)[0];
      const absent = error.code === 'MODULE_NOT_FOUND' && message === `Cannot find module '${specifier}'` ||
        error.code === 'ERR_MODULE_NOT_FOUND' && message?.startsWith(`Cannot find package '${name}' imported from `);
      if (!absent || localPackage(name, context.parentURL)) throw error;
      if (context.conditions.includes('require')) {
        resolvingBundled = true;
        try { return { url: pathToFileURL(bundledRequire.resolve(specifier)).href, shortCircuit: true }; }
        finally { resolvingBundled = false; }
      }
      return nextResolve(specifier, { ...context, parentURL: bundledOwner });
    }
  },
});
