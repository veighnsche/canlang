'use strict';
// Compile reviewed sources separately and set CAN_CLIENT_OUT to that snapshot.
const { fixture, document, tick } = require('../../../editors/vscode/test/client-lifecycle.cjs');
(async () => {
  const checks = [];
  const f = fixture(), c = f.client(), start = c.start(), child = f.children[0];
  child.reply('initialize'); await start;
  let settled = false;
  const pending = c.request('textDocument/hover', {}).then(() => { settled = true; });
  const stopped = c.stop(); await tick();
  checks.push({ case: 'pending request at stop before deadline', settled });
  await f.advance(1999);
  checks.push({ case: 'pending request at 1999ms', settled });
  await f.advance(1); await stopped; await pending;
  const g = fixture(), d = g.client(), ready = d.start(), ch = g.children[0];
  ch.reply('initialize'); await ready;
  const doc = document(); d.didOpen(doc); doc.version = 2;
  ch.throwWrite = true; d.didChange(doc);
  checks.push({ case: 'failed document change ownership', ownsUnsentRevision: d.isDocumentVersion(doc.uri.toString(), 2), sentMethods: ch.messages.map((m) => m.method) });
  ch.throwWrite = false; ch.emit('exit', 1);
  console.log(JSON.stringify(checks, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
