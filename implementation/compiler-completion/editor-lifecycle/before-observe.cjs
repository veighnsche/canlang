/** Run with CAN_CLIENT_OUT pointing at separately compiled pre-change client/extension. */
const { fixture, document, tick } = require('../../../editors/vscode/test/client-lifecycle.cjs');
(async () => {
  const output = {};
  { const f = fixture(), c = f.client(); c.start(); c.didOpen(document());
    output.beforeHandshake = f.children[0].messages.map((m) => m.method); }
  { const f = fixture(), c = f.client(), started = c.start(), child = f.children[0];
    child.reply('initialize', null, { code: -32603, message: 'refused' }); await started;
    output.failedInitialize = { startResolved: true, messages: child.messages.map((m) => m.method) }; }
  { const f = fixture(); f.extension.activate({ subscriptions: [] }); const child = f.children[0];
    child.reply('initialize'); await tick(); f.commands['can.restartServer'](); f.commands['can.restartServer']();
    await tick(); output.restartBeforeOldExit = f.children.length;
    child.reply('shutdown', null); child.emit('exit', 0); await f.advance(2000); await tick();
    output.restartAfterOldExit = f.children.length; }
  { const f = fixture(), c = f.client(), started = c.start(), child = f.children[0];
    child.reply('initialize'); await started; let settled = false;
    c.stop().then(() => { settled = true; }); child.reply('shutdown', null); child.emit('exit', 0);
    await tick(); output.cooperativeExitSettlesStop = settled; }
  console.log(JSON.stringify(output, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
