import { discoverSessionSocket } from '/workspace/canlang/packages/cloudflare/dist/dev/session-socket.js';

const sessionId = 'ba7f37ffc6c94baca15027d505bc8f8f88f4e3d120de9b05';
const owner = await discoverSessionSocket({
  checkoutRoot: '/workspace/.canlang-env/dev-server-life-a',
  app: 'OfficeSupplies', profile: 'local-d1-identity', sessionId,
});
if (owner.identity.sessionId !== sessionId || owner.identity.pid === process.pid) {
  throw new Error('verified owner identity mismatch');
}
process.kill(owner.identity.pid, 'SIGKILL');
console.log(JSON.stringify({ killedVerifiedSession: sessionId, pid: owner.identity.pid }));
