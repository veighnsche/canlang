# Working on Can

- Prioritize the user's requirements, adoption, simplicity, and token efficiency. Keep design assumptions open to revision.
- Express app identity and composition in `.can` source. Derive dependencies and interfaces from owning declarations; use shared defaults and reusable components to keep authoring concise.
- Address missing capabilities in the language design while preserving complete workflows, edge cases, permissions, and evaluation order. Use `##` for explanatory comments and keep executable bindings inside `do`.
- Make focused changes and run checks appropriate to them. Preserve inline behavior examples and report what was verified, what remains proposed, and any gaps.
- Validate changed behavior once with proportionate direct checks and a concise outcome. Reuse unchanged results. Do not create nested proof packets, reviews of reviews, tests of testing code, hash-manifest chains or duplicated verification snapshots. Repeat checks only after a relevant edit, actual failure or concrete unresolved risk.
- Evaluate alternatives fairly against the same outcomes and evidence. Assess draft designs at their declared stage, distinguishing desired generated output from implemented APIs.
- For difficult design decisions, consult JEV with verified context and balanced alternatives. Calls are preauthorized. Use the appropriate question type and three independently worded, equivalent requests; save responses and uncertainty, investigate disagreement, and treat results as advice.
- Keep work moving with reasonable implementation choices. Delegate independent work when useful, with focused context.
- Record project, design, and implementation decisions in [DECISIONS.md](docs/specification/DECISIONS.md), with the choice, rationale, and any remaining uncertainty. Label proposals separately from accepted decisions.
- After every merge, the person or agent handling it must reconcile the [living file-tree plan](docs/ideal-filetree-plan.md) against all changes since its checkpoint, update coverage and decisions together, and advance the checkpoint only when review is complete. Bookkeeping does not require recursive self-updates; plan maintenance does not authorize implementation.
