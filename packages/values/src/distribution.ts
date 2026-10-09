/** Package-owned locations for deployment inventory, resolved after installation. */
export const distribution = {
  modules: new URL("./", import.meta.url),
  bindings: new URL("../bindings/", import.meta.url),
  catalog: new URL("../catalog.json", import.meta.url),
} as const;
