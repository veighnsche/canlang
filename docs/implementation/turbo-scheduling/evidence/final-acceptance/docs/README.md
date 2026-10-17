# Current documentation command review

Reviewed README, developer setup, installation, e2e running instructions and
all owning package READMEs against the actual root/package manifests,
`scripts/run-tasks.mjs`, `scripts/build-package.mjs`, `turbo.json`, release
implementation and compiled e2e loader.

Corrections: replace stale direct TypeScript/manual dependency ordering in
owning script tables with public filtered root builds and owning uncached
check/test wrappers; replace work’s npm/worktree instructions with frozen Bun
install; document catalog and release checks, their prepared output graph and
scope; clarify compiler-only installation versus required platform runtime;
make compiler/browser prerequisites and automatic producer preparation explicit
for e2e. Historical research, specification and prior qualification evidence
were preserved.

`checks.txt` records public script existence, local Markdown link resolution,
and the scan for obsolete active commands. The four `*-dry.json` files are
actual public-runner Turbo dry runs for interfaces build, catalog, release and e2e.
They establish command/graph resolution on this host, not suite completion,
browser qualification, native-host qualification or product acceptance. No
native builds, application execution or release publishing ran in this review.
