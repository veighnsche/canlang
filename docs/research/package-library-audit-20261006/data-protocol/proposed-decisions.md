# Proposed decisions and unresolved ownership

This audit identifies existing required-outcome gaps and source-domain limits. It
does not accept a new language/security/persisted protocol design or authorize repair.

* **Proposed:** let the owner validate/preserve its exact input once, and remove
  redundant conversion only after the real consumer and negative controls pass.
  Rationale: generic serialization/normalization hides presence, Unicode, identity,
  privacy and callback-order differences. Uncertainty: several native/private and
  installed-consumer joins remain unfinished.
* **Required outcome; mechanism unresolved:** freeze CSV selected inputs and row
  identity, with review context and lifetime. Choose private persisted state versus
  integrity-protected state and version the existing unsigned fields before repair.
* **Required outcome; disclosure policy unresolved:** safe provider diagnostics.
  Adapter-owned generic explanations are a minimal safe option; any specificity
  needs an explicit permitted projection. More blacklist branches cannot establish
  the existing no-confidential-data contract.
* **Compatibility decisions remain separate:** old receipt input hashing, exact
  error prose/UTF-16 carrier, S256 verifier admission, live versus retained plan
  capacity, arbitrary-JS media/upload domain, path well-formedness, and native
  preparation release. No historical bytes are silently reinterpreted.

Factual disagreements do not require a new JEV design choice. If implementation
selects a consequential mechanism among these alternatives, use verified balanced
repository context and the preauthorized three equivalent JEV questions, preserve
uncertainty, and record the resulting accepted/proposed decision in
`docs/specification/DECISIONS.md`. That shared concurrent file was not edited here.
