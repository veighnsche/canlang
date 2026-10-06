import { readFileSync } from 'node:fs'; export const read = () => readFileSync(new URL('../../b/src/index.ts', import.meta.url), 'utf8');
