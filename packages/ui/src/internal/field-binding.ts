import type { FormMode, FormFieldDef } from "@canlang/contracts";
import { escapeAttr } from "../escape.js";
import { isValidDate } from "./draft-values.js";


export const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;


const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/;


/**
 * Map a JSON Pointer into the submitted inputs (e.g. "/changes/title") to
 * its bracket form name (e.g. "inputs[changes][title]"). Handles RFC 6901
 * `~0`/`~1` escapes; anything else malformed throws.
 */
export function pointerToFieldName(pointer: string): string {
  if (typeof pointer !== "string") {
    throw new TypeError("pointerToFieldName: pointer must be a string");
  }
  if (pointer === "" || !pointer.startsWith("/")) {
    throw new Error(`malformed JSON pointer ${JSON.stringify(pointer)}: must start with "/"`);
  }
  const segments: string[] = [];
  for (const raw of pointer.split("/").slice(1)) {
    if (raw === "") {
      throw new Error(`malformed JSON pointer ${JSON.stringify(pointer)}: empty segment`);
    }
    segments.push(unescapeSegment(raw, pointer));
  }
  return `inputs${segments.map((segment) => `[${segment}]`).join("")}`;
}


function unescapeSegment(segment: string, pointer: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (ch !== "~") {
      out += ch;
      continue;
    }
    const next = segment.charAt(i + 1);
    if (next === "0") {
      out += "~";
      i += 1;
    } else if (next === "1") {
      out += "/";
      i += 1;
    } else {
      throw new Error(
        `malformed JSON pointer ${JSON.stringify(pointer)}: bad escape in segment ${JSON.stringify(segment)}`,
      );
    }
  }
  return out;
}


/**
 * Render a canonical RFC3339 UTC instant as a datetime-local wall time
 * ("YYYY-MM-DDTHH:mm") in the given time zone. Rejects rolled-over
 * dates/times like messages.ts; an invalid time zone throws the Intl
 * RangeError, which propagates to the caller.
 */
export function formatDatetimeLocal(instant: string, timeZone: string): string {
  if (typeof instant !== "string") {
    throw new TypeError("formatDatetimeLocal: instant must be a string");
  }
  if (typeof timeZone !== "string") {
    throw new TypeError("formatDatetimeLocal: timeZone must be a string");
  }
  if (
    !DATETIME_RE.test(instant) ||
    !isValidDate(instant.slice(0, 10)) ||
    !TIME_RE.test(instant.slice(11, -1)) ||
    !Number.isFinite(Date.parse(instant))
  ) {
    throw new TypeError(
      `invalid datetime instant ${JSON.stringify(instant)}: expected a canonical RFC3339 UTC instant`,
    );
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`formatDatetimeLocal: missing ${type} part`);
    }
    return found.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}


export function assertFieldPath(path: string): void {
  if (typeof path !== "string" || !FIELD_PATH_RE.test(path)) {
    throw new Error(`invalid field path ${JSON.stringify(path)}: must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
  }
}


/** Input root: update writes `inputs[changes][key]`, create/scenario `inputs[key]`. */
export function fieldName(mode: FormMode, path: string): string {
  return mode === "update" ? `inputs[changes][${path}]` : `inputs[${path}]`;
}


/**
 * Shared field-identity helpers (C4): control factories and label/validator
 * fragments derive identical names/ids from the same inputs. Returned values
 * are raw; callers escape for their context.
 */
export function fieldInputName(mode: FormMode, path: string): string {
  assertFieldPath(path);
  return fieldName(mode, path);
}

export function fieldInputId(idPrefix: string, path: string): string {
  assertFieldPath(path);
  return `${idPrefix}-${path}`;
}

export function fieldErrorOutletId(idPrefix: string, path: string): string {
  assertFieldPath(path);
  return `${idPrefix}-${path}-error`;
}


export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}


/** Native-only transport evidence; the business control name remains unique. */
export const NATIVE_BOOLEAN_PRESENCE_PREFIX = "can_boolean_present:";


/** Native transport evidence shared by forms and explicit controls. */
export function nativeBooleanPresence(field: FormFieldDef, controlName: string): string {
  return field.type === "bool" && field.readonly !== true
    ? hidden(NATIVE_BOOLEAN_PRESENCE_PREFIX + controlName, "true") : "";
}
