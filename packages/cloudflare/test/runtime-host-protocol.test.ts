import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MAX_RUNTIME_FRAME, parseRuntimeRequest, RUNTIME_PROTOCOL, readRuntimeFile, writeRuntimeFile,
  parseRuntimeCapture } from '../src/dev/runtime-host-protocol.js';

it('bounds protocol frames and binds session, operation and generation identities', () => {
  const value = { protocol: RUNTIME_PROTOCOL, sessionId: 's', operationId: 'o', generationId: 'g', command: 'probe', payload: {} };
  const bytes = Buffer.from(JSON.stringify(value));
  expect(parseRuntimeRequest(bytes, 's')).toEqual(value);
  expect(() => parseRuntimeRequest(bytes, 'foreign')).toThrow('mismatch');
  expect(() => parseRuntimeRequest(Buffer.alloc(MAX_RUNTIME_FRAME + 1), 's')).toThrow('limit');
  expect(() => parseRuntimeRequest(Buffer.from(JSON.stringify({ ...value, operationId: '' })), 's')).toThrow('string');
});
it('reads and hashes actual private files and refuses stale content, links and public permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-file-test-'));
  try {
    const file = await writeRuntimeFile(root, { actual: true });
    expect(JSON.parse((await readRuntimeFile(file)).toString())).toEqual({ actual: true });
    await writeFile(file.path, 'changed');
    await expect(readRuntimeFile(file)).rejects.toThrow('changed');
    const link = join(root, 'link'); await symlink(file.path, link);
    await expect(readRuntimeFile({ ...file, path: link })).rejects.toThrow('private');
    const publicFile = await writeRuntimeFile(root, {}); await chmod(publicFile.path, 0o644);
    await expect(readRuntimeFile(publicFile)).rejects.toThrow('private');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('revives only validated source snapshot bytes and independently checks their digest', () => {
  const bytes = Buffer.from('app Sample');
  const value = { requestedRoot: '/a', root: '/a', requestedAppPath: '/a/a.can', appPath: '/a/a.can', compilerOperand: 'a.can',
    sourceText: 'app Sample', sourceBytes: bytes.length, sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceRevision: 'r', epochMaterial: 'e',
    profile: 'local-d1-identity', inputs: [], semanticOptions: {},
    sourceSnapshot: [{ path: 'a.can', sha256: createHash('sha256').update(bytes).digest('hex'), bytes }] };
  const parsed = parseRuntimeCapture(Buffer.from(JSON.stringify(value)));
  expect(Buffer.isBuffer(parsed.sourceSnapshot![0]!.bytes)).toBe(true);
  const wrongSource = { ...value, sourceText: 'different' };
  expect(() => parseRuntimeCapture(Buffer.from(JSON.stringify(wrongSource)))).toThrow('source bytes/hash');
  value.sourceSnapshot[0]!.sha256 = '0'.repeat(64);
  expect(() => parseRuntimeCapture(Buffer.from(JSON.stringify(value)))).toThrow('hash');
});
