import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveryRef } from '@canlang/contracts';
import type { HandlerContext } from './context.js';
import { send } from './stdlib.js';

test('send passes real lexical values synchronously to the owning guard seam', async () => {
  const inputs = { count: 2n, optional: null, person: { kind: 'user', id: 'person' } };
  let seen: unknown[] | undefined;
  const delivery = { kind: 'delivery', operation: 'Mail.send', id: 'intent' } as unknown as DeliveryRef;
  const c = { canonical: {}, sendDeferred: async (...args: unknown[]) => { seen = args; return delivery; } } as unknown as HandlerContext;
  const pending = send(c, 'Mail.send', { body: 'hi' }, { binding: 'App.Mail', when: { rule: 'original', inputs } });
  assert.equal(seen?.length, 4);
  assert.equal((seen?.[3] as { inputs: unknown }).inputs, inputs);
  assert.equal(Object.isFrozen(seen?.[3]), true);
  assert.equal(await pending, delivery);
});

test('unguarded send retains the original three-argument ABI', async () => {
  let arity = 0;
  const c = { canonical: {}, sendDeferred: async (...args: unknown[]) => { arity = args.length; return null; } } as unknown as HandlerContext;
  await send(c, 'Mail.send', {}, { binding: 'App.Mail' });
  assert.equal(arity, 3);
});

test('send refuses callbacks, copied marker recipes and getters before context access', async () => {
  let touches = 0;
  const c = new Proxy({} as HandlerContext, { get() { touches++; throw new Error('context touched'); } });
  const options = [
    { when: () => true },
    { when: { rule: 'original', inputs: {}, extra: true } },
    { when: Object.create({ rule: 'original', inputs: {} }) },
    Object.defineProperty({}, 'when', { get() { touches++; throw new Error('getter touched'); } }),
    { when: Object.defineProperty({ inputs: {} }, 'rule', { get() { touches++; throw new Error('getter touched'); }, enumerable: true }) },
  ];
  for (const option of options) await assert.rejects(send(c, 'Mail.send', {}, option as never), /original emitted rule and lexical inputs/);
  assert.equal(touches, 0);
});

test('an emitted marker still requires an installed canonical staging context', async () => {
  await assert.rejects(send({} as HandlerContext, 'Mail.send', {}, {
    binding: 'App.Mail', when: { rule: 'original', inputs: {} },
  }), /bound send staging requires canonical execution/);
});
