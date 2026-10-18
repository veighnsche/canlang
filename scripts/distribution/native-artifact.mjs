/** Native component identity at the existing release assembly boundary. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function nativeArtifact(file, name, version, platform) {
  const info = statSync(file), bytes = readFileSync(file);
  assert.ok(info.isFile() && (info.mode & 0o111), `${name}: executable file required`);
  assert.ok(bytes.length >= 32, `${name}: native executable required`);
  if (platform === 'darwin-arm64') {
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, `${name}: Mach-O executable required`);
    assert.equal(bytes.readUInt32LE(4), 0x0100000c, `${name}: arm64 executable required`);
  } else if (platform === 'linux-x64') {
    assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${name}: ELF executable required`);
    assert.equal(bytes[4], 2, `${name}: 64-bit executable required`);
    assert.equal(bytes[5], 1, `${name}: little-endian executable required`);
    assert.equal(bytes.readUInt16LE(18), 62, `${name}: x86_64 executable required`);
  } else assert.fail(`Unqualified native release host: ${platform}`);
  const identity = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.ok(identity.startsWith(`${name} ${version} (`) && identity.endsWith(')'), `${name}: release version differs: ${identity}`);
  return { version: identity, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
