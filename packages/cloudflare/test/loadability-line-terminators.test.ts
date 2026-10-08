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

describe("CommonJS wrapper callback bindings", () => {
  for (const [shape, wrap] of [
    ["function", (parameters: string, body: string) => `__commonJS(function(${parameters}) { ${body} })`],
    ["arrow", (parameters: string, body: string) => `__commonJS((${parameters}) => { ${body} })`],
    ["object method", (parameters: string, body: string) => `__commonJS({ "dependency.cjs"(${parameters}) { ${body} } })`],
  ] as const) {
    describe(shape, () => {
      for (const [parameters, statement, issue] of [
        ["exports, module", "require('missing');", "bare require"],
        ["exports", "module.exports = {};", "CommonJS module.exports"],
        ["", "exports.value = 1;", "CommonJS free exports"],
      ] as const) {
        it(`refuses ${statement} without a callback binding`, () => {
          const source = `var r = ${wrap(parameters, statement)}; export default r;`;
          expect(() => assertWorkerdLoadable({ "main.js": source })).toThrow(`main.js" is not workerd-loadable: ${issue}`);
        });
      }

      it("admits bound exports/module, nested code, and quoted codegen tokens", () => {
        const source = `var r = ${wrap("exports, module", [
          "module.exports = function() { return exports.value; };",
          "exports.codegen = \"require('missing'); module.exports = {}; exports.value = 1;\";",
          "// require('missing'); module.exports = {}; exports.value = 1;\n",
        ].join("\n"))}; export default r;`;
        expect(() => assertWorkerdLoadable({ "main.js": source })).not.toThrow();
      });
    });
  }
});

it("refuses direct unresolved new require constructor", () => {
  expect(() => assertWorkerdLoadable({ "main.js": "new require(\"missing\");" })).toThrow("bare require( call at offset 4");
});
