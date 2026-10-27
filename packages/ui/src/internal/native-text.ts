/** Adapt only existing native text scalars; callers retain their own escaping sink. */
import type { MessageParamValue } from "@canlang/contracts";
import { isDatetime, isMoney, isUserRef } from "@canlang/values";

export function nativeTextScalar(value: object): MessageParamValue | undefined {
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (kind === undefined || !("value" in kind) || (kind.value !== "user" && kind.value !== "datetime" && kind.value !== "money")) return undefined;
  const payload = kind.value === "money" ? ["minor", "currency"] : [kind.value === "user" ? "id" : "ms"];
  const keys = Reflect.ownKeys(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      keys.length !== payload.length + 1 || !keys.includes("kind") || payload.some(name => !keys.includes(name)) ||
      keys.some(key => {
        const member = Object.getOwnPropertyDescriptor(value, key)!;
        return !("value" in member) || member.enumerable !== true;
      })) throw new TypeError("text native scalar values require their own canonical data fields");
  if (kind.value === "money") {
    if (!isMoney(value)) throw new TypeError("text money value needs exact bigint minor units and its currency");
    return { type: "money", value };
  }
  if (kind.value === "user") {
    if (!isUserRef(value)) throw new TypeError("text user value needs a nonempty stable identity");
    return { type: "text", value: value.id };
  }
  if (!isDatetime(value)) throw new TypeError("text datetime value needs exact bigint milliseconds");
  return { type: "datetime", value };
}
