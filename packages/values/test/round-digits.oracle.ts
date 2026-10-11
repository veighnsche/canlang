/**
 * Independent half-even oracle over digit strings (no shared code with the
 * implementation): round integer `digits` (no sign) dropping `drop` low
 * digits. Returns the kept digit string.
 */
export function oracleRoundDigits(digits: string, drop: number): string {
  if (drop <= 0) return digits;
  const padded = digits.padStart(drop + 1, "0");
  const kept = padded.slice(0, padded.length - drop);
  const dropped = padded.slice(padded.length - drop);
  const half = "5" + "0".repeat(drop - 1);
  let up = false;
  if (dropped > half) {
    up = true;
  } else if (dropped === half) {
    up = Number(kept[kept.length - 1] as string) % 2 === 1;
  }
  if (!up) return kept;
  const arr = kept.split("");
  let i = arr.length - 1;
  while (i >= 0 && arr[i] === "9") {
    arr[i] = "0";
    i -= 1;
  }
  if (i < 0) {
    arr.unshift("1");
  } else {
    arr[i] = String(Number(arr[i]) + 1);
  }
  return arr.join("");
}
