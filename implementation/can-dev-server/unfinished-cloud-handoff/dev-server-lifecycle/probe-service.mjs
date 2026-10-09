import { prepareLocalPreviewCapture } from '/workspace/canlang/packages/cloudflare/dist/dev/preview-inputs.js';
import { startDevSessionService } from '/workspace/canlang/packages/cloudflare/dist/dev/session-service.js';

const root = '/workspace/.canlang-env/dev-server-life-a';
const capture = prepareLocalPreviewCapture({
  checkoutRoot: root,
  appPath: `${root}/tests/integration/can-dev-server/OfficeSupplies.can`,
  compilerPath: `${root}/compiler/target/debug/can`,
  catalogPath: '/workspace/canlang/packages/values/dist/catalog.json',
  helpIndexPath: `${root}/docs/specification/CONSTRUCT-HELP.md`,
});
const owner = await startDevSessionService({ selectedApp: 'OfficeSupplies', capture });
try { console.log(JSON.stringify(owner.status())); }
finally { await owner.stop(); }
