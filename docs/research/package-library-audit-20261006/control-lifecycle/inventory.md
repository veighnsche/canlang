# Resource owner inventory

Planning, exact source pin `fecf84196e38679646d221ee18aa4383ed0d0e83`. Invariants are obligations to preserve or qualify, not automatic proof. Each catalog entry links create/use/terminal/disposal behavior, explicit restart rule, source-derived scenarios and stage limitations. All scenarios are unexecuted.

| ID | Resource owner | Stage | Detailed source |
| --- | --- | --- | --- |
| LSW-01 | State storage adapters | current TS | [state-work.json](state-work.json) |
| LSW-02 | State mutation executor | current TS | [state-work.json](state-work.json) |
| LSW-03 | State invoke/admission | current TS | [state-work.json](state-work.json) |
| LSW-04 | State fresh fence scopes and live authority | current TS | [state-work.json](state-work.json) |
| LSW-05 | State privileged system registry | current TS | [state-work.json](state-work.json) |
| LSW-06 | State/Work joined outbox staging | current TS | [state-work.json](state-work.json) |
| LSW-07 | Work durable dispatch claim + TS driver | current TS | [state-work.json](state-work.json) |
| LSW-08 | Provider outcome/retry/reconciliation owner | current TS | [state-work.json](state-work.json) |
| LSW-09 | Work occurrence receipt owner | current TS | [state-work.json](state-work.json) |
| LSW-10 | Work keyed schedule and supersession owner | current TS | [state-work.json](state-work.json) |
| LSW-11 | Work recurring slot tracker | current TS | [state-work.json](state-work.json) |
| LSW-12 | Recovery planner and owner acts | current TS | [state-work.json](state-work.json) |
| LSW-13 | Receipt association/progress/terminal notification | current TS | [state-work.json](state-work.json) |
| LSW-14 | State receipt read/grant/content snapshot | current TS | [state-work.json](state-work.json) |
| LSW-15 | State frozen fanout membership/admission cursor | current TS | [state-work.json](state-work.json) |
| LSW-16 | Fanout child live lifecycle/claim/body facts | current TS | [state-work.json](state-work.json) |
| LSW-17 | Fanout terminal outcome + checkpoint atomic unit | current TS | [state-work.json](state-work.json) |
| LSW-18 | Fanout stale release/scheduler cursors | current TS | [state-work.json](state-work.json) |
| LSW-19 | Fanout progress/cancellation projection | current TS | [state-work.json](state-work.json) |
| LSW-20 | State migration shadow/progress/failure/installed pointer | current TS | [state-work.json](state-work.json) |
| LSW-21 | Proposed Work host call-local payload references | candidate only | [state-work.json](state-work.json) |
| LSW-22 | Owner retention/lifetime/limits; absent quota/subscriptions | current TS | [state-work.json](state-work.json) |
| LI01 | identity accounts/users/teams | P1/P2 | [identity-files.json](identity-files.json) |
| LI02 | identity passwords/temporary crypto | P1/P3 | [identity-files.json](identity-files.json) |
| LI03 | identity verification tokens | P1/P2 | [identity-files.json](identity-files.json) |
| LI04 | identity recovery/rotation cascade | P1/P2 | [identity-files.json](identity-files.json) |
| LI05 | identity sessions/cookie copies | P1/P2/P3 | [identity-files.json](identity-files.json) |
| LI06 | identity presessions | P1/P2 | [identity-files.json](identity-files.json) |
| LI07 | identity derived CSRF | P1/P2 | [identity-files.json](identity-files.json) |
| LI08 | identity OAuth public clients | P1/P2 | [identity-files.json](identity-files.json) |
| LI09 | identity OAuth authorization codes | P1/P2 | [identity-files.json](identity-files.json) |
| LI10 | identity MCP grants | P1/P3 | [identity-files.json](identity-files.json) |
| LI11 | identity invitations | P1/P2 | [identity-files.json](identity-files.json) |
| LI12 | identity memberships/roles/last owner | P1/P2/P3 | [identity-files.json](identity-files.json) |
| LI13 | identity selected-team hints | P1/P2 | [identity-files.json](identity-files.json) |
| LI14 | identity admitted contexts/live rereads | P1/P2 | [identity-files.json](identity-files.json) |
| LI15 | identity D1 schema/store/host ports | P3 | [identity-files.json](identity-files.json) |
| LF01 | files upload intents/slots/retry index | P1/P2 | [identity-files.json](identity-files.json) |
| LF02 | files staging/chunks/counts | P1/P2 | [identity-files.json](identity-files.json) |
| LF03 | files finalized immutable bytes/metadata | P1/P2 | [identity-files.json](identity-files.json) |
| LF04 | files provider slots/verified events | P1/P2 | [identity-files.json](identity-files.json) |
| LF05 | files attachment links/read/download | P1/P2 | [identity-files.json](identity-files.json) |
| LF06 | files expiry/GC/replay tombstones | P1/P2 | [identity-files.json](identity-files.json) |
| LF07 | files FS root/temp/path/handles | P1 | [identity-files.json](identity-files.json) |
| LF08 | files quota/reservation capability | P2 | [identity-files.json](identity-files.json) |
| LF09 | files principals/bridge-origin/upload auth joint | P1/P2 | [identity-files.json](identity-files.json) |
| SV01 | services HTTP request | TS | [services-delivery.json](services-delivery.json) |
| SV02 | services bounded body reader | TS | [services-delivery.json](services-delivery.json) |
| SV03 | services redirect chain | TS | [services-delivery.json](services-delivery.json) |
| SV04 | mail delivery / finalized attachment metadata | TS | [services-delivery.json](services-delivery.json) |
| SV05 | SystemOne batch delivery | TS | [services-delivery.json](services-delivery.json) |
| SV06 | Ollama final-only generation | TS | [services-delivery.json](services-delivery.json) |
| SV07 | Ollama run handle / NDJSON / snapshot tail | TS | [services-delivery.json](services-delivery.json) |
| SV08 | ComfyUI submit/job identity | TS | [services-delivery.json](services-delivery.json) |
| SV09 | ComfyUI poll/download/cancel | TS | [services-delivery.json](services-delivery.json) |
| SV10 | pagination borrowed provider call | TS | [services-delivery.json](services-delivery.json) |
| SV11 | controlled local HTTP harnesses | fixture | [services-delivery.json](services-delivery.json) |
| SV12 | contract-only / absent provider families | absent | [services-delivery.json](services-delivery.json) |
| CF01 | TS portable bundle / Bun scratch builds | TS | [services-delivery.json](services-delivery.json) |
| CF02 | confirmed deploy writer and Wrangler child | TS | [services-delivery.json](services-delivery.json) |
| CF03 | upgrade rehearsal / borrowed activation gates | rehearsal | [services-delivery.json](services-delivery.json) |
| CF04 | native preparation process / grace timer | held | [services-delivery.json](services-delivery.json) |
| CF05 | native framed retained session | held | [services-delivery.json](services-delivery.json) |
| CF06 | private PublicationSession staging | held | [services-delivery.json](services-delivery.json) |
| CF07 | CLI assembly scratch / local workerd scope | TS | [services-delivery.json](services-delivery.json) |
| CF08 | release build/package/integrity artifacts | release | [services-delivery.json](services-delivery.json) |
| LR01 | UI poll region timer/controller/body | current TS | [root-review.json](root-review.json) |
| LR02 | UI document registry, binders and listener leases | current TS | [root-review.json](root-review.json) |
| LR03 | UI once-action settle listener | browser helper; actual completion join unproved | [root-review.json](root-review.json) |
| LR04 | UI form operation and upload progress | generated client helper; full installed caller qualification remains separate | [root-review.json](root-review.json) |
| LR05 | UI private CSV preview and per-row replay selections | current TS | [root-review.json](root-review.json) |
| LR06 | UI export request/result/download leases | current TS | [root-review.json](root-review.json) |
| LR07 | UI print and instrumentation submission | current TS | [root-review.json](root-review.json) |
| LR08 | Interfaces incoming body reader and capped buffer | current TS | [root-review.json](root-review.json) |
| LR09 | Interfaces finite public asset table | current TS | [root-review.json](root-review.json) |
| LR10 | Interfaces per-request export/print/page projection | current TS | [root-review.json](root-review.json) |
| LR11 | Interfaces verified ingress and durable intake handoff | current TS | [root-review.json](root-review.json) |
| LR12 | Interfaces per-request MCP SDK transport/controller lease | current TS | [root-review.json](root-review.json) |
| LR13 | Cloudflare canonical descriptor cache and producer registry | current TS | [root-review.json](root-review.json) |
| LR14 | Cloudflare schema/bootstrap/host store bindings | current TS | [root-review.json](root-review.json) |
| LR15 | Values owned input issuance and request conversion arena | bindings + finite exact Wasm surface; arbitrary owner validation remains unjoined | [root-review.json](root-review.json) |
| LR16 | Values host plan/default/provenance registries | prepared private hook; full native producer-consumer unjoined | [root-review.json](root-review.json) |
| LR17 | Values native handles/generations/owner capabilities | private TS registry + Rust/profile scaffold | [root-review.json](root-review.json) |
| LR18 | Values generated Wasm singleton/memory/asset pin | current TS | [root-review.json](root-review.json) |
| LR19 | Values host ICU formatter caches | current TS | [root-review.json](root-review.json) |
| LR20 | Values/stdlib local traversal, validation and evaluation order | current TS | [root-review.json](root-review.json) |
| LR21 | Testkit row scope/database/Miniflare disposal | test tooling, not production mutation owner | [root-review.json](root-review.json) |
| LR22 | Testkit fixture graph and stashed observation values | test tooling | [root-review.json](root-review.json) |
| LR23 | Contracts and facade-declared external resources | contract-only | [root-review.json](root-review.json) |
| LR24 | UI request-local markup/options and Interfaces ordered mutation projection | current TS | [root-review.json](root-review.json) |
| LR25 | State loaded immutable descriptor/prepared-input registry | current TS | [root-review.json](root-review.json) |
| LR26 | Test doubles/playback mutable stores and fixture observation maps | test doubles and playback | [root-review.json](root-review.json) |
| LR27 | Values bounded arithmetic memo and local ICU/type collections | current TS | [root-review.json](root-review.json) |

The searchable [normalized catalog](resources.jsonl) adds consolidated qualifications and restart rules; family IDs are audit references, not new canonical implementation tasks. The [file crosswalk](file-coverage.tsv) and [duty crosswalk](duty-coverage.tsv) retain original caller status. Contextual owner-family links are not assertions of implemented duties.
