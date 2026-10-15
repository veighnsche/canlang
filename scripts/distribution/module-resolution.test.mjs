import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'can-playwright-resolution-'));
  const installed = join(root, 'installed'), app = join(root, 'application');
  await mkdir(join(installed, 'libexec'), { recursive: true }); await mkdir(app);
  await writeFile(join(installed, 'package.json'), '{"type":"module"}');
  const hook = join(installed, 'libexec/module-resolution.mjs');
  await copyFile(new URL('./module-resolution.mjs', import.meta.url), hook);
  try { await run({ root, installed, app, hook }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function packageFixture(root, name, manifest, files) {
  const path = join(root, 'node_modules', name); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, type: 'module', ...manifest }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(path, name), source);
}

function execute(app, hook, source) {
  return execFileSync(process.execPath, ['--import', hook, '--input-type=module', '-e', source], { cwd: app, encoding: 'utf8', env: { ...process.env, CAN_BROWSER_TOOLS_ROOT: undefined } }).trim();
}

test('bundled Playwright resolution preserves ESM/CJS conditions and only admitted package names', async () => {
  await fixture(async ({ installed, app, hook }) => {
    for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'unrelated']) {
      await packageFixture(installed, name, { exports: { '.': { import: './index.js', require: './index.cjs' }, './reporter': './index.js' } },
        { 'index.js': 'export const marker="import";', 'index.cjs': 'exports.marker="require";' });
    }
    const result = JSON.parse(execute(app, hook, `
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url), result=[];
      for(const name of ['@playwright/test','playwright','playwright-core']) {
        result.push((await import(name)).marker,require(name).marker,(await import(name+'/reporter')).marker);
      }
      try{await import('unrelated')}catch(error){result.push(error.code)}
      console.log(JSON.stringify(result));`));
    assert.deepEqual(result, [...Array(3)].flatMap(() => ['import', 'require', 'import']).concat('ERR_MODULE_NOT_FOUND'));
  });
});

test('application packages win and broken exports or missing local files do not fall back', async () => {
  await fixture(async ({ installed, app, hook }) => {
    await packageFixture(installed, '@playwright/test', { exports: './index.js' }, { 'index.js': 'export const marker="bundled";' });
    await packageFixture(app, '@playwright/test', { exports: './index.js' }, { 'index.js': 'export const marker="local";' });
    assert.equal(execute(app, hook, 'console.log((await import("@playwright/test")).marker)'), 'local');
    await writeFile(join(app, 'node_modules/@playwright/test/package.json'), JSON.stringify({ name: '@playwright/test', type: 'module', exports: { './other': './index.js' } }));
    assert.equal(execute(app, hook, 'try{await import("@playwright/test")}catch(error){console.log(error.code)}'), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    await writeFile(join(app, 'node_modules/@playwright/test/package.json'), JSON.stringify({ name: '@playwright/test', type: 'module', main: './missing.js' }));
    const errors = JSON.parse(execute(app, hook, `import {createRequire} from 'node:module';const result=[];
      try{await import('@playwright/test/missing')}catch(error){result.push(error.code)}
      try{createRequire(import.meta.url)('@playwright/test/missing')}catch(error){result.push(error.code)}
      console.log(JSON.stringify(result));`));
    assert.deepEqual(errors, ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
    await rm(join(app, 'node_modules/@playwright/test'), { recursive: true });
    await symlink(join(app, 'missing-workspace'), join(app, 'node_modules/@playwright/test'));
    assert.equal(execute(app, hook, 'try{await import("@playwright/test")}catch(error){console.log(error.code)}'), 'ERR_MODULE_NOT_FOUND');
  });
});

const development = process.env.CAN_BROWSER_TOOLS_ROOT;
const distribution = resolve(process.env.CAN_INSTALL_TEST_ROOT ?? fileURLToPath(new URL('../../output/install/can', import.meta.url)));
test('installed Playwright CLI loads external ESM config/tests and starts the separate development Chromium',
  { skip: !development || !existsSync(join(development, 'node_modules/@playwright/test/cli.js')) || !existsSync(join(distribution, 'libexec/node')) }, async () => {
    await fixture(async ({ installed, app, hook }) => {
      await writeFile(join(app, 'playwright.config.mjs'), `import {defineConfig} from '@playwright/test';
        export default defineConfig({testDir:'.',testMatch:'probe.spec.mjs',workers:1,use:{headless:true}});`);
      await writeFile(join(app, 'probe.spec.mjs'), `import {test,expect} from '@playwright/test';
        import {chromium} from 'playwright';import {chromium as core} from 'playwright-core';
        import {createRequire} from 'node:module';
        test('external ESM and CJS resolve the shipped runner',async({page})=>{
          expect(chromium).toBe(core);expect(createRequire(import.meta.url)('@playwright/test').expect).toBe(expect);
          await page.setContent('<title>Bundled Chromium</title>');await expect(page).toHaveTitle('Bundled Chromium');
        });`);
      const output = execFileSync(join(distribution, 'libexec/node'), ['--import', hook,
        join(development, 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.mjs', '--reporter=line'],
      { cwd: app, encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1', PLAYWRIGHT_BROWSERS_PATH: join(development, 'browsers') } });
      assert.match(output, /1 passed/);
      assert.equal(existsSync(join(app, 'node_modules')), false);
    });
  });
