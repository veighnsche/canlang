import { prepareLocalPreviewCapture } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-inputs.js';
import { captureSingleFileSource, captureIsCurrent } from '/workspace/canlang/packages/cloudflare/dist/dev/source-capture.js';

const root = '/workspace/.canlang-env/dev-server-life-a';
const request = prepareLocalPreviewCapture({
  checkoutRoot: root,
  appPath: `${root}/tests/integration/can-dev-server/OfficeSupplies.can`,
  compilerPath: `${root}/compiler/target/debug/can`,
  catalogPath: '/workspace/canlang/packages/values/dist/catalog.json',
  helpIndexPath: `${root}/docs/specification/CONSTRUCT-HELP.md`,
});
const first = await captureSingleFileSource(request);
await new Promise(resolve => setTimeout(resolve, 20_000));
const second = await captureSingleFileSource(request);
const older = new Map(first.inputs.map(input => [input.name, input]));
console.log(JSON.stringify({
  sameEpoch: first.epochMaterial === second.epochMaterial,
  firstCurrent: await captureIsCurrent(first),
  changed: second.inputs.filter(input => {
    const previous = older.get(input.name);
    return previous?.state !== input.state || previous?.sha256 !== input.sha256 || previous?.canonicalPath !== input.canonicalPath;
  }).map(input => input.name),
}));
