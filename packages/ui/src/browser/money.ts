/** Human currency units in the browser; the canonical transport stays minor units. */
import {currencyScale, money, parseDecimal} from '@canlang/values';
import type {DerivedOperationInputs, FormMode} from '@canlang/contracts';
import {GeneratedSubmitError} from '../client.js';

interface MoneyHint {id: string; textContent: string | null}
interface MoneyInput {
  tagName: string; id: string; type: string; value: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  insertAdjacentElement(position: string, element: MoneyHint): unknown;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface MoneyForm {
  tagName: string;
  getAttribute(name: string): string | null;
  elements: {namedItem(name: string): unknown};
  ownerDocument: {
    documentElement: {lang: string};
    getElementById(id: string): MoneyHint | null;
    createElement(tag: string): MoneyHint;
  };
}
interface MoneyControl {input: MoneyInput; currency: MoneyInput; name: string; nullName?: string; locale: string}
const empty = () => ({project(_flat: Record<string, string>) {}, stop() {}});
function isControl(candidate: unknown): candidate is MoneyInput {
  if (candidate === null || typeof candidate !== 'object') return false;
  const input = candidate as Partial<MoneyInput>;
  return ['input', 'select'].includes(input.tagName?.toLowerCase() ?? '') && typeof input.value === 'string' && typeof input.getAttribute === 'function';
}

function decimalSymbols(locale: string) {
  const format = new Intl.NumberFormat(locale);
  const parts = format.formatToParts(-1234.5);
  return {
    decimal: parts.find(part => part.type === 'decimal')?.value ?? '.',
    group: parts.find(part => part.type === 'group')?.value,
    minus: parts.find(part => part.type === 'minusSign')?.value ?? '-',
    digits: Array.from({length: 10}, (_, digit) => format.format(digit)),
  };
}

function majorText(minor: string, currency: string, locale: string): string {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(minor)) return minor;
  const scale = currencyScale(currency), value = BigInt(minor), factor = 10n ** BigInt(scale);
  const absolute = value < 0n ? -value : value;
  const symbols = decimalSymbols(locale);
  const whole = new Intl.NumberFormat(locale, {maximumFractionDigits: 0}).format(absolute / factor);
  const fraction = (absolute % factor).toString().padStart(scale, '0').replace(/[0-9]/g, digit => symbols.digits[Number(digit)]!);
  return (value < 0n ? symbols.minus : '') + whole + (scale ? symbols.decimal + fraction : '');
}

function minorText(major: string, currency: string, locale: string): string {
  const symbols = decimalSymbols(locale);
  let normalized = major.trim();
  for (let digit = 0; digit < symbols.digits.length; digit++) normalized = normalized.replaceAll(symbols.digits[digit]!, String(digit));
  normalized = normalized.replaceAll(symbols.minus, '-');
  if (symbols.group && normalized.includes(symbols.group)) {
    // Only accept grouping actually produced by this locale. Treating an
    // arbitrary separator as grouping can multiply a mistyped amount by 100.
    const [whole, ...fraction] = normalized.split(symbols.decimal);
    const ungrouped = whole!.replaceAll(symbols.group, '');
    if (fraction.length > 1 || fraction.some(part => part.includes(symbols.group!)) || !/^-?[0-9]+$/.test(ungrouped)) throw new Error('Invalid amount grouping');
    const expected = new Intl.NumberFormat(locale, {maximumFractionDigits: 0}).format(BigInt(ungrouped));
    let asciiExpected = expected;
    for (let digit = 0; digit < symbols.digits.length; digit++) asciiExpected = asciiExpected.replaceAll(symbols.digits[digit]!, String(digit));
    asciiExpected = asciiExpected.replaceAll(symbols.minus, '-');
    if (whole !== asciiExpected) throw new Error('Invalid amount grouping');
    normalized = [ungrouped, ...fraction].join(symbols.decimal);
  }
  normalized = normalized.replaceAll(symbols.decimal, '.');
  // Values owns decimal bounds, pinned currency scales and half-even rounding.
  return money(parseDecimal(normalized), currency).minor.toString();
}

export function enhanceMoneyInputs(candidate: unknown) {
  if (candidate === null || typeof candidate !== 'object') return empty();
  const form = candidate as MoneyForm;
  if (form.tagName?.toLowerCase() !== 'form' || typeof form.elements?.namedItem !== 'function' || !form.ownerDocument?.createElement) return empty();
  let metadata: {derived?: DerivedOperationInputs; mode?: FormMode};
  try {metadata = JSON.parse(form.getAttribute('data-can-generated-form') ?? '{}');} catch {return empty();}
  if (!Array.isArray(metadata.derived?.inputs)) return empty();
  const root = (name: string) => metadata.mode === 'update' ? `inputs[changes][${name}]` : `inputs[${name}]`;
  const controls: MoneyControl[] = [];
  const listeners: (() => void)[] = [];
  const locale = form.ownerDocument.documentElement.lang || 'en';
  for (const field of metadata.derived.inputs) {
    if (field.kind !== 'money' || field.array !== undefined) continue;
    const input = form.elements.namedItem(root(field.name)), currency = form.elements.namedItem(root(field.name + '__currency'));
    if (!isControl(input) || !isControl(currency) || input.type === 'hidden') continue;
    if (!input.hasAttribute('data-can-money-major')) {
      if (input.value && currency.value) {
        try {input.value = majorText(input.value, currency.value, locale);} catch {continue;}
      }
      input.setAttribute('data-can-money-major', '');
    }
    const hintId = input.id + '-currency-units';
    let hint = form.ownerDocument.getElementById(hintId);
    if (!hint) {
      hint = form.ownerDocument.createElement('p'); hint.id = hintId;
      input.insertAdjacentElement('afterend', hint);
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), hintId].filter(Boolean).join(' '));
    }
    const updateHint = () => {
      let example = '420';
      try {example = majorText((420n * 10n ** BigInt(currencyScale(currency.value))).toString(), currency.value, locale);} catch { /* The canonical currency boundary reports invalid codes on submit. */ }
      hint!.textContent = 'Amount in currency units, for example ' + example + (currency.value ? ' ' + currency.value : '') + '.';
    };
    updateHint();currency.addEventListener('input', updateHint);listeners.push(() => currency.removeEventListener('input', updateHint));
    controls.push({input, currency, name: root(field.name), ...(field.nullable ? {nullName: root(field.name + '__null')} : {}), locale});
  }
  return {
    project(flat: Record<string, string>) {
      for (const control of controls) {
        if (!Object.hasOwn(flat, control.name) || flat[control.name] === '' || (control.nullName && flat[control.nullName] === 'true')) continue;
        try {flat[control.name] = minorText(flat[control.name]!, control.currency.value, control.locale);}
        catch {throw new GeneratedSubmitError('projection', 'Enter a valid amount in currency units and its currency code.', false);}
      }
    },
    stop() {for (const stop of listeners) stop();},
  };
}
