import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, access, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outputs, readReference, request, PROTOCOL, MAX_FRAME } from '../dev-server/host/protocol.mjs';

test('SDK requests bind bounded frames, sessions, operations and parent generations', () => {
  const value = { protocol: PROTOCOL, sessionId: 's', operationId: 'o', generationId: 'g', command: 'mf.create', payload: {} };
  const frame = Buffer.from(JSON.stringify(value));
  assert.deepEqual(request(frame, 's'), value);
  assert.throws(() => request(frame, 'foreign'), /request/);
  assert.throws(() => request(Buffer.alloc(MAX_FRAME + 1), 's'), /limit/);
  assert.throws(() => request(Buffer.from(JSON.stringify({ ...value, operationId: '' })), 's'), /request/);
});

test('SDK file references bind private regular canonical bytes and reject tampering or aliases', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'can-sdk-file-')));
  try {
    const outputs = new Outputs(directory);
    const original = await outputs.json({ actual: true });
    assert.deepEqual(JSON.parse((await readReference(original)).toString()), { actual: true });
    await writeFile(original.path, 'changed');
    await assert.rejects(readReference(original));
    const link = join(directory, 'link'); await symlink(original.path, link);
    await assert.rejects(readReference({ ...original, path: link }), /alias/);
    const publicFile = await outputs.json({}); await chmod(publicFile.path, 0o644);
    await assert.rejects(readReference(publicFile), /ownership/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SDK consume releases only verified own outputs and supports acknowledgement retry', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'can-sdk-consume-')));
  const foreign = await realpath(await mkdtemp(join(tmpdir(), 'can-sdk-foreign-')));
  try {
    const outputs = new Outputs(directory), foreignOutputs = new Outputs(foreign);
    const output = await outputs.json({ semantic: 'copied result' });
    const other = await foreignOutputs.json({ semantic: 'other owner' });
    await assert.rejects(outputs.consume([other]), /foreign/); await access(other.path);
    await assert.rejects(outputs.consume([{ ...output, sha256: '0'.repeat(64) }]), /identity/); await access(output.path);
    await assert.rejects(outputs.consume(Array(129).fill(output)), /acknowledgment/);
    await outputs.consume([output]); await assert.rejects(access(output.path), { code: 'ENOENT' });
    await outputs.consume([output]);
  } finally { await Promise.all([rm(directory, { recursive: true, force: true }), rm(foreign, { recursive: true, force: true })]); }
});
