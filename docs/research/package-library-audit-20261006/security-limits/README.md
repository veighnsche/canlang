# Security and resource enforcement audit

Planning audit at `d83d11f6c7e88ba03848fba89de8dd4354d2ae72`. Implementation remains deferred. Local Sol high source review identified **63 enforcement surfaces and 29 prioritized candidate findings**. The count includes confirmed source gaps, conditional host hazards, missing consumer controls and held adoption gates; it is not a count of exploited vulnerabilities. Seven P1 conclusions are provisional pending the requested focused Astra review. No new security mechanism, budget threshold, task completion or production acceptance is selected.

The first review/repair priorities are:

1. **Secret/result projection:** generated CRUD returns the full changed row. A `random_secret` default is an ordinary hex string; the canonical HTTP result and separately supported public-read policy can expose it without the required secret metadata/projection. This needs compatible configured producers and serving joins; no compiled/deployed witness was run. Preserve private engine rows where required, while enforcing confidentiality at real client boundaries.
2. **Actual grant admission and lifetime:** `POST /mcp/grants` is routed before assembled HTTP middleware. It authenticates the cookie and membership, but then uses uncapped `req.json()` without the usual session CSRF/origin checks. A suspended body can outlive a sign-out and mint a new grant from the earlier identity snapshot. Cookie/SOP controls narrow browser scenarios; the audit does not prove bearer theft or a State commit bypass.
3. **Owner correspondence and existing identity atomicity:** a shared mixed-owner store is not scoped by the caller's receipt-owner metadata; an isolated owner store defeats that witness. Exported single-use primitives discard zero-row consume outcomes, and last-owner/recovery cascades remain non-atomic. Full auth/team-management serving is not newly demonstrated.
4. **Limits at costly operations:** bounded body/result sizes do not establish bounded recursive hashes, whole-store scans, complete fanout allocation, native frame construction or provider lifetime. Correct SystemOne's configured UTF8-byte mismatch independently; freeze the other missing resource profiles before choosing thresholds.
5. **Real sink refusal:** selected deployment writing follows existing symlinks, and safe provider specificity can preserve confidential lower-case bearer/account text. Held native/publication helpers have additional queue/deadline/review-byte gates; their presence is not current CLI adoption.

[Findings](findings.jsonl) retain exact original task/rule references, source witnesses, prerequisites, strongest counterevidence and proposed acceptance. [Enforcement map](enforcement.jsonl) traces actual owners/callers and separates guard, limit and missing-control claims. [Proposed fix queue](fix-queue.json) groups existing obligations without adding canonical tasks or authorizing implementation.

## Prioritized findings

P1 marks critical confidentiality/authority outcomes under the stated prerequisites; P2 marks bounded defects or missing controls; P3 marks conditional trust/scaffold hardening. Priority is not a CVSS score or a claim of hostile public reachability. All scenarios below are unexecuted.

