import path from 'node:path';

export const PROFILES = ['values', 'state', 'stdlib', 'identity', 'ui', 'interfaces', 'work', 'cloudflare', 'testkit', 'workspace'];
export const NATIVE_PROFILES = ['cloudflare', 'workspace'];
export const NATIVE_TOOLCHAIN = '1.99.0';
export const NATIVE_CRATE = 'packages/cloudflare/preparation';
export const PLAN_VERSION = 2;

export function nativeTargetDir(runnerTemp, profile) {
  return path.join(runnerTemp, 'ts-gate-native', profile);
}
export function nativeBinPath(targetDir, platform = process.platform) {
  return path.join(targetDir, 'debug', platform === 'win32' ? 'can-preparation.exe' : 'can-preparation');
}
export function nativePrerequisiteArgv(cwd) {
  return [
    ['rustup', 'toolchain', 'install', NATIVE_TOOLCHAIN, '--profile', 'minimal'],
    ['rustc', `+${NATIVE_TOOLCHAIN}`, '--version'],
    ['cargo', `+${NATIVE_TOOLCHAIN}`, '--version'],
    ['cargo', `+${NATIVE_TOOLCHAIN}`, 'build', '--locked', '--bin', 'can-preparation', '--manifest-path', path.join(cwd, NATIVE_CRATE, 'Cargo.toml')],
  ];
}
export function buildPrerequisiteArgv(profile) {
  if (!PROFILES.includes(profile)) throw new Error('Invalid gate profile');
  return ['bun', 'run', 'build', ...(['cloudflare', 'testkit', 'workspace'].includes(profile) ? [] : [`--filter=@canlang/${profile}`])];
}

/** Required, ordered command contract. Test identity is explicit, never inferred from argv. */
export function gatePlan(profile, cwd, { runnerTemp, platform = process.platform } = {}) {
  if (!PROFILES.includes(profile) || !path.isAbsolute(cwd)) throw new Error('Invalid gate profile or source directory');
  const plan = [];
  const add = (id, phase, argv, options = {}) => plan.push({ id, phase, argv, cwd, isTest: false, env: null, ...options });
  add('revision', 'preflight', ['git', 'rev-parse', 'HEAD']);
  add('node-version', 'preflight', ['node', '--version']);
  add('bun-version', 'preflight', ['bun', '--version']);
  add('install', 'install', ['bun', 'install', '--frozen-lockfile']);
  add('build', 'build', buildPrerequisiteArgv(profile));
  let nativeBin = null;
  if (NATIVE_PROFILES.includes(profile)) {
    if (!runnerTemp || !path.isAbsolute(runnerTemp)) throw new Error('Native gate requires an absolute runner temporary directory');
    const targetDir = nativeTargetDir(runnerTemp, profile);
    nativeBin = nativeBinPath(targetDir, platform);
    const [install, rustc, cargo, build] = nativePrerequisiteArgv(cwd);
    add('native-install', 'native', install, { timeoutMs: 900000 });
    add('rustc-version', 'native', rustc);
    add('cargo-version', 'native', cargo);
    add('native-build', 'native', build, { timeoutMs: 900000, env: { CARGO_TARGET_DIR: targetDir } });
  }
  // Cold runners must produce the same compiler/catalog/browser inputs used
  // by their real consumers; build phases fail closed before those tests.
  if (profile === 'values' || NATIVE_PROFILES.includes(profile)) {
    add('catalog', 'build', ['bun', 'run', 'catalog']);
  }
  if (NATIVE_PROFILES.includes(profile)) {
    add('compiler-build', 'build', ['bun', 'run', 'build:compiler'], { timeoutMs: 900000 });
    add('chromium-install', 'build', ['bunx', 'playwright', 'install', '--with-deps', 'chromium'], { timeoutMs: 900000 });
  }
  const testOptions = { isTest: true, env: nativeBin ? { CAN_PREPARATION_BIN: nativeBin } : null };
  if (profile === 'workspace') {
    add('boundaries', 'gate', ['bun', 'run', 'check:boundaries']);
    add('boundary-tests', 'gate', ['node', '--test', 'scripts/check-package-boundaries.test.mjs'], testOptions);
    add('typecheck', 'gate', ['bun', 'run', 'typecheck']);
    add('tests', 'gate', ['bunx', 'vitest', 'run'], { ...testOptions, timeoutMs: 900000 });
  } else {
    const packageCwd = path.join(cwd, 'packages', profile);
    add('typecheck', 'gate', ['bun', 'run', 'typecheck'], { cwd: packageCwd });
    if (profile === 'cloudflare' || profile === 'testkit') {
      add('tests', 'gate', ['bunx', 'vitest', 'run', `packages/${profile}/test`], testOptions);
    } else {
      add('tests', 'gate', ['bun', 'run', 'test'], { ...testOptions, cwd: packageCwd });
    }
    if (profile === 'cloudflare') add('runtime-tests', 'gate', ['node', '--test', 'packages/cloudflare/dist/**/*.test.js'], testOptions);
  }
  add('clean-tree', 'final', ['git', 'diff', '--exit-code', 'HEAD']);
  return plan;
}

export function validToolVersion(tool, text) {
  if (tool === 'node') return /^v24\.\d+\.\d+$/.test(text);
  if (tool === 'bun') return text === '1.4.2';
  if (tool === 'rustc' || tool === 'cargo') return new RegExp(`^${tool} 1\\.99\\.0(?:\\s|$)`).test(text);
  return false;
}

export function testCounts(text) {
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  const summaries = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)];
  if (summaries.length) {
    const summary = summaries.at(-1)[1];
    const count = name => Number(summary.match(new RegExp('(\\d+)\\s+' + name))?.[1] ?? 0);
    const total = summary.match(/\((\d+)\)/)?.[1];
    const pass = count('passed'), fail = count('failed'), skipped = count('skipped');
    return { tests: total === undefined ? pass + fail + skipped : Number(total), pass, fail, skipped };
  }
  const get = name => {
    const matches = [...text.matchAll(new RegExp('(?:#|ℹ)\\s*' + name + '\\s+(\\d+)', 'g'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), skipped: get('skipped') };
}
export function executedTests(counts) {
  return ['tests', 'pass', 'fail', 'skipped'].every(key => Number.isInteger(counts[key]) && counts[key] >= 0) &&
    counts.tests > 0 && counts.pass > 0 && counts.fail === 0 && counts.skipped < counts.tests &&
    counts.pass + counts.skipped <= counts.tests;
}
