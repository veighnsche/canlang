/**
 * S4: pagination helper. Over-limit requests are rejected (never
 * truncated), shapes are enforced on both sides, and the loader never
 * runs for rejected requests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PageRequestError,
  ProviderPageError,
  assertProviderPage,
  fetchPage,
} from '../src/http/pagination.js';
import type {
  PageRequest,
  ProviderLimits,
} from '@canlang/contracts';

const LIMITS: ProviderLimits = { maxPageSize: 50, maxTransportBytes: null };

function isString(item: unknown): boolean {
  return typeof item === 'string';
}

describe('pagination', () => {
  it('loads and validates an in-limit page', async () => {
    const request: PageRequest = { cursor: null, limit: 50 };
    const page = await fetchPage<string>(
      request,
      LIMITS,
      isString,
      async (seen) => {
        assert.deepEqual(seen, request);
        return { items: ['a', 'b'], nextCursor: 'next' };
      },
    );
    assert.deepEqual(page, { items: ['a', 'b'], nextCursor: 'next' });
  });

  it('rejects over-limit requests without calling the loader', async () => {
    let calls = 0;
    await assert.rejects(
      fetchPage<string>(
        { cursor: null, limit: 51 },
        LIMITS,
        isString,
        async () => {
          calls += 1;
          return { items: [], nextCursor: null };
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof PageRequestError);
        assert.equal(err.issue, 'over-limit');
        return true;
      },
    );
    assert.equal(calls, 0);
  });

  it('rejects malformed requests without calling the loader', async () => {
    const bad: PageRequest[] = [
      { cursor: null, limit: 0 },
      { cursor: null, limit: -3 },
      { cursor: null, limit: 1.5 },
      { cursor: 12 as unknown as string, limit: 10 },
    ];
    for (const request of bad) {
      let calls = 0;
      await assert.rejects(
        fetchPage<string>(request, LIMITS, isString, async () => {
          calls += 1;
          return { items: [], nextCursor: null };
        }),
        (err: unknown) => {
          assert.ok(err instanceof PageRequestError);
          assert.equal(err.issue, 'invalid');
          return true;
        },
      );
      assert.equal(calls, 0);
    }
  });

  it('rejects paging when the provider declares no page size', async () => {
    const noPaging: ProviderLimits = {
      maxPageSize: null,
      maxTransportBytes: null,
    };
    let calls = 0;
    await assert.rejects(
      fetchPage<string>(
        { cursor: null, limit: 10 },
        noPaging,
        isString,
        async () => {
          calls += 1;
          return { items: [], nextCursor: null };
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof PageRequestError);
        assert.equal(err.issue, 'unsupported');
        return true;
      },
    );
    assert.equal(calls, 0);
  });

  it('rejects malformed provider pages', () => {
    const badPages: unknown[] = [
      null,
      { items: 'nope', nextCursor: null },
      { items: ['ok', 42], nextCursor: null },
      { items: [], nextCursor: 7 },
      { items: [] },
    ];
    for (const page of badPages) {
      assert.throws(
        () => assertProviderPage<string>(page, isString),
        ProviderPageError,
      );
    }
  });
});
