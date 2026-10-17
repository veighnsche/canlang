/** Mechanically selected owning source for the original Customer recover body.
 * No test-authored methods, grants or predicate replacements enter this source.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export async function prepareCustomerRecoverSource(directory: string) {
  const originalInputPaths = [
    'draft/apps/CanCustomer/CanCustomer.can', 'draft/shared/Employees.can',
    'draft/shared/Locations.can', 'draft/apps/CanInvoice/CanInvoice.can',
  ].map(path => join(root, path));
  const originalBytes = await Promise.all(originalInputPaths.map(path => readFile(path)));
  const [customer, employee, location, invoice] = originalBytes.map(bytes => {
    const lines = bytes.toString('utf8').split('\n');
    const many = (prefix: string, count: number) => {
      const found = lines.filter(line => line.trimStart().startsWith(prefix));
      if (found.length !== count) throw new Error(`Customer recover closure expected ${count} original ${prefix}; found ${found.length}.`);
      return found;
    };
    return { lines, many, one: (prefix: string) => many(prefix, 1)[0]! };
  });
  const header = customer!.one('export scenario recover(');
  const start = customer!.lines.indexOf(header);
  let end = start + 1;
  while (end < customer!.lines.length && (!customer!.lines[end]!.trim() || /^ {3}/.test(customer!.lines[end]!))) end++;
  const recover = customer!.lines.slice(start, end).join('\n');
  if (!recover.includes('   require customer_staff(actor,org) and trim(reason)!="" and org.kind==company') ||
      !recover.includes('    let previous=first(org.CompanyRole as grant where grant.account==account and grant.role==administrator order=grant.id)') ||
      !recover.includes('     set previous {active=true,locations=org.locations}')) {
    throw new Error('Original Customer recover guard/body changed; review its finite consumer closure.');
  }
  const source = [
    customer!.one('app CanCustomer '),
    location!.one('package rent_catalog '), ' Given',
    location!.one('export Location {'), location!.one('policy Location read='),
    location!.one('export fixture test_site='), ' When', ' Then',
    employee!.one('package employee '), employee!.one('use rent_catalog {'), ' Given',
    employee!.one('export role hr '), employee!.one('export Employee {'),
    employee!.one('export derive staff('), employee!.one('export derive can_work('),
    ...employee!.many('policy Employee read=', 3), employee!.one('invariant Employee:'),
    employee!.one('export fixture test_worker='), ' When', ' Then',
    invoice!.one('package invoice '), ' Given', invoice!.one('export role finance '), ' When', ' Then',
    customer!.one('package customer'), customer!.one('use rent_catalog {'),
    customer!.one('use employee {'), customer!.one('use invoice {finance}'), ' Given',
    customer!.one('role customer_manager '), customer!.one('export role customer_reader '), customer!.one('role billing_reader '),
    ...['Customer', 'Contact in Customer', 'CompanyRole in Customer'].map(name => customer!.one(`export ${name} {`)),
    customer!.one('export derive has_role('), customer!.one('export derive owns('), customer!.one('derive customer_staff('),
    ...customer!.many('policy Customer read=', 4), ...customer!.many('policy Contact read=', 5),
    ...customer!.many('policy CompanyRole read=', 2), customer!.one('invariant CompanyRole:'), customer!.one('unique CompanyRole '),
    ...['label_Customer_kind_company', 'label_Customer_locations', 'label_Contact', 'label_Contact_account', 'label_CompanyRole_role']
      .map(name => customer!.one(`message ${name} =`)),
    ' When', recover, ' Then', '',
  ].join('\n');
  const sourcePath = join(directory, 'CanCustomer.can');
  await writeFile(sourcePath, source);
  return { source, sourcePath, recover, originalInputPaths, originalBytes };
}
