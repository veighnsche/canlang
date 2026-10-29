/** B25 gate-4 wiring: the real activate CLI runs the inventory gate from bundle evidence. */
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

interface ActivateEnvelope {
  readonly ok: boolean;
  readonly command?: string;
  readonly code?: string;
  readonly active?: boolean;
  readonly reasons?: ReadonlyArray<{ readonly code: string; readonly detail: string }>;
}

function stageBundle(outbox: ReadonlyArray<Record<string, unknown>>, transition: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'can-activate-gate4-'));
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

function runActivate(artifact: string): { readonly exit: number | null; readonly envelope: ActivateEnvelope } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'activate', '--artifact', artifact, '--env', 'local'],
      { encoding: 'utf8', timeout: 60000 });
    return { exit: 0, envelope: JSON.parse(stdout) as ActivateEnvelope };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: unknown };
    const envelope = typeof failure.stdout === 'string' && failure.stdout !== ''
      ? (JSON.parse(failure.stdout) as ActivateEnvelope)
      : { ok: false };
    return { exit: failure.status ?? null, envelope };
  }
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
    migrationId: 'mig-gate4',
    owner: 'TeamTasks',
    fromSnapshotId: 'snap-7',
    fromDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    toSnapshotId: 'snap-8',
    toDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    bodyDigest: 'body-gate4',
    directives: [...directives],
  };
}

it('activates when the transition pins the inventoried work', async () => {
  const artifact = stageBundle([OUTBOX_INTENT],
    bundleTransition([{ kind: 'invalidate', handlerContract: 'acme.worker' }]));
  const { exit, envelope } = runActivate(artifact);
  assert.equal(exit, 0);
  assert.deepEqual(envelope, { ok: true, command: 'activate', active: true });
});

it('blocks unpinned work with the engine reason', async () => {
  const artifact = stageBundle([OUTBOX_INTENT], bundleTransition([]));
  const { exit, envelope } = runActivate(artifact);
  assert.equal(exit, 0);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.active, false);
  assert.equal(envelope.reasons?.length, 1);
  assert.equal(envelope.reasons?.[0]?.code, 'blocked-work');
  assert.match(envelope.reasons?.[0]?.detail ?? '', /no pinned invalidate contract/);
});

it('keeps activation-incomplete without the transition source', async () => {
  const artifact = stageBundle([OUTBOX_INTENT], null);
  const { exit, envelope } = runActivate(artifact);
  assert.equal(exit, 0);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.active, false);
  assert.deepEqual(
    (envelope.reasons ?? []).map(reason => reason.code),
    ['activation-incomplete'],
  );
});

it('fails loud on a malformed transition', async () => {
  const artifact = stageBundle([], { migrationId: 'mig-gate4' });
  const { exit, envelope } = runActivate(artifact);
  assert.equal(exit, 2);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, 'activate');
  assert.equal(envelope.code, 'invalid-activation-bundle');
});
