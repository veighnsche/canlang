// Uses the same host algorithms called by values/src/locale.ts and wire.ts.
for (const tag of ["en-u-ca-gregory", "en-x-private", "en-US-US", "en-US"]) {
  try {
    console.log(JSON.stringify(tag) + ": " + JSON.stringify(Intl.getCanonicalLocales(tag)));
  } catch (error) {
    console.log(JSON.stringify(tag) + ": " + error.name);
  }
}
for (const value of ["💥💥💥", "https://[garbage]", "https://host:999999", "https://valid.example", "https://user:pass@example.com"]) {
  try {
    const parsed = new URL(value);
    console.log(JSON.stringify(value) + ": " + JSON.stringify(parsed.protocol));
  } catch (error) {
    console.log(JSON.stringify(value) + ": " + error.name);
  }
}