| ID | Priority | Finding | Actual stage / prerequisite |
| --- | --- | --- | --- |
| SI01 | P1 | Production grant issuance lacks CSRF/origin and bounded body admission | Actual special production grant route when joins present |
| SI02 | P1 | Lookup then void consume permits two single-use winners | Exported D1 primitives; full auth/OAuth routes unmounted |
| SI03 | P1 | Last-owner and recovery cascades are not atomic enforcement | Exported routines; mounted team management unproved |
| SI04 | P1 | Live-read checks do not cover later credential/authority effects | Grant mint current; other commit/upload arms conditional |
| SI08 | P1 | Upload intent accepts structurally valid unavailable operation or field | Exported upload helper; actual dispatcher never calls kernel |
| SSW01 | P1 | Generated CRUD and supported public read can disclose server secret bytes | Configured canonical CRUD/read serving; not deployed qualification |
| SSW03 | P1 | Mixed-owner injected store has no enforced tenant row separation | Only a mixed-owner injected store; isolation may defeat witness |
| SEC-C01 | P2 | Selected text deployment writer containment | Selected confirmed local CLI writer; existing symlink prerequisite |
| SEC-C03 | P2 | Bun build process and scratch bound | Selected local synchronous Bun build |
| SEC-C04 | P2 | Native session aggregate queue/diagnostics/wholejob resource gate | Held native session adoption gate |
| SEC-C06 | P2 | Publication helper reviewed bytes bypass by disk drift | Held publication helper; current CLI not this helper |
| SEC-S01 | P2 | SystemOne configured request byte cap | Current configured SystemOne byte cap |
| SEC-S02 | P2 | Provider error specificity privacy | Current safe provider errors/detail with confidential upstream text |
| SI05 | P2 | Malformed or missing PKCE verifier can succeed against matching challenge | Exported/unmounted OAuth flow |
| SI06 | P2 | Login presession bearer is not browser/origin bound | Unmounted login handler; existing design blocker |
| SI07 | P2 | MCP SDK origin refusal is disabled by current transport options | Mounted valid-bearer MCP; origin policy unresolved |
| SI09 | P2 | Durable append crash can bypass exact declared transfer count | Conditional independently persistent blob/metadata crash |
| SI10 | P2 | Attachment precheck and downloads lack full current retention/record authority join | Local primitives; actual authorized download/lifetime join missing |
| SI11 | P2 | Ingress types do not enforce verified occurrence age, replay or effect correlation | Trusted verifier/sink and ingress producer unjoined |
| SR02 | P2 | CSV row ceiling is not parser allocation ceiling | Current shared parser; actual HTTP outer cap remains |
| SSW02 | P2 | Streaming body bytes do not bound recursive pre-authorization hash work | Authenticated bounded HTTP/canonical input |
| SSW04 | P2 | Query/recovery returned limit is not bounded scanning or memory | Canonical reads/private recovery; actual storage work |
| SSW05 | P2 | Fanout page/chunk bounds leave whole cohort and progress allocation unbounded | Configured fanout producer; full membership required |
| SSW06 | P2 | Retry horizon cannot interrupt hung provider/evidence promises | Private provider port without its own deadline |
| SEC-C02 | P3 | Artifact namespace collision with platform bootstrap | Caller-admitted local artifact namespace; compiler output unproved |
| SEC-C05 | P3 | Semantic admitted tree budgets versus allocation claims | Held/native tree admission; final refusal remains |
| SR01 | P3 | Native semantic budgets run after initial frame allocation | Private validation profile; public native adoption absent |
| SR03 | P3 | CSV URL props need explicit trusted-route or sink policy | Conditional tainted route props; no producer proved |
| SSW07 | P3 | SQL field metadata lookup admits inherited names as columns | Trusted internal query metadata; no SQL injection proved |

## Existing controls and limits retained

Ordinary HTTP operations stream-cap JSON/form bodies at 1 MiB, authenticate the caller, verify CSRF and frame declared inputs. Canonical operations retain business authority, bound-ref checks, commit revision fences and safe errors at their proved scope. Result limits intentionally refuse overflow rather than silently truncate complete business sets. These controls are not credited to the special grant route without actual wiring.

Services explicitly check configured same origin at every manual redirect, use a whole-response deadline and a real response-byte cap, omit browser credentials and do not retry automatically. Server bindings own provider origin/credentials; no generic user-origin SSRF is demonstrated. Binary/file helpers retain exact receiver/provenance and positive per-transfer policies; missing durable/record/retention joins remain visible.

UI text/attribute escaping and central unsafe-scheme/formula refusal remain useful small policies. Public write-only instrumentation intake deliberately does not require session CSRF; it binds the key to a project and applies body/text/age/rate bounds. Report truncation is not a confidentiality/redaction guarantee. TypeScript contracts and stdlib re-exports are not extra runtime enforcement. Testkit executable fixtures retain developer-tool trust and do not establish production identity or sandboxing.

