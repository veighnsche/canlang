import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const installed = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
const { prepareLocalPreviewCapture } = await import(pathToFileURL(join(installed, 'packages/cloudflare/dist/dev/preview-inputs.js')).href);
const base = join(installed, 'test-results/can-dev-server');
const runtime = join(await realpath(tmpdir()), `cv-${process.getuid()}`);
export const roots = Object.fromEntries(['a', 'b'].map(suffix => [suffix, join(base, `lifecycle-${suffix}`)]));
export const manifests = Object.fromEntries(['a', 'b'].map(suffix => [suffix, join(base, `lifecycle-capture-${suffix}.json`)]));
export const descriptors = Object.fromEntries(['a', 'b'].map(suffix => [suffix,
  join(runtime, createHash('sha256').update(roots[suffix]).digest('hex').slice(0, 24), 'descriptor.json')]));
// Check both owners before replacing either private checkout.
for (const suffix of ['a', 'b']) {
  const present = await stat(descriptors[suffix]).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert.equal(present, false, `${suffix}: owner descriptor exists; refuse replacement`);
}
for (const suffix of ['a', 'b']) {
  const root = roots[suffix];
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const path of ['package.json', 'compiler/Cargo.toml', 'compiler/Cargo.lock',
    'compiler/src', 'compiler/target/debug/can', 'docs/specification/GRAMMAR.md',
    'docs/specification/CONSTRUCT-HELP.md', 'docs/specification/DESIGN.md',
    'design/UI-COMPONENTS.md', 'packages/ui/src/catalog.ts', 'packages/values/src/catalog.ts',
    'tests/integration/can-dev-server/OfficeSupplies.can']) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(installed, path), target, { recursive: true, preserveTimestamps: true });
  }
  await symlink(join(installed, 'node_modules'), join(root, 'node_modules'));
  const request = prepareLocalPreviewCapture({ checkoutRoot: root,
    appPath: join(root, 'tests/integration/can-dev-server/OfficeSupplies.can'),
    compilerPath: join(root, 'compiler/target/debug/can'),
    catalogPath: join(installed, 'packages/values/dist/catalog.json'),
    helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') });
  await writeFile(manifests[suffix], JSON.stringify(request), { mode: 0o600 });
}
