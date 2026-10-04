//! Diagnostic code catalog served by `can explain CODE`.
//!
//! Every range from the lane-01 policy is covered: `E1xxx` syntax/layout,
//! `E2xxx` names/imports/composition, `E3xxx` types/schemas, `E4xxx`
//! effects/owners/disclosure/authority-shape, `E5xxx`
//! operations/fixtures/examples, `E6xxx` codegen/artifact/capability,
//! `E7xxx` tool/config, `W1xxx` unreachable, `W2xxx` shadowing (opt-in),
//! `W3xxx` deprecated, `I1xxx` unused/redundant/locale-fallback.
//!
//! The `E1xxx` entries are reconciled with the real `syntax` emission
//! sites: lexer `E1001`–`E1007`, layout `E1101`–`E1103`/`E1120`–`E1126`
//! and parser `E1200`–`E1216` (see `syntax::mod` for the per-code
//! summary). The `E2xxx` entries describe name resolution, the `E3xxx`
//! entries type checking, and the `E6xxx` entries the producer-catalog
//! loader plus planned-builtin calls; all are reconciled with the real
//! `analysis` emission sites (`E2011`/`E2015`/`E2016` are unallocated).
//! The `E7xxx` entries describe behavior this binary actually
//! implements. `E4xxx`–`E5xxx`, `W1xxx`–`W3xxx` and `I1xxx` are reserved
//! placeholders for stages that do not emit them yet; unknown codes are
//! never invented at explain time (see [`lookup`]).

use crate::diagnostic::Severity;
use std::fmt::Write as _;

/// One documented diagnostic code.
#[derive(Debug, Clone, Copy)]
pub struct CodeInfo {
    /// Stable machine code, e.g. `E1001`.
    pub code: &'static str,
    /// Short kebab-case title.
    pub title: &'static str,
    /// Severity findings under this code carry.
    pub severity: Severity,
    /// What the code means and how to fix it.
    pub explanation: &'static str,
    /// Small example that does not trigger the code.
    pub example_valid: &'static str,
    /// Small example that triggers the code.
    pub example_invalid: &'static str,
}

/// The full catalog in code order.
pub fn all() -> &'static [CodeInfo] {
    &CATALOG
}

/// Look up one code. Matching trims whitespace and is ASCII-case-insensitive
/// so `e1001` finds `E1001`. Returns `None` for unknown codes; callers must
/// report `E7003` and list [`known_codes`] instead of inventing an entry.
pub fn lookup(code: &str) -> Option<&'static CodeInfo> {
    let normalized = code.trim().to_ascii_uppercase();
    CATALOG.iter().find(|info| info.code == normalized)
}

/// Every known code in catalog order, for `E7003` error messages.
pub fn known_codes() -> Vec<&'static str> {
    CATALOG.iter().map(|info| info.code).collect()
}

/// Render one entry as deterministic single-line JSON.
pub fn entry_to_json(info: &CodeInfo) -> String {
    let mut out = String::new();
    out.push_str("{\"code\":");
    crate::diagnostic::push_json_str(&mut out, info.code);
    out.push_str(",\"title\":");
    crate::diagnostic::push_json_str(&mut out, info.title);
    out.push_str(",\"severity\":");
    crate::diagnostic::push_json_str(&mut out, info.severity.as_str());
    out.push_str(",\"explanation\":");
    crate::diagnostic::push_json_str(&mut out, info.explanation);
    out.push_str(",\"example_valid\":");
    crate::diagnostic::push_json_str(&mut out, info.example_valid);
    out.push_str(",\"example_invalid\":");
    crate::diagnostic::push_json_str(&mut out, info.example_invalid);
    out.push('}');
    out
}

/// Render one entry as human-readable text.
pub fn entry_to_text(info: &CodeInfo) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{} [{}]: {}",
        info.code,
        info.severity.as_str(),
        info.title
    );
    out.push_str(info.explanation);
    out.push('\n');
    out.push_str("\nvalid:\n");
    out.push_str(info.example_valid);
    out.push_str("\n\ninvalid:\n");
    out.push_str(info.example_invalid);
    out.push('\n');
    out
}

