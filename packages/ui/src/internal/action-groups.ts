/** Layout recognizes only completed, direct canonical factory roots. Nested
 * owners retain their controls. The canonical forms are opaque strings: never
 * split, rerender or execute them while aggregating an owner's groups. */
interface ActionGroup {
  readonly kind: 'primary' | 'secondary';
  readonly prefix: string;
  readonly entries: string;
  readonly suffix: string;
}

/** A canonical group is one complete div root, never a declaration's joined
 * sibling output. Quoted attributes, comments and raw text do not affect the
 * wrapper depth; nested canonical forms/dialogs remain opaque and intact. */
function tagEnd(html: string, start: number): number {
  let end = start + 1;
  let quote = '';
  for (; end < html.length; end++) {
    const char = html[end];
    if (quote !== '') { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>') break;
  }
  return end;
}

function singleDivRoot(html: string): boolean {
  let depth = 0;
  let cursor = 0;
  let raw: string | undefined;
  const lower = html.toLowerCase();
  while (cursor < html.length) {
    if (raw !== undefined) {
      const close = lower.indexOf(`</${raw}`, cursor);
      if (close < 0) return false;
      cursor = close;
      raw = undefined;
    }
    const start = html.indexOf('<', cursor);
    if (start < 0) return false;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    const end = tagEnd(html, start);
    if (end === html.length) return false;
    const tag = html.slice(start, end + 1);
    const parsed = /^<(\/)?([a-z][a-z0-9:-]*)\b/i.exec(tag);
    if (parsed !== null) {
      const name = parsed[2]!.toLowerCase();
      if (name === 'div') {
        depth += parsed[1] ? -1 : 1;
        if (depth === 0) return end + 1 === html.length;
        if (depth < 0) return false;
      } else if (!parsed[1] && ['script', 'style', 'textarea', 'title'].includes(name)) raw = name;
    }
    cursor = end + 1;
  }
  return false;
}

function actionGroup(html: string): ActionGroup | null {
  const primary = '<div class="can-primary-actions" data-can-primary-actions>';
  if (html.startsWith(primary) && html.endsWith('</div>') && singleDivRoot(html)) {
    return { kind: 'primary', prefix: primary, entries: html.slice(primary.length, -6), suffix: '</div>' };
  }
  if (!html.startsWith('<div class="can-action-menu" data-can-action-menu>')) return null;
  if (!singleDivRoot(html)) return null;
  const list = html.indexOf('<ul class="menu" aria-label="');
  const start = list < 0 ? -1 : html.indexOf('>', list);
  const suffix = '</ul></div></div>';
  if (start < 0 || !html.endsWith(suffix)) return null;
  return { kind: 'secondary', prefix: html.slice(0, start + 1), entries: html.slice(start + 1, -suffix.length), suffix };
}

export function partitionActionGroups(parts: readonly (string | null | undefined)[]): { primary: string; secondary: string; body: string } {
  const groups: Record<ActionGroup['kind'], ActionGroup[]> = { primary: [], secondary: [] };
  const body: string[] = [];
  for (const html of parts) {
    if (typeof html !== 'string') continue;
    const group = actionGroup(html);
    if (group === null) body.push(html);
    else groups[group.kind].push(group);
  }
  const aggregate = (entries: readonly ActionGroup[]) => {
    const first = entries[0];
    return first === undefined ? '' : first.prefix + entries.map(entry => entry.entries).join('') + first.suffix;
  };
  return { primary: aggregate(groups.primary), secondary: aggregate(groups.secondary), body: body.join('') };
}

/** Generated owners receive one opaque binding per standard action region. */
export function actionBindings(parts: readonly (string | null | undefined)[]): { primary: string; secondary: string } {
  const { primary, secondary } = partitionActionGroups(parts);
  return { primary, secondary };
}

/** Local hosts merge direct standard groups at their first authored position.
 * Receive individual completed child roots, never a concatenated HTML body. */
export function renderActionScope(parts: readonly (string | null | undefined)[]): string {
  const output: string[] = [];
  const owners = new Map<ActionGroup['kind'], { position: number; group: ActionGroup; entries: string[] }>();
  for (const html of parts) {
    if (typeof html !== 'string') continue;
    const group = actionGroup(html);
    if (group === null) { output.push(html); continue; }
    const owner = owners.get(group.kind);
    if (owner === undefined) {
      owners.set(group.kind, { position: output.length, group, entries: [group.entries] });
      output.push('');
    } else owner.entries.push(group.entries);
  }
  for (const { position, group, entries } of owners.values()) {
    output[position] = group.prefix + entries.join('') + group.suffix;
  }
  return output.join('');
}
