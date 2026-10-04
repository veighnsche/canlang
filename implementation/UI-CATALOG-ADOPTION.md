# Approved full UI catalog: implementation and migration handoff

The user approved the full daisyUI proposal on October 4, 2026 and explicitly instructed this round to leave `.can` files unchanged. The former small subset was a design mistake: it restricted agents and cannot remain Can's frontend boundary. [All 68 pinned components](../design/UI-COMPONENTS.md) are required language/library scope. Full availability means appropriate component choice, not adding every component to every app.

All apps have the same static shell: right-sidebar page menu, bottom-right user menu, common user configuration dialog and canonical login screen. Current destinations and access derive from owning page descriptors. No app-selected shell layout is adopted. Lane 5 owns the typed catalog and renderer; lane 1 consumes it for language/tooling; lane 6 supplies canonical identity/transport; lane 7 integrates the real output. The [source migration prompt](prompts/08-frontend-catalog-migration.md) assigns later source changes to its separately launched Muse Code 1.3 Contributor worktree.

Approval is a design decision, not a claim that parser, editor, compiler or runtime support has shipped. The per-component appearance matrix must be verified against pinned upstream documentation. Forms, bindings, grants, versions, field/result scopes, localized messages and inline behavior examples retain their canonical semantics.

## Exact documentation handoff

The initial catalog and consultation evidence were committed as `9eaa4e2`. The approved adoption changes were staged separately from concurrent draft work, but another writer's commit, `706c70a`, consumed that staged documentation along with its app changes. The committed DESIGN and GRAMMAR content was verified against the isolated UI-only snapshots. Preserve that history; **do not cherry-pick the whole mixed commit to publish the UI adoption**.

The approved adoption paths in `706c70a` are exactly:

```text
README.md
REQUIREMENTS.md
DESIGN.md
GRAMMAR.md
design/UI-COMPONENTS.md
implementation/PLAN.md
implementation/CONTRACTS.md
implementation/WORKFLOW.md
implementation/prompts/01-language.md
implementation/prompts/05-ui.md
implementation/prompts/08-frontend-catalog-migration.md
```

If these changes are absent from remote main, the migration coordinator is authorized to carry **only the verified UI documentation diff on those paths** into its initial documentation PR. Inspect `git diff 9eaa4e2 706c70a -- <the exact paths above>`, reconcile its UI hunks against current remote contracts, and review the resulting PR. Include the documentation-only initial catalog/evidence prerequisite if absent, plus this handoff and subsequent verified prompt corrections. Never copy whole dirty normative files, import app-source changes, reset the primary checkout or transplant unrelated parent history. Source writers retain their own app work and merge responsibilities.

Launch prompts now stay short and refer to detailed briefs. Include the current verified prompt corrections and these approved documentation files in that initial documentation PR when absent from remote main:

```text
implementation/UI-CATALOG-ADOPTION.md
implementation/briefs/05-ui.md
implementation/briefs/08-frontend-catalog-migration.md
implementation/prompts/05-ui-steering.md
implementation/prompts/08-frontend-catalog-steering.md
```

**Lane 08 drafts first; lane 05 depends on those drafts.** Compiler and standard-library contracts derive from reviewed `.can`/desired-output pairs, not from existing APIs. Lane 08 replans each active app's entire frontend against the full vocabulary and authors complete source/output companions; lane 05 implements the resulting reusable UI library/catalog and lane 01 the compiler. Missing support is a downstream task, not a draft gate. The running lane 05 has a separate short steering prompt, with correction steps in its brief. Updating files does not itself inject input into an already running Muse session; the user pastes that steering prompt to trigger the change of course.

The normal PR loop applies to that documentation PR too: actual diff review, independent review, focused checks, fixes, protected merge of the reviewed head, then fetch main and start the next branch from fresh main. This handoff provides exact approval and scope for importing the documentation subset; it is not authorization to adopt unrelated design changes found nearby. If required non-documentation dependencies are missing, name their owners and continue ready inventory/implementation rather than inventing replacements.

No `.can` file was edited by the UI adoption work. `.can` files appearing in the mixed commit belong to concurrent draft work and are outside this documentation handoff.
