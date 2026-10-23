/** Project-only compilation and bundle assembly. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadArtifactFile} from '../runtime/artifact.js';
import {buildSodaBundle} from '../deploy/soda.js';
import {PINNED_COMPATIBILITY_DATE} from './artifact-defaults.js';
type Options=Map<string,string>;
function required(options:Options,name:string):string{const value=options.get(name);if(!value)throw new Error(name+' is required');return value;}
export async function build(argv:string[]):Promise<void>{
 const options:Options=new Map();const allowed=['--artifact','--descriptor','--environment','--out','--date','--flags'];
 for(let i=1;i<argv.length;i+=2){const name=argv[i]!;const value=argv[i+1];if(!allowed.includes(name)||options.has(name)||value===undefined||value.startsWith('--'))throw new Error('Unknown, duplicate or missing can-soda option');options.set(name,value);}
 await runSodaBuild('build',options);
}
async function runSodaBuild(command: string, options: Options): Promise<void> {
  const artifact = loadArtifactFile(resolve(required(options, '--artifact'))).artifact;
  const descriptor = JSON.parse(await readFile(required(options, '--descriptor'), 'utf8'));
  const environment = JSON.parse(await readFile(required(options, '--environment'), 'utf8'));
  const input = buildSodaBundle(artifact, descriptor, environment, options.get('--date') ?? PINNED_COMPATIBILITY_DATE,
    options.get('--flags')?.split(',').filter(Boolean) ?? []);
  await writeFile(required(options, '--out'), JSON.stringify({ ...input, bundle: { ...input.bundle,
    binaries: Object.fromEntries(Object.entries(input.bundle.binaries).map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')])) } }), { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, command, mixedSha256: input.bundle.mixedSha256 }));
}

