# Syntax and analysis probe evidence

Read-only compiler investigation at HEAD `309644a`, 2026-10-06. Only these evidence files were added. The initial dirty `docs/specification/DECISIONS.md` and Rust port execution records were not touched. Compiler source was not edited.

The probes call the public `analysis::check_program` API without a catalog, using typed field defaults to reach literal validation. The panic is caught solely so the remaining cases run; it is not a successful compiler outcome. The library was freshly compiled from the current unchanged compiler source into `/tmp`; no existing build artifact is required to reproduce.

Run from `/Users/vince/Projects/canlang`:

```sh
CARGO_MANIFEST_DIR=/Users/vince/Projects/canlang/compiler CARGO_PKG_VERSION=0.1.0 rustc --crate-name canlang_compiler --crate-type rlib --edition=2024 compiler/src/lib.rs -o /tmp/libcanlang_compiler-audit.rlib
rustc --edition=2024 docs/research/compiler-library-audit-20261006/evidence/syntax-analysis/url-probe.rs --extern canlang_compiler=/tmp/libcanlang_compiler-audit.rlib -o /tmp/can-url-audit-current
/tmp/can-url-audit-current > docs/research/compiler-library-audit-20261006/evidence/syntax-analysis/url-probe.out.txt 2>&1
rustc --edition=2024 docs/research/compiler-library-audit-20261006/evidence/syntax-analysis/locale-probe.rs --extern canlang_compiler=/tmp/libcanlang_compiler-audit.rlib -o /tmp/can-locale-audit
/tmp/can-locale-audit > docs/research/compiler-library-audit-20261006/evidence/syntax-analysis/locale-probe.out.txt 2>&1
node docs/research/compiler-library-audit-20261006/evidence/syntax-analysis/host-parity.mjs > docs/research/compiler-library-audit-20261006/evidence/syntax-analysis/host-parity.out.txt 2>&1
```

Observed toolchain: `rustc 1.99.0 (b940084d7 2026-09-28)`; Node `v24.21.0`.

`host-parity.mjs` calls the same host primitives used by the current TypeScript value owner: `Intl.getCanonicalLocales` (`packages/values/src/locale.ts:16`) and `new URL` with HTTP(S) protocol admission (`packages/values/src/wire.ts:479`). It does not execute those package exports or prove a future Rust shared-value API. Host-versus-compiler differences are compatibility evidence, not authority to change Can policy.

The compiler's URL literal validator applies trusted-origin-like restrictions to ordinary `url` values (`compiler/src/analysis/types.rs:15433`), including a userinfo ban. The wire value owner explicitly allows userinfo (`packages/values/src/wire.ts:475`). The proposed boundary is to reuse standard parsing under separately specified value/origin policy, with conformance cases; no dependency or frozen shared-core boundary was changed.
