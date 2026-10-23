#!/usr/bin/env node
/** Real filesystem staging/review/publication, including partial writes and cleanup. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PublicationError, PublicationSession, withPublicationSession, writeStagedFile } from '../dist/preparation/publication.js';

const scratch = mkdtempSync(join(tmpdir(), 'can-publication-integration-'));
const files = [
  { relativePath: 'first.txt', bytes: 'reviewed first' },
  { relativePath: 'nested/second.bin', bytes: new Uint8Array([0, 255, 128, 10]) },
  { relativePath: 'third.txt', bytes: 'reviewed third' },
];
const keys = files.map(file => file.relativePath);
const bytes = value => Buffer.from(value);
const checkBytes = (path, expected) => assert.deepEqual(readFileSync(path), bytes(expected));
function refuses(action, written, pending) {
  let refusal;
  assert.throws(action, error => { refusal = error; return error instanceof PublicationError; });
  if (written !== undefined) assert.deepEqual(refusal.written, written);
  if (pending !== undefined) assert.deepEqual(refusal.pending, pending);
  return refusal;
}
let workflows = 0;
try {
  let completed;
  withPublicationSession('confirmed', session => {
    completed = session;
    const staged = session.stage(files), destination = join(scratch, 'success');
    session.verifyReviewed(staged, files);
    assert.deepEqual(session.publish(staged, destination), { written: keys });
    for (const file of files) checkBytes(join(destination, file.relativePath), file.bytes);
  });
  assert.equal(completed.isDisposed, true); assert.equal(existsSync(completed.root), false);
  refuses(() => completed.stage(files)); refuses(() => completed.verifyReviewed([], []));
  refuses(() => completed.publish([], join(scratch, 'disposed'))); completed.dispose();
  assert.equal(existsSync(join(scratch, 'disposed')), false); workflows++;

  for (const timing of ['before-review', 'after-review']) for (const changed of ['x'.repeat(files[0].bytes.length), 'different length']) {
    withPublicationSession('confirmed', session => {
      const staged = session.stage(files), destination = join(scratch, `${timing}-${changed.length}`);
      mkdirSync(destination); writeFileSync(join(destination, 'first.txt'), 'existing destination');
      if (timing === 'after-review') session.verifyReviewed(staged, files);
      writeFileSync(staged[0].absolutePath, changed);
      if (timing === 'before-review') session.verifyReviewed(staged, files);
      let calls = 0;
      refuses(() => session.publish(staged, destination, (path, content) => { calls++; writeStagedFile(path, content); }), [], keys);
      assert.equal(calls, 0); checkBytes(join(destination, 'first.txt'), 'existing destination');
      assert.equal(existsSync(join(destination, 'nested')), false); assert.equal(existsSync(join(destination, 'third.txt')), false);
    }); workflows++;
  }

  withPublicationSession('confirmed', session => {
    const staged = session.stage(files), destination = join(scratch, 'mid-publication');
    session.verifyReviewed(staged, files);
    const calls = [];
    refuses(() => session.publish(staged, destination, (path, content) => {
      calls.push(path); writeStagedFile(path, content);
      if (calls.length === 1) writeFileSync(staged[1].absolutePath, new Uint8Array([1, 2, 3, 4]));
    }), [keys[0]], keys.slice(1));
    assert.equal(calls.length, 1); checkBytes(join(destination, keys[0]), files[0].bytes);
    assert.equal(existsSync(join(destination, keys[1])), false); assert.equal(existsSync(join(destination, keys[2])), false);
  }); workflows++;

  withPublicationSession('confirmed', session => {
    const staged = session.stage(files), destination = join(scratch, 'writer-failure');
    session.verifyReviewed(staged, files);
    const calls = [];
    refuses(() => session.publish(staged, destination, (path, content) => {
      calls.push(path);
      if (calls.length === 2) { writeStagedFile(path, 'partially affected'); throw new Error('writer failed after touching its file'); }
      writeStagedFile(path, content);
    }), [keys[0]], keys.slice(1));
    assert.equal(calls.length, 2); checkBytes(join(destination, keys[0]), files[0].bytes);
    checkBytes(join(destination, keys[1]), 'partially affected'); assert.equal(existsSync(join(destination, keys[2])), false);
  }); workflows++;

  withPublicationSession('preview', session => {
    const staged = session.stage(files), destination = join(scratch, 'preview');
    session.verifyReviewed(staged, files); let calls = 0;
    refuses(() => session.publish(staged, destination, () => { calls++; }));
    assert.equal(calls, 0); assert.equal(existsSync(destination), false);
  }); workflows++;

  const outside = join(scratch, 'outside'); mkdirSync(outside);
  const outsideFile = join(outside, 'protected.txt'); writeFileSync(outsideFile, files[0].bytes);
  withPublicationSession('confirmed', session => {
    for (const key of ['../escape', '/absolute', 'C:/absolute', 'a\\b', 'bad\0name', '']) {
      refuses(() => session.stage([{ relativePath: key, bytes: 'escape' }]));
    }
    symlinkSync(outside, join(session.root, 'link'));
    refuses(() => session.stage([{ relativePath: 'link/escape', bytes: 'escape' }]));
    symlinkSync(outsideFile, join(session.root, 'linked-file'));
    refuses(() => session.stage([{ relativePath: 'linked-file', bytes: 'escape' }]));
    assert.equal(existsSync(join(outside, 'escape')), false); checkBytes(outsideFile, files[0].bytes);
  }); workflows++;

  for (const key of ['linked/protected.txt', 'protected.txt']) withPublicationSession('confirmed', session => {
    const file = { relativePath: key, bytes: 'new contents' }, staged = session.stage([file]);
    session.verifyReviewed(staged, [file]);
    const destination = join(scratch, `destination-symlink-${basename(key)}-${key.length}`); mkdirSync(destination);
    symlinkSync(key.includes('/') ? outside : outsideFile, join(destination, key.includes('/') ? 'linked' : key));
    let calls = 0; refuses(() => session.publish(staged, destination, () => { calls++; }));
    assert.equal(calls, 0); checkBytes(outsideFile, files[0].bytes); workflows++;
  });

  let aborted; const sentinel = new Error('callback failed');
  assert.throws(() => withPublicationSession('confirmed', session => { aborted = session; session.stage(files); throw sentinel; }), error => error === sentinel);
  assert.equal(aborted.isDisposed, true); assert.equal(existsSync(aborted.root), false); workflows++;
  const callerRoot = join(scratch, 'caller-owned'); mkdirSync(callerRoot);
  const caller = PublicationSession.overRoot('confirmed', callerRoot);
  const staged = caller.stage([files[0]]); caller.verifyReviewed(staged, [files[0]]); caller.dispose(); caller.dispose();
  assert.equal(caller.isDisposed, true); assert.equal(existsSync(callerRoot), true);
  checkBytes(join(callerRoot, files[0].relativePath), files[0].bytes); refuses(() => caller.stage(files)); workflows++;
  console.log(JSON.stringify({ status: 'passed', workflows }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
