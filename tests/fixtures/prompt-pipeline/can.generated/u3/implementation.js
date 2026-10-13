export function canonicalKey(value) {
  return value.normalize("NFKC").replace(/[A-Z]/g, letter => letter.toLowerCase());
}
