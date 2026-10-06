/**
 * Bounded pagination helper. Enforces the `PageRequest` / `ProviderPage`
 * contract shapes plus the deployment `maxPageSize`: over-limit requests
 * are rejected, never silently truncated, and the provider loader is not
 * invoked for them.
 */
import type {
  PageRequest,
  ProviderLimits,
  ProviderPage,
} from '@canlang/contracts';

export type PageRequestIssue = 'invalid' | 'over-limit' | 'unsupported';

export class PageRequestError extends Error {
  readonly issue: PageRequestIssue;
  constructor(issue: PageRequestIssue, message: string) {
    super(message);
    this.name = 'PageRequestError';
    this.issue = issue;
  }
}

export class ProviderPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPageError';
  }
}

export function assertPageRequest(
  request: PageRequest,
  limits: ProviderLimits,
): void {
  if (typeof request !== 'object' || request === null) {
    throw new PageRequestError('invalid', 'Page request must be an object');
  }
  const { cursor, limit } = request;
  if (!(cursor === null || typeof cursor === 'string')) {
    throw new PageRequestError(
      'invalid',
      'Page cursor must be a string or null',
    );
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new PageRequestError(
      'invalid',
      'Page limit must be a positive integer',
    );
  }
  if (limits.maxPageSize === null) {
    throw new PageRequestError(
      'unsupported',
      'Provider does not support pagination',
    );
  }
  if (limit > limits.maxPageSize) {
    throw new PageRequestError(
      'over-limit',
      `Page limit ${limit} exceeds maximum ${limits.maxPageSize}`,
    );
  }
}

export function assertProviderPage<T>(
  value: unknown,
  isItem: (item: unknown) => boolean,
): ProviderPage<T> {
  if (typeof value !== 'object' || value === null) {
    throw new ProviderPageError('Provider page must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['items']) || !record['items'].every(isItem)) {
    throw new ProviderPageError(
      'Provider page items must be an array of typed items',
    );
  }
  if (
    !(record['nextCursor'] === null || typeof record['nextCursor'] === 'string')
  ) {
    throw new ProviderPageError(
      'Provider page nextCursor must be a string or null',
    );
  }
  return {
    items: record['items'] as T[],
    nextCursor: record['nextCursor'] as string | null,
  };
}

/**
 * Validate the request, load one page, validate the page shape. `load`
 * runs only for valid in-limit requests.
 */
export async function fetchPage<T>(
  request: PageRequest,
  limits: ProviderLimits,
  isItem: (item: unknown) => boolean,
  load: (request: PageRequest) => Promise<unknown>,
): Promise<ProviderPage<T>> {
  assertPageRequest(request, limits);
  const raw = await load(request);
  return assertProviderPage<T>(raw, isItem);
}
