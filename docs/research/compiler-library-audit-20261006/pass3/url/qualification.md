# C03U URL candidate qualification (bounded, read-only repository)

Date: 2026-10-07. Candidate: `url = { version = "=2.5.8", default-features = false, features = ["std"] }`. API: `Url::parse(raw)` with no base, followed by `matches!(parsed.scheme(), "http" | "https")`. Never use the parsed serialization as the language value. No handwritten authority parser, whitespace/userinfo restrictions, or origin policy belongs in this adapter.

## Observed closure

29/29 independently specified expected admission outcomes agree across candidate, actual public `decodeValue("url", raw)`, actual direct `encodeValue("url", raw)`, and decode/encode roundtrip. All admitted public outputs retain raw spelling; no candidate panic. Source owner and built exports are current workspace evidence, not a package rebuild or installed tarball. Original 14 URL witnesses plus 15 independently authored edge vectors. Host: Node 24.21.0 / ICU 78.3; Rust 1.99.0, aarch64-apple-darwin. Scratch compiled debug build successfully offline with a writable scratch copy of registry cache/index. Linux/release and final compiler lock closure remain root qualifications.

## Caller closure

Current `analysis/types.rs` lines 15322–15330: `validated_shape(Scalar::Url, raw)` dispatches to `valid_url`. The only two `validated_shape` call sites are `type_literal` contextual string typing (9948, strict branch emits E3001 at tight span of string node) and `inhabit_validated` (14322; trial failure stores tight literal span and message, flushed through overload no-match E3001). Test contextual field/default and call-literal routes. Old `strip_scheme` byte slicing causes the emoji panic; remove its URL use/helper if unused. Old validation comments incorrectly equate ordinary values and app_url trusted origins.

Owning public root `packages/values/src/index.ts:25` exports wire. `wire.ts:479` is `isHttpUrl`, `decodeStringlike:504` checks parser and returns original wire, `encodeStringlike:1632` checks parser and returns original value. Decode invalid strings throws SchemaError (format violation); direct encode throws ValueError with invalid-construction. Compiler keeps E3001 and source span; owner error classes are evidence, not a request to expose them at compile time. `stdlib-pure.ts:210` parseTrustedOrigin and `app_url:252` separately reject userinfo/query/fragment and canonicalize trusted origin construction. Those restrictions must not leak into ordinary URL literals.

## Candidate profile

Official tagged manifest declares url MSRV 1.63, MIT OR Apache-2.0, std default; selected explicit std equals ordinary default without serde/debugger/expose-internals. idna 1.1.0 alloc+compiled_data is selected by url regardless of default-features=false, retaining Unicode validation. Locked scratch graph uses idna_adapter 1.2.2, ICU4X normalizer/properties/data 2.3.0, provider 2.3.1. Maximum declared transitive rust-version is 1.88; several crates omit rust-version, so do not claim verified MSRV 1.88. Host build verifies project baseline Rust1.99. Licenses in published manifests include MIT, Apache-2.0, Unicode-3.0, and unicode-ident `(MIT OR Apache-2.0) AND Unicode-3.0`. See dependency-profile.json and Cargo.lock for exact resolution. Optional serde entries in Cargo.lock do not mean serde feature was enabled. No alternative Unicode backend: 1.0 stub loses non-ASCII admission; 1.1 uses different data/performance; neither is needed here.

Primary sources:
- https://raw.githubusercontent.com/servo/rust-url/v2.5.8/url/Cargo.toml
- https://docs.rs/url/2.5.8/url/struct.Url.html (parse absolute URL, scheme lowercasing)
- https://raw.githubusercontent.com/servo/rust-url/v2.5.8/idna/Cargo.toml
- https://docs.rs/crate/idna_adapter/1.2.2 (backend selection and license)

## Independent vector outcomes

Accepted owner values below retain exactly the displayed input. Escapes are JSON spelling for actual characters. Candidate serialization is recorded in comparison.json solely to show why it must not replace raw source text.

