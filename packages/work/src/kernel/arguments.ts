import { KernelTableError } from './tables.js';

export function checkArgs(args: Readonly<Record<string, unknown>>, what: string): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new KernelTableError(`${what}: args must be an object.`);
  }
}

export function argString(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value === '') {
    throw new KernelTableError(`${what}: ${field} must be a non-empty string.`);
  }
  return value;
}

export function argNullableString(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): string | null {
  const value = args[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new KernelTableError(`${what}: ${field} must be a string or null.`);
  }
  return value;
}

export function argRecord(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): Record<string, unknown> {
  const value = args[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelTableError(`${what}: ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function argInstant(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new KernelTableError(`${what}: ${field} must be finite epoch ms >= 0.`);
  }
  return value;
}
