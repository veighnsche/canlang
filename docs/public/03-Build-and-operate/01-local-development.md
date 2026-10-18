# Local development and diagnostics

Use the compiler for fast source feedback and a protected local development session to inspect the application with real runtime authority.

## Keep the toolchain together

Install once using the same command as the [installation guide](../01-Getting-started/02-installation.md):

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

Open a new terminal and run `can --version`. The standalone bundle supplies the matching compiler, catalog, runtime adapters and local Worker engine automatically. Run the commands below from your own application directory; no repository checkout, manual runtime packages or catalog build is required.

If you are changing CanLang itself, [optional contributor setup](../01-Getting-started/03-contributor-setup.md) explains source builds and runtime overrides. A missing adapter reports `E7004`; when using the release, confirm that `can` resolves to the complete installation rather than an old compiler-only binary or a contributor override.

## Check one small change

```sh
can check Tasks.can
can lint Tasks.can
can fmt --check Tasks.can
can explain E7004
```

Fix the earliest concrete source error, then check again. `check` analyzes source; `lint` adds recommendations after successful analysis. `fmt` without `--check` changes files in place. `lint --fix` reports machine-applicable edits rather than writing them.

For an editor, use the Can extension and compiler-backed diagnostics. Restart the language server after changing the catalog so it loads the new version. Keep file formatting and ordinary comments separate from public description metadata.

## Start a protected preview

Continue with the `Tasks.can` application you saved during installation. These controls create one session for the Tasks app, check its current source and inspect readiness:

```sh
can dev help
can dev start --source Tasks.can --app Tasks
can dev status --app Tasks
can dev check --app Tasks
can dev preview.status --app Tasks
can dev preview.open --app Tasks
```

The control adapter returns JSON. Read the check diagnostics and resolve any source errors before continuing. If preview status is still preparing, request status again after preparation; if it reports failure, inspect that result before opening the preview.

File watching marks the session dirty; `can dev check` performs the rebuild. After saving an edit, run the check again. When preview is ready, run
`can dev preview.open` and open its returned URL; a replacement preview can use
a new local port. Display-only edits retain the application's saved data and login.

Open `result.url` from `preview.open` in your browser. Use the URL exactly as returned: its local port and access token belong to this session. Use an account from `result.actors` to sign in with its returned email and password, then select one of its teams. These are real locally seeded accounts with separate memberships. Their credentials and preview URL belong to this local session; keep them private.

Add a task, open its edit panel and mark it done, then close the panel after saving and archive the task. Check the result after reloading the page. The preview is local, protected and tied to its owning session; it is not a remote deployment or a public sharing URL.

When a declared language or resource requirement is refused, resolve the diagnostic in its owning layer. That refusal is not permission to delete the business requirement.

The complete install supplies the local engine. `can dev` derives D1, Files R2,
KV, queues, Durable Objects and local analytics from checked declarations; no
separate Miniflare or runtime installation is needed. API-only apps can preview
their checked operations without declaring a page. Inspect the check response's
`preview` and `preview_error` before opening a failed build.

Local upload links expire after one hour, and unattached files after 24 hours. Attached files remain available until explicitly deleted. Published-byte cleanup
still requires the authoritative reference census; deleting an association does
not promise immediate physical byte reclamation. See the
[binding scope and limits](https://github.com/veighnsche/canlang/blob/main/docs/implementation/lean-install/local-bindings.md)
for supported root and queue compositions.

## Inspect diagnostics at their revision

After a check, use the returned revision in place of `rN`:

```sh
can dev diagnostics --app Tasks --revision rN
can dev diagnostic.detail --app Tasks --revision rN --index 0
```

Construct help and optional ranking are connected to a concrete diagnostic and captured source revision. Read the compiler-owned signature and supported context; a ranked guess is advice about intent, not proof that a replacement source compiles. Recheck after editing.

The first Tasks app has no attached examples yet. Add them using [application testing](02-testing.md) before requesting an example run; a zero-case result is not a passed test.

A stale-revision response means obtain current status and check the intended source again. Do not submit an edit or example request against a different revision just to clear the error.

## End your session

```sh
can dev stop --app Tasks
```

Stop the session you own when finished. Preview access expires with that owner. If another source has an active session, use the session/root controls from `can dev help` to select the correct owner rather than stopping unrelated work.

If cleanup fails, the owner keeps its session claim and reports
`shutdown_error: "CLEANUP_FAILED"` in status. Retry `can dev stop` for that
session after resolving the failure. New checks are refused once shutdown
begins; a replacement session cannot start until the owner releases its claim.

`can run` has a different role: it assembles modules and reports a local file entry. It does not start the preview listener. Continue with [application testing](02-testing.md) before treating a working page as a completed workflow.
