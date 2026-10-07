import { describe, expect, it } from "vitest";
import { assertWorkerdLoadable } from "../src/deploy/bundle.js";

// All ECMAScript line terminators end a line comment. Quoted and
// comment-only CJS names remain data; the next line remains executable.
for (const [name, terminator] of [["LF", "\n"], ["CR", "\r"], ["CRLF", "\r\n"], ["LS", "\u2028"], ["PS", "\u2029"]] as const) {
  describe(`loadability after ${name} line comments`, () => {
    for (const statement of ["require('missing');", "module.exports = {};", "exports.value = 1;"]) {
      it(`refuses executable ${statement}`, () => {
        const source = `// quoted require/module.exports/exports${terminator}${statement}`;
        expect(() => assertWorkerdLoadable({ "main.js": source })).toThrow(/main\.js.*(?:require|CommonJS)/);
      });
    }
    it("admits comment-only and quoted names followed by ordinary ESM", () => {
      const source = `// require('missing'); module.exports = {}; exports.value = 1;${terminator}export const label = "require( module.exports exports";`;
      expect(() => assertWorkerdLoadable({ "main.js": source })).not.toThrow();
    });
  });
}

it("preserves approved bundler wrapper and stdlib require-guard controls", () => {
  assertWorkerdLoadable({ "main.js": [
    "var r = __commonJS(function(exports, module) { module.exports = {}; exports.value = 1; });",
    "export function require(c) { if (!c) throw new Error('forbidden'); }",
    "export default r;",
  ].join("\n") });
});