## Library defaults at the real seams

| Mechanism | Source evidence | Qualification |
| --- | --- | --- |
| MCP SDK 1.32.0 | Exact installed source defaults to a 4 MiB body ceiling and 100 batch entries. DNS/Origin protection defaults off; Can selects JSON response mode without enabling it. | Valid bearer required; no cookie fallback/auth bypass proved. No SDK/host execution or integrity attestation. |
| csv-parse 7.0.3 | Can selects strict quote handling and safe errors. Omitted `max_record_size` becomes zero, disabling that record-size check; all records are parsed before Can's 1000-row refusal. | Version-tagged primary source was read; this checkout has no selected installed CSV copy. Actual Interfaces transport cap remains, and current first-error behavior must survive future bounds. |
| Source-map codec 1.6.0 | Exact locally installed source inspected; Can supplies stricter numeric/shape/admission checks around a permissive codec. | Raw source-map identity/refusal requirements remain; package defaults alone do not qualify staged diagnostics. |
| Import lexer, MagicString, remapping | Current version declarations and explicit import admission/external-loader settings were traced. | Selected declared copies were not locally linked; older transitive defaults are not substituted as current proof. |
| Global fetch / AbortSignal | Can owns redirect, deadline, body and signal policy. | Locally installed Undici is separate from the selected global fetch host; its defaults do not establish deployed limits. |
| Serde/native framing | Can's finite frame/semantic refusal is retained at its actual native/held stage. | Semantic limits may occur after allocation. No numeric Serde recursion default, peak-heap ceiling or public native adoption is credited. |
| Miniflare D1 primary | Local installed source corroborates a success result with zero affected rows. | Can's void wrappers discard the winner result; hosted D1/concurrent execution is not claimed. |

CSV primary sources: [7.0.3 option normalization](https://raw.githubusercontent.com/adaltas/node-csv/csv-parse@7.0.3/packages/csv-parse/lib/api/normalize_options.js), [7.0.3 record-size check](https://raw.githubusercontent.com/adaltas/node-csv/csv-parse@7.0.3/packages/csv-parse/lib/api/index.js). The machine [source index](sources.json) separates frozen Git, exact local library bytes and online version-tagged evidence. No dependency was installed or instantiated.

## Review and verification

Three reused Sol high reviewers audited identity/files/Interfaces, Services/Cloudflare delivery, and State/Work; originating Codex traced Values/UI and consolidated actual callers. Two additional visible-conclusion Sol high source challenges covered seven root/grant cases and four identity/files cases. They corrected mounted team-management and upload-caller overclaims; this is independent source challenge, not cleanroom security certification. See [root/grant review](review-root-grant.json), [identity review](review-identity.json) and [reconciliation](review-reconciliation.json).

**The requested Astra high review is not complete.** In-chat reviewer creation hit the agent limit; automatic approval review rejected the CLI attempt before process launch because sending private repository source/design to OpenAI requires explicit approval for this payload and destination. The approval question is pending. Twenty-four frozen source excerpts were prepared locally for the bounded confidentiality/owner/credential review; no CLI review or egress occurred and no alternative route bypassed the rejection. [Review status](review-status.json) preserves that limitation.

The inherited [395-file crosswalk](file-coverage.tsv) and [316-duty crosswalk](duty-coverage.tsv) retain caller stage and contextual owner coverage. They do not claim every file body, library vulnerability, host quota, generated application or deployed path has been exhaustively proved. [Verification](verification.json) checks source hashes, line bounds, IDs, coverage and local artifact links using only standard Python and read-only Git. It executes no package tests, builds, parser, SDK, Rust, network consumer or security witness.

[Proposed decisions](proposed-decisions.md) retain unresolved owner policies and required handoffs. No consequential new mechanism was chosen, so prior JEV consultations are not repeated. This audit changes documentation only, preserves the compiler agent and shared DECISIONS ownership, and does not advance a living-filetree merge checkpoint.
