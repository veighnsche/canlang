export function canonicalKey(value) {
  return value.normalize('NFKC').replace(/[A-Z]/g, character => character.toLowerCase());
}
