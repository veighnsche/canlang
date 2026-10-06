/** Package-owned locations for deployment inventory, resolved after installation. */
export const distribution = {
  modules: new URL("./", import.meta.url),
} as const;
