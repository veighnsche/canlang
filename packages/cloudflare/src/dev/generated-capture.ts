/** Exact compiler-owned saved input discovery for the local preview. */
import { spawn } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotInputs, type ConsumedInput } from '../generation/journal.js';

export interface GeneratedClosure {
  root: string;
  files: Array<{ path: string; sha256: string }>;
  compilerSources: string[];
}

export async function discoverGeneratedClosure(compiler: string, root: string, app: string): Promise<GeneratedClosure> {
  const project = dirname(app);
  const stdout = await new Promise<string>((done, reject) => {
    const child = spawn(compiler, ['gen'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, CAN_GENERATION_COMPILER_ONLY: '1' } });
    let output = '', size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else output += chunk.toString();
    });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? done(output) : reject(new Error('Saved generation discovery failed')); });
    child.stdin.end(JSON.stringify({ version: 1, request_id: `dev-capture-${randomUUID()}`, operation: 'status', root: project, files: [app] }));
  });
  const report = JSON.parse(stdout) as { ok?: boolean; units?: Array<{ id?: string; association?: string; current_files?: Array<{path:string;sha256:string}>; compiler_sources?: string[] }> };
  if (report.ok !== true || !Array.isArray(report.units)) throw new Error('Invalid saved generation discovery');
  const files = new Map<string, string>(), sources = new Set<string>();
  for (const unit of report.units) {
    if (unit.association === 'orphaned' || unit.id == null) continue;
    if (!Array.isArray(unit.current_files) || !Array.isArray(unit.compiler_sources)) throw new Error('Compiler lacks saved generation capture handoff');
    for (const input of unit.current_files) {
      const path = relative(root, resolve(project, input.path)).split(sep).join('/');
      if (!path || path.startsWith('../') || !/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('Invalid saved generation input');
      if (resolve(root, path) === app) continue;
      const prior = files.get(path);
      if (prior !== undefined && prior !== input.sha256) throw new Error('Conflicting saved generation inputs');
      files.set(path, input.sha256);
    }
    for (const source of unit.compiler_sources) {
      const absolute = resolve(project, source);
      sources.add(absolute === app ? relative(root, app).split(sep).join('/') : relative(project, absolute).split(sep).join('/'));
    }
  }
  return { root: project, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({path, sha256})), compilerSources: [...sources].sort() };
}

export async function snapshotGeneratedClosure(root: string, appPath: string, closure: GeneratedClosure): Promise<ConsumedInput[]> {
  const paths = [...new Set([relative(root, appPath).split(sep).join('/'), ...closure.files.map(file => file.path)])];
  const captured = await snapshotInputs(closure.root, `dev-capture:${randomUUID()}`, paths.map(path => relative(closure.root, resolve(root, path)).split(sep).join('/')));
  const snapshot = captured.map(input => ({ ...input, path: relative(root, resolve(closure.root, input.path)).split(sep).join('/') }));
  const byPath = new Map(snapshot.map(input => [input.path, input]));
  for (const input of closure.files) if (byPath.get(input.path)?.sha256 !== input.sha256) throw new Error('Saved generation inputs changed during capture');
  return snapshot;
}
