/** Original Partner introduction page and its complete capture action dependencies. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCrmPromotionSource } from './crm-promotion-source.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export async function preparePartnerShareSource(directory: string) {
  const dependencyDirectory = join(directory, 'crm-dependencies');
  await mkdir(dependencyDirectory, { recursive: true });
  const dependencies = await prepareCrmPromotionSource(dependencyDirectory);
  const affiliatePath = join(root, 'draft/apps/CanAffiliate/CanAffiliate.can');
  const referPath = join(root, 'draft/apps/CanRefer/CanRefer.can');
  const customerPath = join(root, 'draft/apps/CanCustomer/CanCustomer.can');
  const [affiliate, refer, customer] = await Promise.all(([affiliatePath, referPath, customerPath] as const).map(path => readFile(path, 'utf8')));
  function owner(text: string) {
    const lines = text.split('\n');
    const many = (prefix: string, expected: number) => {
      const found = lines.filter(line => line.trimStart().startsWith(prefix));
      if (found.length !== expected) throw new Error(`Partner page closure expected ${expected} occurrences of ${prefix}; got ${found.length}.`);
      return found;
    };
    return { lines, many, one: (prefix: string) => many(prefix, 1)[0]! };
  }
  const a = owner(affiliate!), r = owner(refer!), c = owner(customer!);
  const base = dependencies.source.split('\n');
  const crmStart = base.findIndex(line => line.startsWith('package crm '));
  if (crmStart < 0) throw new Error('Original CRM dependency package boundary is missing.');
  const dependencyPackages = base.slice(1, crmStart).join('\n').replace(c.one('export fixture test_contact='),
    `${c.one('export fixture test_contact=')}\n${c.one('export fixture test_admin=')}`);
  const attributionStart = r.lines.indexOf('package sales_attribution');
  const attribution = owner(r.lines.slice(attributionStart).join('\n'));
  const captureHeader = attribution.one('export scenario capture(');
  const captureStart = attribution.lines.indexOf(captureHeader);
  let captureEnd = captureStart + 1;
  while (captureEnd < attribution.lines.length && (!attribution.lines[captureEnd]!.trim() || /^ {3}/.test(attribution.lines[captureEnd]!))) captureEnd++;
  const capture = attribution.lines.slice(captureStart, captureEnd).join('\n');
  if (!capture.includes('if advocate!=null') || !capture.includes('require partner!=null') || !capture.includes('examples seed=[test_contact,test_admin]')) {
    throw new Error('Original capture nullable branches/examples were not retained.');
  }
  const pageHeader = a.one('page /partners/share/{Partner.id}');
  const page = a.lines.slice(a.lines.indexOf(pageHeader)).join('\n').trimEnd();
  if (!page.includes('require row.active') || !page.includes('action=capture arguments={partner=row} fields=customer')) {
    throw new Error('Original Partner page guard/action was not retained.');
  }
  const source = [
    a.one('app CanAffiliate '), dependencyPackages,
    'package refer', ' use rent_catalog {Location,test_site}', ' use employee {can_work}', ' Given',
    ...r.many('message ', r.lines.filter(line => line.trimStart().startsWith('message ')).length),
    r.one('role program_manager '), r.one('role finance '),
    r.one('export Program {'), r.one('export Advocate in Program {'), r.one('Credit in Advocate {'),
    r.one('lock Advocate '), r.one('lock Credit '),
    ...r.many('policy Program read=', 2), ...r.many('policy Advocate read=', 3), ...r.many('policy Credit read=', 2),
    r.one('invariant Program:'), r.one('invariant Advocate:'),
    r.one('export fixture campaign='), r.one('export fixture advocate='), ' When', ' Then',
    'package affiliate', ' use rent_catalog {Location,test_site}', ' use employee {can_work}',
    ' use sales_attribution {capture}', ' Given', a.one('export contract AccountState {'),
    ...a.lines.filter(line => line.trimStart().startsWith('message ')),
    a.one('role partner_manager '), a.one('role finance '), a.one('export Partner {'),
    ...a.many('policy Partner read=', 3), a.one('invariant Partner:'), a.one('export fixture broker='),
    ' When', ' Then', a.one('style AffiliateWorkspace '), page,
    'package sales_attribution', ...attribution.lines.filter(line => line.trimStart().startsWith('use ')),
    ' Given', attribution.one('export Capture in Customer {'), attribution.one('invariant Capture:'),
    attribution.one('lock Capture '), attribution.one('policy Capture read='), ' When', capture, ' Then', '',
  ].join('\n');
  const sourcePath = join(directory, 'CanAffiliate.can');
  await writeFile(sourcePath, source);
  const styleId = 'fa30709d-9fba-4496-955c-b1547917cde4';
  const originalStyle = join(root, 'draft/apps/CanAffiliate/can.generated', styleId);
  const preparedStyle = join(directory, 'can.generated', styleId);
  await mkdir(preparedStyle, { recursive: true });
  const styleFiles = ['unit.json', 'style.css'];
  await Promise.all(styleFiles.map(name => copyFile(join(originalStyle, name), join(preparedStyle, name))));
  return { source, sourcePath, originalInputPaths: [...dependencies.originalInputPaths, affiliatePath, referPath, customerPath, ...styleFiles.map(name => join(originalStyle, name))] };
}
