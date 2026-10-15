/** Exact selected source closure for the original CRM promotion native consumer. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const unitId = '17a4aadd-c628-4ee6-9385-7b3385353862';

export async function prepareCrmPromotionSource(directory: string): Promise<{
  source: string;
  sourcePath: string;
  originalInputPaths: readonly string[];
}> {
  const paths = [
    'draft/apps/CanCRM/CanCRM.can', 'draft/shared/Employees.can',
    'draft/apps/CanCustomer/CanCustomer.can', 'draft/shared/Locations.can',
    'draft/apps/CanInvoice/CanInvoice.can',
  ].map(path => join(root, path));
  const texts = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  const [crm, employee, customer, location, invoice] = texts.map(text => {
    const lines = text.split('\n');
    const many = (prefix: string, count: number): string[] => {
      const selected = lines.filter(line => line.trimStart().startsWith(prefix));
      if (selected.length !== count) throw new Error(`CRM promotion source expected ${count} original occurrences of ${prefix}; found ${selected.length}.`);
      return selected;
    };
    return { lines, one: (prefix: string) => many(prefix, 1)[0]!, many };
  });
  // Preserve every authored statement and inline example through the next
  // owning declaration/comment; do not rebuild the original guard or body.
  const header = crm!.one('export scenario promote_research(');
  const start = crm!.lines.indexOf(header);
  let end = start + 1;
  while (end < crm!.lines.length && (!crm!.lines[end]!.trim() || /^ {3}/.test(crm!.lines[end]!))) end++;
  const promotion = crm!.lines.slice(start, end).join('\n');
  if (!promotion.includes('   examples seed=[test_worker]') ||
      !promotion.includes('   examples seed=[test_worker,research_intake]')) {
    throw new Error('CRM promotion source lost its original inline examples.');
  }
  const source = [
    'app CanCRM uses=[crm,customer,employee,rent_catalog,invoice]',
    location!.one('package rent_catalog '), ' Given',
    location!.one('export Location {'), location!.one('policy Location read='),
    location!.one('export fixture test_site='), ' When', ' Then',
    employee!.one('package employee '), ' use rent_catalog {Location,test_site}', ' Given',
    employee!.one('export role hr '), employee!.one('export Employee {'),
    employee!.one('export derive staff('), employee!.one('export derive can_work('),
    ...employee!.many('policy Employee read=', 3), employee!.one('invariant Employee:'),
    employee!.one('export fixture test_worker='), ' When', ' Then',
    invoice!.one('package invoice '), ' Given', invoice!.one('export role finance '), ' When', ' Then',
    customer!.one('package customer'), ' use rent_catalog {Location,test_site}',
    ' use employee {can_work}', ' use invoice {finance}', ' Given',
    customer!.one('role customer_manager '), customer!.one('export role customer_reader '), customer!.one('role billing_reader '),
    ...['Customer', 'Contact in Customer', 'CompanyRole in Customer'].map(name => customer!.one(`export ${name} {`)),
    customer!.one('export derive has_role('), customer!.one('export derive owns('), customer!.one('derive customer_staff('),
    ...customer!.many('policy Customer read=', 4), ...customer!.many('policy Contact read=', 5),
    ...customer!.many('policy CompanyRole read=', 2), customer!.one('invariant CompanyRole:'), customer!.one('unique CompanyRole '),
    customer!.one('export fixture test_company='), customer!.one('export fixture test_contact='),
    ...['label_Customer_kind_company', 'label_Customer_locations', 'label_Contact', 'label_Contact_account', 'label_CompanyRole_role']
      .map(name => customer!.one(`message ${name} =`)), ' When', ' Then',
    crm!.one('package crm '), ' use customer {Customer,Contact,test_company,test_contact,customer_reader}',
    ' use employee {can_work,test_worker}', ' use rent_catalog {Location,test_site}', ' Given',
    crm!.one('trait sales_seats '), crm!.one('export role salesperson '), crm!.one('export Deal {'),
    crm!.one('export contract ResearchLead {'), crm!.one('ResearchIntake {'),
    crm!.one('policy ResearchIntake read='), crm!.one('lock ResearchIntake '),
    crm!.one('policy Deal read='), crm!.one('invariant Deal:'),
    crm!.one('fixture prospect='), crm!.one('fixture research_intake='),
    crm!.one('message label_Deal_stage ='), crm!.one('message label_Deal_outcome_reference ='),
    ' When', promotion, ' Then', '',
  ].join('\n');
  const sourcePath = join(directory, 'CanCRM.can');
  const originalUnit = join(root, 'draft/apps/CanCRM/can.generated', unitId);
  const fixtureUnit = join(directory, 'can.generated', unitId);
  await mkdir(fixtureUnit, { recursive: true });
  const unitFiles = ['unit.json', 'contributions.can', 'server.js'];
  await Promise.all(unitFiles.map(name => copyFile(join(originalUnit, name), join(fixtureUnit, name))));
  await writeFile(sourcePath, source);
  return { source, sourcePath, originalInputPaths: [...paths, ...unitFiles.map(name => join(originalUnit, name))] };
}
