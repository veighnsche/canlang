#!/usr/bin/env node
/** Native facade availability; signatures remain owned by Values. */
import { rmSync, writeFileSync } from 'node:fs';

const output = new URL('../dist/native-catalog.json', import.meta.url);
const devOutput = new URL('../dist/native-dev-catalog.json', import.meta.url);
// A failed re-emission must not leave an earlier supported profile behind.
rmSync(output, { force: true });
rmSync(devOutput, { force: true });

try {
  const { CATALOG } = await import('@canlang/values');
  const { UI_CATALOG } = await import('@canlang/ui');
  if (!Array.isArray(CATALOG.entries) || !Array.isArray(UI_CATALOG.entries)) {
    throw new Error('Values and UI must supply their canonical catalog entries.');
  }
  const matches = CATALOG.entries.filter(entry => entry.kind === 'builtin' && entry.id === 'active_member');
  if (matches.length !== 1 || matches[0].js !== 'active_member' ||
      matches[0].effects !== 'state-read' || matches[0].availability !== 'external') {
    throw new Error('Values must supply exactly one external state-read active_member signature.');
  }
  const facade = await import('@canlang/cloudflare/runtime/stdlib');
  const exported = Object.getOwnPropertyDescriptor(facade, 'active_member');
  if (exported === undefined || !('value' in exported) || typeof exported.value !== 'function') {
    throw new Error('Native stdlib must export the genuine owning active_member function as own data.');
  }
  const producer = await import('../dist/runtime/native-membership.js');
  const original = Object.getOwnPropertyDescriptor(producer, 'active_member');
  if (original === undefined || !('value' in original) || exported.value !== original.value) {
    throw new Error('Native stdlib must export the genuine owning active_member function as own data.');
  }
  const catalog = {
    ...CATALOG,
    entries: CATALOG.entries.map(entry => entry === matches[0] ? { ...entry, availability: 'implemented' } : entry),
  };
  writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(devOutput, `${JSON.stringify({ values: CATALOG.entries, ui: UI_CATALOG.entries }, null, 2)}\n`);
  console.log(`native catalog ${catalog.catalog_version}: scoped active_member -> dist/native-catalog.json`);
  console.log('native construct catalog: canonical Values/UI entries -> dist/native-dev-catalog.json');
} catch (error) {
  console.error(`native catalog emit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
