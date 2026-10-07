import { IdentityError } from '@canlang/identity';
import { parseJsonBody } from '../http/limits.js';

export async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new IdentityError('validation', 'Unsupported content type.');
  }
  const body = await parseJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new IdentityError('validation', 'Invalid request body.');
  }
  return body as Record<string, unknown>;
}

export function bearerToken(request: Request): string | null {
  const header = (request.headers.get('authorization') ?? '').trim();
  const space = header.indexOf(' ');
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return null;
  const token = header.slice(space + 1).trim();
  return token === '' ? null : token;
}
