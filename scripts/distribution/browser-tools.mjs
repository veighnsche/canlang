/** Package the separately installed browser tooling without touching core bytes. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function packBrowserDevelopmentTools({ checkout, out, version }) {
  mkdirSync(join(out, 'browser-development'), { recursive: true });
  copyFileSync(join(checkout, 'scripts/install-browser-tools.sh'), join(out, 'install-browser-tools.sh'));
  for (const name of ['package.json', 'bun.lock']) {
    copyFileSync(join(checkout, 'scripts/distribution/browser', name), join(out, 'browser-development', name));
  }
  const archive = join(out, `can-browser-development-tools-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', out, 'install-browser-tools.sh', 'browser-development/package.json', 'browser-development/bun.lock'], { env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' } });
  const checksum = `${archive}.sha256`;
  writeFileSync(checksum, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${basename(archive)}\n`);
  return [archive, checksum];
}
