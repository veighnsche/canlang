# Development controls

Inspect a verified development session through revision-bound JSON controls, select diagnostics and example failures, and distinguish control success from application readiness.

The `can dev` control protocol selects a canonical workspace and a verified session owner. Commands return one bounded JSON envelope on stdout; human notes use stderr. Success has `{ok:true,command,session,result}`; control refusal has `{ok:false,command,code,detail}`. Exit `0` means the control request completed, `2` is a usage/input failure and `1` is another control failure.

Inspect the nested result for source diagnostics, example failure or preview readiness: control success alone does not imply app success. Use separate `--flag value` tokens, once per flag; `--flag=value` is not accepted. Use `can dev help` to obtain the installed protocol version, command names, required fields and payload schemas.

The separate `can dev ui` command presents the same owner to a person. No-source UI selection attaches only to a verified selected owner.

## Session and revision

Controls identify the selected root, app/source, session and source revision. Read status before acting. Diagnostics and failures are queried for an explicit revision; detail requests refer to indexes/refs from that same result. A revision mismatch is a stale request: refresh status, list current diagnostics or failures, then retry only if the action still makes sense.

### Select a command and owner

The protocol command names are `start`, `discover`, `status`, `check`, `diagnostics`, `diagnostic.detail`, `construct.help`, `construct.rank`, `rank.lookup`, `failure.lookup`, `failure.detail`, `failures`, `preview.status`, `preview.open`, `example.run`, `example.rerun` and `stop`. Common selection flags are `--root`, `--session`, `--app` and `--profile`.

`start` requires exactly one of `--source` or `--capture` and may also select `--compiler`, `--catalog`, `--help-index`, `--preview-roles` and `--check-mode`. `start` does not accept `--session` or `--profile`; a capture already fixes root/tool inputs and cannot be combined with `--root`, `--compiler`, `--catalog` or `--help-index`.

`can dev ui --source Tasks.can` uses the start selection; without source/capture it uses discovery selection. UI also accepts `--plain`. `--preview-roles` takes a JSON object mapping seeded actor labels `Ava`, `Ben`, `Cal` or `Dee` to arrays of declared role names; it does not grant production roles. `can dev help` lists command-specific flags and required values; do not construct private socket requests or infer a session identifier from a path.

### Select the current diagnostic or failure

Typical read controls use `diagnostics --revision rN`, `diagnostic.detail --revision rN --index N`, `construct.help --revision rN --id can.v1.CONSTRUCT`, `construct.rank --revision rN --index N`, `rank.lookup --revision rN --ref SHA256`, `failures --revision rN`, and `failure.lookup --ref SESSION/rN/dN`. `example.run` requires `--expected-revision rN`; the optional `--operation NAME` and zero-based `--row N` must be supplied together to select a case.

`example.rerun` requires an occurrence `--ref`. `failure.detail` also requires `--ref`. Diagnostic indexes are zero-based. `diagnostics` and `failures` support `--after` (initial cursor `-1`) and `--limit` from `1` to `25`. `check` optionally guards with `--expected-revision rN`; `construct.rank` accepts `--author-intent` up to 240 UTF-16 code units without control characters.

Treat identifiers as returned protocol data, not values to guess.

## Examples and failures

An example run is bound to an expected source revision and optional operation/row selection. A rerun references a failure occurrence from the same session. Reports are bounded and redact business values. If the source changed, do not replay a failure against the new revision without first checking that the scenario and its preconditions still apply.

Failure lookup uses an opaque session/revision reference. Detail access is scoped to that owner and may omit private runtime data. A missing or unavailable owner means no control action was performed; resolve session ownership before trying again.

## Development behavior

The terminal's check mode is manual by default; start with `--check-mode automatic` to enable saved-source refresh. A coherent replacement is published only after its build and required runtime resources are ready. A failed rebuild retains the last valid preview with its serving revision identifiable. Newer diagnostics do not imply a newer serving build; inspect source/check/build/serving revision fields separately. See [local development](../01-Get-started/06-local-development.md) for the human workflow and [diagnostics and help](../11-Verify-and-build/01-diagnostics-and-help.md) for source repair.