const CATALOG: [CodeInfo; 104] = [
    CodeInfo {
        code: "E1001",
        title: "bare-carriage-return",
        severity: Severity::Error,
        explanation: "Source uses LF or CRLF line endings (GRAMMAR Tokens and layout). A carriage return not immediately followed by LF is a bare CR, reported once where it stands; the byte stays as an error token so coverage is preserved. Normalize the file to LF and remove the stray CR.",
        example_valid: "app T\nGiven\nWhen\nThen\n## note\n",
        example_invalid: "app T\nGiven\nWhen\nThen\n## a\rb\n",
    },
    CodeInfo {
        code: "E1002",
        title: "invalid-utf8",
        severity: Severity::Error,
        explanation: "Source must be valid UTF-8 (GRAMMAR Tokens and layout). The bytes entry point rejects the first malformed byte; the text entry point cannot see this error. Re-save the file as UTF-8.",
        example_valid: "app T\nGiven\nWhen\nThen\n",
        example_invalid: "bytes `app \\xff\\n` (invalid UTF-8; reported only by the bytes entry point)",
    },
    CodeInfo {
        code: "E1003",
        title: "tab-in-indentation-or-code",
        severity: Severity::Error,
        explanation: "Tabs are never indentation or code (GRAMMAR Tokens and layout): each tab in leading indentation or between code tokens is an error. Tabs are prose only inside `#`/`##` line content and are rejected inside strings. Replace tabs with spaces (one space per block level).",
        example_valid: "app T\nGiven\nWhen\nThen\n",
        example_invalid: "\tapp T\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1004",
        title: "backslash-continuation",
        severity: Severity::Error,
        explanation: "A backslash as the last character of a physical line is a rejected line continuation (GRAMMAR Tokens and layout): physical lines join only inside balanced delimiters. A backslash elsewhere in code is E1007. Join the lines with an explicit delimiter pair or keep one logical line per line.",
        example_valid: "app T\nGiven\nWhen\nThen\n",
        example_invalid: "app T\\\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1005",
        title: "invalid-numeric-literal",
        severity: Severity::Error,
        explanation: "Integer units must be adjacent (`5m`, not `5 m`); decimals take no unit; unknown units (`5minutes`) and identifier tails (`5m2x`) are errors (GRAMMAR Tokens and layout: durations ms/s/m/h/d, bytes B/KiB/MiB/GiB). Use an adjacent valid unit or separate the tokens.",
        example_valid: "app T\nGiven\nWhen\n scenario s() by=members\n  require n > 5m\n  do\n   return 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  require n > 5 m\n  do\n   return 1\nThen\n",
    },
    CodeInfo {
        code: "E1006",
        title: "invalid-string",
        severity: Severity::Error,
        explanation: "Strings are single-line JSON strings (GRAMMAR Tokens and layout): no literal newlines, no unescaped control characters or tabs, and only valid escapes (`\" \\ / b f n r t uXXXX` with well-formed surrogate pairs). Close the string on the same line and use valid JSON escapes.",
        example_valid: "app T\nGiven\n message m = \"a\\u00e9b\"@{}\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n message m = \"a\\qb\"@{}\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1007",
        title: "unexpected-character",
        severity: Severity::Error,
        explanation: "Outside strings only NAME tokens, JSON strings and the GRAMMAR punctuation set are valid. Anything else (e.g. `$`), an inline `#` (prose markers must start the physical line) or a mid-line backslash is reported; the byte stays as an error token so coverage is preserved. Remove or quote the character.",
        example_valid: "app T\nGiven\n role a label=\"A\"\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n role a label=\"A\" $\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1101",
        title: "mismatched-closing-delimiter",
        severity: Severity::Error,
        explanation: "Balanced `()`, `[]` and `{}` join physical lines, but each closer must match the innermost opener (GRAMMAR Tokens and layout). A mismatched closer is reported at that token and layout pops one level to recover. Use the closer that matches the opener.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text ]\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1102",
        title: "unclosed-delimiter",
        severity: Severity::Error,
        explanation: "Every opener needs its closer (GRAMMAR Tokens and layout); joined lines keep no block meaning. An opener still open at end of file is reported at the opener and the pending tokens flush as one line. Close the delimiter.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1103",
        title: "bad-indentation",
        severity: Severity::Error,
        explanation: "A block adds exactly one space to its header's indentation, dedentation returns to an existing level, and the first top-level declaration starts at column 1 (GRAMMAR Tokens and layout). Past the nesting budget the line attaches as a sibling instead. Fix the column of the flagged line.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n  Todo { title:text }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1120",
        title: "description-column-mismatch",
        severity: Severity::Error,
        explanation: "Each description line must start at the same physical column as its declaration (GRAMMAR Descriptions and comments). A line at another column is reported. Align the `#` marker column with the owner.",
        example_valid: "# Track work.\napp T\nGiven\nWhen\nThen\n",
        example_invalid: "# line one.\n # line two.\napp T\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1121",
        title: "description-prose-reference-mixing",
        severity: Severity::Error,
        explanation: "One description set is either prose lines or a single `#= path` reference, never both, and never multiple references (GRAMMAR Descriptions and comments). The second line is reported. Keep one `#=` line alone or use prose only.",
        example_valid: "# About tasks.\napp T\nGiven\nWhen\nThen\n",
        example_invalid: "# prose.\n#= docs.x\napp T\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1122",
        title: "invalid-description-reference",
        severity: Severity::Error,
        explanation: "`#=` (no space between marker and `=`) must be followed by exactly one message path `NAME(.NAME)*` with no call, suffix or extra tokens (GRAMMAR Descriptions and comments). The offending token is reported. Write exactly one path.",
        example_valid: "#= docs.tasks\napp T\nGiven\nWhen\nThen\n",
        example_invalid: "#= 123\napp T\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1123",
        title: "misplaced-description-suffix",
        severity: Severity::Error,
        explanation: "One unescaped `@{...}` suffix may appear on the final prose line only (GRAMMAR Descriptions and comments); a suffix on an earlier line is reported and treated as literal prose. Move the suffix to the last line (or quote it with `\\@{`).",
        example_valid: "# About tasks. @{en=\"Tasks\"}\napp T\nGiven\nWhen\nThen\n",
        example_invalid: "# A @{nl=\"x\"}\n# B\napp Test\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1124",
        title: "invalid-description-suffix",
        severity: Severity::Error,
        explanation: "The `@{...}` suffix is a contiguous marker plus `locale=\"string\"|null` variants consuming the rest of the line (GRAMMAR Descriptions and comments). A split marker, bad key, missing `=`/`}`, non-string value, duplicate locale or trailing tokens is reported. Write `@{locale=\"text\",...}` with no gap after `@`.",
        example_valid: "# About tasks. @{en=\"Tasks\"}\napp T\nGiven\nWhen\nThen\n",
        example_invalid: "# A @{nl}\napp Test\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1125",
        title: "dangling-description",
        severity: Severity::Error,
        explanation: "A description needs a following eligible declaration at the same indentation; a trailing description dangles (GRAMMAR Descriptions and comments). Reported at the first dangling line; the set is kept as a marker so bytes stay covered. Attach it to a declaration or turn it into `##`.",
        example_valid: "# Track work.\napp T\nGiven\nWhen\nThen\n",
        example_invalid: "app T\nGiven\nWhen\nThen\n# trailing.\n",
    },
    CodeInfo {
        code: "E1126",
        title: "description-on-ineligible-item",
        severity: Severity::Error,
        explanation: "Section markers, `do`, guards/effects, `if`/`else`, `for`, examples headers/rows and presentation `require` (plus anything inside a `do`/`examples` suite) cannot carry descriptions (GRAMMAR Descriptions and comments). Reported at the description. Use `##` for those notes.",
        example_valid: "app T\n## on a marker.\nGiven\nWhen\nThen\n",
        example_invalid: "app T\n# on a marker.\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1200",
        title: "invalid-syntax-shape",
        severity: Severity::Error,
        explanation: "Catch-all for malformed declarations: unknown introducer, wrong production shape, unclosed inline bracket, misplaced suite, or an empty construct that must be omitted (GRAMMAR: a recognized introducer must have its full shape). The declaration becomes an Error node and parsing continues. Match the GRAMMAR production for the introducer.",
        example_valid: "app T\nGiven\n policy Todo read=members where=true\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n policy\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1201",
        title: "trailing-tokens",
        severity: Severity::Error,
        explanation: "No production permits an unparsed tail (GRAMMAR: unknown syntax is an error). Any token after a complete statement, including after a section marker or `else`, is reported at that token. Remove the tail or move it to its own declaration.",
        example_valid: "app T\nGiven\n message m = \"Hi\"@{}\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n message m = \"Hi\"@{} extra\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1202",
        title: "duplicate-attribute",
        severity: Severity::Error,
        explanation: "A named attribute is present at most once per header; the same holds for field modifiers, call/object/label slots, order members, scenario attributes and example bindings (GRAMMAR Contextual roles). The repeat is reported. Keep one.",
        example_valid: "app T\nGiven\n Todo { title:text max=1 }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text max=1 max=2 }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1203",
        title: "unknown-attribute",
        severity: Severity::Error,
        explanation: "Only the attributes and slots the GRAMMAR production lists are accepted; there are no arbitrary extension words. The unknown word is reported. Remove it or use a production attribute.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text foo=1 }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1204",
        title: "missing-required-item",
        severity: Severity::Error,
        explanation: "Required attributes, suites, sections and bodies must be present: CRUD needs fields, scenario/if/for/else need bodies, a package needs its sections. Reported at the header or end of input. Add the named item or omit the empty construct.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members\nThen\n",
    },
    CodeInfo {
        code: "E1205",
        title: "invalid-semicolon-sequence",
        severity: Severity::Error,
        explanation: "Same-category leaves may share one logical line (`role a; role b`), but empty entries, a trailing `;`, compound headers (scenario/capability/page/...), top-level declarations, example rows/steps, and any line owning an indented suite cannot (GRAMMAR leaf_lines). Give each entry its own line or drop the empty entry.",
        example_valid: "app T\nGiven\n role a label=\"A\"; role b label=\"B\"\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n role a label=\"A\";; role b label=\"B\"\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1206",
        title: "invalid-query-clause-order",
        severity: Severity::Error,
        explanation: "Query clauses are unique and ordered `archived/as/where/order/select` (GRAMMAR Queries and scope). A repeated or out-of-order clause is reported. Order the clauses.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\n scenario s() by=members\n  require count(Todo as t where t.done order=-created select t) >= 0\n  do\n   return 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  require count(Todo order=x where y) > 0\n  do\n   return 1\nThen\n",
    },
    CodeInfo {
        code: "E1207",
        title: "chained-comparison",
        severity: Severity::Error,
        explanation: "Comparisons do not chain: `1 < 2 < 3` is an error (GRAMMAR Expressions and values). Reported at the second operator. Parenthesize and join with `and`.",
        example_valid: "app T\nGiven\nWhen\n scenario s() by=members\n  require 1 < 2\n  do\n   return 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  require 1 < 2 < 3\n  do\n   return 1\nThen\n",
    },
    CodeInfo {
        code: "E1208",
        title: "mixed-coalescing-operator",
        severity: Severity::Error,
        explanation: "Mixing `??` with `and`/`or` without parentheses is an error (GRAMMAR Expressions and values). Reported at the operator. Parenthesize the `??` operand.",
        example_valid: "app T\nGiven\nWhen\n scenario s() by=members\n  require (a ?? b) or c\n  do\n   return 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  require a ?? b or c\n  do\n   return 1\nThen\n",
    },
    CodeInfo {
        code: "E1209",
        title: "invalid-route",
        severity: Severity::Error,
        explanation: "Routes are contiguous `/`-separated segments on one physical line: static lowercase, `{name:type}` scalar or `{Model.id}` record parameters; only `/` may end in `/` (GRAMMAR Presentation and routes). Reported at the offending segment. Match the route shape.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /s/{name:text} title=\"S\"\n",
        example_invalid: "app T\nGiven\nWhen\nThen\n page /x/{id} title=\"T\"\n",
    },
    CodeInfo {
        code: "E1210",
        title: "invalid-examples-shape",
        severity: Severity::Error,
        explanation: "Behavior examples are a header plus matching-arity rows (`inputs -> expected`, with `error(code)` replacing a whole expected row) or, for user scenarios only, a `do` sequence of calls then assertions (GRAMMAR Inline behavior examples). Wrong arity, a bad operation, child suites, semicolons or sequence misuse is reported. Match the header arity and the table/sequence shape.",
        example_valid: "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n  examples update record=task\n   as,changes.done -> record.done\n   members,true -> true\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n  examples update record=task\n   as,changes.done -> record.done\n   members -> true\nThen\n",
    },
    CodeInfo {
        code: "E1211",
        title: "invalid-file-structure",
        severity: Severity::Error,
        explanation: "Files hold `app`/`package`/`migration` heads; implicit apps need Given/When/Then once in order; imports precede Given; composed apps (`uses=`) take imports only (GRAMMAR Files, composition and sections). The stray line is reported. Use the file skeleton.",
        example_valid: "app T\nGiven\nWhen\nThen\n",
        example_invalid: "hello\napp T\nGiven\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1212",
        title: "invalid-export",
        severity: Severity::Error,
        explanation: "Only exportable declarations take `export`: preferences, derived fields (not functions), invariants, CRUD and trusted handlers cannot be exported, and `export` outside Given is rejected (GRAMMAR Given/When declarations). Drop `export` or export an eligible declaration.",
        example_valid: "app T\nGiven\n export capability Mail version=1\n  send(to:text) -> bool\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\nWhen\n export crud Todo by=members fields=title\nThen\n",
    },
    CodeInfo {
        code: "E1213",
        title: "invalid-type-syntax",
        severity: Severity::Error,
        explanation: "Types allow one array suffix then one nullable suffix (`text[]?`); `!` is required-array field metadata, not a scalar suffix; `enum()`/`action()` need entries (GRAMMAR Types, schemas and signatures). Match the type shape.",
        example_valid: "app T\nGiven\n M { a:int[] }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { a:int[][] }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1214",
        title: "invalid-label-or-message",
        severity: Severity::Error,
        explanation: "Labels need a string caption, message path or valid label object (`text`/`values`/CRUD ops, no duplicates, no unknown slots); message declarations need a contiguous `@{...}` descriptor with valid locale variants (GRAMMAR Inline messages, labels and locales). Match the label/message shape.",
        example_valid: "app T\nGiven\n M { a:int label=\"A\" }\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { a:int label=123 }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E1215",
        title: "invalid-expression",
        severity: Severity::Error,
        explanation: "Value expressions reject missing operands, misplaced `not`, optional calls, non-path constructors, postfix indexing, out-of-order or anonymous-call argument mistakes, and nesting past the budget (GRAMMAR Expressions and values). Complete the expression per the grammar.",
        example_valid: "app T\nGiven\nWhen\n scenario s() by=members\n  require 1 + 2\n  do\n   return 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  require 1 +\n  do\n   return 1\nThen\n",
    },
    CodeInfo {
        code: "E1216",
        title: "invalid-statement-or-effect",
        severity: Severity::Error,
        explanation: "Execution suites hold leading `require` guards, exactly one `do` body, then `examples`; `do` bodies hold only the GRAMMAR effect statements (migration mappers only let/require/if/set-row). Unknown statements and misplaced guards/bodies are reported. Use a valid statement in a valid position.",
        example_valid: "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   return 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   frobnicate x\nThen\n",
    },
    CodeInfo {
        code: "E2001",
        title: "unresolved-name",
        severity: Severity::Error,
        explanation: "A bare name resolves in no visible scope (parameters, lets, query aliases, imports, fixed context) and no uniquely expected enum type claims it as a case. Reported once per use site; the expression is poisoned so no derivative errors follow. A same-spelled builtin never blocks enum-case elision, but a true lexical binding does. Check spelling, the owning declaration and `use` imports; the message names the exporting package when exactly one fits.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\nThen\n",
        example_invalid: "app T\nGiven\n derive bad(): int = nosuch + 1\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E2002",
        title: "duplicate-definition",
        severity: Severity::Error,
        explanation: "Two declarations bind one name in one scope: models, fields, parameters, fixtures, messages, capability members, CRUD, imports, enum cases, preferences schemas and app/package identities. Closed builtin names cannot be redeclared by packages, fixtures or import aliases. A related span marks the first declaration. Rename or remove one.",
        example_valid: "app T\nGiven\n M { a:int }\n N { b:int }\n policy M read=members\n policy N read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { a:int }\n M { b:int }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E2003",
        title: "import-not-exported",
        severity: Severity::Error,
        explanation: "A `use` member is declared in its provider but not exported. Only `export` declarations cross package boundaries; an import grants name visibility, never data access. Export the declaration or drop the member.",
        example_valid: "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {M}\n Given\n When\n  scenario s(m:M) by=members\n   do\n    let x = 1\n Then\n",
        example_invalid: "app T uses=[p,q]\npackage p\n Given\n  M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {M}\n Given\n When\n Then\n",
    },
    CodeInfo {
        code: "E2004",
        title: "import-not-declared",
        severity: Severity::Error,
        explanation: "A `use` member names nothing declared in its provider package. Check the spelling and that the declaration exists in that package.",
        example_valid: "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {M}\n Given\n When\n Then\n",
        example_invalid: "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {Zzz}\n Given\n When\n Then\n",
    },
    CodeInfo {
        code: "E2005",
        title: "unknown-import-provider",
        severity: Severity::Error,
        explanation: "A `use` provider names no known app or package in this build. Check the provider spelling and that its file is part of the build.",
        example_valid: "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {M}\n Given\n When\n Then\n",
        example_invalid: "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use zzz {M}\n Given\n When\n Then\n",
    },
    CodeInfo {
        code: "E2006",
        title: "helper-not-callable",
        severity: Severity::Error,
        explanation: "A catalog helper (`kind: \"helper\"`) is codegen-only: its signature carries producer-internal prose rather than a source-callable shape. Any source reference to the id is an error, never a silent pass. Call a builtin instead, or wait for the owning lane to promote the helper.",
        example_valid: "app T\nGiven\n derive ok(): int = 1\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n derive bad(): int = help_inner(1)\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E2007",
        title: "composition-cycle",
        severity: Severity::Error,
        explanation: "Composed apps select members through `uses`, and that selection graph must be acyclic. Each app on the cycle is reported. Break the cycle by removing one membership edge.",
        example_valid: "app T uses=[p]\npackage p\n Given\n When\n Then\n",
        example_invalid: "app A uses=[B]\napp B uses=[A]\n",
    },
    CodeInfo {
        code: "E2008",
        title: "invalid-containment",
        severity: Severity::Error,
        explanation: "`Model in Parent` needs one stored model in scope as its container (`Model in app` is the explicit app scope instead). The target must resolve and be a stored model; anything else is reported here. Name a model, use `in app`, or omit containment for the team default.",
        example_valid: "app T\nGiven\n Todo { title:text }\n Note in Todo { body:text }\n policy Todo read=members\n policy Note read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n message m = \"Hi\"@{}\n M in m { a:int }\n policy M read=members\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E2009",
        title: "composed-app-import",
        severity: Severity::Error,
        explanation: "A composed app (`uses=`) takes imports only, and only messages: it contributes no declarations of its own. A non-message member is reported. Drop the import or import a message.",
        example_valid: "app T uses=[p]\npackage p\n Given\n When\n Then\n",
        example_invalid: "app T uses=[p]\nuse p {M}\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\n",
    },
    CodeInfo {
        code: "E2010",
        title: "empty-uses",
        severity: Severity::Error,
        explanation: "A composed app must select at least one member: `uses=[]` is empty. Add a member or drop `uses=` to declare an ordinary app.",
        example_valid: "app T uses=[p]\npackage p\n Given\n When\n Then\n",
        example_invalid: "app T uses=[]\n",
    },
    CodeInfo {
        code: "E2012",
        title: "contextual-shadowing",
        severity: Severity::Error,
        explanation: "Authored bindings cannot hide an active injected fact: `actor`, `team`, `now`, `operation`, or the context-specific `row`, `event`, `preferences`, `result` and `before`. These are contextual facts, not reserved spellings, so the same name stays legal where the fact is absent. Rename the binding.",
        example_valid: "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   let actor = 1\nThen\n",
    },
    CodeInfo {
        code: "E2013",
        title: "unknown-member",
        severity: Severity::Error,
        explanation: "Member access names no field of the base record (or no member of the base value): models, contracts, events, preferences and query rows expose only their declared fields. There is no fallback search through unrelated records. Check the spelling against the declaration.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require t.title != \"\"\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require t.nope == 1\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E2014",
        title: "invalid-derive-target",
        severity: Severity::Error,
        explanation: "A derived function must declare a package-local name (a path is not an automatic cross-package extension), and a derived field must resolve to `Model.field`. Declare the function locally or point the field at an existing model field.",
        example_valid: "app T\nGiven\n derive ok(): int = 1\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n derive p.bad(): int = 1\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E2017",
        title: "fixture-cycle",
        severity: Severity::Error,
        explanation: "Fixture recipes reference each other in a cycle, so no provisioning order exists. Each fixture on the cycle is reported. Break the cycle by inlining one recipe or pointing it at an acyclic fixture.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n fixture f=Todo {title=\"x\"}\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { m:M? }\n policy M read=members\n fixture a=M {m=b}\n fixture b=M {m=a}\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E2018",
        title: "derived-value-cycle",
        severity: Severity::Error,
        explanation: "Derived definitions cannot recurse: pure functions and computed fields that reach themselves through calls form a cycle. Each definition on the cycle is reported. Break the cycle by removing one call edge.",
        example_valid: "app T\nGiven\n derive ok(): int = 1\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n derive a(): int = b()\n derive b(): int = a()\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3001",
        title: "type-mismatch",
        severity: Severity::Error,
        explanation: "A value's type does not fit its slot: field and parameter positions, call arguments, query and UI attributes, effect inputs and literal bounds (int64 overflow, decimal shape, duration/byte range, validated-string shape). There is no implicit coercion, no truthiness and no string/number conversion; money never coerces to decimal. Supply a value of the expected type or narrow first.",
        example_valid: "app T\nGiven\n derive ok(): int = 1\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n derive bad(): int = 99999999999999999999\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3002",
        title: "invalid-operator",
        severity: Severity::Error,
        explanation: "An operator's operand pair is outside the DESIGN §3 matrix: arithmetic needs non-null numeric/duration/money/datetime operands, equality needs compatible values with the null rules, ordering needs compatible ordered scalars (enums never order), and `in` needs a collection on the right. Unlisted pairs are type errors; only the explicit int/decimal and validated-text comparison exceptions exist. Narrow nullables or pick a listed overload.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require 1 + 2 == 3\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require 1 + true == 2\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E3003",
        title: "unsafe-access",
        severity: Severity::Error,
        explanation: "Ordinary `.` needs a non-null receiver: use `?.` for nullable member reads or narrow the receiver first. Each nullable hop requires its own `?.`; the result is the field type made nullable with no nested wrapper. Safe access is pure read-only member access and grants nothing.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require t.title != \"\"\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo?) by=members\n  require t.title != \"\"\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E3004",
        title: "invalid-coalesce",
        severity: Severity::Error,
        explanation: "For `left ?? right`, `left` must be nullable with underlying type `T` and `right` must have compatible type `T` or `T?`, without coercion; it is the sole null-fallback form. False, zero, empty strings and empty arrays are values, never fallback triggers. Make the left nullable or drop the fallback.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo?) by=members\n  require (t?.title ?? \"d\") != \"\"\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require (1 ?? 2) == 1\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E3005",
        title: "invalid-call",
        severity: Severity::Error,
        explanation: "A call fits no checked shape: no catalog overload matches (arity, argument types, alias scopes, `round` scale 0-18, `dates` positive limit, `local_instant` time shape), a derived/user/message/role target rejects its arguments (counts, names, duplicates, missing required), or the call breaks a structural rule (hook re-entry, read-into-mutation, `random_secret` outside server defaults, malformed `format` templates). Match one printed overload exactly.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive ok(): int = count(Todo)\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive bad(): int = count()\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3006",
        title: "invalid-query",
        severity: Severity::Error,
        explanation: "A query starts from an expression yielding a model, parent-child collection, array or typed collection-valued local, with `archived/as/where/order/select` each at most once in order. Other domains, bad `order` keys and misplaced clauses are reported here. Start from a collection and order the clauses.",
        example_valid: "app T\nGiven\n Todo { title:text, done:bool }\n policy Todo read=members\n derive ok(): int = count(Todo as t where t.done)\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive bad(): int = count(1 as x select x)\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3007",
        title: "expected-bool",
        severity: Severity::Error,
        explanation: "A boolean slot holds a non-bool: `and`/`or` operands, `not`, `require`, `where=`, invariants, locks and `if` conditions take exactly `bool`. There is no implicit truthiness. Compare explicitly or produce a bool.",
        example_valid: "app T\nGiven\n Todo { title:text, done:bool }\n policy Todo read=members where=row.done\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members where=1\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3008",
        title: "invalid-type",
        severity: Severity::Error,
        explanation: "A type annotation is malformed after resolution: `?`/`[]` applied twice or to the wrong nullability, `!` off required-array fields, a non-type named in type position, cyclic field-type reuse, or a union arm that is not a distinct named model/contract/event. Match the bounded type grammar.",
        example_valid: "app T\nGiven\n A { x:int }\n B { y:int }\n M { u:A|B }\n policy A read=members\n policy B read=members\n policy M read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n A { x:int }\n B { y:int }\n M { u:A|A }\n policy A read=members\n policy B read=members\n policy M read=members\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3009",
        title: "invalid-action",
        severity: Severity::Error,
        explanation: "An action or call shape breaks its static contract: `action(...)`/`invocation(...)` type targets must be enabled canonical user mutations (never trusted handlers or read scenarios), calls cannot target trusted handlers or re-enter hooks, `call` on an action value must supply its remaining required inputs, invocation values take no replacement arguments, hook `event.after` is writable only on its pending record, and CRUD modes/fields/exposure must name enabled operations. Constructor argument mismatches (`action()`/`invocation()` calls) are `E3005`, not this code. Target an enabled user operation with its exact inputs.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title delete=bogus\nThen\n",
    },
    CodeInfo {
        code: "E3010",
        title: "invalid-delivery",
        severity: Severity::Error,
        explanation: "`send` targets, `delivery()` names, `on=` sources and dispatch purity share this code: sends need capability operations or exported scenarios (never trusted handlers), `delivery()` names one bound operation, `on=` needs a known event source or `every(duration)`, and `when=`/page/data/message slots must stay pure. Name a bound target and keep guards pure.",
        example_valid: "app T\nGiven\nWhen\n scenario tick on=every(5m)\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\nWhen\n scenario tick on=nosuch\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E3011",
        title: "invalid-default",
        severity: Severity::Error,
        explanation: "A default or initializer breaks its rule: field and parameter defaults must match the declared type and stay pure (earlier parameters only), secrets need server initializers, required-array inputs take none, preferences forbid server initializers, and nonnullable preferences need context-free constant defaults (nullable ones default null). Supply a pure matching value.",
        example_valid: "app T\nGiven\n M { t:text = \"x\" }\n policy M read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { t:text = 42 }\n policy M read=members\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3012",
        title: "bad-modifier",
        severity: Severity::Error,
        explanation: "A field modifier is duplicated or incompatible: `trim` needs a string-like type, `unique` a non-array type, `min=`/`max=` a matching text/array/numeric type with int lengths and `min <= max`, and preferences forbid `unique`. Drop the duplicate or pick a compatible modifier.",
        example_valid: "app T\nGiven\n M { t:text trim }\n policy M read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { n:int trim }\n policy M read=members\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3013",
        title: "invalid-label-values",
        severity: Severity::Error,
        explanation: "A label value map breaks its contract: cases must be known cases of the labeled enum/bool type (never null), case keys must not repeat, CRUD label maps belong only on CRUD, unknown/disabled CRUD labels are rejected, and page-descriptor messages must stay context-free. Label only real cases.",
        example_valid: "app T\nGiven\n M { s:enum(a,b)=a label={text=\"S\",values={a=\"A\"}} }\n policy M read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n M { s:enum(a,b)=a label={text=\"S\",values={z=\"Z\"}} }\n policy M read=members\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3014",
        title: "invalid-message",
        severity: Severity::Error,
        explanation: "A message slot holds neither literal text nor a shared message: `require ... message=`, outbound text and similar positions take a string literal or a declared message value (parameterized messages need call syntax at their own sites). Pass a literal or a message.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require t.title!=\"\" message=\"needs a title\"\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require t.title!=\"\" message=Todo\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E3015",
        title: "bad-fixture",
        severity: Severity::Error,
        explanation: "A fixture recipe breaks its target contract: unknown or reserved fields, missing required fields (or `parent`), mistyped values, bad `roles=`/`type=`/`owner=` attributes, or inconsistent delivery envelopes. Recipes mirror creation inputs: name real fields and supply every required one.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n fixture f=Todo {title=\"x\"}\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n fixture f=Todo {zzz=1}\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3016",
        title: "invalid-label-message",
        severity: Severity::Error,
        explanation: "A caption slot holds neither text, a message nor a label table: labels take a string, a message reference (parameterized ones need call syntax) or a valid label object, with well-formed locale variants that never repeat the source language. Pass text, a message or a label table.",
        example_valid: "app T\nGiven\n Todo { title:text label=\"Caption\" }\n policy Todo read=members\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text label=Todo }\n policy Todo read=members\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3017",
        title: "invalid-lifetime",
        severity: Severity::Error,
        explanation: "A `retain Model until=` lifetime breaks its rule: at most one per model, and `until=` must be a pure `datetime?` in `row` scope without banned bindings. Keep one pure datetime retention per model.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n retain Todo until=row.archived_at\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n retain Todo until=row.archived_at\n retain Todo until=row.archived_at\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E3018",
        title: "invalid-is",
        severity: Severity::Error,
        explanation: "An `is` type test names a bad target: targets name a permitted type (models, contracts, union arms), never a field path and never a non-type. A failed static test reports why. Name a type on the right of `is`.",
        example_valid: "app T\nGiven\n contract Address {street:text,city:text}\nWhen\n scenario s(j:json) by=members\n  require j is Address\n  do\n   let x = 1\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require t.title is Todo.title\n  do\n   let x = 1\nThen\n",
    },
    CodeInfo {
        code: "E4001",
        title: "cross-package-mutation",
        severity: Severity::Error,
        explanation: "A `create`/`set`/`delete` targets another package's model. An import grants name visibility, never data access; cross-package `call` is the only way to mutate another package's model. Call the owning package's operation instead.",
        example_valid: "app Shop\nGiven\n export Note { title:text }\nWhen\n scenario own(n:Note) by=members\n  do set n {title=\"here\"}\nThen\n",
        example_invalid: "app Shop\nGiven\n export Note { title:text }\nWhen\nThen\npackage Other\n use Shop {Note}\n Given\n When\n  scenario set_foreign(foreign:Note) by=members\n   do set foreign {title=\"there\"}\n Then\n",
    },
    CodeInfo {
        code: "E4002",
        title: "cross-package-rule",
        severity: Severity::Error,
        explanation: "A policy/invariant/unique/lock/retain targets another package's model. A model, its policies, its invariants and its canonical CRUD belong to one package; other packages cannot extend its policy. Declare the rule in the owning package.",
        example_valid: "app Shop\nGiven\n export Note { title:text }\n policy Note read=members\nWhen\nThen\npackage Other\n use Shop {Note}\n Given\n When\n Then\n",
        example_invalid: "app Shop\nGiven\n export Note { title:text }\nWhen\nThen\npackage Other\n use Shop {Note}\n Given\n  policy Note read=members\n When\n Then\n",
    },
    CodeInfo {
        code: "E4003",
        title: "cross-package-crud",
        severity: Severity::Error,
        explanation: "A `crud` declaration targets another package's model. Canonical CRUD belongs to the model's owning package. Declare it there, or `call` the imported operations.",
        example_valid: "app Shop\nGiven\n export Note { title:text }\nWhen\n crud Note by=members fields=title\nThen\npackage Other\n use Shop {Note}\n Given\n When\n Then\n",
        example_invalid: "app Shop\nGiven\n export Note { title:text }\nWhen\nThen\npackage Other\n use Shop {Note}\n Given\n When\n  crud Note by=members fields=title\n Then\n",
    },
    CodeInfo {
        code: "E4004",
        title: "app-scope-needs-policy",
        severity: Severity::Error,
        explanation: "A model declared `in app` has no same-package policy. App-scoped data is visible application-wide, so it needs an explicit access policy. Add a `policy` for the model.",
        example_valid: "app Shop\nGiven\n Config in app { name:text }\n policy Config read=members\nWhen\nThen\n",
        example_invalid: "app Shop\nGiven\n Config in app { name:text }\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E4010",
        title: "secret-field-grant",
        severity: Severity::Error,
        explanation: "A policy `fields=` list grants a `secret` field. Secrets never leave the server through read grants. Drop the field from the grant.",
        example_valid: "app Shop\nGiven\n Token { value:secret server=random_secret() }\n policy Token read=members\nWhen\nThen\n",
        example_invalid: "app Shop\nGiven\n Token { value:secret server=random_secret() }\n policy Token read=members fields=value\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E4011",
        title: "secret-return",
        severity: Severity::Error,
        explanation: "A scenario returns a `secret`-typed value. Secrets never flow to callers through results. Return a non-secret projection instead.",
        example_valid: "app Shop\nGiven\nWhen\n scenario ok(n:int) -> int by=members\n  do return n\nThen\n",
        example_invalid: "app Shop\nGiven\nWhen\n scenario leak(sek:secret) -> secret by=members\n  do return sek\nThen\n",
    },
    CodeInfo {
        code: "E4020",
        title: "redundant-actor-subject",
        severity: Severity::Error,
        explanation: "A role gate names `actor` as its subject (`Role(actor)`). The actor is the implied subject; name the role bare instead.",
        example_valid: "app Shop\nGiven\n role reviewer\nWhen\n scenario clean(who:user, n:int) -> int by=members\n  require reviewer(who)\n  do return n\nThen\n",
        example_invalid: "app Shop\nGiven\n role reviewer\nWhen\n scenario flagged(n:int) -> int by=members\n  require reviewer(actor)\n  do return n\nThen\n",
    },
    CodeInfo {
        code: "E4030",
        title: "unreachable-after-return",
        severity: Severity::Error,
        explanation: "A statement follows an always-returning one (`return`, or an `if` with two returning branches). The dead statement never runs. Remove it or fix the control flow.",
        example_valid: "app Shop\nGiven\nWhen\n scenario early(n:int) -> int by=members\n  do\n   let leftover=1\n   return n\nThen\n",
        example_invalid: "app Shop\nGiven\nWhen\n scenario early(n:int) -> int by=members\n  do\n   return n\n   let leftover=1\nThen\n",
    },
    CodeInfo {
        code: "E4040",
        title: "call-remote-target",
        severity: Severity::Error,
        explanation: "A `call` targets a bound-imported (remote) operation. Remote targets use `send`; `call` is for local operations. Send a message instead. Generated CRUD operations are exempt from the remote restriction: `call` is their only path, so `call` still applies to them.",
        example_valid: "package Shop\n Given\n When\n  export scenario work(n:int) -> int by=members\n   do return n\n Then\npackage Third\n use Shop {work}\n Given\n When\n  scenario local(n:int) -> int by=members\n   do\n    call work {n=n} as r\n    return r\n Then\n",
        example_invalid: "package Shop\n Given\n When\n  export scenario work(n:int) -> int by=members\n   do return n\n Then\npackage Other\n use Shop {work} from=deployment.shop\n Given\n When\n  scenario remote(n:int) -> int by=members\n   do\n    call work {n=n} as r\n    return r\n Then\n",
    },
    CodeInfo {
        code: "E4041",
        title: "heterogeneous-action-call",
        severity: Severity::Error,
        explanation: "An action-`call` value is incompatible with a non-first target's input: every target of one action value must accept the supplied arguments. Split the call per target or align the inputs.",
        example_valid: "app Shop\nGiven\nWhen\n scenario set_text(v:text) by=members\n  do\n   let x=v\n scenario set_name(v:text) by=members\n  do\n   let y=v\n scenario pick(ref:action(set_text,set_name)) by=members\n  do\n   call ref {v=\"s\"}\n   let done=1\nThen\n",
        example_invalid: "app Shop\nGiven\nWhen\n scenario set_text(v:text) by=members\n  do\n   let x=v\n scenario set_num(v:int) by=members\n  do\n   let y=v\n scenario pick(ref:action(set_text,set_num)) by=members\n  do\n   call ref {v=\"s\"}\n   let done=1\nThen\n",
    },
    CodeInfo {
        code: "E4042",
        title: "delete-disabled",
        severity: Severity::Error,
        explanation: "A `delete` statement targets a model whose `crud` declares `delete=none`. The lifecycle forbids deletion. Remove the statement or enable the operation.",
        example_valid: "app Shop\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n scenario wipe(gone:Todo) by=members\n  do delete gone\nThen\n",
        example_invalid: "app Shop\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title delete=none\n scenario wipe(gone:Todo) by=members\n  do delete gone\nThen\n",
    },
    CodeInfo {
        code: "E4050",
        title: "hook-on-disabled-op",
        severity: Severity::Error,
        explanation: "An `on=Model.create/update/delete` handler targets an operation the model's `crud` disables. No occurrence can ever run the handler. Drop the handler or enable the operation.",
        example_valid: "app Shop\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n scenario no_remove on=Todo.delete\n  do\n   let x=1\nThen\n",
        example_invalid: "app Shop\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title delete=none\n scenario no_remove on=Todo.delete\n  do\n   let x=1\nThen\n",
    },
    CodeInfo {
        code: "E4051",
        title: "mixed-handler-scope",
        severity: Severity::Error,
        explanation: "An `on=every` handler spans app- and team-scoped models across queries, writes and transitive local calls. One handler keeps one scope. Split the handler per scope.",
        example_valid: "app Shop\nGiven\n AppConfig in app { name:text }\n Todo { title:text }\n policy AppConfig read=members\nWhen\n scenario team_only on=every(5m)\n  do\n   let m=count(Todo)\nThen\n",
        example_invalid: "app Shop\nGiven\n AppConfig in app { name:text }\n Todo { title:text }\n policy AppConfig read=members\nWhen\n scenario tick on=every(5m)\n  do\n   let n=count(Todo)\n   create AppConfig {name=\"x\"} as c\nThen\n",
    },
    CodeInfo {
        code: "E5001",
        title: "invalid-example-header",
        severity: Severity::Error,
        explanation: "An example header is malformed: an unknown binding, a malformed `seed`, a missing required input, or an example over a disabled CRUD operation. Bind every required input to a fixture and keep headers well-formed.",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> 1\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending bogus=pending\n   as -> expense.amount\n   members -> 1\nThen\n",
    },
    CodeInfo {
        code: "E5002",
        title: "unknown-example-selector",
        severity: Severity::Error,
        explanation: "An example selector is malformed: a bad root/path, a non-selector input, or an observation over an input-only channel. Selectors name fixture state, request envelopes or declared results.",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> 1\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as,nope.status -> expense.amount\n   members,1 -> 1\nThen\n",
    },
    CodeInfo {
        code: "E5003",
        title: "conflicting-example-selectors",
        severity: Severity::Error,
        explanation: "Example initial-state selectors overlap: duplicate or nested paths seed the same state twice. Keep one selector per seeded path (`request.*` and `changes` never conflict).",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> 1\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as,expense.amount,expense.amount -> expense.amount\n   members,1,1 -> 1\nThen\n",
    },
    CodeInfo {
        code: "E5004",
        title: "invalid-example-caller",
        severity: Severity::Error,
        explanation: "An example caller is malformed: a bad `as` cell or `by=` caller (unknown identity, identities in role arrays, or `as` on a trusted handler). Use the caller vocabulary (`self`, `members`, roles, fixtures).",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> 1\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   stranger -> 1\nThen\n",
    },
    CodeInfo {
        code: "E5005",
        title: "invalid-expected-error",
        severity: Severity::Error,
        explanation: "An `error(code)` names a code outside the 8-code business vocabulary (validation, forbidden, not_found, conflict, rule_failed, busy, limit, delivery_unknown). Use a vocabulary code.",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> error(conflict)\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> error(bogus)\nThen\n",
    },
    CodeInfo {
        code: "E5006",
        title: "invalid-example-sequence",
        severity: Severity::Error,
        explanation: "An example sequence is malformed: a bad call target/envelope/args, `as` on a void operation, a missing enclosing-scenario call, or a duplicate binding. Call declared operations with valid envelopes.",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario submit(expense:Expense) by=members\n  do\n   let x = 1\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples\n   do\n    call submit {expense=pending} by=self\n    call approve {expense=pending} by=self\n    expense.amount -> 1\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario submit(expense:Expense) by=members\n  do\n   let x = 1\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples\n   do\n    call submit {expense=pending} by=self\n    expense.amount -> 1\nThen\n",
    },
    CodeInfo {
        code: "E5007",
        title: "invalid-message-pattern",
        severity: Severity::Error,
        explanation: "A message pattern violates the ICU profile: structure, plural/select branches (mandatory `other`, no offsets), styles or selector types. Keep patterns inside the supported profile.",
        example_valid: "app T\nGiven\n message m(name:text) = \"Hi {name}\"@{}\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n message m(n:int) = \"{n, plural, one {#}}\"@{}\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E5008",
        title: "invalid-fixture-override",
        severity: Severity::Error,
        explanation: "A selector patches reserved state: metadata, the server-owned `parent`, user/file recipe internals, or delivery-recipe descendants. Override only seedable fixture state.",
        example_valid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.version\n   members -> 1\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as,expense.version -> expense.amount\n   members,1 -> 1\nThen\n",
    },
    CodeInfo {
        code: "E5009",
        title: "invalid-message-signature",
        severity: Severity::Error,
        explanation: "A message parameter is not a display value: parameters must be non-nullable scalars or enums. Records and nullable types cannot render. Narrow the parameter type.",
        example_valid: "app T\nGiven\n Expense { status:enum(a,b)=a }\n policy Expense read=members\n message m(a:int) = \"x\"@{}\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n message m(e:Expense) = \"x\"@{}\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E6001",
        title: "unavailable-capability",
        severity: Severity::Error,
        explanation: "A call names a catalog builtin whose availability is `planned`: declared but not implemented by its owning lane. The message names the owner. The source is valid; it compiles once the producer flips the entry to `implemented`. Use an implemented builtin meanwhile.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive ok(): int = count(Todo)\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive bad(): int = planned_widget(Todo)\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E6002",
        title: "missing-catalog",
        severity: Severity::Error,
        explanation: "No producer catalog file was found: the loader tried `--catalog PATH`, `CAN_CATALOG`, `./can-catalog.json` and `./packages/values/dist/catalog.json`, and names every location tried. Without a catalog, builtin names do not resolve either. Emit it with `npm run catalog` in packages/values, pass `--catalog PATH`, or set `CAN_CATALOG`.",
        example_valid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive ok(): int = count(Todo)\nWhen\nThen\n",
        example_invalid: "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive bad(): int = count(Todo)\nWhen\nThen\n",
    },
    CodeInfo {
        code: "E6003",
        title: "invalid-catalog",
        severity: Severity::Error,
        explanation: "A producer catalog file is malformed: not UTF-8 or JSON, a `language_version` other than `\"1.0\"`, a missing `catalog_version` or `entries` array, a duplicate id, or an entry with an unknown `kind`/`effects`/`availability` spelling, a missing signature, a component carrying `effects`, or a bad component profile/header/extras shape. The examples below are catalog JSON, not source. Fix the producer file; the checker never guesses what an entry means.",
        example_valid: "{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[]}",
        example_invalid: "{\"language_version\":\"2.0\",\"catalog_version\":\"t\",\"entries\":[]}",
    },
    CodeInfo {
        code: "E6004",
        title: "invalid-signature",
        severity: Severity::Error,
        explanation: "A builtin catalog entry's `signature` is not a `;`-separated list of `id(params)->result` overloads over the supported shape subset (or names a different id, or has an empty segment), or a helper signature fails its `id(...)->...` spine check. The examples below are catalog JSON, not source. Fix the entry's signature in the producer file.",
        example_valid: "{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{\"id\":\"trim\",\"owner\":\"t\",\"kind\":\"builtin\",\"signature\":\"trim(value:S)->text\",\"effects\":\"pure\",\"availability\":\"implemented\"}]}",
        example_invalid: "{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{\"id\":\"w\",\"owner\":\"t\",\"kind\":\"builtin\",\"signature\":\"not a signature\",\"effects\":\"pure\",\"availability\":\"implemented\"}]}",
    },
    CodeInfo {
        code: "E7001",
        title: "cli-usage",
        severity: Severity::Error,
        explanation: "`can` argument error: unknown command, unknown flag, bad `--format` value, misplaced `--check`, or a missing/wrong operand. Exit status is 2. Run `can --help` or `can <COMMAND> --help`.",
        example_valid: "can check main.can --format=json",
        example_invalid: "can check main.can --format=yaml",
    },
    CodeInfo {
        code: "E7002",
        title: "unreadable-input",
        severity: Severity::Error,
        explanation: "An input file could not be read (missing, unreadable or invalid UTF-8). Exit status is 2. Check the path and permissions.",
        example_valid: "can check main.can",
        example_invalid: "can check does-not-exist.can",
    },
    CodeInfo {
        code: "E7003",
        title: "unknown-code",
        severity: Severity::Error,
        explanation: "`can explain` was given a code that is not in this catalog. Exit status is 2. Pick one of the listed known codes.",
        example_valid: "can explain E1001",
        example_invalid: "can explain E9999",
    },
    CodeInfo {
        code: "E7004",
        title: "missing-producer",
        severity: Severity::Error,
        explanation: "`can run|test|build|deploy` are thin lane-7 entries that exec the `can-platform` CLI with argument passthrough. It was not found on PATH and `CAN_PLATFORM_BIN` is unset. Install the lane-7 producer or set `CAN_PLATFORM_BIN`. `can` never embeds a second platform engine.",
        example_valid: "CAN_PLATFORM_BIN=/usr/local/bin/can-platform can run",
        example_invalid: "can run   # without can-platform installed",
    },
    CodeInfo {
        code: "E7005",
        title: "formatter-unimplemented",
        severity: Severity::Error,
        explanation: "`can fmt` needs the lossless CST formatter (slice 2b). Until then it reports this error and never a false clean. Exit status is 2.",
        example_valid: "can check main.can",
        example_invalid: "can fmt --check main.can   # until slice 2b",
    },
    CodeInfo {
        code: "E7006",
        title: "analysis-incomplete",
        severity: Severity::Error,
        explanation: "A check-pipeline pass did not run, so the result reports `complete=false`. The production pipeline always runs every pass; this fires only when a pass is skipped. Run the full `can check`.",
        example_valid: "can check main.can",
        example_invalid: "can check main.can   # with a pass skipped (internal)",
    },
    CodeInfo {
        code: "I1001",
        title: "unused-symbol",
        severity: Severity::Info,
        explanation: "Reserved placeholder: not emitted in this build. A later analysis stage will emit it for a proven unused pure local or private symbol. Informational only and kept out of default build output.",
        example_valid: "do\n let total = 1\n return total",
        example_invalid: "do\n let total = 1\n return 0",
    },
    CodeInfo {
        code: "I1002",
        title: "redundant-default",
        severity: Severity::Info,
        explanation: "Reserved placeholder: not emitted in this build. A later analysis stage will emit it for a redundant equivalent default or guard that can be removed without changing meaning. Informational only; source-reduction hints appear only when equivalence and reachability are established.",
        example_valid: "lock Todo fields=title",
        example_invalid: "lock Todo fields=title when=true",
    },
    CodeInfo {
        code: "W1001",
        title: "unreachable-effect",
        severity: Severity::Warning,
        explanation: "Reserved placeholder: not emitted in this build. A later analysis stage will emit it when the accepted control-flow rules prove an operation path can never execute (e.g. after unconditional termination or a literal-false guard). Does not block output. Fix by removing the dead path or correcting the decisive guard named in the diagnostic.",
        example_valid: "do\n require ok\n create Todo {title=\"t\"} as row",
        example_invalid: "do\n return 1\n create Todo {title=\"t\"} as row",
    },
    CodeInfo {
        code: "W2001",
        title: "suspicious-shadowing",
        severity: Severity::Warning,
        explanation: "Reserved placeholder: not emitted in this build. A later analysis stage will emit it (opt-in until precise low-noise detection ships) when a local declaration hides an outer same-named value actually referenced nearby. Disjoint scopes and canonical contextual names are excluded.",
        example_valid: "do\n let total = 1\n return total",
        example_invalid: "do\n let user = owner\n let user = other\n return user",
    },
    CodeInfo {
        code: "W3001",
        title: "deprecated-capability",
        severity: Severity::Warning,
        explanation: "Reserved placeholder: not emitted in this build. A later stage will emit it when a linked producer catalog marks a still-supported operation/construct deprecated and names a replacement. Migrate to the canonical replacement; removed capabilities are errors, never this warning.",
        example_valid: "call store.v2.save {row=row}",
        example_invalid: "call store.v1.save {row=row}",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sorted_unique_and_covers_policy_ranges() {
        let codes: Vec<_> = CATALOG.iter().map(|info| info.code).collect();
        let mut sorted = codes.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(codes, sorted, "catalog must be sorted with unique codes");
        for prefix in [
            "E1", "E2", "E3", "E4", "E5", "E6", "E7", "W1", "W2", "W3", "I1",
        ] {
            assert!(
                codes.iter().any(|code| code.starts_with(prefix)),
                "missing range {prefix}"
            );
        }
    }

    #[test]
    fn lookup_normalizes_case_and_whitespace() {
        assert_eq!(lookup("e1001").unwrap().code, "E1001");
        assert_eq!(lookup("  E7003\n").unwrap().code, "E7003");
        assert!(lookup("E9999").is_none());
        assert!(lookup("").is_none());
    }

    #[test]
    fn json_shape_has_all_fields() {
        let json = entry_to_json(&CATALOG[0]);
        assert!(!json.contains('\n'));
        for field in [
            "\"code\":\"E1001\"",
            "\"title\":",
            "\"severity\":\"error\"",
            "\"explanation\":",
            "\"example_valid\":",
            "\"example_invalid\":",
        ] {
            assert!(json.contains(field), "missing {field} in {json}");
        }
    }
}
