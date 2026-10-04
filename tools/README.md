# Language tools

## Initial syntax parser

`can_parser.py` uses Python's standard library and the [exact grammar](../GRAMMAR.md). It produces syntax trees with physical start locations, rejects unsupported syntax, and requires no build manifest.

```sh
python3 tools/can_parser.py draft examples
python3 tools/can_parser.py examples/TeamTasks.can --json
python3 -m unittest discover -s tools -p test_can_parser.py
```

The corpus has 44 sources; the focused suite includes corpus parsing and syntax-boundary cases. The parser recognizes inline keyed message values (`"Tasks"@{nl="Taken"}`), translated `#` prose, genuine shared `message` leaves/imports, owner `source` overrides and declaration-local `label=` metadata. Mandatory locale-column tables and detached label bindings are removed. It also handles unnamed preferences and bounded tabs/detail/split/default-filter/page-placement forms. Navigation derives solely from pages; authored nav/link trees are rejected. Syntax acceptance does not resolve imports/names, validate ICU patterns or canonical locale aliases, check types or permissions, render translations, execute migrations, generate an app, or run its inline BDD examples.

## Given invariant spelling migration

`migrate_given_invariants.py` changes only the `require` introducer of a direct Given constraint (`require path: expression`) to `invariant`, including constraints on `preferences`. It uses the parser's lexer and follows ordered Given/When/Then sections across implicit apps and explicit packages. Contextual model names, expression identifiers, strings, `#` descriptions, `##` comments, When/Then guards and migration/backfill guards are preserved. Nested delimiters and semicolon-separated Given leaves retain their original formatting.

```sh
python3 tools/migrate_given_invariants.py
python3 tools/migrate_given_invariants.py draft examples
python3 tools/migrate_given_invariants.py --apply draft examples
python3 -m unittest discover -s tools -p test_migrate_given_invariants.py
```

The default is a dry run over the active `draft/` and `examples/` `.can` sources. Pass files or directories to narrow the scan; only explicit `--apply` writes. The report lists declaration positions and totals, and applying also prints before/after SHA-256 hashes. The tool plans all replacements before writing and refuses a file changed since it was read. Repeating it after migration produces zero replacements. Lexical errors, unordered/incomplete owner sections and malformed old Given constraint prefixes fail the scan; this targeted rewrite does not validate complete language syntax or behavior. Historical files outside the supplied/default paths are untouched.

## JEV caller

`jev.py` uses Python's standard library and the `TYPESAFE_API_KEY` environment variable.
It calls `jev-latest` through the [TypeSafe HTTP API](https://docs.typesafe.ai/api).

```sh
python3 tools/jev.py request.json --context REQUIREMENTS.md --output review.json
```

Repeat `--context` to attach additional files. The output preserves the request,
response, model, confidence, probabilities, and usage without credentials. Each
invocation makes one call and does not overwrite an existing evidence file.

A request contains evidence and focused typed questions. Use `noul` for a yes/no property, `choice` to select among alternatives, or `score` for an ordered rubric. Select the type that fits the question; NOUL is neither exclusive nor the default. The caller already supports these types without code changes. Frame questions and criteria neutrally and supply relevant evidence.

For example, a yes/no property uses NOUL:

```json
{
  "state": "Describe the decision and relevant evidence here.",
  "questions": {
    "decision": {
      "type": "noul",
      "instructions": "Does this proposal preserve the specified operation ordering?",
      "criteria": {
        "true": "The supplied semantics retain the original order of all guards and effects.",
        "false": "The supplied semantics reorder a guard/effect or do not establish preservation."
      }
    }
  }
}
```

NOUL answers have the form `{"type":"noul","noul":0.7}`: the value is the estimated probability of yes, not a selected option or a separate confidence score. Preserve it as returned; an intermediate value remains uncertainty rather than being rounded to a decision. The optional `criteria` map uses `true`/`false`. See the [official NOUL request/response reference](https://docs.typesafe.ai/api#noul).

Follow AGENTS.md: make three fresh semantically equivalent consultations, rewriting all explanatory prose, including context, questions and any criteria. Save each request/response and examine divergent probabilities. Preserve historical requests/responses in their actual format. Python callers can also import `consult(request)` from `jev.py`.
