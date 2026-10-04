Consult Jev (TypeSafe AI) SystemOne for difficult design decisions. It is a classifier, not an LLM, and cannot research: supply all relevant context and evidence yourself. Make three fresh consultations, rewriting ALL explanatory prose each time: context, instructions, questions, and option descriptions. Preserve the same facts, constraints, and alternatives; keep exact code and technical identifiers where needed. Check semantic equivalence and full-request wording differences before sending. Save all requests and responses, investigate disagreements, and treat agreement as advice—not proof or guaranteed bias removal.

Choose JEV question types according to the actual question: `noul` for yes/no properties, `choice` for selecting among alternatives, and `score` for an ordered rubric. The user's request to use NOUL did not make it exclusive or the default. Preserve each type's returned probabilities/uncertainty without automatic approval thresholds. Rewrite supplied criteria as well as context/instructions across the three consultations.

The user grants standing authorization to call JEV through the TypeSafe API and send relevant canlang design context for those consultations. Do not stop work to request permission to consult JEV.

# Recorded violations — do not repeat

- Do not sacrifice adoption, token efficiency or simplicity to preserve an assistant-created design constraint; question and revise the constraint when it conflicts with the user's requirements.
- Do not compensate for a missing language mechanism by adding scaffolding files, configuration formats or architectural layers; identify and resolve the language-design gap.
- Do not strip app identity and composition from the actual app source to enforce an invented requirement that every loaded file collectively contain exactly one app declaration; the useful boundary is one selected app per deployment.
- Do not create per-profile app/context wrapper files like `draft/apps/`; declare the app and its composition in its actual `.can` source.
- Do not require an authored build manifest like `draft/builds.json` to repeat entry points, package lists or dependencies that the compiler should derive from `.can` declarations and imports.
- Do not give every implicit app the same `main` package identity or require named package wrappers to resolve that collision; derive its stable owning identity from the authored app name, independent of composition and file placement.
- Do not require a central connections file like `Connections.can`; keep exported business interfaces with their owning packages and imports with their consumers.
- Do not copy standard runtime, database, authentication, team, theme or file setup across near-identical app shells; eliminate required boilerplate through the language's shared context and defaults.
- Do not preserve identical per-app R2 MIME/size declarations as mandatory policy after the user requires a language default; pin the common baseline once, infer storage from file use, and declare only deviations.
- Do not duplicate canonical operation signatures, descriptions or schemas in separate connection, UI or MCP definitions; derive those interfaces from their owning declarations.
- Do not introduce competing ways to perform canonical SaaS primitives such as CRUD, authentication, page definition or business-operation invocation.
- Do not add verification frameworks, redundant tests or validation layers merely to appear thorough; use checks justified by the actual change and preserve the required inline behavior examples.
- Do not oversimplify business requirements or omit workflows and edge cases to achieve an attractive line count; compactness must preserve required behavior.
- Do not invent undeclared syntax, helpers or automatic integration behavior to hide a missing primitive or unresolved requirement.
- Do not use passing structural checks as proof of language-rule compliance, complete application requirements or executable correctness; report known violations, remaining gaps and what was actually run.
- Do not treat JEV's judgments as authorization to override the user's requirements or as proof that the proposed design works; the alternatives supplied to JEV are themselves reviewable choices.
- Do not attribute assistant-created design mistakes to the user or quietly promote provisional assistant choices into immutable requirements.
- Do not turn a request to use a tool, question type or technique into an exclusivity rule or default unless the user explicitly asks for that.
- Do not steer JEV by labeling a preferred proposal's costs as optional clutter, assuming its safety in the question, or omitting concrete competing benefits and risks; rewording the same biased framing is not independent validation.
- Do not copy near-identical model fixtures merely to vary initial state when existing example selectors can express the same cases with less source.
- Do not supply illustrative or remembered permissions to JEV as actual source facts; check the canonical operation signature and preserve its real `by` and guards in the consultation.
- Do not use description marker `#` for explanatory comments before guards or effects; use `##` so the comment cannot become unattached declaration metadata.
- Do not put executable bindings outside `do` to compress a scenario; leading guards and body effects must retain their written evaluation order.

- Do not copy generic presentation preferences, labels and wrappers across apps; keep common history expansion and other uniform appearance behavior in the shared runtime settings and canonical components.
- Do not lose page guards or canonical operation/record bindings when reorganizing frontends; preserve their original scopes and check audience-specific fields against current read grants.
- Do not force single-use descriptions or UI wording through abstract localization keys; keep authored text at its declaration/use site where feasible and reserve named assets for actual reuse.
- Do not present proposed generated-code dependencies as existing APIs; label unimplemented import contracts plainly.
- Do not treat tentative brainstorming or a classifier recommendation as approval to select a renderer or propagate that choice across app drafts.
- Do not overload one agent's context window with unrelated research and implementation; delegate independent work to separate agents in parallel, give each only relevant context, and keep implementation unblocked by unrelated investigations.
