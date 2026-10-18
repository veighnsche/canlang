# Build scheduling and local cache

Turbo schedules TypeScript producers from their declared package dependencies. Each producer owns its emitted files and incremental state. Cleaning owned outputs before restoration prevents a cache hit from leaving obsolete files from a different build. Separately generated native assets and catalogs keep their own owners.

Typechecks and tests consume built producers. Compiler and native generation commands use their owning build tools; the editor extension has its own package. Use the commands in the current root `package.json` and [development setup](../../dev-setup.md).

Cache behavior should preserve the same outputs and executable modes as an ordinary build, invalidate affected dependents when inputs change, and stop dependent tasks when a producer fails. A cache hit is a build optimization, not a substitute for a behavior check.
