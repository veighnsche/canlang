# E007 — Rule authority and interpretation handoff

Status: initial static reconciliation, 2026-10-04. Baseline prefix below is `design/evaluation/baseline-20261004T041647Z/snapshot/`. Live `EVALUATION.md` controls method and the draft-only boundary; frozen sources control evaluated semantics. Later evidence is identified separately.

The product is a proposed language and library contract. Desired MJS is handwritten. Missing compiler, standard library, infrastructure, semantic checker, or execution is **unverified implementation**, never a design failure. Real conflicting contracts and missing required app behavior remain assessable. Company replacement is evaluated across required composed workflows, with one deployment allowed; app count is not a saving.

| Rule / authority | Interpretation for experiments and target comparisons | Citation |
| --- | --- | --- |
| Document precedence (explicit present contract) | REQUIREMENTS owns goals, DESIGN semantics, GRAMMAR exact written form. DECISIONS history is not a parallel specification; do not enforce old MINE/OPEN proposals. User goals are reviewable with evidence but not silently overridden. | DESIGN.md:3; DECISIONS.md:5–9; live EVALUATION.md:100–104 |
| Canonical primitives (user requirement) | CRUD/auth/pages have one source authority; custom scenarios encode actual additional business work. A helper name does not install behavior. Quantify repeated mechanics before proposing syntax. | REQUIREMENTS.md:33–45; DESIGN.md:5 |
| Identity/composition (user outcome; chosen notation) | Implicit package identity is authored app name; `uses` selects product, `use` imports exported owner symbols. File moves preserve identity; app renames do not. Packages do not require separate deployments. | DESIGN.md:15–19,39–45,81–91; DECISIONS.md:13,30 |
| Defaults (user repetition goal; particular choices reviewable) | Workerd/D1/auth/teams/UI/MCP/theme/locale/file baseline is language-version pinned. Stored models default team, not permissions. Explicit app/parent scope is genuine deviation. Merge explicit composed contexts before applying defaults; imports do not import app context. | DESIGN.md:19,95–99; REQUIREMENTS.md:75–79 |
| Operation body / invariant spelling (explicit user changes) | Executable bindings remain inside `do`. Given constraints use `invariant`; execution/presentation/migration guards use `require`. Do not count old saved proposals as present source errors. | DECISIONS.md:21,715–717; GRAMMAR.md:261 |
| Description/localization (explicit user outcome; current notation) | `#` attaches metadata, `##` is ignored comment, inline keyed `@{locale=...}` is current. `label=` inherits schema labels. A single source-language override and viewer locale have different meanings. | REQUIREMENTS.md:49–67; DESIGN.md:11–13; DECISIONS.md:48 |
| UI vocabulary (user technology choice) | daisyUI via canonical primitives is current; PatternFly is superseded. C owns detailed current prop/interface comparisons. | DECISIONS.md:23; REQUIREMENTS.md:93–118 |
| Exact scalar / reused type contracts (chosen semantics) | Required non-null scalars omit `!`; nullable/default/server differ. Reuse carries value constraints, not initializer/authority. Omitted update differs from explicit null. | DESIGN.md:122–134; DECISIONS.md:25,28 |
| Version/order contract (chosen semantics) | Admitted existing row version stays v through transaction; accepted write reserves v+1 once, including no-op. Hook-after exposes v+1. Child-only write does not advance parent. CRUD admission sees normalized proposal but queries see prior provisional owner state. | DESIGN.md:101–103; DECISIONS.md:708–710 |
| BDD contract (user colocated-test goal; chosen table design) | Independently authored expectations invoke actual operation under its authority. Invalid fixture setup cannot count as expected rejection. Finalized files are provisioned actual test bytes; no fake file IDs. | REQUIREMENTS.md:39–47; DESIGN.md:349–411 |

## Conflicts / stale text to avoid propagating

1. DECISIONS.md:15 still says the migration retained implicit `main`; its later paragraph :30 explicitly supersedes that identity. Use DESIGN.md:39–45, not `main` in new artifacts.
2. DECISIONS.md:19 and :25 record intermediate decisions retaining scope/requiredness before later adoptions (:25/:28). Use current scalar and scope rules above.
3. DECISIONS.md:50 says “Tables are chosen” and describes locale-column layout after :48 records the user's inline-keyed replacement. This is stale historical prose within “Current status,” not a second current grammar. Smallest correction would label paragraph :50 as historical and link :48; no language change is needed. Benefit: fewer spurious experiment/target failures; tradeoff: documentation edit only; reevaluate by an agent resolving localization with both paragraphs present.
4. DECISIONS.md:34 explicitly says recurrence admission, availability expansion, daily reservation/pricing and federated refresh remained app work then. Later changes may close particular portions; these sentences are leads to inspect actual app bodies, not current failures by themselves.

No remaining conflict above warrants declaring an artifact invalid under two incompatible rule sets. Additional substantive ambiguity will be added here and messaged to A/C before affected conclusions close.
