import type { FormFieldDef } from "@canlang/contracts";

const INT_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^[+-]?(?:\d+)(?:\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(iso: string): boolean {
  const parts = iso.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y === undefined || m === undefined || d === undefined) {
    return false;
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function stringFieldValue(field: FormFieldDef): string | null {
  const value = field.value;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`field "${field.path}": type ${field.type} needs a string value`);
  }
  return value;
}

export function intFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `field "${field.path}": type int needs a bigint, safe number or canonical int string`,
      );
    }
    return String(value);
  }
  if (typeof value === "string" && INT_RE.test(value)) {
    return value;
  }
  throw new TypeError(
    `field "${field.path}": type int needs a bigint, safe number or canonical int string`,
  );
}

export function decimalFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "string" && DECIMAL_RE.test(value)) {
    return value;
  }
  throw new TypeError(
    `field "${field.path}": type decimal needs a bigint or canonical decimal string`,
  );
}

export function moneyFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `field "${field.path}": type money needs a bigint, safe number or canonical minor-units string`,
      );
    }
    return String(value);
  }
  if (typeof value === "string" && INT_RE.test(value)) {
    return value;
  }
  throw new TypeError(
    `field "${field.path}": type money needs a bigint, safe number or canonical minor-units string`,
  );
}

export function boolFieldValue(field: FormFieldDef): boolean {
  const value = field.value;
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`field "${field.path}": type bool needs a boolean value`);
  }
  return value;
}

export function dateFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string" || !DATE_RE.test(value) || !isValidDate(value)) {
    throw new TypeError(`field "${field.path}": type date needs a valid YYYY-MM-DD civil date`);
  }
  return value;
}

export function rawText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
