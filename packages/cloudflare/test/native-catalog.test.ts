import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { expect, it } from 'vitest';
import type { CatalogEnvelope } from '@canlang/contracts/values';

// Bypass Vitest's accessor namespaces: inspect the genuine installed ESM exports.
const nativeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (url: string) => Promise<Record<string, unknown>>;
const require = createRequire(import.meta.url);

it('publishes the installed native catalog with only builtin active_member availability changed', async () => {
  const module = await nativeImport(pathToFileURL(require.resolve('@canlang/cloudflare/distribution')).href);
  const distribution = module.distribution as { readonly nativeCatalog: URL };
  expect(distribution.nativeCatalog).toBeInstanceOf(URL);
  const stdlibUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib'));
  expect(distribution.nativeCatalog.href).toBe(new URL('../native-catalog.json', stdlibUrl).href);
  const nativeCatalog: unknown = JSON.parse(await readFile(distribution.nativeCatalog, 'utf8'));
  const values = await nativeImport(pathToFileURL(require.resolve('@canlang/values')).href);
  const generic = values.CATALOG as CatalogEnvelope;
  const originals = generic.entries.filter(entry => entry.kind === 'builtin' && entry.id === 'active_member');
  expect(originals).toHaveLength(1);
  expect(originals[0]!.availability).toBe('external');
  expect(originals[0]!.effects).toBe('state-read');
  const expected = {
    ...generic,
    entries: generic.entries.map(entry => entry.kind === 'builtin' && entry.id === 'active_member'
      ? { ...entry, availability: 'implemented' } : entry),
  };
  // Complete ordered equality preserves signatures, ownership, versions, features
  // and every other entry; the generic catalog remains external and unmodified.
  expect(nativeCatalog).toEqual(expected);
  expect(originals[0]!.availability).toBe('external');
});

it('exports active_member as an own native data function identical to its emitted defining producer', async () => {
  const stdlibUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib'));
  const facade = await nativeImport(stdlibUrl.href);
  // Derived from the public installed facade, not a new private package export.
  const defining = await nativeImport(new URL('./native-membership.js', stdlibUrl).href);
  const facadeMember = Object.getOwnPropertyDescriptor(facade, 'active_member');
  const definingMember = Object.getOwnPropertyDescriptor(defining, 'active_member');
  expect(facadeMember).toBeDefined();
  expect(definingMember).toBeDefined();
  expect(Object.hasOwn(facadeMember!, 'value')).toBe(true);
  expect(Object.hasOwn(definingMember!, 'value')).toBe(true);
  expect(facadeMember!.get).toBeUndefined();
  expect(definingMember!.get).toBeUndefined();
  expect(typeof facadeMember!.value).toBe('function');
  expect(facadeMember!.value).toBe(definingMember!.value);
});
