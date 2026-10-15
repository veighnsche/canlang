/** Adapt only existing native text scalars; callers retain their own escaping sink. */
import type { MessageParamValue } from "@canlang/contracts";
import { isDatetime, isUserRef } from "@canlang/values";

export function nativeTextScalar(value: object): MessageParamValue | undefined {
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (kind === undefined || !("value" in kind) || (kind.value !== "user" && kind.value !== "datetime")) return undefined;
  const payload = kind.value === "user" ? "id" : "ms";
  const keys = Reflect.ownKeys(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      keys.length !== 2 || !keys.includes("kind") || !keys.includes(payload) ||
      keys.some(key => {
        const member = Object.getOwnPropertyDescriptor(value, key)!;
        return !("value" in member) || member.enumerable !== true;
      })) throw new TypeError("text native user/datetime values require their own canonical data fields");
  if (kind.value === "user") {
    if (!isUserRef(value)) throw new TypeError("text user value needs a nonempty stable identity");
    return { type: "text", value: value.id };
  }
  if (!isDatetime(value)) throw new TypeError("text datetime value needs exact bigint milliseconds");
  return { type: "datetime", value };
}
