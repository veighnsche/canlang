import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Lexical discovery for test intake, never a replacement for compiler closure/admission. */
export interface DraftPage {
  route: string;
  title: string | null;
  packageName: string;
  source: string;
  line: number;
  guards: string[];
  emptyMessages: string[];
  requiredStates: string[];
}
export interface DraftOperation { name: string; kind: string; source: string; line: number; exampleRows: number }
export interface DraftSelection { name: string; packages: string[] }
export interface DraftSource {
  source: string;
  appDir: string;
  selections: DraftSelection[];
  packages: string[];
  imports: { owner: string; from: string; deployed: boolean }[];
  pages: DraftPage[];
  operations: DraftOperation[];
  exampleRows: number;
  requirements: { id: string; text: string }[];
}

function quoted(line: string, key: string): string | null {
  const raw = new RegExp(`\\b${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(line)?.[1];
  return raw === undefined ? null : JSON.parse(raw) as string;
}

/** Companion candidates, not an exhaustive interpretation of prose requirements. */
function companionRequirements(source: string, markdown: string): DraftSource["requirements"] {
  const candidates = new Map<string, { id: string; text: string }>();
  const app = path.basename(source, ".can");
  const add = (text: string): void => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || candidates.has(normalized)) return;
    const label = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 6).join("-");
    // Text identity survives line movement and wrapping; changed outcomes need new coverage.
    const identity = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    candidates.set(normalized, { id: `requirement:${app}:${label}:${identity}`, text: normalized });
  };
  const lines = markdown.split(/\r?\n/);
  let inJourneys = false;
  for (const line of lines) {
    if (/^(?:#{1,6}\s+)?Frontend (?:acceptance journeys|completion additionally requires these journeys):?\s*$/i.test(line)) {
      inJourneys = true;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) inJourneys = false;
    if (inJourneys && /^-\s+/.test(line)) add(line.replace(/^-\s+/, ""));
    const inline = /^(?:Frontend journey:\s*|Front-end acceptance also requires\s+)(.+)$/i.exec(line);
    if (inline) add(inline[1]!);
  }
  const hasExplicitJourneys = candidates.size > 0;
  let heading = "";
  let requiredTable = false;
  let firstTableRow = false;
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    const title = /^#{1,6}\s+(.+)$/.exec(text);
    if (title) { heading = title[1]!; requiredTable = false; continue; }
    if (text.startsWith("|")) {
      if (requiredTable) {
        firstTableRow = true;
        for (const row of text.split(/\r?\n/)) {
          if (firstTableRow) { firstTableRow = false; continue; }
          if (/^\s*\|[\s:|-]+\|\s*$/.test(row)) continue;
          const cells = row.replace(/^\s*\||\|\s*$/g, "").split("|").map(cell => cell.trim());
          if (cells.length >= 2) add(`${cells[0]} → ${cells.slice(1).join("; ")}`);
        }
      }
      requiredTable = false;
      continue;
    }
    // PromptLab and media companions declare concrete acceptance tables/cases
    // outside the standard frontend-journey heading. Keep their exact outcomes.
    requiredTable = /\b(?:required (?:runtime outcomes|shared-runtime\/provider acceptance cases|runtime acceptance checks|binding\/runtime cases)|finite owner fixtures)\b/i.test(text);
    if (/\b(?:required runtime acceptance checks|additional required binding\/runtime cases)\b/i.test(text)) add(text);
    // For narrative companions lacking explicit journeys, retain actual workflow
    // paragraphs. This lexical selection deliberately makes no completeness claim.
    if (!hasExplicitJourneys && /\b(?:workflows?|generate|publish|publication|review|approval|intake|replies|answers|resolution|research and coverage|evidence and decisions|recovery|revocation|resource and file guarantees)\b/i.test(heading)) {
      if (!/\b(?:verification|witnesses|composition|shared mechanics|scope)\b/i.test(heading)) add(text);
    }
  }
  return [...candidates.values()];
}

export function readDraftSource(source: string, companion = source.replace(/\.can$/, ".md")): DraftSource {
  const lines = readFileSync(source, "utf8").split(/\r?\n/);
  const result: DraftSource = { source, appDir: path.dirname(source), selections: [], packages: [], imports: [], pages: [], operations: [], exampleRows: 0, requirements: [] };
  let packageName = "";
  let operation: DraftOperation | undefined;
  let operationIndent = -1;
  let page: DraftPage | undefined;
  let pageIndent = -1;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimStart();
    const indent = raw.length - line.length;
    if (!line || line.startsWith("#")) continue;
    let match: RegExpExecArray | null;
    if (operation && indent <= operationIndent) operation = undefined;
    if (page && indent <= pageIndent) page = undefined;
    if ((match = /^app\s+(\w+)\b(.*)/.exec(line))) {
      const name = match[1]!;
      result.selections.push({ name, packages: /\buses\s*=\s*\[([^\]]*)\]/.exec(match[2]!)?.[1]?.split(",").map(value => value.trim()).filter(Boolean) ?? [] });
      if (!packageName) packageName = name;
    }
    if ((match = /^package\s+(\w+)/.exec(line))) { packageName = match[1]!; result.packages.push(packageName); }
    if ((match = /^(?:export\s+)?use\s+(\w+)/.exec(line))) result.imports.push({ owner: packageName, from: match[1]!, deployed: /\bfrom\s*=/.test(line) });
    if ((match = /^(?:export\s+)?(scenario|query|handler|crud)\s+([\w.]+)/.exec(line))) {
      const kind = match[1] === "scenario" && /\bon\s*=/.test(line) ? "handler" : match[1]!;
      const base = `${packageName}.${match[2]}`;
      operationIndent = indent;
      operation = { name: base, kind, source, line: index + 1, exampleRows: 0 };
      if (kind === "crud") {
        for (const method of ["create", "update", "delete"]) {
          if (!new RegExp(`\\b${method}\\s*=\\s*none\\b`).test(line)) result.operations.push({ ...operation, name: `${base}.${method}`, kind: "crud" });
        }
      } else result.operations.push(operation);
    }
    if (/^examples\b/.test(line)) {
      let rows = 0;
      let header = false;
      for (let child = index + 1; child < lines.length; child++) {
        const text = lines[child]!.trimStart();
        if (!text || text.startsWith("#")) continue;
        if (lines[child]!.length - text.length <= indent) break;
        if (!header) { header = true; continue; }
        rows++;
      }
      result.exampleRows += rows;
      if (operation?.kind === "crud") {
        const method = /^examples\s+(create|update|delete)\b/.exec(line)?.[1];
        const owner = result.operations.find(value => value.name === `${operation!.name}.${method}`);
        if (owner) owner.exampleRows += rows;
      } else if (operation) operation.exampleRows += rows;
    }
    if ((match = /^page\s+(\/\S*|\/)(?:\s|$)/.exec(line))) {
      page = { route: match[1]!, title: quoted(line, "title"), packageName, source, line: index + 1, guards: [], emptyMessages: [], requiredStates: ["initial"] };
      pageIndent = indent;
      result.pages.push(page);
    } else if (page) {
      if (indent === pageIndent + 1 && line.startsWith("require ")) page.guards.push(line.slice(8));
      const empty = quoted(line, "empty");
      if (empty !== null) page.emptyMessages.push(empty);
      // Canonical collections await their query during server rendering. The
      // collection token declares empty/populated output, not an inline async
      // loading/failure UI. Explicit app recovery requirements stay in the
      // companion inventory; form pending/validation remains separate below.
      if (/^(?:list|table|query|cards|gallery)\b/.test(line)) page.requiredStates.push("empty", "populated");
      if (/^(?:form|edit|delete)\b/.test(line)) page.requiredStates.push("validation", "pending", "success");
      // Lexical intake follows authored bindings; caption prose cannot add states.
      const priority = /^(primary|secondary)\b/.exec(line)?.[1];
      const attributes = line.replace(/"(?:[^"\\]|\\.)*"/g, "");
      if (priority && /\b(?:action\s*=|submit\s*=\s*true\b)/.test(attributes)) {
        page.requiredStates.push("validation", "pending", "success");
      }
      if (priority === "secondary" && /\b(?:action|submit|opens|target)\s*=/.test(attributes)) {
        page.requiredStates.push("menu-open");
      }
      if (priority && /\bopens\s*=/.test(attributes)) page.requiredStates.push("dialog-open");
      if (/^(?:modal|drawer)\b/.test(line)) page.requiredStates.push("dialog-open");
      if (/^(?:collapse|history)\b/.test(line)) page.requiredStates.push("expanded");
    }
  }
  for (const entry of result.pages) {
    if (entry.guards.length) entry.requiredStates.push("denied");
    entry.requiredStates = [...new Set(entry.requiredStates)];
  }
  let requirements: string;
  try { requirements = readFileSync(companion, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return result; }
  result.requirements = companionRequirements(source, requirements);
  return result;
}

export function discoverDraftSources(root: string): DraftSource[] {
  const directory = path.join(root, "draft", "apps");
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    readdirSync(path.join(directory, entry.name), { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith(".can"))
      .sort((a, b) => a.name.localeCompare(b.name)).map(file => readDraftSource(path.join(directory, entry.name, file.name))));
}

/** Local package candidates; deployment imports are resources, not source-file imports. */
export function selectedInventory(root: string, owner: DraftSource, selection: DraftSelection, replacedSource = owner.source): { pages: DraftPage[]; operations: DraftOperation[]; missingPackages: string[] } {
  // Acceptance may supply a frozen source overlay. Keep authored companion
  // requirements, but derive routes/operations from the actual candidate bytes.
  const all = discoverDraftSources(root).filter(source => path.resolve(source.source) !== path.resolve(replacedSource));
  all.push(owner);
  const shared = path.join(root, "draft", "shared");
  all.push(...readdirSync(shared, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith(".can"))
    .map(file => readDraftSource(path.join(shared, file.name))));
  const selected = new Set(selection.packages.length ? selection.packages : owner.packages.length ? owner.packages : [selection.name]);
  // Explicit app composition admits pages. Symbol imports are dependencies;
  // importing Location must not expose all of the location owner's pages.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const source of all) for (const app of source.selections) if (selected.has(app.name)) {
      for (const member of app.packages) if (!selected.has(member)) { selected.add(member); expanded = true; }
    }
  }
  const wanted = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of all) for (const dependency of source.imports) {
      // std is the compiler-known provider (resolve.rs), not a local source
      // owner. Its member validity and deployment slots still need compilation.
      if (wanted.has(dependency.owner) && !dependency.deployed && dependency.from !== "std" && !wanted.has(dependency.from)) { wanted.add(dependency.from); changed = true; }
    }
  }
  return {
    pages: all.flatMap(source => source.pages).filter(page => selected.has(page.packageName)),
    operations: all.flatMap(source => source.operations).filter(operation => selected.has(operation.name.split(".")[0]!)),
    missingPackages: [...wanted].filter(name => !all.some(source => source.packages.includes(name) || source.selections.some(app => app.name === name))),
  };
}