| Case | Authored input (JSON string) | Expected | Public owner | Candidate |
|---|---|---|---|---|
| url_basic | `"https://example.com/path"` | accept | accept | accept |
| url_unicode_panic | `"💥💥💥"` | reject | reject | reject |
| url_bracketed_bad | `"https://[garbage]"` | reject | reject | reject |
| url_port_high | `"https://host:999999"` | reject | reject | reject |
| url_userinfo | `"https://user:pass@example.com"` | accept | accept | accept |
| url_case | `"HTTPS://EXAMPLE.COM/a"` | accept | accept | accept |
| url_unicode_host | `"https://é.example/a"` | accept | accept | accept |
| url_backslash | `"https://example.com\\a"` | accept | accept | accept |
| url_trimmed | `" https://example.com/a "` | accept | accept | accept |
| url_space_path | `"https://example.com/a b"` | accept | accept | accept |
| url_relative | `"/a"` | reject | reject | reject |
| url_non_http | `"ftp://example.com/a"` | reject | reject | reject |
| url_ipv6 | `"https://[::1]:443/a"` | accept | accept | accept |
| url_port_empty | `"https://example.com:/a"` | accept | accept | accept |
| bracket_unclosed | `"https://[::1"` | reject | reject | reject |
| bracket_suffix | `"https://[::1]junk"` | reject | reject | reject |
| port_65535 | `"https://example.com:65535"` | accept | accept | accept |
| port_65536 | `"https://example.com:65536"` | reject | reject | reject |
| port_nondigit | `"https://example.com:abc"` | reject | reject | reject |
| host_missing | `"https://"` | reject | reject | reject |
| proto_relative | `"//example.com/a"` | reject | reject | reject |
| http_no_slashes | `"http:example.com/a"` | accept | accept | accept |
| ascii_tab | `"ht\ttp://example.com/a"` | accept | accept | accept |
| unicode_idna | `"https://faß.de/a"` | accept | accept | accept |
| unicode_joiner | `"https://a‍b.example/a"` | reject | reject | reject |
| unicode_space | `"https://a b.example/a"` | reject | reject | reject |
| ipv4_legacy | `"http://0x7f.1/a"` | accept | accept | accept |
| host_bad_percent | `"https://%zz.example/a"` | reject | reject | reject |
| path_bad_percent | `"https://example.com/%zz"` | accept | accept | accept |

## Limits / JEV need

This is finite admission parity, not proof of every WHATWG string or equivalence between ICU4X Unicode data and Node ICU78.3. No policy conflict appeared: established ordinary-value owner contract determines permissive HTTP(S) admission; trusted-origin policy stays separate. No difficult design decision requires high/JEV on these observations. If a later vector reveals Unicode-data admission disagreement, preserve raw evidence, escalate owner-policy choice to high + three equivalent independent JEV consultations rather than inventing stricter host rules or adding a local Unicode table. JEV advice cannot replace executable parity evidence.

Artifacts: vectors.json (expected independent cases), public-probe.mjs, public-results.json, src/main.rs, rust-results.tsv, comparison.json, Cargo.toml/Cargo.lock, dependency-profile.json. All remain isolated under scratch; no repository files changed/staged/committed and no package builds run.

## Source hashes

- `packages/values/src/wire.ts` sha256 `73832128fd4b2db93d08770836271323d61bed02647ca83fd21bdd9496054f03`
- `packages/values/src/stdlib-pure.ts` sha256 `9bc0c180f1468efbcb1a054c2a23c587e7fef3e3b1fc33abd750d96e74652eff`
- `packages/values/dist/src/index.js` sha256 `51bbc15972a6836a4e1b4cebf6b2bd5b48e34405ff7f09062ad65b449dc1093c`
- `packages/values/dist/src/wire.js` sha256 `2a91e383809915365406990b9896ab5fc042b60e115efcf3fe81a1d7c3171288`
