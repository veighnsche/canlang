/** Existing emitted role arrays select one membership caller, never a fixture. */
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect, test} from 'vitest';
import {loadExampleSuite} from '../src/runner/loader.js';
import {provisionRowAccounts, resolveCaller} from '../src/fixtures/accounts.js';

const bindings = {self: 'self-binding', other: 'other-binding', imported: {}};
function moduleSource(expression: string): string {
  return `import {runInNewContext} from "node:vm";
export let reads=0;
const roles=${expression};
export function exampleFixtures(){return {fixtures:{},examples:[{
 operation:"crm.promote",dependencies:[],inputs:async()=>({}),selectors:["as"],
 rows:[{dependencies:[],values:async()=>[roles],error:"rule_failed"}]
}]};}`;
}

test('real suite loading maps the emitted canonical role array to the same row self membership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-caller-role-array-'));
  try {
    for (const [index, expression] of ['["crm.salesperson","customer.customer_reader"]',
      `runInNewContext('["crm.salesperson","customer.customer_reader"]')`].entries()) {
    const path = join(directory, `roles-${index}.mjs`);
    await writeFile(path, moduleSource(expression));
    const suite = await loadExampleSuite(pathToFileURL(path).href, bindings);
    expect(suite.rows).toHaveLength(1);
    const selection = suite.rows[0]!.caller;
    expect(selection).toEqual({kind: 'membership', roles: ['crm.salesperson', 'customer.customer_reader']});
    const accounts = provisionRowAccounts(7);
    expect(resolveCaller(selection, accounts)).toEqual({account: accounts.self, team: 'current',
      roles: ['crm.salesperson', 'customer.customer_reader'], authenticated: true});
    }
    const empty = join(directory, 'empty.mjs'); await writeFile(empty, moduleSource('[]'));
    const suite = await loadExampleSuite(pathToFileURL(empty).href, bindings);
    expect(suite.rows[0]!.caller).toEqual({kind: 'self'});
    expect(resolveCaller(suite.rows[0]!.caller, provisionRowAccounts(7)).roles).toEqual(['members']);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('role-array caller intake rejects malformed and nonrole cells without invoking accessors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-caller-role-refusals-'));
  try {
    const cases = [
      '[,"crm.salesperson"]', '[["crm.salesperson"]]', '[{}]', '[1]', '[null]', '[""]',
      '["self"]', '["other"]', '["outsider"]', '["public"]',
      'Object.assign(["crm.salesperson"],{extra:"customer.customer_reader"})',
      'Object.defineProperty([],"0",{enumerable:true,get(){reads++;return "crm.salesperson";}})',
    ];
    for (const [index, expression] of cases.entries()) {
      const path = join(directory, `invalid-${index}.mjs`), url = pathToFileURL(path).href;
      await writeFile(path, moduleSource(expression));
      await expect(loadExampleSuite(url, bindings)).rejects.toThrow(/as-cell role array/);
      const namespace = await import(url);
      expect(namespace.reads).toBe(0);
    }
  } finally {await rm(directory, {recursive: true, force: true});}
});
