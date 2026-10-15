/** Explicit local-preview actor grants; never production identity configuration. */
export type PreviewRoles = Readonly<Record<string, readonly string[]>>;

export function parsePreviewRoles(value: unknown): PreviewRoles {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("preview roles must map seeded actor labels to role names");
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const [actor, roles] of Object.entries(value)) {
    if (!["Ava", "Ben", "Cal", "Dee"].includes(actor) || !Array.isArray(roles) || roles.length > 32 ||
        roles.some(role => typeof role !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(role)) || new Set(roles).size !== roles.length) {
      throw new Error("preview roles require known seeded actors and distinct declared role names");
    }
    result[actor] = Object.freeze([...roles]);
  }
  return Object.freeze(result);
}

/** Resolve short names only when unique in the installed compiled definition. */
export function resolvePreviewRoles(request: PreviewRoles, definition: unknown): PreviewRoles {
  if (Object.keys(request).length === 0) return request;
  const app = definition as { policy?: { roles?: unknown }; packages?: Record<string, { roles?: Record<string, { id?: unknown }> }> };
  const declared = Array.isArray(app?.policy?.roles) ? app.policy.roles : [];
  const roles = Object.values(app?.packages ?? {}).flatMap(pkg => Object.entries(pkg.roles ?? {}))
    .filter((entry): entry is [string, { id: string }] => typeof entry[1]?.id === "string" && declared.includes(entry[1].id));
  const resolved: Record<string, readonly string[]> = Object.create(null);
  for (const [actor, requested] of Object.entries(request)) {
    const ids = requested.map(name => {
      const matches = [...new Set(roles.filter(([short, role]) => role.id === name || short === name).map(([, role]) => role.id))];
      if (matches.length !== 1) throw new Error(`preview role ${JSON.stringify(name)} is absent or ambiguous in the compiled app`);
      return matches[0]!;
    });
    if (new Set(ids).size !== ids.length) throw new Error("preview roles contain duplicate canonical assignments");
    resolved[actor] = Object.freeze(ids);
  }
  return Object.freeze(resolved);
}
