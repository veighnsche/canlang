// Existing public import contract; a research module, not compiler output.
import { parseDecimal, negateDecimal } from '@canlang/stdlib';
export const construct=text=>parseDecimal(text);
export const negative=text=>negateDecimal(parseDecimal(text));
