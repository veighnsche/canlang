import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasRole, require as guard, type HandlerRoleContext } from '../../src/effects/guards.js';

describe('synchronous handler guards', () => {
  it('preserves truthiness and plain guard error messages', () => {
    guard({});
    guard('yes');
    for (const condition of [false, null, undefined, 0, '']) {
      assert.throws(() => guard(condition), { name: 'Error', message: 'forbidden' });
    }
    assert.throws(() => guard(false, 'limit'), { name: 'Error', message: 'limit' });
    assert.throws(() => guard(false, ''), { name: 'Error', message: 'forbidden' });
  });

  it('keeps canonical built-ins separate from declared snapshot grants', () => {
    const context: HandlerRoleContext = {
      memberships: Object.freeze(['owner', 'Shop.editor']),
      canonical: { builtinRoles: Object.freeze(['public', 'authenticated', 'members']) },
    };
    assert.equal(hasRole(context, 'owner'), false);
    for (const role of ['public', 'authenticated', 'members']) assert.equal(hasRole(context, role), true);
    assert.equal(hasRole(context, 'Shop.editor'), true);
    assert.equal(hasRole(context, 'Shop.other'), false);
    assert.equal(hasRole({ memberships: [], canonical: {} }, 'public'), false);
    assert.equal(hasRole({ memberships: ['owner'] }, 'owner'), true);
    assert.equal(hasRole({ memberships: [] }, 'members'), false);
  });

  it('refuses every defined subject before reading the context', () => {
    const context = {
      get memberships(): readonly string[] { throw new Error('must not read memberships'); },
      get canonical(): never { throw new Error('must not read canonical'); },
    };
    for (const subject of [null, false, 0, '', 'person', {}]) {
      assert.throws(() => hasRole(context, 'Shop.editor', subject), {
        name: 'Error',
        message: 'unsupported(hasRole-subject): subject-scoped role tests need the L3 membership directory.',
      });
    }
    assert.equal(hasRole({ memberships: ['Shop.editor'] }, 'Shop.editor', undefined), true);
  });

  it('preserves getter evaluation order for canonical and declared roles', () => {
    const reads: string[] = [];
    const context = {
      get canonical() { reads.push('canonical'); return {
        get builtinRoles() { reads.push('builtinRoles'); return ['public']; },
      }; },
      get memberships() { reads.push('memberships'); return ['Shop.editor']; },
    };
    assert.equal(hasRole(context, 'public'), true);
    assert.deepEqual(reads, ['canonical', 'canonical', 'builtinRoles']);
    reads.length = 0;
    assert.equal(hasRole(context, 'Shop.editor'), true);
    assert.deepEqual(reads, ['canonical', 'memberships']);
  });
});
