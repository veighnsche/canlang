/** B25 deploy wiring: deploy preview reports the staged verdict from bundle evidence. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages/cloudflare/dist/cli/platform.js');
const FIXTURES = join(ROOT, 'packages/cloudflare/test/fixtures/teamtasks-activate');

interface DeployEnvelope {
  readonly ok: boolean;
  readonly command?: string;
  readonly preview?: boolean;
  readonly verdict?: { readonly active: boolean; readonly reasons?: ReadonlyArray<{ readonly code: string }> };
}

function stageBundle(outbox: ReadonlyArray<Record<string, unknown>>, transition: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'can-deploy-verdict-'));
  for (const name of ['artifact', 'descriptor', 'local.environment', 'store', 'target']) {
    cpSync(join(FIXTURES, `teamtasks-good.${name}.json`), join(dir, `case.${name}.json`));
  }
  const store = JSON.parse(readFileSync(join(dir, 'case.store.json'), 'utf8')) as Record<string, unknown>;
  store['outbox'] = [...outbox];
  writeFileSync(join(dir, 'case.store.json'), JSON.stringify(store));
  if (transition !== null) {
    writeFileSync(join(dir, 'case.transition.json'), JSON.stringify(transition));
  }
  return join(dir, 'case.artifact.json');
}

function runPreview(artifact: string): DeployEnvelope {
  const stdout = execFileSync(process.execPath, [CLI, 'deploy', '--artifact', artifact, '--env', 'local', '--preview'],
    { encoding: 'utf8', timeout: 180000 });
  const last = stdout.trimEnd().split('\n').pop() ?? '';
  return JSON.parse(last) as DeployEnvelope;
}

const OUTBOX_INTENT = {
  intentId: 'intent-1',
  operation: 'acme.worker',
  operationId: 'op-1',
  target: 'worker',
  arguments: {},
  occurrenceIndex: 0,
};

function bundleTransition(directives: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return {
    migrationId: 'mig-deploy',
    owner: 'TeamTasks',
    fromSnapshotId: 'snap-7',
    fromDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    toSnapshotId: 'snap-8',
    toDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    bodyDigest: 'body-deploy',
    directives: [...directives],
  };
}

it('previews an active verdict when the transition pins the work', async () => {
  const artifact = stageBundle([OUTBOX_INTENT],
    bundleTransition([{ kind: 'invalidate', handlerContract: 'acme.worker' }]));
  const envelope = runPreview(artifact);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.preview, true);
  assert.equal(envelope.verdict?.active, true);
});

it('previews blocked-work when the transition leaves work unpinned', async () => {
  const artifact = stageBundle([OUTBOX_INTENT], bundleTransition([]));
  const envelope = runPreview(artifact);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.verdict?.active, false);
  assert.deepEqual(
    (envelope.verdict?.reasons ?? []).map(reason => reason.code),
    ['blocked-work'],
  );
});

it('previews activation-incomplete without bundle evidence', async () => {
  const artifact = stageBundle([OUTBOX_INTENT], null);
  const envelope = runPreview(artifact);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.verdict?.active, false);
  assert.deepEqual(
    (envelope.verdict?.reasons ?? []).map(reason => reason.code),
    ['activation-incomplete'],
  );
});
