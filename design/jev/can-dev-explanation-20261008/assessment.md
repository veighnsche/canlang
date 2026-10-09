# Can dev failure explanation consultation — 2026-10-08

This is advice on a proposed first debugging increment, not a test or an accepted API. The three requests independently reword the same verified state and compare the same four routes: improve the static catalog, compose a deterministic current-occurrence explanation, use Jev as the primary hypothesis guide, or expose existing outputs in one session first. Exact requests and complete model replies are saved alongside this note.

| Request | Preferred route | Route probability | Confidence | Session-only probability |
| --- | --- | ---: | ---: | ---: |
| [01](01-result.json) | Contextual occurrence | 0.61 | 0.48 | 0.31 |
| [02](02-result.json) | Contextual occurrence | 0.70 | 0.61 | 0.13 |
| [03](03-result.json) | Contextual occurrence | 0.72 | 0.63 | 0.25 |

Jev consistently prefers joining existing diagnostic, source and runtime evidence for a specific failure. Its first confidence is moderate, and the session-only option retains 0.13–0.31 probability, so this is directional advice rather than a decisive architecture verdict. The replies supply no rationale. The alternatives' engineering costs and benefit to agents are unmeasured; their wording may influence the distributions.

Source inspection supports the recommendation at a narrower scope. `compiler/src/diagnostic.rs` already pins source hashes, stable spans and completeness; `compiler/src/explain.rs` provides generic code meanings; `packages/cloudflare/src/runtime/invoke.ts` maps some thrown frames; `packages/cloudflare/src/dev/local-run.ts` exposes only in-process dispatch; `packages/interfaces/src/errors/envelope.ts` keeps public business errors safe. A dev-only occurrence view can join these existing facts and say when a source, trace or cause is missing. Jev remains an optional adviser over that view, with its probabilities and evidence revision retained separately from observed outcomes.

Open choices: exact incident schema and owner, supported runtime trace points, safe local visibility/redaction, live-session transport, and whether the resulting workflow measurably reduces debugging turns and tokens. No `can dev` command or explanation service was implemented by this consultation.
