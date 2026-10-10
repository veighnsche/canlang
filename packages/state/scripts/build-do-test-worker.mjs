import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const outputPath = resolve(packageDir, 'dist/test/storage/do-test-worker.js');
const adapterPath = resolve(packageDir, 'dist/src/storage/durable-object.js');

// A failed dependency load or bundle must never leave a usable stale worker.
rmSync(outputPath, { force: true });
const { buildSync } = await import('esbuild');
const result = buildSync({
  absWorkingDir: packageDir,
  entryPoints: ['test/storage/do-test-worker.js'],
  outfile: outputPath,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
  metafile: true,
  sourcemap: false,
  legalComments: 'none',
});

if (!Object.keys(result.metafile.inputs).some(path => resolve(packageDir, path) === adapterPath)) {
  throw new Error('DO test worker must bundle the owning emitted Durable Object adapter.');
}
if (result.outputFiles.length !== 1 || result.outputFiles[0].path !== outputPath) {
  throw new Error('DO test worker build must produce exactly its single JavaScript asset.');
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, result.outputFiles[0].text);
