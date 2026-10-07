function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Digest known business-error members without passing raw bodies through. */
export function digestBusinessError(value: unknown) {
  if (!isRecord(value)) return null;
  const code = value["code"];
  const message = value["message"];
  if (typeof code !== "string" || code === "" || typeof message !== "string" || message === "") {
    return null;
  }
  const fields = value["fields"];
  const digested: Array<{ path: string; code?: string; message: string }> = [];
  if (Array.isArray(fields)) {
    for (const entry of fields) {
      if (!isRecord(entry)) continue;
      const path = entry["path"];
      const fieldMessage = entry["message"];
      if (typeof path !== "string" || typeof fieldMessage !== "string") continue;
      const fieldCode = entry["code"];
      if (typeof fieldCode === "string") {
        digested.push({ path, code: fieldCode, message: fieldMessage });
      } else {
        digested.push({ path, message: fieldMessage });
      }
    }
  }
  return {
    code,
    message,
    ...(digested.length > 0 ? { fields: digested } : {}),
    ...(typeof value["retryable"] === "boolean" ? { retryable: value["retryable"] } : {}),
  };
}
