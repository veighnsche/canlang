/** Disclosure projection from the already captured source, never a file read. */
import { createHash } from 'node:crypto';

export const OFFICE_COLUMN_INTENT = 'Show the supplies in separate name, quantity and available columns.';
export interface ConstructSourceEvidence {
  readonly sourceSha256: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly sourceWindow: {
    readonly text: string;
    readonly logicalLines: number;
    readonly bytesBeforeRedaction: number;
    readonly redacted: true;
    readonly truncated: boolean;
  };
  readonly authorIntent?: { readonly label: 'author_intent_data'; readonly text: string };
}

export function validAuthorIntent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 240 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** No declaration facts or identifier names are disclosed in this finite profile. */
export function captureConstructEvidence(source: string, sourceSha256: string,
  span: { readonly start: number; readonly end: number }, guess: string,
  authorIntent?: string): ConstructSourceEvidence | null {
  const bytes = Buffer.from(source, 'utf8');
  if (createHash('sha256').update(bytes).digest('hex') !== sourceSha256 ||
      !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 ||
      span.end <= span.start || span.end > bytes.length ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(guess) ||
      !bytes.subarray(span.start,span.end).equals(Buffer.from(guess)) ||
      (authorIntent !== undefined && !validAuthorIntent(authorIntent))) return null;
  const lines = source.split('\n');
  const lineIndex = bytes.subarray(0,span.start).toString('utf8').split('\n').length - 1;
  // The selected statement, nearest preceding declaration and its immediate
  // suite fit five lines. A larger statement is withheld rather than sliced.
  const selected = lines.slice(Math.max(0,lineIndex-1),lineIndex+4);
  const raw = selected.join('\n');
  const count = Buffer.byteLength(raw,'utf8');
  if (count > 1024 || selected.length > 5) return null;
  const words = new Set(['page','title','empty','text','row','name','quantity','available',guess]);
  const text = raw.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?(?:\1|$)|#[^\n]*|[A-Za-z_][A-Za-z0-9_]*|[^\sA-Za-z_()[\]{}.,:=/?<>!-]+/g,
    token => token.startsWith('#') ? '<COMMENT>' : /^["'`]/.test(token) ? '<STRING>' :
      words.has(token) ? token : '<REDACTED>');
  // Blank and comment-only lines do not close a collection suite. Find its next actual line
  // without disclosing any omitted text in the bounded window.
  let next: string | undefined;
  for (let index = lineIndex + 4; index < lines.length; index++) {
    const body = lines[index]!.trimStart();
    if (body.trim().length > 0 && !body.startsWith('##')) { next = lines[index]; break; }
  }
  const indent = (line: string) => line.length-line.trimStart().length;
  const truncated = next !== undefined && next.trim().length > 0 && indent(next) > indent(lines[lineIndex]!);
  return Object.freeze({ sourceSha256, span: Object.freeze({...span}),
    sourceWindow: Object.freeze({text,logicalLines:selected.length,bytesBeforeRedaction:count,redacted:true,truncated}),
    ...(authorIntent === undefined ? {} : {authorIntent:Object.freeze({label:'author_intent_data' as const,text:authorIntent})}) });
}

/** A bounded explicit choice resolves only the accepted read-only Office branch. */
export function hasOfficeColumnEvidence(messageKind: string, section: string | null, slot: string | null,
  ids: readonly string[], evidence?: ConstructSourceEvidence): boolean {
  return messageKind === 'unknown_collection_presentation' && section === 'Then' &&
    slot === 'then.collection-presentation' && ids.length === 2 &&
    [...ids].sort().join(',') === 'can.v1.ui.list,can.v1.ui.table' &&
    evidence?.authorIntent?.text === OFFICE_COLUMN_INTENT && !evidence.sourceWindow.truncated &&
    /\btext\s+row\.name\s*,\s*row\.quantity\s*,\s*row\.available\b/.test(evidence.sourceWindow.text);
}
