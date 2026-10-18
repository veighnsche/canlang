/** Mechanical original-source closure for Purchase's return/payable consumers.
 * No test-authored operation, policy or substituted expression enters it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export async function preparePurchaseSource(directory: string) {
  const originalInputPaths = [
    'draft/apps/CanPurchase/CanPurchase.can', 'draft/shared/Employees.can',
    'draft/shared/Locations.can', 'draft/shared/Suppliers.can', 'draft/apps/CanStock/CanStock.can',
  ].map(path => join(root, path));
  const originalBytes = await Promise.all(originalInputPaths.map(path => readFile(path)));
  const [purchase, employee, location, supplier, stock] = originalBytes.map(bytes => {
    const lines = bytes.toString('utf8').split('\n');
    const one = (prefix: string) => {
      const found = lines.filter(line => line.trimStart().startsWith(prefix));
      if (found.length !== 1) throw new Error(`Purchase closure expected one original ${prefix}; found ${found.length}.`);
      return found[0]!;
    };
    const section = (start: string, end: string) => lines.slice(lines.indexOf(one(start)), lines.indexOf(one(end))).join('\n');
    const operation = (name: string) => {
      const start = lines.indexOf(one(`scenario ${name}(`));
      let end = start + 1;
      while (end < lines.length && (!lines[end]!.trim() || /^ {3}/.test(lines[end]!))) end++;
      return lines.slice(start, end).join('\n');
    };
    return { lines, one, section, operation };
  });
  const recordPayable = purchase!.operation('record_payable'), returnGoods = purchase!.operation('return_goods');
  const source = [
    purchase!.one('app CanPurchase '), location!.one('package rent_catalog '), ' Given',
    location!.one('export Location {'), location!.one('policy Location read='), location!.one('export fixture test_site='), ' When', ' Then',
    employee!.section('package employee ', 'When'), ' When', ' Then',
    supplier!.section('package supplier ', 'When'), ' When', ' Then',
    stock!.one('package stock'), stock!.one('use std {OperationOutcome}'), ' Given',
    ...stock!.lines.filter(line => line.trimStart().startsWith('message label_StockReceipt_')),
    stock!.one('export contract StockReceipt {'), stock!.section('export capability StockV1 ', '## StockV1.post '),
    ' When', ' Then', purchase!.section('package purchase ', 'When'),
    ' When', returnGoods, recordPayable, ' Then', '',
  ].join('\n');
  const sourcePath = join(directory, 'CanPurchase.can');
  await writeFile(sourcePath, source);
  return { source, sourcePath, recordPayable, returnGoods, originalInputPaths, originalBytes };
}
