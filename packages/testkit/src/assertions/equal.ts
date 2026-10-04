import type { ObservationMismatch, ReportValue } from "@canlang/contracts";

function isRecord(value: ReportValue): value is { readonly [key: string]: ReportValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-typed comparison of one observation. Returns every mismatch with its
 * JSON path; an empty list means equal. Primitives compare with `Object.is`
 * (NaN equals NaN, -0 differs from 0); objects compare by key union so
 * missing and extra keys both report.
 */
export function diffReportValues(
  observation: string,
  expected: ReportValue,
  actual: ReportValue,
): ObservationMismatch[] {
  const mismatches: ObservationMismatch[] = [];
  compareAtPath(observation, expected, actual, mismatches);
  return mismatches;
}

function compareAtPath(
  path: string,
  expected: ReportValue,
  actual: ReportValue,
  mismatches: ObservationMismatch[],
): void {
  if (typeof expected !== typeof actual || Array.isArray(expected) !== Array.isArray(actual)) {
    mismatches.push({ observation: path, expected, actual });
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      mismatches.push({ observation: `${path}.length`, expected: expected.length, actual: actual.length });
    }
    const shared = Math.min(expected.length, actual.length);
    for (let index = 0; index < shared; index += 1) {
      compareAtPath(`${path}[${index}]`, expected[index] as ReportValue, actual[index] as ReportValue, mismatches);
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      compareAtPath(`${path}.${key}`, expected[key] ?? null, actual[key] ?? null, mismatches);
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    mismatches.push({ observation: path, expected, actual });
  }
}
