import { readFileSync } from 'node:fs'; export const read = () => readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');
