/** Existing own-data traversal and freeze mechanics shared by their owners. */
export function deepFreeze<T>(value: T, seen: Set<unknown> = new Set()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry, seen);
    }
  } else {
    for (const entry of Object.values(value)) {
      deepFreeze(entry, seen);
    }
  }
  return Object.freeze(value);
}

export function getDataPath(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    const obj = current as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(obj, segment)) {
      return undefined;
    }
    current = obj[segment];
  }
  return current;
}
