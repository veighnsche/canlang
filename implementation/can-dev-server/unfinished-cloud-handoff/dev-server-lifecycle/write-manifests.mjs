import { writeFile } from 'node:fs/promises';
import { prepareLocalPreviewCapture } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-inputs.js';

for (const suffix of ['a', 'b']) {
  const root = `/workspace/.canlang-env/dev-server-life-${suffix}`;
  const request = prepareLocalPreviewCapture({
    checkoutRoot: root,
    appPath: `${root}/tests/integration/can-dev-server/OfficeSupplies.can`,
    compilerPath: `${root}/compiler/target/debug/can`,
    catalogPath: '/workspace/canlang/packages/values/dist/catalog.json',
    helpIndexPath: `${root}/docs/specification/CONSTRUCT-HELP.md`,
  });
  const extraInputPaths = [
    ...request.extraInputPaths,
    ...[
      'packages/values/src/catalog.ts', 'packages/values/dist/src/catalog.js',
      'packages/ui/src/catalog.ts', 'packages/ui/dist/src/catalog.js',
    ].map((path, index) => ({ name: `worktree-help-${index}`, path: `${root}/${path}` })),
  ];
  const { inputInventory: _inventory, ...other } = request;
  await writeFile(`/workspace/.canlang-env/logs/dev-server-lifecycle/capture-${suffix}.json`,
    JSON.stringify({ ...other, extraInputPaths }));
}
