import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/** Select exact original declarations and complete owning model rules for native consumers. */
export async function originalScenarioSource(owner: string, handlerName: string, app = 'OriginalVenueCleanup',
  additional: readonly { owner: string; name: string }[] = []) {
  const requested = [{ owner, name: handlerName }, ...additional];
  const paths: string[] = [];
  const collect = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.name.endsWith('.can')) paths.push(path);
    }
  };
  await collect(join(root, 'draft'));
  type Unit = { name: string; text: string; kind: string };
  type Package = { units: Unit[]; imports: Array<{ from: string; members: Array<{ original: string; local: string }>; suffix: string }>; selected: Set<Unit>; handlers: string };
  const packages = new Map<string, Package>();
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    const matches = [...source.matchAll(/^package ([A-Za-z_][A-Za-z_0-9]*)[^\n]*\n/gm)];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!, content = source.slice(match.index! + match[0].length, matches[i + 1]?.index);
      const given = content.indexOf(' Given\n'), when = content.indexOf(' When\n');
      if (given < 0 || when < 0) continue;
      const units: Unit[] = [];
      const lines = content.slice(given + ' Given\n'.length, when).split('\n');
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j]!;
        if (!/^  \S/.test(line) || /^  #/.test(line)) continue;
        let end = j + 1;
        while (end < lines.length && (/^   /.test(lines[end]!) || lines[end] === '')) end++;
        const text = lines.slice(j, end).join('\n').trimEnd() + '\n';
        const declaration = line.match(/^  (?:export )?(?:(message|role|event|contract|capability|derive) )?([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?)/);
        if (declaration && !/^(?:fixture|policy|invariant|unique|lock)$/.test(declaration[2]!)) {
          units.push({ kind: declaration[1] ?? 'model', name: declaration[2]!, text });
        } else {
          const rule = line.match(/^  (policy|invariant|unique|lock) ([A-Za-z_][A-Za-z_0-9]*)/);
          if (rule) units.push({ kind: rule[1]!, name: rule[2]!, text });
        }
        j = end - 1;
      }
      const imports = [...content.slice(0, given).matchAll(/^ use ([A-Za-z_][A-Za-z_0-9]*) \{([^}]+)\}(.*)$/gm)].map(entry => ({
        from: entry[1]!, suffix: entry[3]!, members: entry[2]!.split(',').map(member => {
          const [original, local = original] = member.trim().split(/ +as +/);
          return { original: original!, local: local! };
        }),
      }));
      const handlers = requested.filter(handler => handler.owner === match[1]).map(handler => {
        const text = (content.match(new RegExp(`^  (?:export )?scenario ${handler.name}(?:\\(| on=)[^\n]+\n(?:   [^\n]*\n|\n)*`, 'm'))?.[0] ?? '').split(/\n   examples\b/)[0]!;
        assert.ok(new RegExp(`^  (?:export )?scenario ${handler.name}(?:\\(| on=)`).test(text), `actual original ${handler.owner}.${handler.name} was extracted`);
        return text.trimEnd() + '\n';
      }).join('');
      packages.set(match[1]!, { units, imports, selected: new Set(), handlers });
    }
  }
  assert.ok(new RegExp(`^  (?:export )?scenario ${handlerName}(?:\\(| on=)`, 'm').test(packages.get(owner)?.handlers ?? ''), 'actual original whole handler was extracted');
  const identifiers = (text: string) => new Set(text.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []);
  // Capability interfaces contribute only the exact operations/events consumed
  // by retained declarations. Keep their original header/version and member
  // lines; every retained model still contributes all its owning rules.
  const capabilityText = (packageName: string, unit: Unit) => {
    const operations = new Set<string>();
    for (const [consumerName, consumer] of packages) {
      const aliases = consumer.imports.filter(imported => imported.from === packageName)
        .flatMap(imported => imported.members.filter(member => member.original === unit.name).map(member => member.local));
      if (consumerName === packageName) aliases.push(unit.name);
      const text = (consumer.handlers + [...consumer.selected].filter(selected => selected.kind !== 'capability')
        .map(selected => selected.text).join('')).replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const alias of aliases) for (const match of text.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_][A-Za-z_0-9]*)`, 'g'))) {
        operations.add(match[1]!);
      }
    }
    assert.ok(operations.size > 0, `retained capability ${packageName}.${unit.name} needs an actual member consumer`);
    const lines = unit.text.trimEnd().split('\n');
    const members = lines.slice(1).filter(line => {
      const member = line.match(/^   (?:event )?([A-Za-z_][A-Za-z_0-9]*)[ ({]/);
      return member !== null && operations.has(member[1]!);
    });
    assert.equal(members.length, operations.size, `every consumed ${packageName}.${unit.name} member has its original declaration`);
    return [lines[0], ...members].join('\n') + '\n';
  };
  const retainedText = (name: string, pkg: Package) => pkg.handlers + [...pkg.selected]
    .map(unit => unit.kind === 'capability' ? capabilityText(name, unit) : unit.text).join('');
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, pkg] of packages) {
      const tokens = identifiers(retainedText(name, pkg));
      for (const unit of pkg.units) {
        const selectedModel = (name: string) => [...pkg.selected].some(candidate => candidate.kind === 'model' && candidate.name === name);
        const field = unit.kind === 'derive' ? unit.name.split('.') : [];
        const needed = ['policy', 'invariant', 'unique', 'lock'].includes(unit.kind) ? selectedModel(unit.name)
          : field.length === 2 ? selectedModel(field[0]!) && tokens.has(field[1]!) : tokens.has(unit.name);
        if (needed && !pkg.selected.has(unit)) { pkg.selected.add(unit); changed = true; }
      }
      for (const imported of pkg.imports) for (const member of imported.members) {
        if (!tokens.has(member.local)) continue;
        const provider = packages.get(imported.from);
        const unit = provider?.units.find(candidate => candidate.name === member.original && !['policy', 'invariant', 'unique', 'lock'].includes(candidate.kind));
        if (unit && !provider!.selected.has(unit)) { provider!.selected.add(unit); changed = true; }
      }
    }
  }
  let result = `app ${app} uses=[${[...new Set(requested.map(handler => handler.owner))].join(',')}]\n`;
  for (const [name, pkg] of packages) {
    if (pkg.selected.size === 0 && pkg.handlers === '') continue;
    const tokens = identifiers(retainedText(name, pkg));
    result += `package ${name}\n`;
    for (const imported of pkg.imports) {
      const members = imported.members.filter(member => tokens.has(member.local));
      if (members.length) result += ` use ${imported.from} {${members.map(member => member.original === member.local ? member.original : `${member.original} as ${member.local}`).join(',')}}${imported.suffix}\n`;
    }
    result += ' Given\n' + pkg.units.filter(unit => pkg.selected.has(unit)).map(unit => unit.kind === 'capability' ? capabilityText(name, unit) : unit.text).join('') + ' When\n' + pkg.handlers + ' Then\n';
  }
  return { app, source: result, handler: `${owner}.${handlerName}` };
}
