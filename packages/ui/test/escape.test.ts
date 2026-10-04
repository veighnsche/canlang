import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  csvFormulaProtect,
  escapeAttr,
  escapeHtml,
  isSafeUrl,
  isolate,
  safeHref,
} from "../src/escape.js";

describe("escapeHtml", () => {
  it("escapes markup-breaking characters", () => {
    assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.equal(escapeHtml("Tom & 'Jerry'"), "Tom &amp; &#39;Jerry&#39;");
  });

  it("leaves safe text untouched, including unicode", () => {
    assert.equal(escapeHtml("Taken en voortgang — 100%"), "Taken en voortgang — 100%");
    assert.equal(escapeHtml(""), "");
  });

  it("fails closed on non-string input", () => {
    assert.throws(() => escapeHtml(null as unknown as string), TypeError);
    assert.throws(() => escapeHtml(42 as unknown as string), TypeError);
  });
});

describe("escapeAttr", () => {
  it("neutralizes attribute breakout", () => {
    assert.equal(
      escapeAttr(`x" onmouseover="alert(1)`),
      "x&quot; onmouseover=&quot;alert(1)",
    );
  });

  it("fails closed on non-string input", () => {
    assert.throws(() => escapeAttr(undefined as unknown as string), TypeError);
  });
});

describe("isSafeUrl / safeHref", () => {
  const safe = ["/notes", "/invoices/abc", "#section", "https://example.com/x", "http://a.nl/", "mailto:a@b.nl", "relative/path?a=1&b=2"];
  for (const url of safe) {
    it(`accepts ${url}`, () => {
      assert.equal(isSafeUrl(url), true);
      assert.equal(safeHref(url), url);
    });
  }

  const unsafe = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)  ",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "",
    "\\\\evil\\share",
  ];
  for (const url of unsafe) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      assert.equal(isSafeUrl(url), false);
      assert.equal(safeHref(url), "#");
    });
  }

  it("supports a custom fallback", () => {
    assert.equal(safeHref("javascript:x", "/"), "/");
  });
});

describe("csvFormulaProtect", () => {
  it("prefixes formula-leading cells", () => {
    assert.equal(csvFormulaProtect("=1+1"), "'=1+1");
    assert.equal(csvFormulaProtect("+cmd"), "'+cmd");
    assert.equal(csvFormulaProtect("-2"), "'-2");
    assert.equal(csvFormulaProtect("@x"), "'@x");
    assert.equal(csvFormulaProtect(" a"), "' a");
  });

  it("leaves ordinary cells alone", () => {
    assert.equal(csvFormulaProtect("Travel"), "Travel");
    assert.equal(csvFormulaProtect("25"), "25");
    assert.equal(csvFormulaProtect("a=b"), "a=b");
  });
});

describe("isolate", () => {
  it("wraps values in bidi isolates", () => {
    assert.equal(isolate("abc"), "\u2068abc\u2069");
  });
});
