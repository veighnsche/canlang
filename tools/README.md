# Language tools

## Initial syntax parser

`can_parser.py` uses Python's standard library and the [exact grammar](../docs/specification/GRAMMAR.md). It produces syntax trees with physical start locations, rejects unsupported syntax, and requires no build manifest.

```sh
python3 tools/can_parser.py draft examples
python3 tools/can_parser.py examples/TeamTasks.can --json
```

The parser's historical reference corpus contained 44 sources. That historical corpus count says nothing about current corpus parity: the separate Python prototype is known to drift from current syntax, and parity would require rerunning it against the present corpus and grammar. The parser recognizes inline keyed message values (`"Tasks"@{nl="Taken"}`), translated `#` prose, genuine shared `message` leaves/imports, owner `source` overrides and declaration-local `label=` metadata. Mandatory locale-column tables and detached label bindings are removed. It also handles unnamed preferences and bounded tabs/detail/split/default-filter/page-placement forms. Navigation derives solely from pages; authored nav/link trees are rejected. Syntax acceptance does not resolve imports/names, validate ICU patterns or canonical locale aliases, check types or permissions, render translations, execute migrations, generate an app, or run its inline BDD examples. This Python syntax prototype is separate from the Rust compiler: it does not provide Rust semantic checking, code generation or runtime behavior.

## JEV caller

`jev.py` uses Python's standard library and the `TYPESAFE_API_KEY` environment variable.
It calls `jev-latest` through the [TypeSafe HTTP API](https://docs.typesafe.ai/api).

```sh
python3 tools/jev.py request.json --context REQUIREMENTS.md --output review.json
```

Repeat `--context` to attach additional files. The output preserves the request,
response, model, confidence, probabilities, and usage without credentials. Each
invocation makes one call and does not overwrite an existing output file.

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

Python callers can also import `consult(request)` from `jev.py`.
