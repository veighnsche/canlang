# Authoring demo: format → rename → complete → fix

One file, four authoring legs, all through the real `can` binary.
The executable version is `compiler/tests/b3_authoring_join.rs`
(`cargo test --test b3_authoring_join`); this page narrates it.

## The fixture

`compiler/tests/data/AuthoringDemo.can` is deliberately sloppy-but-valid — trailing
spaces, tight braces, doubled spaces — and carries one renamable symbol
(`label`: declaration + 2 uses), an expression position for completion,
and one safe-fix site (`task?.title`, rule `redundant-null-marker` /
I1002). It uses no builtins and no migration syntax, so it checks clean
under both the producer catalog and an empty one. The demo mutates a temp
copy; the committed file keeps its drift.

## Leg 1 — format

```console
$ can fmt --check /tmp/demo.can
/tmp/demo.can
exit=10
$ can fmt /tmp/demo.can
exit=0
$ can fmt --check /tmp/demo.can
exit=0
```

The rewrite is whitespace-only (trailing-space strip, `{title:text}` →
`{ title:text }`, doubled-space collapse, `=` tightening); the `?.`
site survives byte-identical.

## Leg 2 — open a session

```console
$ can lsp
→ initialize ⇒ renameProvider, completionProvider, codeActionProvider
→ initialized, textDocument/didOpen
```

## Leg 3 — rename `label` → `caption` on a use-site

`textDocument/rename` at the `return label` use answers exactly 3 edits —
declaration plus both uses, nothing else:

```text
6:7-6:12   -> 'caption'   (let declaration)
7:19-7:24  -> 'caption'   (set-entry use)
8:10-8:15  -> 'caption'   (return use)
```

Apply client-side, `didChange`, and the republished diagnostics carry
zero severity-1 entries.

## Leg 4 — completion in expression scope

`textDocument/completion` on the `return` line answers 58 items including
the visible bindings and keywords:

```text
'task': present    'caption': present    'Todo': present
'complete': present    'and': present
```

## Leg 5 — the safe fix, two paths that agree

`textDocument/codeAction` on the `?.` range answers exactly one action:

```text
title='replace redundant `?.` with `.`' kind='quickfix' newText='.'
```

`can lint --fix --format=json` reports the same fix:

```json
{"rule":"redundant-null-marker","title":"replace redundant `?.` with `.`",
 "file":0,"span":{"start":113,"end":115},
 "expected_sha256":"1d4bb735…","replacement":"."}
```

Splicing the CLI span and applying the LSP edit produce byte-identical
text. After applying:

```console
$ can lint --catalog=… demo.can
exit=0                                    # I1002 gone
$ can check --format=json --catalog=… demo.can
{…,"diagnostics":[],…}
exit=0
$ can fmt --check demo.can
exit=0                                    # fix keeps fmt clean
```

Back on the LSP session the same range now answers `"result":[]`;
`shutdown` ⇒ `null`, `exit` ⇒ status 0.
