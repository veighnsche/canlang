import type { Violation, ViolationCode } from "@canlang/contracts/values";

export function pushViolation(
  ctx: { readonly violations: Violation[] },
  path: ReadonlyArray<string | number>,
  code: ViolationCode,
  message: string,
  expected?: string,
  actual?: string,
): void {
  const frozenPath = Object.freeze([...path]);
  if (expected === undefined) {
    ctx.violations.push({ path: frozenPath, code, message });
  } else if (actual === undefined) {
    ctx.violations.push({ path: frozenPath, code, message, expected });
  } else {
    ctx.violations.push({ path: frozenPath, code, message, expected, actual });
  }
}
